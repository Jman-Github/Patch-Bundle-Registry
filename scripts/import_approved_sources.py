"""Add reviewed public patch repositories to the registry inventory."""

import argparse
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import NamedTuple
from urllib.parse import quote, urlsplit

import httpx

from scripts.git_hosts import ROOT, endpoint, normalize_source
from scripts.release_assets import BUNDLE_TYPES, asset_extension, auxiliary_bundle, release_assets
from scripts.source_policy import source_channels
from scripts.update_patch_sources import repository_key, unique_object

HOSTS = {"github": "github.com", "gitlab": "gitlab.com"}
CURSOR = re.compile(r"(?:github|gitlab):[1-9][0-9]*")
PATH = re.compile(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+")


def approved_sources(client, url, headers):
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
        or parsed.path != "/api/approved" or parsed.query or parsed.fragment
    ):
        raise ValueError("Use the HTTPS /api/approved URL of the hosted scraper.")
    sources = []
    cursors = set()
    params = None
    for _ in range(100):
        with client.stream("GET", url, headers=headers, params=params) as response:
            response.raise_for_status()
            body = bytearray()
            for chunk in response.iter_bytes():
                if len(body) + len(chunk) > 1024 * 1024:
                    raise ValueError("Approved feed page exceeded its size limit.")
                body.extend(chunk)
        feed = json.loads(body, object_pairs_hook=unique_object)
        if (
            not isinstance(feed, dict)
            or feed.get("version") != 1
            or not isinstance(feed.get("sources"), list)
        ):
            raise ValueError("Unexpected approved feed format.")
        if len(feed["sources"]) > 50:
            raise ValueError("Approved feed returned too many entries on one page.")
        sources.extend(feed["sources"])
        cursor = feed.get("next")
        if cursor is None:
            return sources
        if not isinstance(cursor, str) or not CURSOR.fullmatch(cursor) or cursor in cursors:
            raise ValueError("Approved feed returned an invalid page cursor.")
        cursors.add(cursor)
        params = {"cursor": cursor}
    raise ValueError("Approved feed exceeded the page limit.")


def canonical_approval(source, root):
    if not isinstance(source, dict):
        raise ValueError("Approval is not an object.")
    forge = source.get("forge")
    repository = source.get("repository")
    project_id = source.get("projectId")
    tag = source.get("tag")
    extension = source.get("extension")
    host = HOSTS.get(forge) if isinstance(forge, str) else None
    if (
        not host or not isinstance(repository, str) or len(repository) > 350
        or type(project_id) is not int or project_id < 1
        or not isinstance(tag, str) or not 0 < len(tag) <= 250 or tag in {".", ".."}
        or not isinstance(extension, str) or extension not in BUNDLE_TYPES
    ):
        raise ValueError("Approval is missing a repository or qualifying release.")
    prefix = "https://" + host + "/"
    path = repository.removeprefix(prefix)
    if (
        not repository.startswith(prefix) or not PATH.fullmatch(path)
        or any(part in {".", ".."} for part in path.split("/"))
        or (forge == "github" and path.count("/") != 1)
    ):
        raise ValueError("Approval must identify a public GitHub or GitLab repository.")
    return normalize_source(repository, root), forge, project_id, tag, extension


def verify_release(client, approval, root, token):
    repository, forge, project_id, tag, extension = approval
    headers = {"Accept": "application/json"}
    if forge == "github" and token:
        headers.update({"Authorization": "Bearer " + token, "X-GitHub-Api-Version": "2026-03-10"})
    api = endpoint(repository, releases=False, root=root)
    result = client.get(api, headers=headers)
    result.raise_for_status()
    project = result.json()
    if not isinstance(project, dict) or project.get("id") != project_id:
        raise ValueError("Repository identity changed. Scan it again.")
    if forge == "github":
        public = project.get("private") is False and project.get("visibility", "public") == "public"
        release_url = api + "/releases/tags/"
    else:
        public = project.get("visibility") == "public"
        release_url = api + "/releases/"
    if not public:
        raise ValueError("Repository is no longer public.")

    result = client.get(release_url + quote(tag, safe=""), headers=headers)
    result.raise_for_status()
    release = result.json()
    if not isinstance(release, dict) or release.get("tag_name") != tag:
        raise ValueError("Release no longer matches the approved tag.")
    if release.get("draft") or release.get("upcoming_release"):
        raise ValueError("Release is unpublished.")
    if forge == "gitlab" and (released_at := release.get("released_at")):
        if not isinstance(released_at, str):
            raise ValueError("Invalid release timestamp.")
        if datetime.fromisoformat(released_at.replace("Z", "+00:00")) > datetime.now(UTC):
            raise ValueError("Release is unpublished.")
    if not any(
        asset_extension(asset) == extension and not auxiliary_bundle(asset)
        for asset in release_assets(release)
    ):
        raise ValueError("The approved release no longer lists a qualifying bundle asset.")


class ImportIssue(NamedTuple):
    repository: str
    message: str
    deferred: bool


def verification_deferred(error):
    if isinstance(error, httpx.RequestError):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return status in {401, 403, 408, 429} or status >= 500
    return False


def add_approved_sources(root, client, feed, *, token=None, dry_run=False):
    path = root / "config/sources.json"
    before = path.read_bytes()
    inventory = json.loads(before, object_pairs_hook=unique_object)
    if not isinstance(inventory, dict):
        raise ValueError("Invalid source inventory.")
    existing = {
        repository_key(normalize_source(entry["patches"], root))
        for entry in inventory.values()
    }
    channels = set(source_channels(inventory, root))
    added = []
    issues = []
    for source in feed:
        repository = "Invalid approval"
        try:
            approval = canonical_approval(source, root)
            repository = approval[0]
            key = repository_key(repository)
            if key in existing:
                continue
            verify_release(client, approval, root, token)
        except (httpx.HTTPError, ValueError, TypeError) as error:
            issues.append(ImportIssue(repository, str(error), verification_deferred(error)))
            continue

        base = re.sub(r"[^a-z0-9]+", "-", key.rsplit("/", 1)[-1]).strip("-") or "source"
        alias = base
        suffix = 2
        entry = {"patches": repository, "integrations": False, "disabled": False}
        while True:
            if alias not in inventory and not alias.endswith(("-latest", "-stable", "-dev")):
                generated = set(source_channels({alias: entry}, root))
                if channels.isdisjoint(generated):
                    break
            alias = f"{base}-{suffix}"
            suffix += 1
        inventory[alias] = entry
        channels.update(generated)
        existing.add(key)
        added.append(alias)

    if added and not dry_run:
        # The workflow serializes writers. An intervening edit aborts an update.
        temporary = None
        try:
            with NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write((json.dumps(inventory, indent=2, ensure_ascii=False) + "\n").encode())
            if path.read_bytes() != before:
                raise RuntimeError("Source inventory changed during import.")
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return added, issues


def required(name):
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"Missing {name}.")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true", help="Validate the feed without writing the inventory."
    )
    args = parser.parse_args()
    try:
        headers = {
            "CF-Access-Client-Id": required("IMPORT_ACCESS_CLIENT_ID"),
            "CF-Access-Client-Secret": required("IMPORT_ACCESS_CLIENT_SECRET"),
        }
        with httpx.Client(
            timeout=12, follow_redirects=False, headers={"User-Agent": "Patch-Bundle-Registry"}
        ) as client:
            feed = approved_sources(client, required("APPROVED_SOURCES_URL"), headers)
            added, issues = add_approved_sources(
                ROOT, client, feed, token=os.environ.get("GITHUB_TOKEN"), dry_run=args.dry_run,
            )
        if output_path := os.environ.get("GITHUB_OUTPUT"):
            with open(output_path, "a", encoding="utf-8") as output:
                deferred = any(issue.deferred for issue in issues)
                output.write(f"verification_deferred={str(deferred).lower()}\n")
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, httpx.HTTPError) as error:
        raise SystemExit(f"Approved source import stopped: {error}") from None
    for issue in issues:
        action = "Deferred" if issue.deferred else "Skipped"
        print(f"{action} {issue.repository}: {issue.message}")
    action = "Would add" if args.dry_run else "Added"
    print(f"{action} {len(added)} source(s): {', '.join(added) or 'none'}")
    if issues:
        print(
            f"{len(issues)} approval(s) could not be verified. "
            "They will be checked again on the next run."
        )


if __name__ == "__main__":
    main()
