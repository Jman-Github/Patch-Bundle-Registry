"""Cache repository indexes, regional Google Play metadata, and APKMirror fallbacks."""

import argparse
import json
import re
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote

import httpx

try:
    from scripts.apkmirror_metadata import ChallengePage, UnrecognizedSearchPage
    from scripts.apkmirror_metadata import lookup as lookup_apkmirror
    from scripts.app_catalog import safe_icon
    from scripts.generate_database import ROOT, encoded, packages_for, read_json
    from scripts.git_hosts import normalize_source
    from scripts.source_policy import disabled_sources, source_channels
except ModuleNotFoundError:
    from apkmirror_metadata import ChallengePage, UnrecognizedSearchPage
    from apkmirror_metadata import lookup as lookup_apkmirror
    from app_catalog import safe_icon
    from generate_database import ROOT, encoded, packages_for, read_json
    from git_hosts import normalize_source
    from source_policy import disabled_sources, source_channels

INDEXES = (
    "https://f-droid.org/repo/index-v2.json",
    "https://f-droid.org/repo/index-v1.json",
)
REPOSITORIES = (
    ("fdroid", "https://f-droid.org/repo/", INDEXES),
    (
        "izzyondroid",
        "https://apt.izzysoft.de/fdroid/repo/",
        (
            "https://apt.izzysoft.de/fdroid/repo/index-v2.json",
            "https://apt.izzysoft.de/fdroid/repo/index-v1.json",
        ),
    ),
)
PLAY_COUNTRIES = ("US", "GB", "IN")
PLAY_EXTRA_COUNTRIES = ("DE", "BR", "JP", "KR", "ID")
MAX_INDEX_BYTES = 256 * 1024 * 1024
APKMIRROR_LIMIT = 30
PACKAGE = re.compile(r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+")


def localized(value):
    if not isinstance(value, dict):
        return value
    for locale in ("en-US", "en-GB", "en"):
        if value.get(locale):
            return value[locale]
    return next((item for item in value.values() if item), None)


def fdroid_apps(payload, base_url="https://f-droid.org/repo/", source="fdroid"):
    result = {}
    if not isinstance(payload, dict):
        raise ValueError("Unrecognized F-Droid index")
    if isinstance(payload.get("packages"), dict) and "apps" not in payload:
        entries = (
            (name, item.get("metadata", {}) if isinstance(item, dict) else {})
            for name, item in payload["packages"].items()
        )
        version = 2
    elif isinstance(payload.get("apps"), list):
        entries = (
            (item.get("packageName"), item) for item in payload["apps"] if isinstance(item, dict)
        )
        version = 1
    else:
        raise ValueError("Unrecognized F-Droid index")
    for package, metadata in entries:
        if not isinstance(metadata, dict):
            continue
        if not isinstance(package, str) or not PACKAGE.fullmatch(package):
            continue
        name = localized(metadata.get("name"))
        if not isinstance(name, str) or not name.strip():
            continue
        icon = metadata.get("icon")
        if version == 2:
            icon = (
                icon
                if isinstance(icon, dict) and isinstance(icon.get("name"), str)
                else localized(icon)
            )
            icon = icon.get("name") if isinstance(icon, dict) else icon
        elif icon:
            icon = "icons/" + icon
        if isinstance(icon, str) and ".." not in icon.split("/"):
            icon = base_url + quote(icon.lstrip("/"), safe="/-._~")
        else:
            icon = None
        result[package] = {"app_name": name.strip(), "icon_url": icon, "metadata_source": source}
    if not result:
        raise ValueError("F-Droid index contains no application metadata")
    return result


class LookupBudget(Exception):
    pass


class PlayMetadata(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values = {}
        self.structured = []
        self.in_json = False
        self.json_parts = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == "meta":
            key = values.get("property") or values.get("name")
            if key in {"og:title", "og:image"}:
                self.values[key] = values.get("content")
        if tag == "script" and values.get("type") == "application/ld+json":
            self.in_json = True
            self.json_parts = []

    def handle_data(self, data):
        if self.in_json:
            self.json_parts.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self.in_json:
            try:
                data = json.loads("".join(self.json_parts))
                self.structured.extend(structured_applications(data))
            except ValueError:
                pass
            self.in_json = False

    def metadata(self):
        for value in self.structured:
            if not isinstance(value, dict):
                continue
            kinds = value.get("@type", [])
            kinds = [kinds] if isinstance(kinds, str) else kinds
            kinds = (
                [kind.rsplit("/", 1)[-1] for kind in kinds if isinstance(kind, str)]
                if isinstance(kinds, list)
                else []
            )
            if isinstance(kinds, list) and any(
                kind
                in {
                    "SoftwareApplication",
                    "MobileApplication",
                }
                for kind in kinds
                if isinstance(kind, str)
            ):
                name = value.get("name")
                if isinstance(name, str) and name.strip():
                    image = value.get("image")
                    image = next(iter(image), None) if isinstance(image, list) else image
                    image = (
                        (image.get("url") or image.get("contentUrl"))
                        if isinstance(image, dict)
                        else image
                    )
                    return {
                        "app_name": unescape(name.strip()),
                        "icon_url": safe_icon(image),
                        "metadata_source": "google_play",
                    }
        title = self.values.get("og:title")
        image = safe_icon(self.values.get("og:image"))
        if isinstance(title, str) and title.endswith(" - Apps on Google Play") and image:
            return {
                "app_name": title.removesuffix(" - Apps on Google Play").strip(),
                "icon_url": image,
                "metadata_source": "google_play",
            }
        return None


def structured_applications(value):
    """Walk JSON-LD graphs without treating unrelated nested text as an app."""
    pending, result = [value], []
    while pending and len(result) < 2000:
        item = pending.pop()
        if isinstance(item, list):
            pending.extend(reversed(item))
        elif isinstance(item, dict):
            result.append(item)
            pending.extend(v for v in item.values() if isinstance(v, dict | list))
    return result


def fresh_packages(root):
    """Read current extraction outputs directly; no second catalog build is needed."""
    inventory = read_json(root / "config/sources.json", {})
    channels = source_channels(inventory, root)
    disabled = disabled_sources(inventory, root)
    configured = {normalize_source(row["patches"], root).lower() for row in channels.values()}
    history = read_json(root / "internal/cache/history/sources.json", {})
    inputs = []
    cache = (root / "internal/cache").resolve()
    for alias, row in {**channels, **history}.items():
        url = normalize_source(row["patches"], root).lower()
        if url not in configured or url in disabled:
            continue
        base = row.get("alias") or re.sub(r"-(latest|stable|dev)$", "", alias)
        relative = row.get("cache_path") or (
            f"internal/cache/bundles/{base}-patch-bundles/{alias}-patches-bundle.json"
        )
        path = root / relative
        if not path.resolve().is_relative_to(cache):
            raise ValueError("Unsafe application extraction input")
        inputs.append((alias, path))
    wanted, seen = {}, set()
    fresh = read_json(root / "internal/fresh-app-packages.json")
    if isinstance(fresh, dict) and isinstance(fresh.get("folders"), dict):
        allowed = {path.parent.name for _, path in inputs}
        for folder, counts in fresh["folders"].items():
            if folder not in allowed or not isinstance(counts, dict):
                continue
            for name, count in counts.items():
                if PACKAGE.fullmatch(name) and isinstance(count, int) and count > 0:
                    wanted.setdefault(name, {"package_name": name, "bundle_count": 0})[
                        "bundle_count"
                    ] += count
        return wanted
    # Standalone enrichment still supports extraction outputs from older parser builds.
    for alias, path in inputs:
        patches = read_json(path.with_name(alias + "-patches-list.json"), {})
        raw = read_json(path, {})
        if not isinstance(patches, dict) or not isinstance(raw, dict):
            continue
        metadata = raw.get("patches") if isinstance(raw.get("patches"), dict) else raw
        version = metadata.get("version")
        identity = (str(path.parent), version, metadata.get("download_url") or metadata.get("url"))
        if identity in seen or not version or patches.get("version") != version:
            continue
        seen.add(identity)
        names = {
            package["name"]
            for patch in patches.get("patches", [])
            if isinstance(patch, dict)
            for package in packages_for(patch)
            if PACKAGE.fullmatch(package["name"])
        }
        for name in names:
            wanted.setdefault(name, {"package_name": name, "bundle_count": 0})["bundle_count"] += 1
    return wanted


def expired(stamp, now, ttl):
    try:
        return now - datetime.fromisoformat(stamp) >= ttl
    except (TypeError, ValueError):
        return True


def provider_retry_after(response, received_at):
    retry = response.headers.get("retry-after", "3600").strip()
    try:
        seconds = (
            int(retry)
            if retry.isdigit()
            else (parsedate_to_datetime(retry) - received_at).total_seconds()
        )
        return (received_at + timedelta(seconds=max(60, seconds))).isoformat()
    except (ValueError, TypeError, OverflowError):
        return (received_at + timedelta(hours=1)).isoformat()


def fetch_index(client, url, headers, deadline, base_url, source):
    with client.stream("GET", url, headers=headers) as response:
        if response.status_code == 304:
            return None, dict(response.headers)
        response.raise_for_status()
        chunks, size = [], 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > MAX_INDEX_BYTES or time.monotonic() >= deadline:
                raise ValueError("F-Droid index exceeds download budget")
            chunks.append(chunk)
        return fdroid_apps(json.loads(b"".join(chunks)), base_url, source), dict(response.headers)


def enrich_apkmirror(
    state, apps, candidates, client, *, now, current_time, deadline, limit, delay, sleep
):
    """Spend a bounded lookup budget on packages with confirmed Play misses."""
    deadline = min(deadline, time.monotonic() + 30)
    if (
        not limit
        or time.monotonic() >= deadline
        or not expired(state.get("apkmirror_retry_after"), current_time(), timedelta(0))
    ):
        return 0
    requests = 0

    def fetch_page(url):
        nonlocal requests
        remaining = deadline - time.monotonic()
        wait = delay if requests else 0
        if requests >= limit or remaining <= wait:
            raise LookupBudget
        if wait:
            sleep(wait)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise LookupBudget
        requests += 1
        with client.stream(
            "GET", url, follow_redirects=False, timeout=min(10, remaining)
        ) as response:
            if response.status_code == 404:
                return None
            response.raise_for_status()
            content = bytearray()
            for chunk in response.iter_bytes():
                if time.monotonic() >= deadline:
                    raise LookupBudget
                if len(content) + len(chunk) > 2 * 1024 * 1024:
                    raise ValueError("APKMirror response exceeds metadata budget")
                content.extend(chunk)
            return content.decode("utf-8", errors="replace")

    queued = sorted(
        (
            package
            for package in candidates
            if apps.get(package, {}).get("play_status") == "not_found"
            and (
                not apps[package].get("app_name")
                or apps[package].get("metadata_source") == "apkmirror"
            )
            and expired(apps[package].get("apkmirror_retry_after"), now, timedelta(0))
            and expired(
                apps[package].get("apkmirror_checked_at"),
                now,
                timedelta(days=30 if apps[package].get("app_name") else 7),
            )
        ),
        key=lambda package: apps[package].get("apkmirror_checked_at") or "",
    )
    consecutive_failures = 0
    for package in queued:
        cached = apps[package]
        try:
            found = lookup_apkmirror(package, fetch_page, cached.get("apkmirror_path"))
        except LookupBudget:
            break
        except (httpx.HTTPError, ValueError) as error:
            consecutive_failures += 1
            received_at = current_time()
            blocked = isinstance(error, httpx.HTTPStatusError) and (
                error.response.status_code in {401, 403, 429, 503}
                or "retry-after" in error.response.headers
            )
            if blocked:
                retry = provider_retry_after(error.response, received_at)
                reason = f"HTTP {error.response.status_code}"
            elif isinstance(error, ChallengePage):
                # A challenge served with 200 is still a refusal: wait like a 403.
                retry = (received_at + timedelta(hours=1)).isoformat()
                reason = "browser challenge"
            else:
                retry = (received_at + timedelta(minutes=10)).isoformat()
                reason = type(error).__name__
            cached["apkmirror_retry_after"] = retry
            if blocked or isinstance(error, UnrecognizedSearchPage) or consecutive_failures >= 3:
                state["apkmirror_retry_after"] = retry
                print(
                    f"Application metadata: APKMirror unavailable ({reason}); "
                    "retaining cached names."
                )
                break
            continue
        consecutive_failures = 0
        cached.pop("apkmirror_retry_after", None)
        if found:
            cached.update({**found, "icon_url": found["icon_url"] or cached.get("icon_url")})
        cached["apkmirror_checked_at"] = current_time().isoformat()
    return requests


def refresh(
    root,
    client,
    *,
    now=None,
    max_play=None,
    max_apkmirror=None,
    delay=1,
    sleep=time.sleep,
    budget=None,
):
    now = now or datetime.now(UTC)
    stamp = now.isoformat()
    started = time.monotonic()
    deadline = float("inf")  # Set after inspecting the backlog, before any requests.

    def current_time():
        return now + timedelta(seconds=time.monotonic() - started)

    path = root / "database/app-metadata.json"
    state = read_json(path, {})
    repositories = [
        (source, base, urls, state.setdefault(source, {})) for source, base, urls in REPOSITORIES
    ]
    cached_index = {
        package for _, _, _, cache in repositories for package in cache.get("applications", {})
    }
    apps = state.setdefault("apps", {})
    manifest = read_json(root / "database/manifest.json", {})
    snapshot = root / "database" / manifest.get("snapshot", "")
    catalog_apps = read_json(snapshot / "apps.json", [])
    if not catalog_apps:
        catalog_apps = [
            {"package_name": item["name"], "bundle_count": 0}
            for item in read_json(snapshot / "packages.json", [])
        ]
    wanted = {item["package_name"]: item for item in catalog_apps}
    for package, item in fresh_packages(root).items():
        wanted[package] = item
    overrides = read_json(root / "config/apps.json", {})

    def unchecked(package):
        return not apps.get(package, {}).get("checked_at")

    pending = sum(
        unchecked(package)
        and package not in cached_index
        and package not in overrides
        and PACKAGE.fullmatch(package) is not None
        for package in wanted
    )
    backfill = pending > 50 and (max_play is None or max_play > 50)
    max_play = (1500 if backfill else 50) if max_play is None else max_play
    budget = (1800 if backfill else 180) if budget is None else budget
    max_apkmirror = APKMIRROR_LIMIT if max_apkmirror is None else max_apkmirror
    if max_play < 0 or max_apkmirror < 0 or budget < 0 or delay < 0:
        raise ValueError("Application metadata budgets must be nonnegative")
    deadline = started + budget

    def save_state():
        state["apps"] = {key: value for key, value in apps.items() if key in wanted}
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".tmp")
        temporary.write_bytes(encoded(state))
        temporary.replace(path)

    for source, base_url, urls, cache in repositories:
        if (
            wanted
            and time.monotonic() < deadline
            and expired(cache.get("checked_at"), now, timedelta(days=1))
            and expired(cache.get("attempted_at"), now, timedelta(minutes=10))
            and expired(cache.get("retry_after"), now, timedelta(0))
        ):
            cache["attempted_at"] = stamp
            for url in urls:
                headers = {}
                if cache.get("url") == url and cache.get("applications"):
                    if cache.get("etag"):
                        headers["If-None-Match"] = cache["etag"]
                    if cache.get("last_modified"):
                        headers["If-Modified-Since"] = cache["last_modified"]
                try:
                    applications, received = fetch_index(
                        client, url, headers, deadline, base_url, source
                    )
                    if applications is None and not cache.get("applications"):
                        raise ValueError("F-Droid returned 304 without a cached index")
                    if cache.get("url") != url:
                        cache.pop("etag", None)
                        cache.pop("last_modified", None)
                    cache.update(
                        checked_at=stamp,
                        url=url,
                        etag=received.get("etag", cache.get("etag")),
                        last_modified=received.get("last-modified", cache.get("last_modified")),
                    )
                    if applications is not None:
                        cache["applications"] = applications
                    cache.pop("retry_after", None)
                    break
                except (httpx.HTTPError, ValueError, TypeError) as error:
                    print(
                        f"Application metadata: {source} index unavailable; retaining cached names."
                    )
                    if isinstance(error, httpx.HTTPStatusError) and error.response.status_code in {
                        429,
                        503,
                    }:
                        cache["retry_after"] = provider_retry_after(error.response, current_time())
                        break
                    if time.monotonic() >= deadline:
                        break

    indexed = {}
    for _, _, _, cache in repositories:
        for package, info in cache.get("applications", {}).items():
            indexed.setdefault(package, {**info, "checked_at": cache.get("checked_at")})
            if not indexed[package].get("icon_url") and info.get("icon_url"):
                indexed[package]["icon_url"] = info["icon_url"]
    for package in wanted:
        if package in indexed:
            apps[package] = {
                **indexed[package],
                "icon_url": indexed[package].get("icon_url")
                or apps.get(package, {}).get("icon_url"),
            }
    save_state()  # Preserve the bulk index even if a long backfill is interrupted.
    candidates = sorted(
        wanted,
        key=lambda package: (
            not unchecked(package),
            -wanted[package].get("bundle_count", 0),
            package,
        ),
    )
    lookups = 0

    @contextmanager
    def play_stream(url):
        nonlocal lookups
        for attempt in range(2):
            if (
                lookups >= max_play
                or time.monotonic() >= deadline
                or not expired(state.get("play_retry_after"), current_time(), timedelta(0))
            ):
                raise LookupBudget
            if lookups:
                sleep(delay)
            if time.monotonic() >= deadline:
                raise LookupBudget
            if lookups and lookups % 25 == 0:
                save_state()
                print(
                    f"Application metadata: checkpoint after {lookups} Google Play lookups.",
                    flush=True,
                )
            lookups += 1
            stream = client.stream("GET", url)
            try:
                response = stream.__enter__()
            except httpx.TransportError:
                if attempt == 0 and time.monotonic() < deadline:
                    sleep(0.5)
                    continue
                raise
            if (
                attempt == 0
                and response.status_code in {500, 502, 504}
                and "retry-after" not in response.headers
            ):
                stream.__exit__(None, None, None)
                sleep(0.5)
                continue
            try:
                yield response
            finally:
                stream.__exit__(None, None, None)
            return

    halted = False
    transient_failures = 0
    for package in candidates:
        if package in indexed or package in overrides or not PACKAGE.fullmatch(package):
            continue
        cached = apps.get(package, {})
        primary_name = cached.get("app_name") and cached.get("metadata_source") != "apkmirror"
        ttl = timedelta(days=30 if primary_name else 7)
        countries = list(PLAY_COUNTRIES)
        # Extra markets are an opt-in second pass for packages absent in all base markets.
        if (
            (
                cached.get("play_status") == "not_found"
                and expired(cached.get("checked_at"), now, ttl)
            )
            or cached.get("play_extended_markets")
            or cached.get("play_country") in PLAY_EXTRA_COUNTRIES
        ):
            countries.extend(
                country for country in PLAY_EXTRA_COUNTRIES if country not in countries
            )
            cached = {**cached, "play_extended_markets": True}
        if cached.get("play_country") in countries:
            countries.remove(cached["play_country"])
            countries.insert(0, cached["play_country"])
        attempted = cached.get("play_checked_countries", [])
        # Old negative entries covered the US only. Try the new regions now.
        if not attempted and cached.get("checked_at") and not cached.get("app_name"):
            attempted = ["US"]
        if not expired(cached.get("play_retry_after"), now, timedelta(0)):
            continue
        if not expired(cached.get("checked_at"), now, ttl):
            if primary_name or set(countries).issubset(attempted):
                continue
        if expired(cached.get("play_attempted_at", cached.get("checked_at")), now, ttl):
            attempted = []
        for country in countries:
            if country in attempted:
                continue
            if (
                lookups >= max_play
                or time.monotonic() >= deadline
                or not expired(state.get("play_retry_after"), current_time(), timedelta(0))
            ):
                halted = True
                break
            url = (
                "https://play.google.com/store/apps/details?id="
                + quote(package, safe="")
                + "&hl=en&gl="
                + country
            )
            try:
                found = None
                with play_stream(url) as response:
                    if response.status_code in {429, 503}:
                        state["play_retry_after"] = provider_retry_after(response, current_time())
                        halted = True
                        break
                    if time.monotonic() >= deadline:
                        halted = True
                        break
                    if response.url.host != "play.google.com":
                        state["play_retry_after"] = (
                            current_time() + timedelta(hours=1)
                        ).isoformat()
                        halted = True
                        break
                    if response.status_code != 404:
                        response.raise_for_status()
                        chunks, size = [], 0
                        for chunk in response.iter_bytes():
                            size += len(chunk)
                            if size > 4 * 1024 * 1024 or time.monotonic() >= deadline:
                                raise ValueError("Google Play response exceeds metadata budget")
                            chunks.append(chunk)
                        content = b"".join(chunks).decode("utf-8", errors="replace")
                        if re.search(r"<title[^>]*>\s*Before you continue", content, re.IGNORECASE):
                            state["play_retry_after"] = (
                                current_time() + timedelta(hours=1)
                            ).isoformat()
                            halted = True
                            break
                        parser = PlayMetadata()
                        parser.feed(content)
                        found = parser.metadata()
                        if not found and re.search(
                            r"unusual traffic|automated queries|"
                            r"<title[^>]*>[^<]*(?:captcha|access denied)",
                            content,
                            re.IGNORECASE,
                        ):
                            state["play_retry_after"] = (
                                current_time() + timedelta(hours=1)
                            ).isoformat()
                            halted = True
                            break
                if found:
                    transient_failures = 0
                    apps[package] = {
                        **found,
                        "icon_url": found.get("icon_url") or cached.get("icon_url"),
                        "checked_at": stamp,
                        "play_country": country,
                        "play_extended_markets": country in PLAY_EXTRA_COUNTRIES
                        or cached.get("play_extended_markets", False),
                        "play_status": "found",
                    }
                    break
                # Only an actual 404 is evidence that this market lacks the listing.
                if response.status_code != 404:
                    apps[package] = {
                        **cached,
                        "play_status": "unrecognized",
                        "play_retry_after": (current_time() + timedelta(hours=1)).isoformat(),
                    }
                    break
                transient_failures = 0
                attempted = [*attempted, country]
                cached = {
                    **cached,
                    "play_checked_countries": attempted,
                    "play_attempted_at": current_time().isoformat(),
                }
                if set(countries).issubset(attempted):
                    cached["checked_at"] = stamp
                    cached["play_status"] = "not_found"
                apps[package] = cached
            except LookupBudget:
                halted = True
                break
            except (httpx.HTTPError, ValueError) as error:
                # Isolated failures leave other packages eligible; repeated failures pause the host.
                transient_failures += 1
                provider_error = isinstance(error, httpx.HTTPStatusError) and (
                    error.response.status_code in {401, 403, 429, 503}
                    or "retry-after" in error.response.headers
                )
                if provider_error or transient_failures >= 3:
                    state["play_retry_after"] = (
                        provider_retry_after(error.response, current_time())
                        if provider_error
                        else (current_time() + timedelta(hours=1)).isoformat()
                    )
                    halted = True
                apps[package] = {
                    **cached,
                    "play_status": "temporary_failure",
                    "play_retry_after": (current_time() + timedelta(minutes=10)).isoformat(),
                }
                break
        if halted:
            break
    mirror_candidates = (
        package
        for package in candidates
        if package not in indexed and package not in overrides and PACKAGE.fullmatch(package)
    )
    mirror_requests = enrich_apkmirror(
        state,
        apps,
        mirror_candidates,
        client,
        now=now,
        current_time=current_time,
        deadline=deadline,
        limit=max_apkmirror,
        delay=delay,
        sleep=sleep,
    )
    save_state()
    named = sum(
        bool(apps.get(package, {}).get("app_name"))
        or bool(overrides.get(package, {}).get("app_name"))
        for package in wanted
    )
    remaining = sum(unchecked(package) and package not in overrides for package in wanted)
    print(
        f"Application metadata: {named}/{len(wanted)} apps named; "
        f"{lookups} Google Play lookups; {mirror_requests} APKMirror requests; "
        f"{remaining} packages awaiting a completed lookup.",
        flush=True,
    )
    return state


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--play-limit", type=int, help="Override the adaptive Google Play lookup cap"
    )
    parser.add_argument("--apkmirror-limit", type=int, help="Override the APKMirror request cap")
    parser.add_argument("--budget", type=float, help="Override the metadata time budget in seconds")
    args = parser.parse_args()
    with httpx.Client(
        timeout=httpx.Timeout(20, connect=10),
        follow_redirects=True,
        headers={"User-Agent": "Patch-Bundle-Registry/1.0"},
    ) as client:
        refresh(
            ROOT,
            client,
            max_play=args.play_limit,
            max_apkmirror=args.apkmirror_limit,
            budget=args.budget,
        )
