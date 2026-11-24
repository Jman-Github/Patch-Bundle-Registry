"""Update the configured patch inventory from the public Morphe bundle index."""

import json
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor

import httpx

from scripts.git_hosts import ROOT, endpoint, normalize_source
from scripts.source_policy import source_channels

FEED = "https://morphe-patches.software/json/bundles.json"
FEED_HOSTS = {"github": "github.com", "gitlab": "gitlab.com"}
MAX_FEED_BYTES = 64 * 1024 * 1024


def unique_object(pairs):
    result = dict(pairs)
    if len(result) != len(pairs):
        raise ValueError("Duplicate keys in source inventory")
    return result


def repository_key(url):
    return url.split("://", 1)[1].lower()


def discover(client, root):
    with client.stream("GET", FEED) as response:
        response.raise_for_status()
        body = bytearray()
        for chunk in response.iter_bytes():
            if len(body) + len(chunk) > MAX_FEED_BYTES:
                raise ValueError("Morphe source feed exceeds size limit")
            body.extend(chunk)
    payload = json.loads(body)
    bundles = payload.get("bundles") if isinstance(payload, dict) else None
    if not isinstance(bundles, list) or not bundles:
        raise ValueError("Morphe source feed has no bundle inventory")
    sources = {}
    for bundle in bundles:
        host = FEED_HOSTS.get(bundle.get("source", "")) if isinstance(bundle, dict) else None
        repo = bundle.get("repo") if host else None
        if not isinstance(repo, str) or not re.fullmatch(r"[\w.-]+(?:/[\w.-]+)+", repo, re.ASCII):
            raise ValueError("Invalid repository in Morphe source feed")
        if host == "github.com" and repo.count("/") != 1:
            raise ValueError("Invalid GitHub repository in Morphe source feed")
        url = normalize_source("https://" + host + "/" + repo, root)
        sources.setdefault(repository_key(url), url)
    return sources


def repository_is_missing(client, url, root, token):
    api = endpoint(url, releases=False, root=root)
    headers = (
        {"Authorization": "Bearer " + token}
        if token and api.startswith("https://api.github.com/")
        else {}
    )
    try:
        with client.stream("GET", api, headers=headers) as response:
            if response.status_code != 404:
                return False
        # Confirm through the public repository URL. Scoped API credentials can
        # produce a 404 for a repo that still exists, and redirects may be renames.
        with client.stream("GET", url) as response:
            return response.status_code == 404
    except httpx.RequestError:
        return False


def update_sources(root, client, token=None):
    path = root / "config/sources.json"
    before = path.read_bytes()
    inventory = json.loads(before, object_pairs_hook=unique_object)
    if not isinstance(inventory, dict):
        raise ValueError("Invalid source inventory")

    discovered = discover(client, root)
    existing = {
        alias: normalize_source(settings["patches"], root) for alias, settings in inventory.items()
    }
    repositories = dict(discovered)
    repositories.update((repository_key(url), url) for url in existing.values())
    keys = list(repositories)
    with ThreadPoolExecutor(max_workers=8) as pool:
        missing = {
            key
            for key, dead in zip(
                keys,
                pool.map(
                    lambda key: repository_is_missing(client, repositories[key], root, token), keys
                ),
                strict=True,
            )
            if dead
        }
    removed = [alias for alias, url in existing.items() if repository_key(url) in missing]
    known = {repository_key(url) for url in existing.values()}
    for alias in removed:
        del inventory[alias]
    channels = set(source_channels(inventory, root))
    added = []
    for key, url in sorted(discovered.items()):
        if key in known or key in missing:
            continue
        name = re.sub(r"[^a-z0-9]+", "-", key.rsplit("/", 1)[1]).strip("-") or "source"
        alias = name
        suffix = 2
        entry = {"patches": url, "integrations": False, "disabled": False}
        while True:
            # In a mixed inventory a channel suffix can turn a new repo into a
            # legacy entry, so reserve these suffixes for the expanded channels.
            if alias not in inventory and not alias.endswith(("-latest", "-stable", "-dev")):
                generated = set(source_channels({alias: entry}, root))
                if channels.isdisjoint(generated):
                    break
            alias = f"{name}-{suffix}"
            suffix += 1
        inventory[alias] = entry
        channels.update(generated)
        added.append(alias)
    if added or removed:
        body = (json.dumps(inventory, indent=2, ensure_ascii=False) + "\n").encode()
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = path.with_name(os.path.basename(output.name))
                output.write(body)
            if path.read_bytes() != before:
                raise RuntimeError("Source inventory changed during update")
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return added, removed


def main():
    try:
        with httpx.Client(
            timeout=12, follow_redirects=False, headers={"User-Agent": "Patch-Bundle-Registry"}
        ) as client:
            added, removed = update_sources(ROOT, client, os.environ.get("GITHUB_TOKEN"))
    except (ValueError, KeyError, TypeError, OSError, httpx.HTTPError) as error:
        raise SystemExit(f"Source inventory update aborted: {error}") from None
    print(f"Added {len(added)} source(s), removed {len(removed)} HTTP 404 source(s).")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
            output.write(f"pruned={'true' if removed else 'false'}\n")


if __name__ == "__main__":
    main()
