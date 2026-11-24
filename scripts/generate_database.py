"""Generate immutable catalog snapshots from private release/extraction inputs."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlencode, urlparse

try:
    from scripts.extraction_policy import (
        history_patch_inventory,
        is_internal_patch,
        patch_completeness_current,
    )
    from scripts.git_hosts import hosts
    from scripts.git_hosts import normalize_source as normalize_repository
    from scripts.release_assets import (
        auxiliary_bundle,
        canonical_bundle_type,
        digest_matches,
        migrate_bundle_types,
    )
    from scripts.release_history import reconcile_release, release_is_prerelease
    from scripts.snapshot_retention import apply_retention, published_snapshots, retention_plan
except ModuleNotFoundError:
    from extraction_policy import (
        history_patch_inventory,
        is_internal_patch,
        patch_completeness_current,
    )
    from git_hosts import hosts
    from git_hosts import normalize_source as normalize_repository
    from release_assets import (
        auxiliary_bundle,
        canonical_bundle_type,
        digest_matches,
        migrate_bundle_types,
    )
    from release_history import reconcile_release, release_is_prerelease
    from snapshot_retention import apply_retention, published_snapshots, retention_plan

try:
    from scripts.source_policy import (
        disabled_sources,
        source_channels,
        unavailable_sources,
        write_extraction_policy,
    )
except ModuleNotFoundError:
    from source_policy import (
        disabled_sources,
        source_channels,
        unavailable_sources,
        write_extraction_policy,
    )

ROOT = Path(__file__).resolve().parents[1]
PATCH_METADATA_SCHEMA_VERSION = 3


def read_json(path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def runtime_config_hash(root):
    config = root / "config/patcher-runtimes.json"
    return digest(config.read_bytes() if config.is_file() else b"")


_revision_cache = {}


def parser_revision(root):
    directory = root / "bundle-parser/src/main/kotlin/me/jman/parser"
    paths = sorted(directory.glob("*.kt"))
    script = root / "scripts/reseam_legacy.py"
    signature = tuple(
        (str(path), path.stat().st_mtime_ns, path.stat().st_size)
        for path in [*paths, script]
        if path.is_file()
    )
    key = str(root.resolve())
    if key not in _revision_cache or _revision_cache[key][0] != signature:
        content = b"".join(
            path.name.encode() + b"\0" + path.read_bytes().replace(b"\r\n", b"\n") for path in paths
        )
        if script.is_file():
            content += script.read_bytes().replace(b"\r\n", b"\n")
        _revision_cache[key] = signature, digest(content)
    return _revision_cache[key][1]


def runtime_fingerprint(root):
    files = (
        root / "config/patcher-runtimes.json",
        root / "bundle-parser/build/runtime-classpaths.json",
    )
    java_home = (
        os.environ.get("CATALOG_WORKER_JAVA_HOME")
        or os.environ.get("JAVA_HOME_21_X64")
        or os.environ.get("JAVA_HOME")
        or ""
    )
    return digest(
        b"".join(path.read_bytes() for path in files if path.is_file())
        + parser_revision(root).encode()
        + java_home.encode()
    )


def paused_failure(root, status, raw, family):
    # Before runtime preparation on a fresh runner, compare the portable config
    # hash. Once installed, also account for runtime availability/classpaths.
    manifest = root / "bundle-parser/build/runtime-classpaths.json"
    return bool(
        status.get("terminal") is True
        and status.get("status") != "verified"
        and status.get("file_hash")
        and canonical_bundle_type(status.get("bundle_type")) == family
        and status.get("failure_fingerprint")
        and status.get("runtime_config_hash") == runtime_config_hash(root)
        and status.get("parser_revision") == parser_revision(root)
        and (not manifest.is_file() or status["failure_fingerprint"] == runtime_fingerprint(root))
        and digest_matches(
            raw.get("provider_digest"), status["file_hash"], status.get("provider_digest")
        )
    )


def timestamp_rank(value):
    try:
        stamp = datetime.fromisoformat(str(value))
        return (stamp.replace(tzinfo=UTC) if stamp.tzinfo is None else stamp).timestamp()
    except (TypeError, ValueError, OverflowError):
        return float("-inf")


def normalize_source(value, root=ROOT):
    return normalize_repository(value, root)


def packages_for(patch):
    def versions_list(value):
        if isinstance(value, str):
            return [value]
        if isinstance(value, list):
            return [str(item) for item in value if isinstance(item, str | int | float)]
        return []

    value = patch.get("compatiblePackages")
    if isinstance(value, dict):
        return [
            {"name": name, "versions": versions_list(versions)}
            for name, versions in value.items()
            if isinstance(name, str) and name and not (isinstance(versions, list) and not versions)
        ]
    result = []
    for item in value if isinstance(value, list) else []:
        if isinstance(item, str):
            result.append({"name": item, "versions": []})
        elif isinstance(item, dict):
            name = item.get("name") or item.get("packageName")
            if isinstance(name, str) and name:
                versions = item.get("versions")
                targets = item.get("targets")
                if versions is None and isinstance(targets, list):
                    versions = [
                        target["version"]
                        for target in targets
                        if isinstance(target, dict) and target.get("version")
                    ]
                if isinstance(versions, list) and not versions:
                    continue
                result.append({"name": name, "versions": versions_list(versions)})
    return result


def grams(text):
    text = text.lower()
    return {text[i : i + 3] for i in range(max(0, len(text) - 2))}


def javascript_lower_texts(pages):
    """Use JavaScript case conversion for the Worker's Unicode search postings."""
    if not pages:
        return {}
    script = (
        "let data='';process.stdin.setEncoding('utf8');"
        "process.stdin.on('data',chunk=>data+=chunk);"
        "process.stdin.on('end',()=>{const pages=JSON.parse(data);"
        "process.stdout.write(JSON.stringify(Object.fromEntries("
        "Object.entries(pages).map(([page,texts])=>"
        "[page,texts.map(text=>text.toLowerCase())]))));});"
    )
    try:
        result = subprocess.run(  # noqa: S603 - fixed Node command, input passed over stdin
            ["node", "-e", script],  # noqa: S607 - Node provisioned by project workflows
            input=json.dumps(pages, ensure_ascii=False),
            capture_output=True,
            check=True,
            encoding="utf-8",
            timeout=60,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError("Node.js is required to build Unicode search postings") from exc
    return json.loads(result.stdout)


def restore_catalog_cache(root=ROOT):
    """Restore current channel inputs from the last committed, trusted snapshot."""
    write_extraction_policy(root)
    manifest = read_json(root / "database/manifest.json", {})
    snapshot = manifest.get("snapshot", "")
    if not re.fullmatch(r"snapshots/[a-f0-9]{24}", snapshot):
        return
    history = migrate_bundle_types(read_json(root / "database" / snapshot / "history.json", {}))
    observations_path = root / "internal/cache/history/releases.json"
    if not observations_path.exists():
        observations = read_json(root / "database" / snapshot / "releases.json", {})
        observations_path.parent.mkdir(parents=True, exist_ok=True)
        observations_path.write_bytes(encoded(observations))
    availability = read_json(root / "database" / snapshot / "availability.json", {})
    missing_channels = {
        (row["source_id"], row["channel"])
        for row in availability.get("missing", [])
        if row.get("reason") == "no_release"
    }
    inventory = read_json(root / "config/sources.json", {})
    if not isinstance(inventory, dict):
        return
    inventory = source_channels(inventory, root)
    cache = root / "internal/cache/bundles"
    discovery_path = cache / "discovery-status.json"
    discovery = read_json(discovery_path, {})
    for key, settings in inventory.items():
        if not isinstance(settings, dict) or not isinstance(settings.get("patches"), str):
            continue
        source_id = digest(normalize_source(settings["patches"], root).lower().encode())[:16]
        channel = (
            "latest"
            if settings.get("latest")
            else "dev" if settings.get("prerelease") else "stable"
        )
        if (source_id, channel) in missing_channels:
            discovery.setdefault(key, "no_matching_release")
        item = next(
            (
                item
                for item in history.values()
                if item["bundle"]["source_id"] == source_id
                and channel in item["bundle"]["channels"]
            ),
            None,
        )
        if item is None:
            continue
        base = re.sub(r"-(latest|stable|dev)$", "", key)
        folder = cache / f"{base}-patch-bundles"
        raw_path = folder / f"{key}-patches-bundle.json"
        if raw_path.exists():
            continue
        bundle = item["bundle"]
        folder.mkdir(parents=True, exist_ok=True)
        if bundle["bundle_type"] == "ReVanced:v21":
            raw = {
                "patches": {"version": bundle["version"], "url": bundle["download_url"]},
                "integrations": bundle.get("integrations"),
                "provider_digest": bundle.get("provider_digest"),
                "created_at": bundle.get("created_at"),
                "description": bundle.get("description"),
                "signature_download_url": bundle.get("signature_download_url"),
                "is_prerelease": bundle.get("is_prerelease"),
                "bundle_type": bundle["bundle_type"],
            }
        else:
            raw = {
                field: bundle.get(field)
                for field in (
                    "version",
                    "download_url",
                    "provider_digest",
                    "signature_download_url",
                    "bundle_type",
                    "is_prerelease",
                    "created_at",
                    "description",
                )
            }
        raw_path.write_bytes(encoded(raw))
        patch_path = folder / f"{key}-patches-list.json"
        if isinstance(bundle["patch_metadata_version"], str):
            patch_path.write_bytes(
                encoded(
                    {
                        "version": bundle["patch_metadata_version"],
                        "patches": history_patch_inventory(item),
                        "metadata_schema_version": bundle.get("patch_metadata_schema_version", 0),
                    }
                )
            )
        status = {
            "version": bundle["version"],
            "download_url": bundle["download_url"],
            "status": bundle["extraction_status"],
            "runtime": bundle["patcher_runtime"],
            "reseam_bundle": bundle.get("reseam_bundle"),
            "provider_digest": bundle.get("extracted_provider_digest"),
            "file_hash": bundle["file_hash"],
            "attempted_at": bundle.get("patch_refresh_attempted_at"),
            "failure_fingerprint": bundle.get("patcher_failure_fingerprint"),
            "terminal": bundle.get("extraction_terminal", False),
            "bundle_type": bundle.get("bundle_type"),
            "runtime_config_hash": bundle.get("patcher_failure_config_hash"),
            "parser_revision": bundle.get("patcher_parser_revision"),
            "completeness_version": bundle.get("patch_completeness_version", 0),
            "runtime_attempts": bundle.get("runtime_attempts", []),
            "patch_list_hash": (
                digest(patch_path.read_bytes()) if bundle["metadata_status"] == "verified" else None
            ),
        }
        (folder / f"{key}-extraction.json").write_bytes(encoded(status))
        discovery.setdefault(key, bundle.get("release_status", "unverified"))
    if discovery:
        cache.mkdir(parents=True, exist_ok=True)
        discovery_path.write_bytes(encoded(discovery))
    try:
        from scripts.historical_cache import restore_history
    except ModuleNotFoundError:
        from historical_cache import restore_history
    catalog_sources = read_json(root / "database" / snapshot / "sources.json", [])
    active_urls = {
        normalize_source(item["patches"], root).lower()
        for item in inventory.values()
        if isinstance(item, dict) and item.get("patches")
    }
    restore_history(
        root,
        history,
        {item["id"]: item for item in catalog_sources if item["url"].lower() in active_urls},
    )
    write_extraction_policy(root)


def stable_refresh_attempts(output, previous_path, bundles, summaries):
    """Keep published refresh-attempt times when nothing else in a bundle changed.

    Every run records new extraction attempts. history.json keeps the fresh time for
    the pipeline, but rewriting unchanged public bundle files made each publication
    upload and verify about a thousand objects. D1 records already apply this rule.
    """
    field = "patch_refresh_attempted_at"
    if not re.fullmatch(r"snapshots/[a-f0-9]{24}", previous_path or ""):
        return bundles
    # Detail files equal their bundles.json summary without detail_file. The
    # summary index is part of every run's restored refresh inputs.
    published = {
        row["id"]: row
        for row in read_json(output / previous_path / "bundles.json", [])
        if isinstance(row, dict) and isinstance(row.get("id"), str)
    }
    summary_rows = {row["id"]: row for row in summaries}

    def without(row, *extra):
        return {key: value for key, value in row.items() if key not in (field, *extra)}

    result = {}
    for key, bundle in bundles.items():
        result[key] = bundle
        old = published.get(key)
        if old is None or old.get(field) == bundle.get(field):
            continue
        if without(old, "detail_file") != without(bundle):
            continue
        # Copy, so history.json still records the fresh attempt time.
        stable = without(bundle)
        if field in old:
            stable[field] = old[field]
        result[key] = stable
        if key in summary_rows:
            summary_rows[key].pop(field, None)
            if field in old:
                summary_rows[key][field] = old[field]
    return result


def build_database(root=ROOT, *, restore=True):
    try:
        from scripts.source_cleanup import clean_inputs, clean_snapshots
    except ModuleNotFoundError:
        from source_cleanup import clean_inputs, clean_snapshots
    clean_inputs(root)
    if restore:
        restore_catalog_cache(root)
    config = read_json(root / "config/site.json")
    inventory = read_json(root / "config/sources.json")
    if not isinstance(inventory, dict) or not config:
        raise ValueError("Source inventory and site configuration are required")
    inventory = source_channels(inventory, root)
    output = root / "database"
    previous = read_json(output / "manifest.json", {})
    previous_path = previous.get("snapshot", "")
    history = {}
    if re.fullmatch(r"snapshots/[a-f0-9]{24}", previous_path):
        history = migrate_bundle_types(read_json(output / previous_path / "history.json", {}))
    disabled = disabled_sources(inventory, root)
    unavailable = unavailable_sources(inventory, root)
    configured_urls = {
        normalize_source(item["patches"], root).lower()
        for item in inventory.values()
        if isinstance(item, dict) and item.get("patches")
    }
    observations = read_json(root / "internal/cache/history/releases.json", {})
    observations = {
        url: versions for url, versions in observations.items() if url in configured_urls
    }
    historical_inventory = read_json(root / "internal/cache/history/sources.json", {})
    inventory = {
        **inventory,
        **{
            key: item
            for key, item in historical_inventory.items()
            if normalize_source(item["patches"], root).lower() in configured_urls
        },
    }
    sources, bundles, details = {}, {}, {}
    detail_ranks = {}
    input_bundles = set()
    historical_inputs = set()
    missing, retired = [], []
    run = read_json(root / "internal/cache/bundle-run-metadata.json", {}).get("bundles", {})
    discovery = read_json(root / "internal/cache/bundles/discovery-status.json", {})
    repository_metadata = read_json(root / "database/repository-metadata.json", {})
    for key, settings in sorted(inventory.items()):
        if not isinstance(settings, dict) or not isinstance(settings.get("patches"), str):
            continue
        url = normalize_source(settings["patches"], root)
        source_id = digest(url.lower().encode())[:16]
        base = settings.get("alias") or re.sub(r"-(latest|stable|dev)$", "", key)
        channel = (
            "latest"
            if settings.get("latest")
            else ("dev" if settings.get("prerelease") else "stable")
        )
        parsed = urlparse(url)
        namespace, repo = parsed.path.strip("/").rsplit("/", 1)
        source = sources.setdefault(
            source_id,
            {
                "id": source_id,
                "url": url,
                "host": parsed.hostname,
                "enabled": url.lower() not in disabled,
                "unavailable_reason": unavailable.get(url.lower()),
                "namespace": namespace,
                "repo": repo,
                "aliases": [],
                "bundles": [],
                "source_metadatum": {
                    "owner_name": namespace,
                    "repo_name": repo,
                    "owner_avatar_url": None,
                    "bundle_icon_url": None,
                    "repo_description": None,
                    "repo_stars": None,
                    "repo_pushed_at": None,
                    "is_repo_archived": None,
                },
            },
        )
        enriched = repository_metadata.get(url.lower(), {}).get("source_metadatum")
        if isinstance(enriched, dict):
            source["source_metadatum"].update(
                {key: value for key, value in enriched.items() if key in source["source_metadatum"]}
            )
        if base not in source["aliases"]:
            source["aliases"].append(base)
        if not source["enabled"]:
            continue
        relative = f"internal/cache/bundles/{base}-patch-bundles/{key}-patches-bundle.json"
        if settings.get("historical"):
            relative = settings["cache_path"]
            resolved = (root / relative).resolve()
            if not resolved.is_relative_to((root / "internal/cache/history").resolve()):
                raise ValueError("Historical input escaped cache directory")
        path = root / relative
        raw = read_json(path)
        patch_path = path.with_name(f"{key}-patches-list.json")
        patches = read_json(patch_path, {})
        if not isinstance(patches, dict):
            patches = {}
        status = read_json(path.with_name(f"{key}-extraction.json"), {})
        if not isinstance(status, dict):
            status = {}
        if not settings.get("historical") and discovery.get(key) == "no_matching_release":
            missing.append({"source_id": source_id, "channel": channel, "reason": "no_release"})
            continue
        if not isinstance(raw, dict):
            missing.append({"source_id": source_id, "channel": channel, "reason": "missing_bundle"})
            continue
        modern = "download_url" in raw
        artifact = raw if modern else raw.get("patches", {})
        if not isinstance(artifact, dict):
            missing.append({"source_id": source_id, "channel": channel, "reason": "invalid_bundle"})
            continue
        version = artifact.get("version")
        if not reconcile_release(raw, url, observations):
            continue
        if (
            url.lower() in observations
            and not settings.get("historical")
            and channel != "latest"
            and raw["is_prerelease"] != (channel == "dev")
        ):
            missing.append({"source_id": source_id, "channel": channel, "reason": "no_release"})
            continue
        download = artifact.get("download_url" if modern else "url")
        if (
            not version
            or not download
            or str(version).startswith("N/A")
            or str(download).startswith("N/A")
        ):
            missing.append({"source_id": source_id, "channel": channel, "reason": "no_release"})
            continue
        if auxiliary_bundle({"url": download}):
            missing.append(
                {"source_id": source_id, "channel": channel, "reason": "non_runtime_asset"}
            )
            continue
        if status.get("version") != version or status.get("download_url") != download:
            status = {}
        prior_release = next(
            (
                item["bundle"]
                for item in history.values()
                if item["bundle"]["source_id"] == source_id and item["bundle"]["version"] == version
            ),
            {},
        )
        file_hash = status.get("file_hash")
        identity = digest(
            encoded(
                [
                    source_id,
                    version,
                    download,
                    file_hash,
                    raw.get("provider_digest"),
                    raw.get("bundle_type"),
                ]
            )
        )[:24]
        input_bundles.add(identity)
        if settings.get("historical"):
            historical_inputs.add(identity)
        patch_array = patches.get("patches") if isinstance(patches, dict) else None
        valid = (
            isinstance(patch_array, list)
            and (bool(patch_array) or isinstance(patches.get("version"), str))
            and all(
                isinstance(p, dict) and (p.get("name") is None or isinstance(p["name"], str))
                for p in patch_array
            )
        )
        same_version = isinstance(patches, dict) and patches.get("version") == version
        family = canonical_bundle_type(raw.get("bundle_type")) or (
            "Reseam"
            if urlparse(download).path.lower().endswith(".reseam")
            else (
                "Morphe:V1"
                if urlparse(download).path.lower().endswith(".mpp")
                else ("ReVanced:v22" if modern else "ReVanced:v21")
            )
        )
        if family not in {"Morphe:V1", "ReVanced:v22", "ReVanced:v21", "Reseam"}:
            raise ValueError("Unsupported bundle type: " + str(family))
        # Older extraction could overwrite repeated compatibility entries.
        # Keep its list readable, but re-extract before trusting its compatibility.
        schema_current = patches.get("metadata_schema_version") == PATCH_METADATA_SCHEMA_VERSION
        proof = bool(
            valid
            and same_version
            and schema_current
            and patch_completeness_current(
                family, len(patch_array), status.get("completeness_version", 0), patch_array
            )
            and status.get("status") == "verified"
            and status.get("download_url") == download
            and status.get("version") == version
            and file_hash
            and digest_matches(raw.get("provider_digest"), file_hash, status.get("provider_digest"))
            and status.get("patch_list_hash") == digest(patch_path.read_bytes())
        )
        freshness = (
            "verified"
            if proof
            else ("stale" if valid and not same_version else "unverified" if valid else "missing")
        )
        paused = not proof and paused_failure(root, status, raw, family)
        bundle = bundles.setdefault(
            identity,
            {
                "id": identity,
                "source_id": source_id,
                "bundle_type": family,
                "release_status": discovery.get(key, "unverified"),
                "ecosystem": family.split(":")[0].lower(),
                "version": version,
                "created_at": raw.get("created_at"),
                "description": raw.get("description") or "",
                "download_url": download,
                "signature_download_url": raw.get("signature_download_url"),
                "integrations": raw.get("integrations"),
                "file_hash": file_hash,
                "provider_digest": raw.get("provider_digest"),
                "extracted_provider_digest": status.get("provider_digest"),
                "channels": [],
                "import_urls": {},
                "is_prerelease": run.get(key, {}).get(
                    "is_prerelease",
                    raw.get(
                        "is_prerelease",
                        history.get(identity, {})
                        .get("bundle", {})
                        .get(
                            "is_prerelease",
                            channel == "dev" or release_is_prerelease({"tag_name": version}),
                        ),
                    ),
                ),
                "is_latest": False,
                "metadata_status": freshness,
                "need_patches_update": not (proof or paused),
                "extraction_terminal": paused,
                "patcher_failure_config_hash": status.get("runtime_config_hash"),
                "patcher_parser_revision": status.get("parser_revision"),
                "patch_completeness_version": status.get("completeness_version", 0),
                "runtime_attempts": status.get("runtime_attempts", []),
                "patch_list_available": valid,
                "patch_metadata_version": patches.get("version"),
                "patch_metadata_schema_version": patches.get("metadata_schema_version", 0),
                "patcher_runtime": status.get("runtime"),
                "reseam_bundle": status.get("reseam_bundle"),
                "extraction_status": status.get("status", "unverified"),
                "patch_refresh_attempted_at": status.get("attempted_at"),
                "patcher_failure_fingerprint": status.get("failure_fingerprint"),
                "patch_count": len(patch_array) if proof else 0,
                "packages": [],
                "release_url": run.get(key, {}).get("patches", {}).get("release_url")
                or prior_release.get("release_url"),
            },
        )
        if url.lower() in observations:
            bundle["is_prerelease"] = raw["is_prerelease"]
        if timestamp_rank(status.get("attempted_at")) > timestamp_rank(
            bundle["patch_refresh_attempted_at"]
        ):
            bundle["patch_refresh_attempted_at"] = status["attempted_at"]
            if bundle["metadata_status"] != "verified":
                bundle.update(
                    extraction_status=status.get("status", "unverified"),
                    extracted_provider_digest=status.get("provider_digest"),
                    patcher_runtime=status.get("runtime"),
                    reseam_bundle=status.get("reseam_bundle"),
                    extraction_terminal=paused,
                    patcher_failure_fingerprint=status.get("failure_fingerprint"),
                    patcher_failure_config_hash=status.get("runtime_config_hash"),
                    patcher_parser_revision=status.get("parser_revision"),
                    patch_completeness_version=status.get("completeness_version", 0),
                    runtime_attempts=status.get("runtime_attempts", []),
                    need_patches_update=not (proof or paused),
                )
        detail_rank = (
            proof,
            same_version,
            timestamp_rank(status.get("attempted_at")),
            not settings.get("historical"),
        )
        preferred_metadata = valid and (
            identity not in detail_ranks or detail_rank >= detail_ranks[identity]
        )
        preferred_proof = proof and preferred_metadata
        if preferred_metadata:
            bundle.update(
                metadata_status=freshness,
                patch_metadata_version=patches.get("version"),
                patch_metadata_schema_version=patches.get("metadata_schema_version", 0),
                patch_list_available=True,
                patch_count=len(patch_array) if proof else 0,
            )
        if preferred_proof:
            bundle.update(
                metadata_status="verified",
                need_patches_update=False,
                extraction_terminal=False,
                patcher_failure_fingerprint=None,
                patch_count=len(patch_array),
                patcher_runtime=status.get("runtime"),
                reseam_bundle=status.get("reseam_bundle"),
                extracted_provider_digest=status.get("provider_digest"),
                extraction_status=status.get("status"),
                patch_metadata_version=patches.get("version"),
                patch_metadata_schema_version=patches.get("metadata_schema_version", 0),
                patch_list_available=True,
            )
        if not settings.get("historical"):
            # History may be visited first and carry an old integration APK.
            # Current channel metadata also takes precedence when it removes it.
            bundle["integrations"] = raw.get("integrations")
            if channel not in bundle["channels"]:
                bundle["channels"].append(channel)
            bundle["import_urls"][channel] = (
                config["api"].rstrip("/")
                + ("/api/reseam/bundle?" if family == "Reseam" else "/api/v3/bundle?")
                + urlencode(
                    {
                        "source_url": url,
                        "version": "latest",
                        "channel": {"latest": "any", "stable": "stable", "dev": "prerelease"}[
                            channel
                        ],
                    }
                )
            )
            if channel == "stable":
                bundle["is_prerelease"] = False
        if identity not in source["bundles"]:
            source["bundles"].append(identity)
        if preferred_metadata:
            detail_ranks[identity] = detail_rank
            details[identity] = patch_array
            bundle["packages"] = sorted(
                {p["name"] for patch in patch_array for p in packages_for(patch)}
            )
        elif identity not in details:
            details[identity] = patch_array if valid else []
            if valid:
                bundle["packages"] = sorted(
                    {p["name"] for patch in patch_array for p in packages_for(patch)}
                )
    for identity, item in history.items():
        if item["bundle"]["source_id"] not in sources:
            continue
        bundle = item["bundle"].copy()
        if auxiliary_bundle({"url": bundle.get("download_url", "")}):
            retired.append(identity)
            continue
        if not reconcile_release(bundle, sources[bundle["source_id"]]["url"], observations):
            retired.append(identity)
            continue
        if identity not in bundles:
            if sources[bundle["source_id"]]["enabled"]:
                bundle.update(channels=[], is_latest=False, import_urls={})
            bundles[identity], details[identity] = bundle, history_patch_inventory(item)
            sources[bundle["source_id"]]["bundles"].append(identity)

    # Upstream upserts one record per source/version/release category. Keep the
    # previously published ID while replacing its artifact and extraction proof.
    groups = {}
    for key, bundle in bundles.items():
        group = (bundle["source_id"], bundle["version"], bool(bundle["is_prerelease"]))
        groups.setdefault(group, []).append(key)
    canonical, canonical_details, canonical_inputs = {}, {}, set()
    for keys in groups.values():
        # The historical registry contains the asset currently selected by
        # discovery, even if a channel still has an older extraction input.
        def asset(key):
            row = bundles[key]
            return (row["download_url"], row["bundle_type"], row.get("provider_digest"))

        selected_asset = max(
            keys,
            key=lambda key: (
                key in historical_inputs,
                key in input_bundles,
                "latest" in bundles[key]["channels"],
                bool(bundles[key]["channels"]),
            ),
        )
        candidates = [key for key in keys if asset(key) == asset(selected_asset)]

        def observed_rank(key):
            row = bundles[key]
            return (
                timestamp_rank(row.get("patch_refresh_attempted_at")),
                "latest" in row["channels"],
                bool(row["channels"]),
            )

        observed = [key for key in candidates if key in input_bundles and bundles[key]["file_hash"]]
        if observed:
            # A successful download establishes which binary is at this URL,
            # even when parsing it fails. Old proof applies only to that hash.
            observed_hash = bundles[max(observed, key=observed_rank)]["file_hash"]
            candidates = [key for key in candidates if bundles[key]["file_hash"] == observed_hash]
        selected = max(
            candidates,
            key=lambda key: (
                key in input_bundles,
                bundles[key]["metadata_status"] == "verified",
                "latest" in bundles[key]["channels"],
                bool(bundles[key]["channels"]),
            ),
        )
        previous_keys = [key for key in keys if key in history]
        retained = (
            max(
                previous_keys,
                key=lambda key: (
                    bool(history[key]["bundle"].get("is_latest")),
                    bool(history[key]["bundle"].get("channels")),
                    history[key]["bundle"]["metadata_status"] == "verified",
                ),
            )
            if previous_keys
            else selected
        )
        bundle = bundles[selected].copy()
        # Integrations are channel metadata, independent of which cache supplied
        # the selected binary's extraction proof.
        current = [
            key
            for key in keys
            if key in input_bundles
            and bundles[key]["channels"]
            and asset(key) == asset(selected_asset)
        ]
        if current:
            bundle["integrations"] = bundles[max(current, key=observed_rank)]["integrations"]
        bundle["id"] = retained
        bundle["channels"] = sorted(
            {channel for key in keys for channel in bundles[key]["channels"]}
        )
        bundle["import_urls"] = {
            channel: url for key in keys for channel, url in bundles[key]["import_urls"].items()
        }
        canonical[retained] = bundle
        canonical_details[retained] = details.get(selected, [])
        if selected in input_bundles:
            canonical_inputs.add(retained)
    bundles, details, input_bundles = canonical, canonical_details, canonical_inputs
    for source in sources.values():
        source["bundles"] = [
            key for key, bundle in bundles.items() if bundle["source_id"] == source["id"]
        ]

    # History can survive without a restored extraction input. Runtime changes
    # must still make its paused failures eligible in the published catalog.
    for bundle in bundles.values():
        if (
            bundle["metadata_status"] == "verified"
            and (
                bundle.get("patch_metadata_schema_version") != PATCH_METADATA_SCHEMA_VERSION
                or not patch_completeness_current(
                    bundle["bundle_type"],
                    bundle["patch_count"],
                    bundle.get("patch_completeness_version", 0),
                    details.get(bundle["id"], []),
                )
            )
        ):
            bundle.update(metadata_status="unverified", patch_count=0, need_patches_update=True)
        if bundle.get("extraction_terminal"):
            status = {
                "terminal": True,
                "status": bundle["extraction_status"],
                "file_hash": bundle["file_hash"],
                "bundle_type": bundle["bundle_type"],
                "provider_digest": bundle.get("extracted_provider_digest"),
                "failure_fingerprint": bundle.get("patcher_failure_fingerprint"),
                "runtime_config_hash": bundle.get("patcher_failure_config_hash"),
                "parser_revision": bundle.get("patcher_parser_revision"),
                "completeness_version": bundle.get("patch_completeness_version", 0),
                "runtime_attempts": bundle.get("runtime_attempts", []),
            }
            if not paused_failure(root, status, bundle, bundle["bundle_type"]):
                bundle.update(extraction_terminal=False, need_patches_update=True)

    # Upstream ranks releases separately for stable and prerelease, across
    # formats. Channel pointers continue to reflect their configured choices.
    def release_time(bundle):
        try:
            parsed = datetime.fromisoformat(str(bundle.get("created_at")).replace("Z", "+00:00"))
            return (
                parsed.replace(tzinfo=UTC).timestamp()
                if parsed.tzinfo is None
                else parsed.timestamp()
            )
        except (TypeError, ValueError, OverflowError):
            return float("-inf")

    def latest_rank(bundle):
        # Fresh runners restore all retained assets. Keep the published choice
        # on ties, unless discovery supplied a replacement input this run.
        return (
            release_time(bundle),
            bool(bundle["channels"]),
            bundle["id"] in input_bundles,
            bool(history.get(bundle["id"], {}).get("bundle", {}).get("is_latest")),
        )

    newest = {}
    for bundle in bundles.values():
        if not sources[bundle["source_id"]]["enabled"]:
            continue
        bundle["is_latest"] = False
        category = (bundle["source_id"], bool(bundle["is_prerelease"]))
        current = newest.get(category)
        if current is None or latest_rank(bundle) > latest_rank(current):
            newest[category] = bundle
    for bundle in newest.values():
        bundle["is_latest"] = True
    # Keep internal dependency helper metadata in private history/checkpoints, not
    # public patch counts, search results, or app compatibility indexes.
    internal_details, public_positions = {}, {}
    for identity, bundle in bundles.items():
        inventory = details.get(identity, [])
        internal_details[identity] = [
            patch for patch in inventory if is_internal_patch(patch)
        ]
        public_positions[identity] = [
            position for position, patch in enumerate(inventory)
            if not is_internal_patch(patch)
        ]
        public = [inventory[position] for position in public_positions[identity]]
        bundle["packages"] = sorted(
            {package["name"] for patch in public for package in packages_for(patch)}
        )
        if bundle["metadata_status"] == "verified":
            bundle["patch_count"] = len(public)

    identifiers = read_json(output / "ids.json", {})
    next_ids = {table: max(mapping.values(), default=0) for table, mapping in identifiers.items()}

    def numeric_id(table, key):
        mapping = identifiers.setdefault(table, {})
        if key not in mapping:
            next_ids[table] = next_ids.get(table, 0) + 1
            mapping[key] = next_ids[table]
        return mapping[key]

    for source in sorted(sources.values(), key=lambda item: item["id"]):
        source["legacy_id"] = numeric_id("source", source["id"])
        source["source_metadatum"].update(
            id=numeric_id("source_metadata", source["id"]), source_fk=source["legacy_id"]
        )
    for bundle in sorted(bundles.values(), key=lambda item: item["id"]):
        if bundle["bundle_type"] != "Reseam":
            bundle.pop("reseam_bundle", None)
        bundle["legacy_id"] = numeric_id("bundle", bundle["id"])
    summaries = []
    for bundle in bundles.values():
        files_name = f"bundles/{bundle['id']}.json"
        # Predicates, text extrema and stream cursors use this shared index.
        # Keep the same description as the detail response for SQL comparisons.
        summary = {**bundle, "detail_file": files_name}
        summaries.append(summary)
    files = {
        "sources.json": list(sources.values()),
        "bundles.json": summaries,
        "releases.json": observations,
    }
    # Load changelog history without transferring release notes or patch compatibility.
    changelog_fields = (
        "id",
        "source_id",
        "version",
        "bundle_type",
        "created_at",
        "is_prerelease",
        "patch_list_available",
        "metadata_status",
    )
    files["changelogs.json"] = {
        "columns": changelog_fields,
        "rows": [
            [bundle.get(field) for field in changelog_fields]
            for bundle in summaries
            if sources[bundle["source_id"]]["enabled"]
            and bundle.get("availability") != "unavailable"
            and (bundle.get("description") or "").strip()
        ],
    }
    # GraphQL scans scalar bundle fields without downloading the growing
    # release descriptions or repeating object keys thousands of times.
    # Keep the full text separately for description filters and projections.
    graphql_columns = (
        "id",
        "legacy_id",
        "source_id",
        "bundle_type",
        "ecosystem",
        "version",
        "created_at",
        "download_url",
        "signature_download_url",
        "file_hash",
        "icon_url",
        "owner_avatar_url",
        "is_prerelease",
        "is_latest",
        "need_patches_update",
        "patcher_failure_fingerprint",
        "metadata_status",
        "patcher_runtime",
        "extraction_status",
        "patch_count",
        "release_status",
        "channels",
        "import_urls",
        "release_url",
    )
    files["graphql-bundles.json"] = {
        "columns": graphql_columns,
        "rows": [[bundle.get(column) for column in graphql_columns] for bundle in summaries],
    }
    files["graphql-bundle-descriptions.json"] = {
        bundle["id"]: bundle.get("description") for bundle in summaries
    }
    # The complete description index is needed for SQL-style comparisons,
    # while projected bundle descriptions can read only a small shard.
    for bundle in summaries:
        shard = int(bundle["legacy_id"]) // 400
        files.setdefault(f"graphql-descriptions/{shard}.json", {})[bundle["id"]] = bundle.get(
            "description"
        )
    # App lookups need release selectors, not every historical changelog.
    app_bundle_fields = (
        "id",
        "source_id",
        "version",
        "bundle_type",
        "ecosystem",
        "created_at",
        "is_latest",
        "is_prerelease",
        "channels",
        "metadata_status",
        "patch_count",
        "packages",
        "detail_file",
    )
    files["app-bundles.json"] = [
        {field: bundle[field] for field in app_bundle_fields} for bundle in summaries
    ]
    # Manager imports need one source's release selection, not the global history.
    import_fields = (
        "id",
        "source_id",
        "bundle_type",
        "version",
        "created_at",
        "is_latest",
        "is_prerelease",
        "channels",
    )
    for source in sources.values():
        files[f"imports/{source['id']}.json"] = [
            {field: bundles[key][field] for field in import_fields}
            for key in source["bundles"]
            if key in bundles
        ]
    published_details = stable_refresh_attempts(output, previous_path, bundles, summaries)
    files.update({f"bundles/{key}.json": value for key, value in published_details.items()})
    index = {"packages": {}, "bundles": {}, "patch_ids": {}, "pages": []}
    # Two-character buckets prevent common trigrams from creating multi-MB
    # index files, while retaining deterministic shard lookup.
    search = {f"{first}-{second}": {} for first in range(16) for second in range(16)}
    short_search = {}
    unicode_text = {}
    package_page_counts = {}
    patch_name_ids = {}
    app_versions, rows = {}, []
    for identity, patches in sorted(details.items()):
        for position, patch in enumerate(patches):
            if is_internal_patch(patch):
                continue
            packages = packages_for(patch)
            rows.append(
                {
                    **patch,
                    "name": patch.get("name"),
                    "hidden": patch.get("hidden", False),
                    "id": f"{identity}:{position}",
                    "legacy_id": numeric_id("patch", f"{identity}:{position}"),
                    "bundle_id": identity,
                    "source_id": bundles[identity]["source_id"],
                    "packages": packages,
                    "metadata_status": bundles[identity]["metadata_status"],
                    "patch_metadata_version": bundles[identity]["patch_metadata_version"],
                }
            )
            for package in packages:
                app_versions.setdefault(package["name"], set()).update(
                    str(v) for v in package["versions"]
                )
    package_records = {}
    for row in rows:
        for package in row["packages"]:
            for version in package["versions"] or [None]:
                key = json.dumps([package["name"], version], separators=(",", ":"))
                package_records[key] = {
                    "id": numeric_id("package", key),
                    "name": package["name"],
                    "version": version,
                }
    files["package-records.json"] = sorted(package_records.values(), key=lambda item: item["id"])
    # Public indexes contain only published entities. The private root registry
    # retains numeric reservations so deleted IDs cannot be reassigned.
    public_id_keys = {
        "source": set(sources),
        "source_metadata": set(sources),
        "bundle": set(bundles),
        "patch": {row["id"] for row in rows},
        "package": set(package_records),
    }
    files["ids.json"] = {
        table: {key: value for key, value in mapping.items() if key in public_id_keys[table]}
        for table, mapping in identifiers.items()
        if table in public_id_keys
    }
    run_metadata = read_json(root / "internal/cache/bundle-run-metadata.json", {})
    prior_jobs = (
        read_json(output / previous_path / "refresh-jobs.json", []) if previous_path else []
    )
    timestamp = run_metadata.get("generated_at")
    progress = read_json(root / "internal/cache/refresh-jobs.json", [])
    jobs = prior_jobs
    if timestamp and not progress:
        job_id = digest(timestamp.encode())[:24]
        jobs = [item for item in jobs if item["job_id"] != job_id]
        jobs.append(
            {
                "id": numeric_id("refresh_jobs", job_id),
                "job_id": job_id,
                "job_type": "BUNDLES",
                "status": run_metadata.get("status", "COMPLETED"),
                "started_at": run_metadata.get("started_at", timestamp),
                "completed_at": timestamp,
                "error": run_metadata.get("error"),
            }
        )
    by_id = {row["job_id"]: row for row in jobs}
    for row in progress:
        by_id[row["job_id"]] = {**row, "id": numeric_id("refresh_jobs", row["job_id"])}
    files["refresh-jobs.json"] = [
        {**row, "status": "STARTED" if row["status"] in {"PENDING", "RUNNING"} else row["status"]}
        for row in by_id.values()
    ]
    rows.sort(key=lambda row: row["legacy_id"])
    try:
        from scripts.catalog_statistics import patch_statistics
    except ModuleNotFoundError:
        from catalog_statistics import patch_statistics
    public_bundles = {
        key: value for key, value in bundles.items() if sources[value["source_id"]]["enabled"]
    }
    try:
        from scripts.app_catalog import build_apps
    except ModuleNotFoundError:
        from app_catalog import build_apps
    app_metadata = read_json(output / "app-metadata.json", {})
    app_metadata["overrides"] = read_json(root / "config/apps.json", {})
    applications = build_apps(rows, public_bundles, app_metadata)
    files["apps.json"] = applications
    application_lookup = {app["package_name"]: app for app in applications}
    bundle_apps = {key: [] for key in bundles}
    for app in applications:
        for association in app["bundles"]:
            bundle_apps[association["bundle_id"]].append(
                {
                    **{
                        key: app[key]
                        for key in ("package_name", "app_name", "icon_url", "metadata_source")
                    },
                    **association,
                }
            )
    files.update({f"bundle-apps/{key}.json": value for key, value in bundle_apps.items()})
    for row in rows:
        for package in row["packages"]:
            app = application_lookup.get(package["name"], {})
            package.update(
                app_name=app.get("app_name", package["name"]), icon_url=app.get("icon_url")
            )
    for record in package_records.values():
        app = application_lookup.get(record["name"], {})
        record.update(app_name=app.get("app_name", record["name"]), icon_url=app.get("icon_url"))
    files["patch-statistics.json"] = patch_statistics(
        [row for row in rows if row["bundle_id"] in public_bundles],
        public_bundles,
        config.get("postgres_locale", "en_US.utf8"),
    )
    page_size = config.get("page_size", 100)
    for start in range(0, len(rows), page_size):
        page_id = f"patches/{start // page_size:05d}.json"
        page = rows[start : start + page_size]
        files[page_id] = page
        index["pages"].append(page_id)
        for row in page:
            if row["bundle_id"] in public_bundles:
                index["patch_ids"][str(row["legacy_id"])] = [page_id]
                # SQL name = '' cannot match NULL. Keep the two apart before
                # paginating exact-name lookups by their posting lists.
                if row.get("name") is not None:
                    patch_name_ids.setdefault(row["name"], []).append(row["legacy_id"])
            index["bundles"].setdefault(row["bundle_id"], set()).add(page_id)
            for package_name in {package["name"] for package in row["packages"]}:
                index["packages"].setdefault(package_name, set()).add(page_id)
                counts = package_page_counts.setdefault(package_name, {})
                counts.setdefault(page_id, 0)
                if row["bundle_id"] in public_bundles:
                    counts[page_id] += 1
            # Disabled sources cannot produce public search results. Exclude
            # their postings so GraphQL does not exhaust shard reads before
            # finding an enabled match on a later page.
            if row["bundle_id"] in public_bundles:
                original_text = (row.get("name") or "") + " " + (row.get("description") or "")
                # Preserve original text so the Worker can use its own Unicode
                # lowercase tables to find matching pages before loading them.
                if any(ord(char) > 127 for char in original_text):
                    unicode_text.setdefault(page_id, []).append(original_text)
                for gram in grams(original_text):
                    search[f"{ord(gram[0]) % 16}-{ord(gram[1]) % 16}"].setdefault(gram, set()).add(
                        page_id
                    )
                text = ((row.get("name") or "") + " " + (row.get("description") or "")).lower()
                for char in set(text):
                    short_search.setdefault(f"1-{ord(char) % 16}", {}).setdefault(char, set()).add(
                        page_id
                    )
                for position in range(len(text) - 1):
                    gram = text[position : position + 2]
                    short_search.setdefault(
                        f"2-{ord(gram[0]) % 16}-{ord(gram[1]) % 16}", {}
                    ).setdefault(gram, set()).add(page_id)
    for bucket, values in search.items():
        files[f"search-v2/{bucket}.json"] = {
            key: sorted(value) for key, value in sorted(values.items())
        }
    for bucket, values in short_search.items():
        files[f"search-short/{bucket}.json"] = {
            key: sorted(value) for key, value in sorted(values.items())
        }
    unicode_search = {f"{first}-{second}": {} for first in range(16) for second in range(16)}
    unicode_short = {}
    for page_id, texts in javascript_lower_texts(unicode_text).items():
        for text in texts:
            characters = list(text)
            for position in range(len(characters) - 2):
                gram = "".join(characters[position : position + 3])
                unicode_search[f"{ord(gram[0]) % 16}-{ord(gram[1]) % 16}"].setdefault(
                    gram, set()
                ).add(page_id)
            for char in set(characters):
                unicode_short.setdefault(f"1-{ord(char) % 16}", {}).setdefault(char, set()).add(
                    page_id
                )
            for position in range(len(characters) - 1):
                gram = "".join(characters[position : position + 2])
                unicode_short.setdefault(
                    f"2-{ord(gram[0]) % 16}-{ord(gram[1]) % 16}", {}
                ).setdefault(gram, set()).add(page_id)
    for bucket, values in unicode_search.items():
        files[f"search-unicode-v2/{bucket}.json"] = {
            key: sorted(value) for key, value in sorted(values.items())
        }
    for bucket, values in unicode_short.items():
        files[f"search-unicode-short/{bucket}.json"] = {
            key: sorted(value) for key, value in sorted(values.items())
        }
    for group in ("packages", "bundles"):
        index[group] = {key: sorted(value) for key, value in sorted(index[group].items())}
    # A query scoped to specific bundles needs only their patch-page locations.
    # The full index also contains patch IDs, packages, and search data.
    files["patch-bundle-index.json"] = index["bundles"]
    files["patch-package-counts.json"] = package_page_counts
    files["patch-name-ids.json"] = patch_name_ids
    files["patch-index.json"] = index
    files["packages.json"] = [
        {
            "name": name,
            "versions": sorted(versions),
            "app_name": application_lookup.get(name, {}).get("app_name", name),
            "icon_url": application_lookup.get(name, {}).get("icon_url"),
        }
        for name, versions in sorted(app_versions.items())
    ]
    files["history.json"] = {
        key: {"bundle": value,
              "patches": [details[key][position] for position in public_positions[key]],
              "internal_patches": internal_details.get(key, []),
              "patch_positions": public_positions[key]}
        for key, value in bundles.items()
    }
    files["availability.json"] = {"missing": missing, "retired_history": retired}
    payloads = {
        name: (
            (
                json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"
            ).encode("utf-8")
            if name.startswith(
                (
                    "graphql-",
                    "changelogs.json",
                    "search-v2/",
                    "search-short/",
                    "search-unicode-v2/",
                    "search-unicode-short/",
                    "patch-bundle-index.json",
                    "patch-package-counts.json",
                    "patch-name-ids.json",
                )
            )
            else encoded(value)
        )
        for name, value in files.items()
    }
    generation = digest(encoded({name: digest(value) for name, value in payloads.items()}))[:24]
    snapshot = f"snapshots/{generation}"
    target = output / snapshot
    target.mkdir(parents=True, exist_ok=True)
    for name, value in payloads.items():
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists() or destination.read_bytes() != value:
            destination.write_bytes(value)
    manifest = {
        "schema_version": 1,
        "generation": generation,
        "snapshot": snapshot,
        "files": {
            name: {"sha256": digest(value), "bytes": len(value)}
            for name, value in payloads.items()
            if name != "history.json"
        },
        "counts": {"sources": len(sources), "bundles": len(bundles), "patches": len(rows)},
    }
    # Retain the immutable Git anchor when a rebuild produces the same files.
    # New generations receive their anchor only after their snapshot is committed.
    reference = previous.get("snapshot_ref")
    if previous.get("generation") == generation and isinstance(reference, str):
        if re.fullmatch(r"[a-f0-9]{40}", reference):
            manifest["snapshot_ref"] = reference
    # Match build_site: only the legacy backend copies snapshot folders into Pages.
    plan = retention_plan(
        output, snapshot, previous_path, published=os.environ.get("CATALOG_BACKEND") != "d1"
    )
    ids_temp = output / "ids.tmp"
    ids_temp.write_bytes(encoded(identifiers))
    ids_temp.replace(output / "ids.json")
    temp = output / "manifest.tmp"
    temp.write_bytes(encoded(manifest))
    temp.replace(output / "manifest.json")
    apply_retention(output, plan)
    clean_snapshots(root)
    print(f"Catalog {generation}: {manifest['counts']}")
    return manifest


def version_site_assets(destination):
    """Keep HTML, styles and the full local module graph on the same release."""
    assets = sorted(
        path
        for path in destination.rglob("*")
        if path.is_file()
        and path.suffix in {".js", ".css", ".json"}
        and path.relative_to(destination).parts[0] != "database"
    )
    if not assets:
        return
    fingerprint = digest(
        encoded(
            [
                [path.relative_to(destination).as_posix(), digest(path.read_bytes())]
                for path in assets
            ]
        )
    )[:16]
    renamed = {path: path.with_name(f"{path.stem}.{fingerprint}{path.suffix}") for path in assets}
    documents = sorted(destination.rglob("*.html")) + [
        path for path in assets if path.suffix in {".js", ".css"}
    ]
    for document in documents:
        content = document.read_text(encoding="utf-8")
        for original, target in renamed.items():
            relative = os.path.relpath(original, document.parent).replace("\\", "/")
            replacement = os.path.relpath(target, document.parent).replace("\\", "/")
            for prefix in ("", "./"):
                for quote in ('"', "'"):
                    content = content.replace(
                        f"{quote}{prefix}{relative}{quote}",
                        f"{quote}{prefix}{replacement}{quote}",
                    )
        renamed.get(document, document).write_text(content, encoding="utf-8")
    # Cached pages from before asset versioning still request the stable URLs.
    # Keep aliases with the same rewritten contents as the versioned assets.
    for original, target in renamed.items():
        if original.suffix == ".json":
            shutil.copyfile(original, target)
        else:
            shutil.copyfile(target, original)


def build_site(root=ROOT):
    destination = root / "site-dist"
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(root / "web", destination)
    shutil.copytree(root / "shared", destination / "shared")
    output = root / "database"
    manifest = read_json(output / "manifest.json")
    public = destination / "database"
    public.mkdir()
    (public / "manifest.json").write_bytes(encoded(manifest))
    for snapshot in (
        []
        if os.environ.get("CATALOG_BACKEND") == "d1"
        else published_snapshots(output, manifest["snapshot"])
    ):
        shutil.copytree(
            snapshot,
            public / "snapshots" / snapshot.name,
            ignore=shutil.ignore_patterns("history.json"),
        )
    config = read_json(root / "config/site.json")
    if os.environ.get("CATALOG_BACKEND") == "d1":
        config["catalog_backend"] = "d1"
    (destination / "config.json").write_bytes(encoded(config))
    (destination / "config").mkdir(exist_ok=True)
    (destination / "config/git-hosts.json").write_bytes(encoded(hosts(root)))
    (destination / "CNAME").write_text(urlparse(config["website"]).hostname + "\n")
    (destination / ".nojekyll").touch()
    version_site_assets(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--site", action="store_true")
    parser.add_argument(
        "--prepare", action="store_true", help="Restore private extraction inputs only"
    )
    args = parser.parse_args()
    if args.prepare:
        restore_catalog_cache()
        raise SystemExit(0)
    build_database()
    if args.site:
        build_site()
