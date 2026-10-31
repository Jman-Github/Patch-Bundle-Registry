"""Cloudflare operations used by reviewed GitHub Actions; never called by ordinary tests."""

import argparse
import gzip
import hashlib
import json
import os
import re
import ssl
import time
from collections import Counter
from contextlib import contextmanager
from pathlib import Path

import httpx

from scripts.catalog_reconciliation import reconcile_retained_records
from scripts.catalog_records import catalog_records, encode, record_hash
from scripts.cloudflare_progress import Progress
from scripts.cloudflare_storage import (
    REFRESH_FILES,
    REFRESH_ROOT_FILES,
    BlobCache,
    R2Reader,
    pack_refresh,
    unpack_refresh,
)
from scripts.extraction_policy import is_internal_patch
from scripts.git_hosts import normalize_source
from scripts.refresh_issues import read_issues
from scripts.source_cleanup import clean_inputs, clean_snapshots, configured_sources, filter_records
from scripts.source_policy import disabled_sources, source_channels

ROOT = Path(__file__).resolve().parents[1]
D1_CLEANUP_BATCH_SIZE = 1000
D1_CLEANUP_SCAN_SIZE = 10_000
D1_WRITE_BATCH_SIZE = 1000


def merge_ids(*registries):
    merged = {}
    for registry in registries:
        if not isinstance(registry, dict):
            raise ValueError("Invalid catalog ID registry")
        for table, mapping in registry.items():
            if not isinstance(mapping, dict):
                raise ValueError("Invalid catalog ID mapping")
            target = merged.setdefault(table, {})
            owners = {value: key for key, value in target.items()}
            for key, value in mapping.items():
                if type(value) is not int or value < 1:
                    raise ValueError("Invalid catalog numeric ID")
                if (key in target and target[key] != value) or (
                    value in owners and owners[value] != key
                ):
                    raise ValueError("Catalog conflicts with published numeric IDs")
                target[key] = value
                owners[value] = key
    return merged


class Cloud:
    def __init__(self):
        import boto3
        from botocore.config import Config
        from botocore.exceptions import (
            ConnectionClosedError,
            ConnectTimeoutError,
            EndpointConnectionError,
            IncompleteReadError,
            ReadTimeoutError,
            ResponseStreamingError,
        )

        self.account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        self.database = os.environ.get("CATALOG_D1_ID")
        self.bucket = os.environ.get("CATALOG_R2_BUCKET") or "patch-bundle-registry"
        self.http = httpx.Client(
            base_url="https://api.cloudflare.com/client/v4/accounts/" + self.account,
            headers={"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]},
            timeout=60,
        )
        self.s3 = None
        self.s3_reads = None
        if os.environ.get("R2_ACCESS_KEY_ID"):
            options = {
                "endpoint_url": "https://" + self.account + ".r2.cloudflarestorage.com",
                "aws_access_key_id": os.environ["R2_ACCESS_KEY_ID"],
                "aws_secret_access_key": os.environ["R2_SECRET_ACCESS_KEY"],
                "region_name": "auto",
            }
            self.s3 = boto3.client(
                "s3",
                **options,
                config=Config(
                    retries={"max_attempts": 5, "mode": "standard"},
                    max_pool_connections=16,
                    connect_timeout=30,
                    read_timeout=60,
                ),
            )
            # Shared R2Reader policy must see failures before the SDK retries
            # them independently. Writes retain the normal SDK retry policy.
            self.s3_reads = boto3.client(
                "s3",
                **options,
                config=Config(
                    retries={"total_max_attempts": 1, "mode": "standard"},
                    max_pool_connections=4,
                    connect_timeout=30,
                    read_timeout=60,
                ),
            )
        self._r2_reader = R2Reader(
            self.read_object,
            workers=int(os.environ.get("CATALOG_R2_WORKERS") or "8"),
            transport_errors=(
                ConnectionClosedError,
                ConnectTimeoutError,
                EndpointConnectionError,
                IncompleteReadError,
                ReadTimeoutError,
                ResponseStreamingError,
            ),
        )

    def transfers(self):
        if not hasattr(self, "_transfers"):
            self._transfers = BlobCache(
                ROOT / "internal/r2-objects",
                self.get,
                self.put,
                workers=int(os.environ.get("CATALOG_R2_WORKERS") or "8"),
            )
        return self._transfers

    @contextmanager
    def phase(self, name):
        cache = self.transfers()
        before = dict(cache.metrics)
        progress = Progress(name)
        try:
            with progress:
                yield
        finally:
            result = {
                "phase": name,
                "status": progress.status,
                "elapsed_seconds": round(time.perf_counter() - progress.started, 3),
                "metrics": {
                    key: value - before.get(key, 0)
                    for key, value in cache.metrics.items()
                    if value != before.get(key, 0)
                },
            }
            self.publication_metrics = getattr(self, "publication_metrics", {})
            self.publication_metrics.setdefault("publication_phases", []).append(result)
            print(json.dumps({"cloudflare_phase": result}), flush=True)

    def report(self, operation, started):
        cache = self.transfers()
        cache.trim(int(os.environ.get("CATALOG_OBJECT_CACHE_BYTES") or str(1024**3)))
        metrics = {
            "operation": operation,
            "elapsed_seconds": round(time.perf_counter() - started, 3),
            **dict(cache.metrics),
            **getattr(self, "publication_metrics", {}),
            "r2_read_retries": getattr(getattr(self, "_r2_reader", None), "retries", 0),
        }
        path = ROOT / "internal/cache/cloudflare-performance.json"
        try:
            history = json.loads(path.read_bytes())
            if not isinstance(history, list):
                history = []
        except (OSError, ValueError):
            history = []
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(encode([*history[-23:], metrics]))
        print(json.dumps({"cloudflare_performance": metrics}), flush=True)

    def api(self, method, path, *, retry_safe=False, **kwargs):
        safe = retry_safe or method.upper() in {"GET", "HEAD"}
        for attempt in range(5):
            try:
                response = self.http.request(method, path, **kwargs)
            except httpx.TransportError as error:
                cause = error
                certificate_error = False
                while cause is not None:
                    certificate_error |= isinstance(cause, ssl.SSLError)
                    cause = cause.__cause__
                if certificate_error or not safe or attempt == 4:
                    raise RuntimeError(
                        "Cloudflare connection failed; verify any uncertain write before retrying"
                    ) from error
                time.sleep(2**attempt)
                continue
            if response.status_code in (429, 500, 502, 503, 504):
                if not safe and response.status_code != 429:
                    raise RuntimeError(
                        "Cloudflare write outcome is uncertain; verify before retrying"
                    )
                if attempt == 4:
                    break
                header = response.headers.get("Retry-After", "").strip()
                requested = float(header) if header.isascii() and header.isdigit() else 0.0
                if requested > 60:
                    raise RuntimeError(
                        "Cloudflare requested a cooldown longer than 60 seconds; retry later"
                    )
                time.sleep(max(requested, 2**attempt))
                continue
            if not response.is_success:
                raise RuntimeError("Cloudflare API failed with HTTP " + str(response.status_code))
            result = response.json()
            if not result.get("success"):
                raise RuntimeError("Cloudflare API returned unsuccessful status")
            return result["result"]
        raise RuntimeError(f"Cloudflare API retries exhausted (HTTP {response.status_code})")

    def sql(self, sql, params=()):
        self.transfers().add("d1_requests")
        result = self.api(
            "POST",
            "/d1/database/" + self.database + "/query",
            retry_safe=sql.lstrip().upper().startswith(("SELECT", "UPDATE", "DELETE"))
            or "ON CONFLICT" in sql.upper(),
            json={"sql": sql, "params": list(params)},
        )
        if not all(row.get("success") for row in result):
            raise RuntimeError("D1 query failed")
        return result[0].get("results", [])

    def cleanup_records(self, statement, params=()):
        # Evaluate the predicate in the projection so LIMIT bounds rows scanned,
        # even when no records match. Only matching rows need write requests.
        # Fixed targets keep retried mutations from advancing to another batch.
        predicate = statement.split(" WHERE ", 1)[1]
        cursor = None
        completed = scanned = 0
        with Progress("d1_cleanup") as progress:
            while True:
                rows = self.sql(
                    "SELECT rowid, (" + predicate + ") AS matches FROM catalog_records"  # noqa: S608
                    + (" WHERE rowid>?" if cursor is not None else "")
                    + " ORDER BY rowid LIMIT ?",
                    [*params, *([cursor] if cursor is not None else []), D1_CLEANUP_SCAN_SIZE],
                )
                if not rows:
                    return
                scanned += len(rows)
                targets = [row["rowid"] for row in rows if row["matches"]]
                for start in range(0, len(targets), D1_CLEANUP_BATCH_SIZE):
                    batch = targets[start : start + D1_CLEANUP_BATCH_SIZE]
                    self.sql(
                        statement + " AND rowid IN (SELECT value FROM json_each(?))",  # noqa: S608
                        [*params, encode(batch).decode()],
                    )
                    self.transfers().add("d1_cleanup_batches")
                    completed += len(batch)
                    progress.update(rows=completed, rows_scanned=scanned)
                progress.update(rows=completed, rows_scanned=scanned)
                cursor = rows[-1]["rowid"]
                if len(rows) < D1_CLEANUP_SCAN_SIZE:
                    return

    def put(self, key, body):
        for attempt in range(5):
            try:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=body)
                return
            except Exception as error:
                response = getattr(error, "response", {})
                if not isinstance(response, dict):
                    response = {}
                code = response.get("Error", {}).get("Code")
                status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
                transient = (
                    code in {
                        "SlowDown",
                        "ServiceUnavailable",
                        "InternalError",
                        "RequestTimeout",
                        "RequestTimeoutException",
                        "Conflict",
                        "TooManyRequests",
                        "BandwidthLimitExceeded",
                    }
                    or status in {408, 409, 429, 500, 502, 503, 504}
                )
                if not transient or attempt == 4:
                    raise
                time.sleep(2**attempt * 0.25)

    def read_object(self, key):
        body = self.s3_reads.get_object(Bucket=self.bucket, Key=key)["Body"]
        try:
            return body.read()
        finally:
            body.close()

    def get(self, key):
        return self._r2_reader.read(key)

    def blob(self, body, known):
        return self.transfers().upload(body, known)

    def active(self):
        rows = self.sql(
            "SELECT g.* FROM catalog_state s JOIN catalog_generations g ON g.seq=s.active_seq"
            " WHERE s.id=1 AND g.status='ready'"
        )
        return rows[0] if rows else None

    def document(self, generation):
        body = self.get(generation["manifest_key"])
        document = json.loads(body)
        if document["manifest"]["generation"] != generation["generation"]:
            raise ValueError("Generation manifest mismatch")
        return document

    def verified_blob(self, digest, fresh=False):
        return self.transfers().read(digest, fresh=fresh)

    @staticmethod
    def object_digests(document):
        return (
            set(document["files"].values())
            | set(document["record_blocks"])
            | {document["ids"]}
            | ({document["refresh_inputs"]} if document.get("refresh_inputs") else set())
            | set(document.get("record_objects", []))
        )

    def checkpoint(self):
        from scripts.cloudflare_checkpoint import save

        save(self, ROOT)

    def restore_checkpoint(self):
        from scripts.cloudflare_checkpoint import restore

        restore(self, ROOT, merge_ids, clean_inputs)

    def download_catalog(self, document, refresh_inputs=False):
        manifest = document["manifest"]
        identifiers = json.loads(self.verified_blob(document["ids"]))
        tips = self.sql(
            "SELECT * FROM catalog_generations WHERE status='ready' ORDER BY seq DESC LIMIT 1"
        )
        if tips:
            # Rollback changes the public pointer, but newer records still own their IDs.
            tip = self.document(tips[0])
            identifiers = merge_ids(identifiers, json.loads(self.verified_blob(tip["ids"])))
        else:
            identifiers = merge_ids(identifiers)
        if refresh_inputs:
            self.download_refresh_inputs(document, identifiers)
            return
        target = ROOT / "database" / manifest["snapshot"]
        target.mkdir(parents=True, exist_ok=True)
        self.transfers().prefetch(document["files"].values())
        for name, digest in document["files"].items():
            path = (target / name).resolve()
            if not path.is_relative_to(target.resolve()):
                raise ValueError("Unsafe snapshot path")
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.verified_blob(digest))
        (ROOT / "database/manifest.json").write_bytes(encode(manifest))
        (ROOT / "database/ids.json").write_bytes(encode(identifiers))

    @staticmethod
    def history_archive(records):
        computed = {
            "bundle_ids",
            "runtimes",
            "bundle_types",
            "is_latest",
            "channels",
            "metadata_document_url",
            "document_key",
        }
        return {
            "releases": {
                item["key"]: {
                    key: value for key, value in item["data"].items() if key not in computed
                }
                for item in records
                if item["kind"] == "history_release"
            },
            "sources": {
                item["key"]: item["data"] for item in records if item["kind"] == "history_source"
            },
        }

    def refresh_archive(self, document, base, records):
        prefix = "database/" + document["manifest"]["snapshot"] + "/"
        entries = {
            prefix + name: (base / name).read_bytes()
            for name in REFRESH_FILES
            if name in document["files"]
        }
        entries["database/manifest.json"] = encode(document["manifest"])
        entries["database/ids.json"] = (ROOT / "database/ids.json").read_bytes()
        entries["internal/cache/history/archive.json"] = encode(self.history_archive(records))
        for name in REFRESH_ROOT_FILES:
            if (ROOT / name).is_file():
                entries[name] = (ROOT / name).read_bytes()
        return pack_refresh(entries, document["manifest"]["generation"])

    def refresh_entries(self, document):
        manifest = document["manifest"]
        if (
            not re.fullmatch(r"[a-f0-9]{24}", manifest["generation"])
            or manifest["snapshot"] != "snapshots/" + manifest["generation"]
        ):
            raise ValueError("Unsafe refresh snapshot path")
        prefix = "database/" + manifest["snapshot"] + "/"
        required = {prefix + name for name in REFRESH_FILES if name in document["files"]}
        required |= {
            "database/manifest.json",
            "database/ids.json",
            "internal/cache/history/archive.json",
        }
        entries = unpack_refresh(
            self.verified_blob(document["refresh_inputs"]),
            manifest["generation"],
            required | set(REFRESH_ROOT_FILES),
        )
        supplemental = {
            prefix + name for name in ("bundles.json", "packages.json") if name in document["files"]
        }
        if (
            not (required - supplemental) <= entries.keys()
            or json.loads(entries["database/manifest.json"]) != manifest
        ):
            raise ValueError("Refresh archive manifest mismatch")
        # Initial compact archives omitted indexes needed by metadata refresh.
        # Fetch only those missing indexes and verify them against the generation.
        for name in supplemental - entries.keys():
            entries[name] = self.verified_blob(document["files"][name[len(prefix) :]])
        for name, body in entries.items():
            if (
                name.startswith(prefix)
                and hashlib.sha256(body).hexdigest() != document["files"][name[len(prefix) :]]
            ):
                raise ValueError("Refresh archive snapshot integrity mismatch")
        if hashlib.sha256(entries["database/ids.json"]).hexdigest() != document["ids"]:
            raise ValueError("Refresh archive ID integrity mismatch")
        return entries

    def download_refresh_inputs(self, document, identifiers):
        manifest = document["manifest"]
        if (
            not re.fullmatch(r"[a-f0-9]{24}", manifest["generation"])
            or manifest["snapshot"] != "snapshots/" + manifest["generation"]
        ):
            raise ValueError("Unsafe refresh snapshot path")
        prefix = "database/" + manifest["snapshot"] + "/"
        if document.get("refresh_inputs"):
            entries = self.refresh_entries(document)
            print("Restoring compact generation-bound refresh inputs", flush=True)
        else:
            # Existing generations need no reseeding or republishing to use the fast path.
            names = [name for name in REFRESH_FILES if name in document["files"]]
            self.transfers().prefetch(document["files"][name] for name in names)
            entries = {prefix + name: self.verified_blob(document["files"][name]) for name in names}
            entries["database/manifest.json"] = encode(manifest)
            entries["internal/cache/history/archive.json"] = encode(
                self.history_archive(self.read_records(document))
            )
            print(
                "Restoring legacy generation input subset; skipping generated API shards",
                flush=True,
            )
        # Validate every payload and ID merge before replacing any restored input.
        entries["database/ids.json"] = encode(identifiers)
        for body in entries.values():
            json.loads(body)
        for name, body in entries.items():
            target = (ROOT / name).resolve()
            if not target.is_relative_to(ROOT.resolve()):
                raise ValueError("Unsafe refresh input path")
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_suffix(target.suffix + ".restore-tmp")
            temporary.write_bytes(body)
            temporary.replace(target)

    def publish(self, require_complete=True):
        self.publication_metrics = {}
        with self.phase("publish"):
            return self._publish(require_complete)

    def _publish(self, require_complete):
        with self.phase("prepare_records"):
            clean_inputs(ROOT)
            manifest, records = catalog_records(ROOT)
            configured, _ = configured_sources(ROOT)
            inventory_complete = True
            snapshot_sources = json.loads(
                (ROOT / "database" / manifest["snapshot"] / "sources.json").read_bytes()
            )
            if any(row["url"].lower() not in configured for row in snapshot_sources):
                raise ValueError("Catalog contains removed sources; rebuild before publication")
            base_generation = manifest["generation"]
            if require_complete:
                inventory = source_channels(
                    json.loads((ROOT / "config/sources.json").read_text(encoding="utf-8")), ROOT
                )
                required = {
                    normalize_source(row["patches"], ROOT).lower() for row in inventory.values()
                } - disabled_sources(inventory, ROOT).keys()
                states = {
                    key.lower(): row
                    for (kind, key), row in records.items()
                    if kind == "history_source"
                }
                issue_sources = {
                    normalize_source(row["source"], ROOT).lower()
                    for row in read_issues(ROOT)
                    if row["phase"] == "Release check"
                    and row.get("observed_at", "")
                    >= states.get(normalize_source(row["source"], ROOT).lower(), {}).get(
                        "checked_at", "~"
                    )
                }
                inventory_complete = all(
                    states.get(url, {}).get("status") == "complete" for url in required
                )
                if any(
                    not states.get(url, {}).get("configured")
                    or not states[url].get("required", True)
                    or (
                        states[url].get("status") != "complete"
                        and not (states[url].get("status") == "incomplete" and url in issue_sources)
                    )
                    for url in required
                ):
                    raise ValueError("Historical reconciliation incomplete; publication refused")
        with self.phase("read_previous_generation"):
            active = self.active()
            if active and not require_complete:
                raise ValueError(
                    "Seed is only allowed for an empty catalog; use normal publication"
                )
            active_document = self.document(active) if active else None
            if active_document and active_document.get("source_purge_pending"):
                # A prior purge may have discarded generation rows before removing
                # their record versions. Finish it before choosing or reusing a seq.
                self.finish_source_purge(active_document)
            tips = self.sql(
                "SELECT * FROM catalog_generations WHERE status='ready' ORDER BY seq DESC LIMIT 1"
            )
            previous = (
                active_document
                if tips and active and tips[0]["seq"] == active["seq"]
                else self.document(tips[0]) if tips else None
            )
            known = self.object_digests(previous) if previous else set()
            previous_records = self.read_records(previous) if previous else []
        with self.phase("reconcile_records"):
            removed = {
                (row["data"].get("url") or row["data"].get("source_url") or row["key"]).lower()
                for row in previous_records
                if row["kind"] in ("source", "history_source")
            } - configured
            # A newly verified JVM inventory is authoritative for the same bundle ID.
            # Historical retention must not resurrect exports now classified as helpers.
            verified_inventories = {
                key
                for (kind, key), row in records.items()
                if kind == "bundle" and row.get("metadata_status") == "verified"
            }
            public_inventories = {
                key
                for key in verified_inventories
                if (
                    records["bundle", key].get("patch_completeness_version", 0) >= 4
                    or (
                        records["bundle", key].get("bundle_type") == "Reseam"
                        and records["bundle", key].get("patch_completeness_version", 0) >= 1
                    )
                )
            }
            superseded_patches, superseded_associations = set(), set()
            for item in previous_records:
                key = (item["kind"], item["key"])
                if key in records:
                    continue
                if key[0] == "patch" and (
                    item["data"]["bundle_id"] in public_inventories
                    or is_internal_patch(item["data"])
                ):
                    superseded_patches.add(key[1])
                elif key[0] == "patch_package":
                    patch = records.get(("patch", item["data"]["patch_id"]))
                    if patch is not None and patch["bundle_id"] in verified_inventories:
                        superseded_associations.add(key[1])
            # Retain upstream release deletions for configured (including disabled) sources.
            # Removing the source itself is an explicit purge.
            for item in previous_records:
                key = (item["kind"], item["key"])
                if key in records or key[0] == "refresh_jobs":
                    continue
                row = item["data"]
                if key[0] == "patch" and (key[1] in superseded_patches or is_internal_patch(row)):
                    continue
                # Keep the new verified links, while retaining relationships for
                # fallback patches and releases absent from the current snapshot.
                if key[0] == "patch_package" and (
                    row["patch_id"] in superseded_patches or key[1] in superseded_associations
                ):
                    continue
                if key[0] == "source":
                    row = {**row, "enabled": False, "configured": False}
                elif key[0] == "history_source":
                    row = {**row, "configured": False, "status": "removed"}
                elif key[0] in ("bundle", "history_release"):
                    row = {**row, "is_latest": False, "availability": "unavailable", "channels": []}
                records[key] = row
            for item in previous_records:
                key = (item["kind"], item["key"])
                if key[0] == "history_release" and key in records:
                    for field in ("bundle_ids", "runtimes", "bundle_types"):
                        records[key][field] = sorted(
                            set(records[key].get(field, [])) | set(item["data"].get(field, []))
                        )
            records = filter_records(ROOT, reconcile_retained_records(records))
            previous_map = {(item["kind"], item["key"]): item["data"] for item in previous_records}
            for key, row in list(records.items()):
                if key[0] == "bundle":
                    old = previous_map.get(key)
                    if old is not None and {
                        k: v for k, v in old.items() if k != "patch_refresh_attempted_at"
                    } == {
                        k: v for k, v in row.items() if k != "patch_refresh_attempted_at"
                    }:
                        if "patch_refresh_attempted_at" in old:
                            row["patch_refresh_attempted_at"] = old["patch_refresh_attempted_at"]
                        else:
                            row.pop("patch_refresh_attempted_at", None)
            exported = [
                {"kind": kind, "key": key, "data": row}
                for (kind, key), row in sorted(records.items())
            ]
        with self.phase("upload_record_blocks"):
            record_blocks = self.upload_records(exported, known)
            record_digest = hashlib.sha256(encode(record_blocks)).hexdigest()
            identity_digest = hashlib.sha256((ROOT / "database/ids.json").read_bytes()).hexdigest()
            generation = hashlib.sha256(
                encode([manifest["generation"], record_digest, identity_digest])
            ).hexdigest()[:24]
            existing = self.sql(
                "SELECT * FROM catalog_generations WHERE generation=? AND status='ready'",
                [generation],
            )
        if existing and active and active["generation"] == generation:
            self.finish_source_purge(active_document)
            self.prune("PRUNE", verify=False)
            print("Catalog unchanged; no D1 writes or repeated full verification")
            return
        if existing:
            with self.phase("verify_existing_generation"):
                self.verify_document(self.document(existing[0]))
            with self.phase("activate_generation"):
                self.sql("UPDATE catalog_state SET active_seq=? WHERE id=1", [existing[0]["seq"]])
            self.finish_source_purge(self.document(existing[0]))
            self.prune("PRUNE", verify=False)
            print("Reactivated verified existing generation")
            return
        if active and active["generation"] == generation:
            print("Catalog unchanged; no D1 writes")
            return
        with self.phase("recover_staging"):
            seq = int(
                self.sql("SELECT COALESCE(MAX(seq),0)+1 AS next FROM catalog_generations")[0][
                    "next"
                ]
            )
            pending = self.sql(
                "SELECT seq,generation FROM catalog_generations WHERE status='staging'"
            )
            # A retry of the same immutable generation can keep completed D1 batches.
            # Never reuse a sequence behind a ready generation (including after rollback).
            resume = next(
                (
                    row for row in pending
                    if row["generation"] == generation
                    and (not tips or row["seq"] > tips[0]["seq"])
                ),
                None,
            )
            if resume:
                seq = resume["seq"]
            for row in pending:
                if resume and row["seq"] == seq:
                    continue
                abandoned = row["seq"]
                self.cleanup_records("DELETE FROM catalog_records WHERE from_seq=?", [abandoned])
                self.cleanup_records(
                    "UPDATE catalog_records SET to_seq=NULL WHERE to_seq=?", [abandoned]
                )
                self.sql("DELETE FROM catalog_generations WHERE seq=?", [abandoned])
        base = ROOT / "database" / manifest["snapshot"]
        names = set(manifest["files"]) | {"history.json"}
        paths = {name: base / name for name in sorted(names)}
        with self.phase("upload_snapshot"):
            files = self.transfers().upload_files(paths, known, expected=manifest["files"])
        with self.phase("upload_generation_manifest"):
            manifest = {**manifest, "generation": generation, "snapshot": "snapshots/" + generation}
            manifest.pop("snapshot_ref", None)
            document = {
                "manifest": manifest,
                "base_generation": base_generation,
                "identity_digest": identity_digest,
                "files": files,
                "record_blocks": record_blocks,
                "record_block_encoding": "gzip",
                "record_objects": sorted(
                    {
                        hashlib.sha256(encode(item["data"])).hexdigest()
                        for item in exported
                        if item["kind"] == "history_release"
                        and len(encode(item["data"])) > 1_500_000
                    }
                ),
                "ids": self.blob((ROOT / "database/ids.json").read_bytes(), known),
                "complete": require_complete and inventory_complete,
                "source_purge_pending": bool(removed)
                or (ROOT / "internal/cache/source-removals.json").exists()
                or bool(previous and previous.get("source_purge_pending")),
                "record_count": len(records),
            }
            document["refresh_inputs"] = self.blob(
                self.refresh_archive(document, base, exported), known
            )
            manifest_key = "generations/" + generation + ".json"
            self.put(manifest_key, encode(document))
            self.sql(
                "INSERT INTO catalog_generations(seq,generation,manifest_key,status)"
                " VALUES(?,?,?,'staging') ON CONFLICT DO NOTHING",
                [seq, generation, manifest_key],
            )
        with self.phase("diff_d1_records"):
            pending_rows = []
            prior = {
                (item["kind"], item["key"]): record_hash(item["data"]) for item in previous_records
            }
            writes = 0
            changed_kinds, metadata_only = Counter(), Counter()
            previous_data = {(item["kind"], item["key"]): item["data"] for item in previous_records}
            volatile = {
                "checked_at",
                "verified_at",
                "last_verified_at",
                "patch_refresh_attempted_at",
            }
            for (kind, key), row in sorted(records.items()):
                digest = record_hash(row)
                if prior.get((kind, key)) == digest:
                    continue
                body = self.storage_row(kind, row, known)
                if len(body.encode()) > 1_900_000:
                    raise ValueError("Record exceeds D1 row budget; publication refused")
                pending_rows.append((kind, key, seq, body, digest))
                writes += 1
                changed_kinds[kind] += 1
                old = previous_data.get((kind, key))
                if old is not None and {k: v for k, v in old.items() if k not in volatile} == {
                    k: v for k, v in row.items() if k not in volatile
                }:
                    metadata_only[kind] += 1
        # JSON input uses one binding; each inserted row still runs the version-closing trigger.
        with self.phase("insert_d1_records"):
            if resume:
                self.insert_rows(pending_rows, repair=True)
            else:
                self.insert_rows(pending_rows)
        self.publication_metrics.update(
            {
                "changed_records_by_kind": dict(changed_kinds),
                "timestamp_only_changes_by_kind": dict(metadata_only),
            }
        )
        print(json.dumps(self.publication_metrics), flush=True)
        with self.phase("expire_and_count_d1_records"):
            self.expire_rows(seq, sorted(prior.keys() - records.keys()))
            count_sql = (
                "SELECT COUNT(*) AS n,COALESCE(SUM(from_seq=?),0) AS staged"
                " FROM catalog_records WHERE from_seq<=?"
                " AND (to_seq IS NULL OR to_seq>?)"
            )
            counts = self.sql(count_sql, [seq, seq, seq])[0]
            if counts["n"] != len(records) or counts["staged"] != len(pending_rows):
                if not resume:
                    raise ValueError("D1 staged row count mismatch")
                # Conditional upserts already compare every intended staged body
                # and hash. Extra rows or damaged visibility boundaries require
                # the original discard-and-replay recovery path.
                self.cleanup_records("DELETE FROM catalog_records WHERE from_seq=?", [seq])
                self.cleanup_records(
                    "UPDATE catalog_records SET to_seq=NULL WHERE to_seq=?", [seq]
                )
                self.insert_rows(pending_rows)
                self.expire_rows(seq, sorted(prior.keys() - records.keys()))
                counts = self.sql(count_sql, [seq, seq, seq])[0]
                if counts["n"] != len(records) or counts["staged"] != len(pending_rows):
                    raise ValueError("D1 staged row count mismatch")
            count = counts["n"]
        # Ready generations were verified before activation. Re-read only new blobs here;
        # the explicit verify/recovery operations still check every retained object.
        with self.phase("verify_new_objects"):
            previous_digests = self.object_digests(previous) if previous else set()
            self.verify_document(document, skip_digests=previous_digests)
        # Atomic activation. The workflow concurrency group is the single-writer lock.
        with self.phase("activate_generation"):
            self.sql("UPDATE catalog_generations SET status='ready' WHERE seq=?", [seq])
            self.sql("UPDATE catalog_state SET active_seq=? WHERE id=1", [seq])
        with self.phase("purge_removed_sources"):
            self.finish_source_purge(document)
        self.prune("PRUNE", verify=False)
        print(json.dumps({"generation": generation, "records_changed": writes, "records": count}))

    def finish_source_purge(self, document):
        if not document.get("source_purge_pending") and not (
            ROOT / "internal/cache/source-removals.json"
        ).exists():
            return
        active = self.active()
        if not active or active["generation"] != document["manifest"]["generation"]:
            raise ValueError("Source purge requires the active verified generation")
        if not document.get("source_purge_pending"):
            document["source_purge_pending"] = True
            self.put(active["manifest_key"], encode(document))
        sequence = active["seq"]
        # Older snapshots contain removed data and cannot remain restorable. Keep
        # the newly verified snapshot and all records visible in that snapshot.
        self.sql("DELETE FROM catalog_generations WHERE seq<>?", [sequence])
        self.cleanup_records(
            "DELETE FROM catalog_records WHERE NOT (from_seq<=? AND (to_seq IS NULL OR to_seq>?))",
            [sequence, sequence],
        )
        # Discarded future versions must not expire rows retained by this snapshot
        # when their sequence numbers are reused by a later publication.
        self.cleanup_records("UPDATE catalog_records SET to_seq=NULL WHERE to_seq>?", [sequence])
        retained = {"objects/" + digest for digest in self.object_digests(document)}
        retained.add(active["manifest_key"])
        for row in self.read_records(document):
            if row["kind"] == "history_release" and len(encode(row["data"])) > 1_500_000:
                retained.add("objects/" + hashlib.sha256(encode(row["data"])).hexdigest())
        # A checkpoint written before removal must never restore deleted content.
        clean_inputs(ROOT)
        clean_snapshots(ROOT)
        (ROOT / "internal/cache/source-removals.json").unlink(missing_ok=True)
        self.checkpoint()
        from scripts.cloudflare_checkpoint import evict_key, retained_keys

        retained.update(retained_keys(self, ROOT))
        obsolete = []
        scanned = 0
        with Progress("r2_list_source_purge") as progress:
            for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket):
                for item in page.get("Contents", []):
                    key = item["Key"]
                    if (
                        key.startswith(("objects/", "generations/", "checkpoints/"))
                        and key not in retained
                    ):
                        obsolete.append(key)
                scanned += len(page.get("Contents", []))
                progress.update(objects_scanned=scanned)

        def delete(keys):
            result = self.s3.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": key} for key in keys], "Quiet": True},
            )
            failed = {row["Key"] for row in result.get("Errors", [])}
            for key in set(keys) - failed:
                if key.startswith("objects/"):
                    self.transfers().path(key[8:]).unlink(missing_ok=True)
                evict_key(self, key)
            if failed:
                raise RuntimeError("R2 source purge could not delete all obsolete objects")

        self.transfers().parallel(
            delete, [obsolete[start : start + 1000] for start in range(0, len(obsolete), 1000)],
            operation="r2_delete_source_purge",
        )
        # Last write is the durable completion marker; a later publish retries
        # interrupted cleanup even when the catalog contents are unchanged.
        document["source_purge_pending"] = False
        self.put(active["manifest_key"], encode(document))
        print(f"Purged removed sources; deleted {len(obsolete)} obsolete R2 objects")

    def upload_records(self, records, known):
        blocks = {}
        for item in records:
            prefix = hashlib.sha256(item["key"].encode()).hexdigest()[:2]
            # Mutable timestamps/jobs must not rewrite unrelated patch relationships.
            blocks.setdefault((item["kind"], prefix), []).append(item)
        return self.transfers().parallel(
            lambda item: self.blob(gzip.compress(encode(item[1]), compresslevel=1, mtime=0), known),
            sorted(blocks.items()),
            operation="r2_upload_records",
        )

    def read_records(self, document):
        encoding = document.get("record_block_encoding", "json")
        if encoding not in ("json", "gzip"):
            raise ValueError("Unsupported record block encoding")
        self.transfers().prefetch(document["record_blocks"])
        result = []
        for digest in document["record_blocks"]:
            body = self.verified_blob(digest)
            result.extend(json.loads(gzip.decompress(body) if encoding == "gzip" else body))
        return result

    def verify_document(self, document, skip_digests=(), *, metadata_only=False):
        record_digest = hashlib.sha256(encode(document["record_blocks"])).hexdigest()
        identity = [document["base_generation"], record_digest]
        if "identity_digest" in document:
            if document["identity_digest"] != document["ids"]:
                raise ValueError("Snapshot ID registry integrity mismatch")
            identity.append(document["identity_digest"])
        generation = hashlib.sha256(encode(identity)).hexdigest()[:24]
        if generation != document["manifest"]["generation"]:
            raise ValueError("Snapshot manifest integrity mismatch")
        if document["manifest"]["snapshot"] != "snapshots/" + generation:
            raise ValueError("Unsafe snapshot path")
        from scripts.generate_database import encoded

        if (
            hashlib.sha256(encoded(document["files"])).hexdigest()[:24]
            != document["base_generation"]
        ):
            raise ValueError("Snapshot base integrity mismatch")
        if set(document["files"]) != set(document["manifest"]["files"]) | {"history.json"}:
            raise ValueError("Snapshot file set mismatch")
        for name, metadata in document["manifest"]["files"].items():
            if document["files"].get(name) != metadata["sha256"]:
                raise ValueError("Snapshot file index mismatch")
        if document.get("record_block_encoding", "json") not in ("json", "gzip"):
            raise ValueError("Unsupported record block encoding")
        if any(not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
               for digest in document.get("record_objects", [])):
            raise ValueError("Invalid external record object digest")
        if metadata_only:
            # Automatic retention only uses generations already verified before activation.
            return document
        self.transfers().prefetch(self.object_digests(document) - set(skip_digests), fresh=True)
        if document.get("refresh_inputs"):
            self.refresh_entries(document)
        if not skip_digests:
            records = self.read_records(document)
            if len(records) != document["record_count"] or len(
                {(row["kind"], row["key"]) for row in records}
            ) != len(records):
                raise ValueError("Snapshot record count or identity mismatch")
            external = set()
            for row in records:
                body = encode(row["data"])
                if row["kind"] == "history_release" and len(body) > 1_500_000:
                    digest = hashlib.sha256(body).hexdigest()
                    external.add(digest)
                    self.verified_blob(digest, fresh=True)
            if "record_objects" in document and set(document["record_objects"]) != external:
                raise ValueError("External record object index mismatch")
        return document

    def verify_database(self, sequence, document):
        expected = {
            (row["kind"], row["key"]): record_hash(row["data"])
            for row in self.read_records(document)
        }
        after = ("", "")
        actual = {}
        while True:
            rows = self.sql(
                "SELECT kind,record_key,content_hash FROM catalog_records "
                "WHERE from_seq<=? AND (to_seq IS NULL OR to_seq>?) "
                "AND (kind>? OR (kind=? AND record_key>?)) ORDER BY kind,record_key LIMIT 1000",
                [sequence, sequence, after[0], after[0], after[1]],
            )
            for row in rows:
                actual[(row["kind"], row["record_key"])] = row["content_hash"]
            if len(rows) < 1000:
                break
            after = (rows[-1]["kind"], rows[-1]["record_key"])
        if actual != expected:
            raise ValueError("D1 generation does not match verified R2 records")

    def storage_row(self, kind, row, known=None):
        body = encode(row)
        if len(body) <= 1_500_000:
            return body.decode()
        if kind != "history_release":
            raise ValueError("Record exceeds D1 row budget; publication refused")
        digest = hashlib.sha256(body).hexdigest()
        self.blob(body, known if known is not None else set())
        compact = {
            key: value
            for key, value in row.items()
            if key not in ("raw_metadata", "assets", "bundle_assets", "changelog", "release_notes")
        }
        compact["document_key"] = digest
        compact["metadata_document_url"] = "/history/releases/" + row["id"] + "/document"
        return encode(compact).decode()

    def rebuild(self, document, confirmation):
        if confirmation != "REBUILD":
            raise ValueError("Database rebuild requires --confirm REBUILD")
        self.verify_document(document)
        records = self.read_records(document)
        # verify_document has just checked these originals remotely, including
        # legacy manifests without a record_objects index. Rebuild only D1 rows.
        known = {
            hashlib.sha256(encode(row["data"])).hexdigest()
            for row in records
            if row["kind"] == "history_release" and len(encode(row["data"])) > 1_500_000
        }
        # Explicit disaster recovery only. Verified R2 data is loaded before D1 is cleared.
        self.sql("UPDATE catalog_state SET active_seq=NULL WHERE id=1")
        self.sql("DELETE FROM catalog_records")
        self.sql("DELETE FROM catalog_generations")
        manifest = document["manifest"]
        key = "generations/" + manifest["generation"] + ".json"
        self.sql(
            "INSERT INTO catalog_generations(seq,generation,manifest_key,status)"
            " VALUES(1,?,?,'staging') ON CONFLICT DO NOTHING",
            [manifest["generation"], key],
        )
        batch = []
        for row in records:
            batch.append(
                (
                    row["kind"],
                    row["key"],
                    1,
                    self.storage_row(row["kind"], row["data"], known),
                    record_hash(row["data"]),
                )
            )
            if len(batch) == 200:
                self.insert_rows(batch)
                batch = []
        if batch:
            self.insert_rows(batch)
        if self.sql("SELECT COUNT(*) AS n FROM catalog_records")[0]["n"] != len(records):
            raise ValueError("Rebuilt D1 count mismatch")
        self.sql("UPDATE catalog_generations SET status='ready' WHERE seq=1")
        self.sql("UPDATE catalog_state SET active_seq=1 WHERE id=1")
        print("Rebuilt verified generation " + manifest["generation"])

    def insert_rows(self, rows, *, repair=False):
        conflict = " ON CONFLICT(kind,record_key,from_seq) DO NOTHING"
        if repair:
            # Only a matching staging generation may repair existing row bodies.
            # Identical rows stay untouched, including all their index entries.
            conflict = (
                " ON CONFLICT(kind,record_key,from_seq) DO UPDATE SET"
                " data=excluded.data,content_hash=excluded.content_hash,to_seq=NULL"
                " WHERE catalog_records.to_seq IS NOT NULL"
                " OR catalog_records.data<>excluded.data"
                " OR catalog_records.content_hash<>excluded.content_hash"
            )
        with Progress("insert_rows", len(rows)) as progress:
            batch, size = [], 2
            completed = 0

            def flush():
                nonlocal completed
                if not batch:
                    return
                self.sql(
                    "INSERT INTO catalog_records(kind,record_key,from_seq,data,content_hash) "
                    "SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),"
                    "json_extract(value,'$[2]'),json_extract(value,'$[3]'),"
                    "json_extract(value,'$[4]') "
                    "FROM json_each(?) WHERE 1" + conflict,
                    [encode(batch).decode()],
                )
                self.transfers().add("d1_insert_batches")
                completed += len(batch)
                progress.update(completed)

            for row in rows:
                length = len(encode(row)) + 1
                if batch and (len(batch) >= D1_WRITE_BATCH_SIZE or size + length > 512_000):
                    flush()
                    batch, size = [], 2
                if length > 512_000:
                    self.sql(
                        "INSERT INTO catalog_records(kind,record_key,from_seq,data,content_hash) "
                        "VALUES(?,?,?,?,?)" + conflict,
                        row,
                    )
                    self.transfers().add("d1_insert_batches")
                    completed += 1
                    progress.update(completed)
                    continue
                batch.append(row)
                size += length
            flush()

    def expire_rows(self, seq, keys):
        if not keys:
            return
        with Progress("expire_rows", len(keys)) as progress:
            batch, size = [], 2
            completed = 0

            def flush():
                nonlocal completed
                if not batch:
                    return
                self.sql(
                    "UPDATE catalog_records SET to_seq=? WHERE to_seq IS NULL AND "
                    "(kind, record_key) IN ("
                    "SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') "
                    "FROM json_each(?)"
                    ")",
                    [seq, encode(batch).decode()],
                )
                self.transfers().add("d1_expire_batches")
                completed += len(batch)
                progress.update(completed)

            for key in keys:
                length = len(encode(key)) + 1
                if batch and (len(batch) >= D1_WRITE_BATCH_SIZE or size + length > 512_000):
                    flush()
                    batch, size = [], 2
                batch.append(key)
                size += length
            flush()

    def prune(self, confirmation, *, verify=True):
        with self.phase("retention"):
            return self._prune(confirmation, verify=verify)

    def _prune(self, confirmation, *, verify=True):
        retain = int(os.environ.get("CATALOG_RETENTION_GENERATIONS") or "8")
        if retain < 2:
            raise ValueError("CATALOG_RETENTION_GENERATIONS must be at least 2")
        generations = self.sql("SELECT * FROM catalog_generations ORDER BY seq DESC")
        active = self.active()
        keep = generations[:retain] + [
            row for row in generations
            if row["status"] == "staging" or (active and row["seq"] == active["seq"])
        ]
        keep = list({row["seq"]: row for row in keep}.values())
        keys = {row["manifest_key"] for row in keep}
        objects = set()
        for row in keep:
            document = self.verify_document(self.document(row), metadata_only=not verify)
            objects.update(self.object_digests(document))
        # Legacy manifests did not index oversized D1 documents. Read only their
        # small D1 references, never all historical R2 record blocks for cleanup.
        for start in range(0, len(keep), 40):
            batch = keep[start:start + 40]  # Stay below D1's bound-parameter limit.
            visible = " OR ".join("(from_seq<=? AND (to_seq IS NULL OR to_seq>?))" for _ in batch)
            params = [number for row in batch for number in (row["seq"], row["seq"])]
            for row in self.sql(
                "SELECT DISTINCT json_extract(data,'$.document_key') AS digest "
                "FROM catalog_records WHERE kind='history_release' "
                "AND json_extract(data,'$.document_key') IS NOT NULL AND (" + visible + ")",
                params,
            ):
                digest = row["digest"]
                if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                    raise ValueError("Invalid retained document reference")
                objects.add(digest)
        obsolete = [row for row in generations if row["manifest_key"] not in keys]
        from scripts.cloudflare_checkpoint import evict_key, retained_keys

        checkpoints = retained_keys(self, ROOT)
        orphaned = []
        scanned = 0
        with Progress("r2_list_retention") as progress:
            for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket):
                for item in page.get("Contents", []):
                    key = item["Key"]
                    if (key.startswith("objects/") and key[8:] not in objects) or (
                        key.startswith("generations/") and key not in keys
                    ) or (key.startswith("checkpoints/") and key not in checkpoints):
                        orphaned.append(key)
                scanned += len(page.get("Contents", []))
                progress.update(objects_scanned=scanned)
        print(json.dumps({"retained_generations": len(keys), "old_generations": len(obsolete),
                          "orphaned_objects": len(orphaned), "dry_run": confirmation != "PRUNE"}))
        if confirmation != "PRUNE":
            return
        if not keep:
            raise ValueError("No recoverable generations; refusing retention cleanup")
        if obsolete or verify:
            # A normal unchanged refresh has no expired versions to remove.
            # Explicit maintenance can still clean previously orphaned D1 versions.
            floor = min(row["seq"] for row in keep)
            self.cleanup_records("DELETE FROM catalog_records WHERE to_seq<=?", [floor])
        if obsolete:
            self.sql(
                "DELETE FROM catalog_generations WHERE seq IN (SELECT value FROM json_each(?))",
                [encode([row["seq"] for row in obsolete]).decode()],
            )

        def delete(batch):
            result = self.s3.delete_objects(
                Bucket=self.bucket,
                Delete={"Objects": [{"Key": key} for key in batch], "Quiet": True},
            )
            failed = {row["Key"] for row in result.get("Errors", [])}
            for key in set(batch) - failed:
                if key.startswith("objects/"):
                    self.transfers().path(key[8:]).unlink(missing_ok=True)
                evict_key(self, key)
            if failed:
                raise RuntimeError("R2 retention could not delete all obsolete objects")

        self.transfers().parallel(
            delete, [orphaned[start:start + 1000] for start in range(0, len(orphaned), 1000)],
            operation="r2_delete_retention",
        )

    def provision(self):
        name = os.environ.get("CATALOG_D1_NAME") or "patch-bundle-registry"
        databases = self.api("GET", "/d1/database", params={"name": name, "per_page": 100})
        found = [row for row in databases if row["name"] == name]
        database = found[0] if found else self.api("POST", "/d1/database", json={"name": name})
        buckets = self.api("GET", "/r2/buckets")["buckets"]
        if not any(row["name"] == self.bucket for row in buckets):
            self.api("POST", "/r2/buckets", json={"name": self.bucket})
        print("CATALOG_D1_ID=" + database["uuid"])
        print("CATALOG_R2_BUCKET=" + self.bucket)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "operation",
        choices=[
            "provision",
            "publish",
            "seed",
            "download",
            "checkpoint",
            "resume",
            "verify",
            "restore",
            "rebuild",
            "prune",
        ],
    )
    parser.add_argument("--generation")
    parser.add_argument("--refresh-inputs", action="store_true")
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument(
        "--metadata-only",
        action="store_true",
        help="Verify ready generation metadata without scanning R2 objects or D1 records",
    )
    parser.add_argument("--confirm")
    args = parser.parse_args()
    if args.metadata_only and args.operation != "verify":
        parser.error("--metadata-only is only supported for verify")
    cloud = Cloud()
    started = time.perf_counter()
    try:
        if args.operation == "provision":
            cloud.provision()
        elif args.operation in ("publish", "seed"):
            cloud.publish(require_complete=args.operation == "publish")
        elif args.operation == "checkpoint":
            cloud.checkpoint()
        elif args.operation == "prune":
            cloud.prune(args.confirm)
        elif args.operation == "resume":
            cloud.restore_checkpoint()
        else:
            active = cloud.active()
            if args.operation == "rebuild":
                if not args.generation:
                    raise ValueError("Rebuild requires a verified R2 generation ID")
                if not re.fullmatch(r"[a-f0-9]{24}", args.generation):
                    raise ValueError("Invalid generation ID")
                document = json.loads(cloud.get("generations/" + args.generation + ".json"))
                cloud.rebuild(document, args.confirm)
                return
            if args.generation:
                rows = cloud.sql(
                    "SELECT * FROM catalog_generations WHERE generation=? AND status='ready'",
                    [args.generation],
                )
                if not rows:
                    raise ValueError("Unknown ready generation")
                active = rows[0]
            if not active:
                raise ValueError("No active catalog")
            document = cloud.document(active)
            if args.require_complete and not document["complete"]:
                raise ValueError("Historical backfill is not complete")
            if args.operation == "verify":
                cloud.verify_document(document, metadata_only=args.metadata_only)
                if not args.metadata_only:
                    cloud.verify_database(active["seq"], document)
                print(
                    json.dumps(
                        {
                            "generation": active["generation"],
                            "complete": document["complete"],
                            "verification": "metadata-only" if args.metadata_only else "full",
                        }
                    )
                )
            elif args.operation == "download":
                cloud.download_catalog(document, refresh_inputs=args.refresh_inputs)
            elif args.operation == "restore":
                if args.confirm != "RESTORE":
                    raise ValueError("Restore requires --confirm RESTORE")
                cloud.verify_document(document)
                cloud.sql("UPDATE catalog_state SET active_seq=? WHERE id=1", [active["seq"]])
                print("Restored " + active["generation"])
    finally:
        try:
            cloud.report(args.operation, started)
        except (OSError, ValueError) as error:
            # Diagnostics and a disposable cache must not mask the operation's outcome.
            print("Could not save Cloudflare performance diagnostics: " + str(error), flush=True)


if __name__ == "__main__":
    main()
