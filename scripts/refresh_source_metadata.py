"""Refresh repository metadata daily within the existing updater; isolate upstream failures."""

import argparse
import os
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event
from urllib.parse import quote, urljoin, urlparse

import httpx
from generate_database import ROOT, encoded, normalize_source, read_json
from git_hosts import auth_headers, endpoint, hosts

try:
    from scripts.revanced_api import OFFICIAL_SOURCE as REVANCED_OFFICIAL_SOURCE
except ModuleNotFoundError:
    try:
        from revanced_api import OFFICIAL_SOURCE as REVANCED_OFFICIAL_SOURCE
    except ModuleNotFoundError:
        REVANCED_OFFICIAL_SOURCE = "https://github.com/ReVanced/revanced-patches"

REVANCED_METADATA_REPO = "https://gitlab.com/ReVanced/revanced-patches"


def metadata_for(url, payload):
    namespace, repo = urlparse(url).path.strip("/").rsplit("/", 1)
    kind = hosts().get(urlparse(url).netloc, "github")
    if kind in {"github", "gitea"}:
        owner = payload.get("owner") or {}
        return {
            "owner_name": owner.get("login") or namespace,
            "repo_name": payload.get("name") or repo,
            "owner_avatar_url": owner.get("avatar_url"),
            "repo_description": payload.get("description"),
            "repo_stars": payload.get("stargazers_count", payload.get("stars_count")),
            "repo_pushed_at": payload.get("pushed_at"),
            "is_repo_archived": payload.get("archived"),
        }
    group = payload.get("namespace") or {}
    avatar = group.get("avatar_url")
    return {
        "owner_name": group.get("full_path") or namespace,
        "repo_name": payload.get("path") or repo,
        "owner_avatar_url": urljoin(url, avatar) if avatar else None,
        "repo_description": payload.get("description"),
        "repo_stars": payload.get("star_count"),
        "repo_pushed_at": payload.get("last_activity_at"),
        "is_repo_archived": payload.get("archived"),
    }


def morphe_sources(root):
    manifest = read_json(root / "database/manifest.json", {})
    snapshot = manifest.get("snapshot", "")
    if not snapshot.startswith("snapshots/") or "." in snapshot:
        return set()
    folder = root / "database" / snapshot
    bundles = read_json(folder / "bundles.json", [])
    sources = read_json(folder / "sources.json", [])
    identities = {
        row["source_id"] for row in bundles if str(row.get("bundle_type", "")).startswith("Morphe:")
    }
    return {row["url"].lower() for row in sources if row["id"] in identities}


def icon_url(url, metadata, branch):
    parsed = urlparse(url)
    namespace = metadata["owner_name"]
    repo = metadata["repo_name"]
    path = "/".join(quote(part, safe="") for part in (namespace + "/" + repo).split("/"))
    ref = quote(branch, safe="")
    kind = hosts()[parsed.netloc]
    if parsed.netloc == "github.com":
        return f"https://raw.githubusercontent.com/{path}/refs/heads/{ref}/patches-bundle.png"
    origin = parsed.scheme + "://" + parsed.netloc
    if kind == "gitlab":
        return f"{origin}/{path}/-/raw/{ref}/patches-bundle.png"
    if kind == "gitea":
        return f"{origin}/{path}/raw/branch/{ref}/patches-bundle.png"
    return None


def refresh_icon(client, url, updated, now):
    metadata = updated.get("source_metadatum", {})
    branch = updated.get("default_branch")
    if not branch or not metadata:
        return
    target = icon_url(url, metadata, branch)
    if not target:
        return
    headers = {"User-Agent": "Patch-Bundle-Registry"}
    if updated.get("icon_url") == target and updated.get("icon_etag"):
        headers["If-None-Match"] = updated["icon_etag"]
    try:
        # Public raw HEADs do not consume GitHub's REST quota or download images.
        # Never send repository API credentials to a raw/content host.
        response = client.head(target, headers=headers, follow_redirects=True)
        updated["icon_checked_at"] = now.isoformat()
        content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
        if response.status_code == 200 and content_type == "image/png":
            metadata["bundle_icon_url"] = target
            updated.update(icon_url=target, icon_etag=response.headers.get("etag"))
        elif response.status_code in {200, 404, 410}:
            metadata["bundle_icon_url"] = None
            updated.update(icon_url=target, icon_etag=None)
        # A 304 or transient outage keeps the last known icon.
    except httpx.HTTPError:
        updated["icon_checked_at"] = now.isoformat()


def fetch_metadata(client, api, headers):
    origin = urlparse(api)
    for _ in range(11):
        response = client.get(api, headers=headers, follow_redirects=False)
        if not response.is_redirect or "location" not in response.headers:
            return response
        following = urljoin(api, response.headers["location"])
        target = urlparse(following)
        # Keep Authorization and PRIVATE-TOKEN scoped to their original origin.
        if target.netloc != origin.netloc or target.scheme != origin.scheme:
            raise ValueError("Repository metadata redirect changed origin")
        api = following
    raise ValueError("Too many repository metadata redirects")


def refresh(root, client, limit=None, now=None, workers=None):
    now = now or datetime.now(UTC)
    workers = int(os.environ.get("CATALOG_METADATA_WORKERS") or "4") if workers is None else workers
    if not 1 <= workers <= 8:
        raise ValueError("CATALOG_METADATA_WORKERS must be between 1 and 8")
    path = root / "database/repository-metadata.json"
    previous = read_json(path, {})
    inventory = read_json(root / "config/sources.json", {})
    urls = {
        normalize_source(item["patches"])
        for item in inventory.values()
        if isinstance(item, dict) and isinstance(item.get("patches"), str)
    }
    try:
        from scripts.refresh_issues import record_issue
        from scripts.source_policy import (
            PERMANENT_STATUS,
            disabled_sources,
            save_availability,
            source_availability,
        )
    except ModuleNotFoundError:
        from refresh_issues import record_issue
        from source_policy import (
            PERMANENT_STATUS,
            disabled_sources,
            save_availability,
            source_availability,
        )
    disabled = disabled_sources(inventory, root)
    availability = source_availability(root)
    checks = read_json(root / "internal/cache/release-checks.json", {})
    recovered = {url for url, completed in checks.items() if completed is True}
    result = {url.lower(): previous.get(url.lower(), {}) for url in sorted(urls)}
    morphe = morphe_sources(root)
    candidates = []
    # Cache identities are case-insensitive; dispatch each identity only once.
    unique_urls = {url.lower(): url for url in sorted(urls, reverse=True)}
    for url in sorted(unique_urls.values()):
        cached = result[url.lower()]
        if url.lower() in disabled:
            continue
        try:
            checked = datetime.fromisoformat(cached.get("checked_at", ""))
            icon_checked = (
                datetime.fromisoformat(cached.get("icon_checked_at", ""))
                if url.lower() in morphe else now
            )
            if (url.lower() not in availability and now - checked < timedelta(days=1)
                    and now - icon_checked < timedelta(days=1)):
                continue
        except (ValueError, TypeError):
            pass
        candidates.append(url)
    if limit is not None:
        candidates = candidates[:max(0, limit)]
    stop = Event()

    def fetch(url):
        if stop.is_set():
            return None
        cached = result[url.lower()]
        updated = {**cached, "checked_at": now.isoformat(),
                   "source_metadatum": dict(cached.get("source_metadatum", {}))}
        target_url = (
            REVANCED_METADATA_REPO
            if url.lower() == REVANCED_OFFICIAL_SOURCE.lower()
            else url
        )
        api = endpoint(target_url, releases=False)
        headers = auth_headers(target_url)
        if cached.get("etag") and (url.lower() not in morphe or cached.get("default_branch")):
            headers["If-None-Match"] = cached["etag"]
        response = None
        try:
            response = fetch_metadata(client, api, headers)
            updated["http_status"] = response.status_code
            if response.status_code == 200:
                payload = response.json()
                if not isinstance(payload, dict):
                    raise ValueError("Expected repository metadata")
                updated["source_metadatum"].update(metadata_for(target_url, payload))
                updated["default_branch"] = payload.get("default_branch")
                updated["etag"] = response.headers.get("etag")
            elif response.status_code != 304:
                print(f"Repository metadata unavailable: {url} (HTTP {response.status_code})")
        except (httpx.HTTPError, ValueError, TypeError, AttributeError):
            updated["http_status"] = None
            print(f"Repository metadata unavailable: {url}")
        status = updated.get("http_status")
        if status in {401, 429} or (
            status == 403 and response is not None and (
                response.headers.get("x-ratelimit-remaining") == "0"
                or "retry-after" in response.headers
                or "secondary rate limit" in response.text.lower()
            )
        ):
            stop.set()
        if url.lower() in morphe and status in {200, 304} and not stop.is_set():
            refresh_icon(client, url, updated, now)
        return url, updated

    attempted = 0

    def consume(item):
        nonlocal attempted
        if item is None:
            return
        attempted += 1
        url, updated = item
        status = updated.get("http_status")
        if status in PERMANENT_STATUS:
            availability[url.lower()] = PERMANENT_STATUS[status]
        elif status in {200, 304} and url.lower() in recovered:
            availability.pop(url.lower(), None)
        if status not in {200, 304}:
            record_issue(root, url, "Repository metadata",
                         f"HTTP {status}" if status else "Repository request failed")
        result[url.lower()] = updated

    pending_urls = iter(candidates)
    first = next(pending_urls, None)
    # Probe once before filling the pool so bad credentials never fan out.
    if first is not None:
        consume(fetch(first))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        pending = set()
        while not stop.is_set():
            while len(pending) < workers and not stop.is_set():
                url = next(pending_urls, None)
                if url is None:
                    break
                pending.add(pool.submit(fetch, url))
            if not pending:
                break
            finished, pending = wait(pending, return_when=FIRST_COMPLETED)
            for future in finished:
                consume(future.result())
        # Already-started requests retain their valid results; dispatch stops immediately.
        for future in pending:
            consume(future.result())
    save_availability(root, availability)
    if result != previous:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(encoded(result))
        temporary.replace(path)
    print(f"Repository metadata: {attempted} refresh attempts, {len(result)} registered sources")
    return result

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    with httpx.Client(timeout=20, follow_redirects=False) as client:
        refresh(Path(ROOT), client, args.limit)
