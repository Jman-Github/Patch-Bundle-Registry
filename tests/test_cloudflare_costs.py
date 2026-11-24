import gzip
import hashlib
import json
from types import SimpleNamespace

from test_cloudflare_catalog import MemoryCloud, archive, catalog, release

from scripts import cloudflare_catalog as cloud
from scripts import generate_database as db
from scripts.cloudflare_storage import BlobCache


def test_generations_store_manifest_digests_once(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    monkeypatch.setenv("CATALOG_COMPACT_GENERATIONS", "true")
    catalog(tmp_path)
    memory.publish()
    active = memory.active()
    stored = json.loads(memory.objects[active["manifest_key"]])
    assert "files" not in stored
    assert set(stored["extra_files"]) == {"history.json"}
    files = cloud.document_files(stored)
    for name, metadata in stored["manifest"]["files"].items():
        assert files[name] == metadata["sha256"]
    # Legacy documents keep their explicit index.
    legacy = {**stored, "files": files}
    legacy.pop("extra_files")
    assert cloud.document_files(legacy) == files
    memory.verify_document(memory.document(active))


def test_new_release_rewrites_only_its_own_patch_blocks(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)

    def patches(bundle, count):
        rows = []
        for index in range(count):
            key = hashlib.sha256(f"{bundle}:{index}".encode()).hexdigest()[:24]
            rows.append({"kind": "patch", "key": key,
                         "data": {"bundle_id": bundle, "description": "Patch " * 40}})
            rows.append({"kind": "patch_package", "key": key + ":1",
                         "data": {"patch_id": key, "package_fk": 1}})
        return rows

    existing = [row for bundle in range(40) for row in patches(f"bundle{bundle}", 50)]
    first = set(memory.upload_records(existing, set()))
    second = memory.upload_records(existing + patches("new-release", 300), set(first))
    # One patch block and one patch-package block hold the new release.
    assert len(set(second) - first) <= 2
    loaded = memory.read_records({"record_blocks": second, "record_block_encoding": "gzip"})
    assert len(loaded) == len(existing) + 600


def test_matching_upload_etag_confirms_objects_without_a_download(tmp_path):
    body = b"immutable object"
    digest = hashlib.sha256(body).hexdigest()
    etag = '"' + hashlib.md5(body, usedforsecurity=False).hexdigest() + '"'
    instance = object.__new__(cloud.Cloud)
    instance.bucket = "test"
    calls = []

    def put_object(**kwargs):
        calls.append(kwargs["Key"])
        return {"ETag": instance.response_etag}

    instance.s3 = SimpleNamespace(put_object=put_object)
    instance.response_etag = etag
    assert instance.put("objects/" + digest, body) is True
    instance.response_etag = '"different"'
    assert instance.put("objects/" + digest, body) is False

    confirmed = BlobCache(tmp_path / "a", lambda key: b"", lambda key, value: True)
    confirmed.upload(body, set())
    assert digest in confirmed.confirmed
    unconfirmed = BlobCache(tmp_path / "b", lambda key: b"", lambda key, value: False)
    unconfirmed.upload(body, set())
    assert digest not in unconfirmed.confirmed


def test_refresh_attempt_alone_keeps_published_bundle_files(tmp_path):
    output = tmp_path / "database"
    previous = "snapshots/" + "a" * 24
    (output / previous).mkdir(parents=True)
    field = "patch_refresh_attempted_at"
    published = [
        {"id": "same", "version": "1", field: "old", "detail_file": "bundles/same.json"},
        {"id": "changed", "version": "1", field: "old", "detail_file": "bundles/changed.json"},
    ]
    (output / previous / "bundles.json").write_bytes(db.encoded(published))
    bundles = {
        "same": {"id": "same", "version": "1", field: "new"},
        "changed": {"id": "changed", "version": "2", field: "new"},
        "added": {"id": "added", "version": "1", field: "new"},
    }
    summaries = [
        {**bundle, "detail_file": f"bundles/{key}.json"} for key, bundle in bundles.items()
    ]
    result = db.stable_refresh_attempts(output, previous, bundles, summaries)
    assert result["same"][field] == "old"
    assert result["changed"][field] == "new"
    assert result["added"][field] == "new"
    # history.json keeps the fresh time from the original bundle objects.
    assert bundles["same"][field] == "new"
    assert {row["id"]: row[field] for row in summaries} == {
        "same": "old", "changed": "new", "added": "new"
    }
    assert db.stable_refresh_attempts(output, "", bundles, summaries) is bundles


def test_record_blocks_stay_gzip_encoded(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    blocks = memory.upload_records(
        [{"kind": "patch", "key": "k", "data": {"bundle_id": "b"}}], set()
    )
    assert json.loads(gzip.decompress(memory.objects["objects/" + blocks[0]]))[0]["key"] == "k"


def test_compact_generations_wait_for_opt_in(monkeypatch):
    monkeypatch.delenv("CATALOG_COMPACT_GENERATIONS", raising=False)
    files = {"a.json": "1" * 64, "history.json": "2" * 64}
    manifest = {"files": {"a.json": {"sha256": "1" * 64}}}
    assert cloud.compact_file_index(files, manifest) == {"files": files}
    monkeypatch.setenv("CATALOG_COMPACT_GENERATIONS", "true")
    assert cloud.compact_file_index(files, manifest) == {"extra_files": {"history.json": "2" * 64}}


def test_publish_trusts_confirmed_uploads_only_after_a_verified_generation(tmp_path, monkeypatch):
    class ConfirmingCloud(MemoryCloud):
        def put(self, key, body):
            super().put(key, body)
            return True

    memory = ConfirmingCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    calls = []
    original = cloud.Cloud.verify_document

    def spy(self, document, skip_digests=(), **kwargs):
        calls.append(set(skip_digests))
        return original(self, document, skip_digests, **kwargs)

    monkeypatch.setattr(cloud.Cloud, "verify_document", spy)
    catalog(tmp_path)
    memory.publish()
    # The first generation has no verified predecessor: run every record check.
    assert calls and all(skip == set() for skip in calls)
    first = len(calls)
    archive(tmp_path, [release(1, body="Changed original notes")])
    memory.publish()
    later = [skip for skip in calls[first:] if skip]
    # Later publications skip downloads for objects whose upload was confirmed.
    assert later
    assert memory.transfers().confirmed <= later[0]
