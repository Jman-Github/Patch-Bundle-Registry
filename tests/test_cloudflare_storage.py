import hashlib
import io
import json
import shutil
import tarfile
import time
from collections import Counter
from threading import Lock

import httpx
import pytest
from test_cloudflare_catalog import SOURCE, MemoryCloud, catalog, release
from test_generate_database import db, fixture
from test_refresh_source_metadata import metadata

from scripts import cloudflare_catalog as cloud
from scripts import refresh_app_metadata as apps
from scripts.cloudflare_storage import REFRESH_FILES, BlobCache, pack_refresh, unpack_refresh
from scripts.release_archive import reconcile_archive


def test_cache_deduplicates_parallel_reads_and_recovers_corruption(tmp_path):
    body = b'{"immutable":true}'
    digest = hashlib.sha256(body).hexdigest()
    calls = []
    cache = BlobCache(tmp_path, lambda key: calls.append(key) or body, lambda *a: None)
    assert cache.parallel(cache.read, [digest] * 30) == [body] * 30
    assert calls == ["objects/" + digest]
    cache.path(digest).write_bytes(b"corrupt")
    assert cache.read(digest) == body
    assert len(calls) == 2
    assert cache.metrics["cache_corruptions"] == 1
    reused = BlobCache(tmp_path, lambda key: pytest.fail("Cache missed"), lambda *a: None)
    assert reused.read(digest) == body
    with pytest.raises(ValueError, match="digest"):
        cache.read("../unsafe")


def test_failed_download_is_retryable_and_fresh_reads_bypass_cache(tmp_path):
    body = b"good"
    digest = hashlib.sha256(body).hexdigest()
    replies = [b"bad", body, b"bad"]
    cache = BlobCache(tmp_path, lambda key: replies.pop(0), lambda *a: None)
    with pytest.raises(ValueError, match="integrity"):
        cache.read(digest)
    assert cache.read(digest) == body
    assert cache.read(digest) == body
    with pytest.raises(ValueError, match="integrity"):
        cache.read(digest, fresh=True)
    assert not replies


def test_transfer_concurrency_is_bounded_and_uploads_are_unique(tmp_path):
    bodies = [str(i).encode() for i in range(50)]
    objects = {hashlib.sha256(body).hexdigest(): body for body in bodies}
    guard = Lock()
    active, peak = 0, 0

    def get(key):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
        time.sleep(0.005)
        with guard:
            active -= 1
        return objects[key[8:]]

    uploads = []
    cache = BlobCache(tmp_path / "objects", get, lambda key, body: uploads.append(key), workers=4)
    cache.prefetch(list(objects) * 3)
    assert 1 < peak <= 4
    assert cache.metrics["object_downloads"] == len(objects)
    cache = BlobCache(tmp_path / "uploads", get, lambda key, body: uploads.append(key), workers=4)
    known = set()
    cache.parallel(lambda _: cache.upload(bodies[0], known), range(30))
    assert len(uploads) == 1
    paths = {}
    for i in range(12):
        path = tmp_path / str(i)
        path.write_bytes(bodies[i % 3])
        paths[str(i)] = path
    cache.upload_files(paths, known)
    assert len(uploads) == 3
    assert cache.metrics["duplicate_files_avoided"] == 9
    cache.trim(5)
    assert sum(p.stat().st_size for p in cache.directory.glob("*/*.blob")) <= 5


def test_refresh_archive_is_deterministic_and_generation_bound():
    entries = {"database/ids.json": b'{"source":{}}', "database/manifest.json": b"{}"}
    body = pack_refresh(entries, "a" * 24)
    assert body == pack_refresh(dict(reversed(list(entries.items()))), "a" * 24)
    assert unpack_refresh(body, "a" * 24, set(entries)) == entries
    with pytest.raises(ValueError, match="integrity"):
        unpack_refresh(body, "b" * 24, set(entries))
    with pytest.raises(ValueError, match="Unsafe"):
        unpack_refresh(body, "a" * 24, {"database/ids.json"})


@pytest.mark.parametrize("problem", ["duplicate", "traversal", "symlink", "hash", "json"])
def test_refresh_archive_rejects_malformed_entries(problem):
    entries = {"database/ids.json": b"{}"}
    body = pack_refresh(entries, "a" * 24)
    output = io.BytesIO()
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as source:
        members = [(item, source.extractfile(item).read()) for item in source]
    if problem in ("duplicate", "traversal", "symlink"):
        info = tarfile.TarInfo("../escape.json" if problem == "traversal" else "database/ids.json")
        if problem == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = "escape"
        members.append((info, b"{}"))
    else:
        members = [
            (info, b"{invalid" if problem == "json" else b'{"changed":true}')
            if info.name == "database/ids.json"
            else (info, payload)
            for info, payload in members
        ]
    with tarfile.open(fileobj=output, mode="w:gz") as target:
        for info, payload in members:
            info.size = len(payload)
            target.addfile(info, io.BytesIO(payload))
    with pytest.raises(ValueError):
        unpack_refresh(output.getvalue(), "a" * 24, set(entries))


@pytest.mark.parametrize("legacy", [False, True])
def test_fast_restore_rebuilds_catalog_without_generated_shards(tmp_path, monkeypatch, legacy):
    memory = MemoryCloud(tmp_path)
    original = tmp_path / "original"
    monkeypatch.setattr(cloud, "ROOT", original)
    catalog(original)
    metadata = original / "database/repository-metadata.json"
    metadata.write_text('{"repo":{"description":"saved metadata"}}')
    memory.publish()
    document = memory.document(memory.active())
    expected_archive = json.loads((original / "internal/cache/history/archive.json").read_bytes())
    expected_ids = json.loads((original / "database/ids.json").read_bytes())
    fresh = tmp_path / "fresh"
    shutil.copytree(original / "config", fresh / "config")
    monkeypatch.setattr(cloud, "ROOT", fresh)
    del memory._transfers
    if legacy:
        document.pop("refresh_inputs")
    memory.download_catalog(document, refresh_inputs=True)
    snapshot = fresh / "database" / document["manifest"]["snapshot"]
    assert {p.name for p in snapshot.iterdir()} == set(REFRESH_FILES)
    restored = json.loads((fresh / "internal/cache/history/archive.json").read_bytes())
    assert restored["releases"] == expected_archive["releases"]
    assert json.loads((fresh / "database/ids.json").read_bytes()) == expected_ids
    if not legacy:
        assert memory.transfers().metrics["object_downloads"] == 2  # IDs and compact archive.
        assert (fresh / "database/repository-metadata.json").read_bytes() == metadata.read_bytes()
    db.restore_catalog_cache(fresh)
    assert list((fresh / "internal/cache/bundles").rglob("*-patches-list.json"))
    inventory = json.loads((fresh / "config/sources.json").read_bytes())
    again = reconcile_archive(
        fresh, inventory, {SOURCE: [release(1)], "https://gitlab.com/team/empty": []}
    )
    assert again["releases"] == expected_archive["releases"]
    rebuilt = db.build_database(fresh)
    assert rebuilt["counts"]["bundles"] == document["manifest"]["counts"]["bundles"]
    assert json.loads((fresh / "database/ids.json").read_bytes()) == expected_ids


def test_fast_restore_rejects_corrupt_archive_before_writing(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    document = memory.document(memory.active())
    before = (tmp_path / "database/manifest.json").read_bytes()
    memory.objects["objects/" + document["refresh_inputs"]] = b"corrupt"
    memory.transfers().path(document["refresh_inputs"]).unlink()
    with pytest.raises(ValueError, match="integrity"):
        memory.download_catalog(document, refresh_inputs=True)
    assert (tmp_path / "database/manifest.json").read_bytes() == before


@pytest.mark.parametrize("changed", ["ids", "snapshot", "manifest"])
def test_fast_restore_checks_archive_against_generation_document(tmp_path, monkeypatch, changed):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    document = memory.document(memory.active())
    entries = memory.refresh_entries(document)
    if changed == "ids":
        name = "database/ids.json"
    elif changed == "manifest":
        name = "database/manifest.json"
    else:
        name = "database/" + document["manifest"]["snapshot"] + "/sources.json"
    entries[name] = b"{}"
    body = pack_refresh(entries, document["manifest"]["generation"])
    digest = hashlib.sha256(body).hexdigest()
    document["refresh_inputs"] = digest
    memory.objects["objects/" + digest] = body
    before = (tmp_path / "database/manifest.json").read_bytes()
    with pytest.raises(ValueError, match=r"integrity|mismatch"):
        memory.download_catalog(document, refresh_inputs=True)
    assert (tmp_path / "database/manifest.json").read_bytes() == before


def test_json_bulk_inserts_preserve_versions_and_are_idempotent(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    data = cloud.encode({"name": 'Quotes " \n \u2603', "items": [1, None]}).decode()
    first = [("app", str(i), 1, data, "first") for i in range(435)]
    memory.insert_rows(first)
    assert memory.inserts == 1
    assert memory.sql("SELECT COUNT(*) AS n FROM catalog_records")[0]["n"] == 435
    assert {row["data"] for row in memory.sql("SELECT data FROM catalog_records")} == {data}
    second = [("app", str(i), 2, data, "second") for i in range(435)]
    memory.insert_rows(second)
    memory.insert_rows(second)  # Retry after a lost successful response.
    versions = Counter(
        (row["from_seq"], row["to_seq"])
        for row in memory.sql("SELECT from_seq,to_seq FROM catalog_records")
    )
    assert versions == {(1, 2): 435, (2, None): 435}


def test_json_bulk_inserts_bound_payload_size_and_handle_large_rows(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    calls = []
    sql = memory.sql

    def record(statement, params=()):
        calls.append((statement, params))
        return sql(statement, params)

    monkeypatch.setattr(memory, "sql", record)
    rows = [
        ("app", str(i), 1, json.dumps({"data": "x" * size}), "hash")
        for i, size in enumerate([180_000] * 5 + [600_000])
    ]
    memory.insert_rows(rows)
    assert len(calls) == 4
    for statement, params in calls:
        if "json_each" in statement:
            assert len(params) == 1
            assert len(params[0].encode()) <= 512_000
        else:
            assert len(params) == 5
    assert memory.sql("SELECT COUNT(*) AS n FROM catalog_records")[0]["n"] == 6


def test_publication_reports_timestamp_only_changes(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    path = tmp_path / "internal/cache/history/archive.json"
    archive = json.loads(path.read_bytes())
    archive["sources"][SOURCE]["checked_at"] = "2030-01-01T00:00:00Z"
    path.write_bytes(cloud.encode(archive))
    memory.publish()
    assert memory.publication_metrics["timestamp_only_changes_by_kind"] == {"history_source": 1}
    memory.report("publish", time.perf_counter())
    report = json.loads((tmp_path / "internal/cache/cloudflare-performance.json").read_bytes())[-1]
    assert report["changed_records_by_kind"]["history_source"] == 1
    assert report["d1_insert_batches"] >= 1


@pytest.mark.parametrize("legacy", [False, True])
def test_fast_restore_preserves_morphe_icon_refresh(tmp_path, monkeypatch, legacy):
    memory = MemoryCloud(tmp_path)
    original = tmp_path / "original"
    monkeypatch.setattr(cloud, "ROOT", original)
    fixture(original)
    inventory = json.loads((original / "config/sources.json").read_bytes())
    reconcile_archive(
        original,
        inventory,
        {
            SOURCE: [release(1)],
            "https://gitlab.com/team/empty": [],
        },
    )
    for path in (original / "internal/cache/bundles").rglob("*-patches-bundle.json"):
        bundle = json.loads(path.read_bytes())
        bundle["bundle_type"] = "Morphe:V1"
        path.write_bytes(cloud.encode(bundle))
    db.build_database(original)
    assert metadata.morphe_sources(original) == {SOURCE.lower()}
    memory.publish()
    document = memory.document(memory.active())
    if legacy:
        document.pop("refresh_inputs")
    fresh = tmp_path / "fresh"
    shutil.copytree(original / "config", fresh / "config")
    monkeypatch.setattr(cloud, "ROOT", fresh)
    del memory._transfers
    memory.download_catalog(document, refresh_inputs=True)
    requests = []

    def handle(request):
        requests.append(request)
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-type": "image/png"})
        return httpx.Response(
            200, json={"name": "demo", "owner": {"login": "owner"}, "default_branch": "main"}
        )

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        result = metadata.refresh(fresh, client)
    icons = [request for request in requests if request.method == "HEAD"]
    assert len(icons) == 1
    assert result[SOURCE.lower()]["source_metadatum"]["bundle_icon_url"].endswith(
        "/patches-bundle.png"
    )


@pytest.mark.parametrize("legacy", [False, True])
def test_fast_restore_keeps_app_metadata_for_snapshots_without_app_index(
    tmp_path, monkeypatch, legacy
):
    memory = MemoryCloud(tmp_path)
    original = tmp_path / "original"
    monkeypatch.setattr(cloud, "ROOT", original)
    catalog(original)
    manifest_path = original / "database/manifest.json"
    manifest = json.loads(manifest_path.read_bytes())
    snapshot = original / "database" / manifest["snapshot"]
    (snapshot / "apps.json").unlink()
    manifest["files"].pop("apps.json")
    digests = {name: row["sha256"] for name, row in manifest["files"].items()}
    digests["history.json"] = hashlib.sha256((snapshot / "history.json").read_bytes()).hexdigest()
    generation = hashlib.sha256(db.encoded(digests)).hexdigest()[:24]
    manifest.update(generation=generation, snapshot="snapshots/" + generation)
    snapshot.rename(original / "database" / manifest["snapshot"])
    manifest_path.write_bytes(db.encoded(manifest))
    stamp = "2030-01-01T00:00:00+00:00"
    metadata = {
        "apps": {"com.video": {"app_name": "Saved app name", "checked_at": stamp}},
        "fdroid": {"checked_at": stamp},
        "izzyondroid": {"checked_at": stamp},
    }
    (original / "database/app-metadata.json").write_bytes(cloud.encode(metadata))
    memory.publish()
    document = memory.document(memory.active())
    if legacy:
        document.pop("refresh_inputs")
    fresh = tmp_path / "fresh"
    shutil.copytree(original / "config", fresh / "config")
    (fresh / "database").mkdir()
    (fresh / "database/app-metadata.json").write_bytes(cloud.encode(metadata))
    monkeypatch.setattr(cloud, "ROOT", fresh)
    del memory._transfers
    memory.download_catalog(document, refresh_inputs=True)
    with httpx.Client(
        transport=httpx.MockTransport(
            lambda request: pytest.fail("Cached app unexpectedly needed a network request")
        )
    ) as client:
        result = apps.refresh(fresh, client)
    assert result["apps"]["com.video"]["app_name"] == "Saved app name"


@pytest.mark.parametrize("omitted", [("packages.json",), ("bundles.json", "packages.json")])
def test_fast_restore_accepts_older_compact_archives(tmp_path, monkeypatch, omitted):
    memory = MemoryCloud(tmp_path)
    original = tmp_path / "original"
    monkeypatch.setattr(cloud, "ROOT", original)
    catalog(original)
    memory.publish()
    document = memory.document(memory.active())
    entries = memory.refresh_entries(document)
    prefix = "database/" + document["manifest"]["snapshot"] + "/"
    for name in omitted:
        entries.pop(prefix + name)
    body = pack_refresh(entries, document["manifest"]["generation"])
    digest = hashlib.sha256(body).hexdigest()
    document["refresh_inputs"] = digest
    memory.objects["objects/" + digest] = body
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    monkeypatch.setattr(cloud, "ROOT", fresh)
    del memory._transfers
    memory.download_catalog(document, refresh_inputs=True)
    for name in omitted:
        payload = (fresh / prefix / name).read_bytes()
        assert hashlib.sha256(payload).hexdigest() == document["files"][name]
    assert memory.transfers().metrics["object_downloads"] == 2 + len(omitted)


@pytest.mark.parametrize("remote_state", ["present", "missing", "corrupt"])
def test_cached_upload_hint_checks_remote_bytes_before_skipping_put(tmp_path, remote_state):
    body = b"immutable object"
    digest = hashlib.sha256(body).hexdigest()
    key = "objects/" + digest
    objects = {} if remote_state == "missing" else {
        key: body if remote_state == "present" else b"corrupt"
    }
    reads, writes = [], []

    def get(name):
        reads.append(name)
        return objects[name]

    def put(name, content):
        writes.append(name)
        objects[name] = content

    cache = BlobCache(tmp_path, get, put)
    # Even a corrupt local hint cannot establish that remote content exists.
    cache.remember(digest, b"untrusted local hint")
    known = set()
    cache.parallel(lambda _: cache.upload(body, known), range(12))
    assert reads == [key]
    assert writes == ([] if remote_state == "present" else [key])
    assert objects[key] == body
    assert cache.read(digest) == body
    assert known == {digest}


def test_new_upload_does_not_probe_r2_without_a_cached_hint(tmp_path):
    writes = []
    cache = BlobCache(
        tmp_path,
        lambda key: pytest.fail("New content should go straight to PUT"),
        lambda key, body: writes.append(body),
    )
    cache.upload(b"new content", set())
    assert writes == [b"new content"]


@pytest.mark.parametrize("write_fails", [False, True])
def test_failed_remote_probe_falls_back_to_upload(tmp_path, write_fails):
    body = b"immutable"
    digest = hashlib.sha256(body).hexdigest()
    known = set()
    calls = []

    def get(key):
        raise RuntimeError("R2 unavailable")

    def put(key, content):
        calls.append(content)
        if write_fails:
            raise RuntimeError("R2 write unavailable")

    cache = BlobCache(tmp_path, get, put)
    cache.remember(digest, body)
    if write_fails:
        with pytest.raises(RuntimeError, match="R2 write unavailable"):
            cache.upload(body, known)
        assert known == set()
    else:
        cache.upload(body, known)
        assert known == {digest}
    assert calls == [body]
