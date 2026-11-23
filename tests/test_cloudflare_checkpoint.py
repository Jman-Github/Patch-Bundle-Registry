import gzip
import io
import json
import tarfile

import pytest
from test_cloudflare_catalog import MemoryCloud

from scripts import cloudflare_catalog as cloud
from scripts import cloudflare_checkpoint as checkpoint


def setup(root, monkeypatch):
    memory = MemoryCloud(root)
    monkeypatch.setattr(cloud, "ROOT", root)
    folder = root / "internal/cache"
    folder.mkdir(parents=True)
    (folder / "one.json").write_text('{"one":1}')
    (folder / "two.json").write_text('{"two":2}')
    return memory, folder


def test_incremental_checkpoint_uploads_only_changed_content_and_complete_manifest(
    tmp_path, monkeypatch
):
    memory, folder = setup(tmp_path, monkeypatch)
    writes = []
    put = memory.put
    memory.put = lambda key, body: (writes.append(key), put(key, body))[-1]
    memory.checkpoint()
    assert 2 <= len(writes) <= 3
    writes.clear()
    memory.checkpoint()
    assert writes == []
    (folder / "one.json").write_text('{"one":3}')
    (folder / "two.json").unlink()
    memory.checkpoint()
    assert len(writes) == 2
    manifest = json.loads(memory.objects[checkpoint.MANIFEST_KEY])
    assert set(manifest["files"]) == {"internal/cache/one.json"}
    (folder / "one.json").write_text("{}")
    memory.restore_checkpoint()
    assert json.loads((folder / "one.json").read_bytes()) == {"one": 3}


def test_interrupted_upload_does_not_replace_complete_checkpoint(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.checkpoint()
    before = memory.objects[checkpoint.MANIFEST_KEY]
    (folder / "one.json").write_text('{"new":1}')
    put = memory.put

    def fail(key, body):
        if key.startswith(checkpoint.PREFIX):
            raise RuntimeError("Interrupted checkpoint")
        put(key, body)

    memory.put = fail
    with pytest.raises(RuntimeError, match="Interrupted"):
        memory.checkpoint()
    assert memory.objects[checkpoint.MANIFEST_KEY] == before
    memory.put = put
    memory.restore_checkpoint()
    assert json.loads((folder / "one.json").read_bytes()) == {"one": 1}


def test_corrupt_incremental_object_leaves_local_state_unchanged(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.checkpoint()
    manifest = json.loads(memory.objects[checkpoint.MANIFEST_KEY])
    digest = manifest["blocks"][checkpoint.bucket("internal/cache/one.json")]
    memory.objects[checkpoint.PREFIX + digest + ".json.gz"] = gzip.compress(b'{"corrupt":true}')
    memory.transfers().path(digest).unlink(missing_ok=True)
    (folder / "one.json").write_text('{"local":true}')
    with pytest.raises(ValueError, match="integrity"):
        memory.restore_checkpoint()
    assert json.loads((folder / "one.json").read_bytes()) == {"local": True}


@pytest.mark.parametrize("name", ["../escape.json", "/escape.json", "config/sources.json",
                                  "internal/cache/../escape.json", "internal\\cache\\bad.json"])
def test_unsafe_incremental_manifest_is_rejected_before_writes(tmp_path, monkeypatch, name):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.objects[checkpoint.MANIFEST_KEY] = json.dumps({
        "format_version": 2, "files": {name: "a" * 64}, "blocks": {}
    }).encode()
    with pytest.raises(ValueError, match="Unsafe"):
        memory.restore_checkpoint()
    assert (folder / "one.json").read_text() == '{"one":1}'


def test_legacy_checkpoint_still_restores_when_new_manifest_is_absent(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        body = b'{"legacy":true}'
        entry = tarfile.TarInfo("internal/cache/legacy.json")
        entry.size = len(body)
        archive.addfile(entry, io.BytesIO(body))
    memory.objects[checkpoint.LEGACY_KEY] = output.getvalue()
    memory.restore_checkpoint()
    assert json.loads((folder / "legacy.json").read_bytes()) == {"legacy": True}


def test_failed_manifest_commit_preserves_previous_checkpoint(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.checkpoint()
    previous = memory.objects[checkpoint.MANIFEST_KEY]
    (folder / "one.json").write_text('{"changed":true}')
    put = memory.put

    def fail(key, body):
        if key == checkpoint.MANIFEST_KEY:
            raise RuntimeError("Manifest commit failed")
        put(key, body)

    memory.put = fail
    with pytest.raises(RuntimeError, match="commit"):
        memory.checkpoint()
    assert memory.objects[checkpoint.MANIFEST_KEY] == previous


def test_checkpoint_blocks_bound_remote_reads_and_reuse_the_existing_object_cache(
    tmp_path, monkeypatch
):
    memory, folder = setup(tmp_path, monkeypatch)
    for index in range(128):
        (folder / f"entry-{index}.json").write_text(json.dumps({"value": index}))
    memory.checkpoint()
    manifest = json.loads(memory.objects[checkpoint.MANIFEST_KEY])
    assert len(manifest["blocks"]) <= 144
    assert len(manifest["files"]) == 130
    reads = []
    get = memory.get
    memory.get = lambda key: (reads.append(key), get(key))[-1]
    memory.restore_checkpoint()
    assert reads == [checkpoint.MANIFEST_KEY]
    assert json.loads((folder / "entry-127.json").read_bytes()) == {"value": 127}


def test_checkpoint_cleanup_evicts_removed_blocks_from_the_local_cache(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.checkpoint()
    previous = checkpoint.document(memory, tmp_path)
    (folder / "one.json").write_text('{"new":true}')
    memory.checkpoint()
    current = checkpoint.retained_keys(memory, tmp_path)
    removed = {
        checkpoint.PREFIX + digest + ".json.gz" for digest in previous["blocks"].values()
    } - current
    assert removed
    for key in removed:
        digest = key[len(checkpoint.PREFIX):-len(".json.gz")]
        assert key not in memory.objects
        assert not memory.transfers().path(digest).exists()
    assert checkpoint.payloads(memory, tmp_path, checkpoint.document(memory, tmp_path))


def test_v2_checkpoint_restores_and_migrates_without_losing_progress(tmp_path, monkeypatch):
    import hashlib

    memory, folder = setup(tmp_path, monkeypatch)
    files, groups = {}, {}
    for path in folder.glob("*.json"):
        name = path.relative_to(tmp_path).as_posix()
        body = path.read_bytes()
        files[name] = hashlib.sha256(body).hexdigest()
        groups.setdefault(checkpoint.bucket(name, 2), {})[name] = body.decode()
    blocks = {}
    for group, entries in groups.items():
        body = checkpoint.encode(entries)
        digest = hashlib.sha256(body).hexdigest()
        blocks[group] = digest
        memory.objects[checkpoint.PREFIX + digest + ".json.gz"] = gzip.compress(body)
    memory.objects[checkpoint.MANIFEST_KEY] = checkpoint.encode(
        {"format_version": 2, "files": files, "blocks": blocks}
    )
    (folder / "one.json").write_text("{}")
    memory.restore_checkpoint()
    assert json.loads((folder / "one.json").read_bytes()) == {"one": 1}
    memory.checkpoint()
    assert checkpoint.document(memory, tmp_path)["format_version"] == 3
    assert checkpoint.payloads(memory, tmp_path, checkpoint.document(memory, tmp_path))
    assert set(memory.objects) == checkpoint.retained_keys(memory, tmp_path)


def test_mutable_proofs_do_not_rewrite_patch_lists_and_cleanup_bounds_storage(
    tmp_path, monkeypatch
):
    memory, folder = setup(tmp_path, monkeypatch)
    patches = folder / "history/demo-patches-list.json"
    patches.parent.mkdir()
    patches.write_text(json.dumps({"patches": [{"name": "Stable", "description": "x" * 100_000}]}))
    proof = folder / "history/demo-extraction.json"
    proof.write_text('{"attempted_at": "before"}')
    memory.checkpoint()
    first = checkpoint.document(memory, tmp_path)
    patch_group = checkpoint.bucket(patches.relative_to(tmp_path).as_posix())
    stable = first["blocks"][patch_group]
    writes = []
    put = memory.put
    memory.put = lambda key, body: (writes.append(key), put(key, body))[-1]
    for index in range(5):
        proof.write_text(json.dumps({"attempted_at": str(index)}))
        memory.checkpoint()
        assert checkpoint.document(memory, tmp_path)["blocks"][patch_group] == stable
        assert set(memory.objects) == checkpoint.retained_keys(memory, tmp_path)
    assert checkpoint.PREFIX + stable + ".json.gz" not in writes
    memory.restore_checkpoint()
    assert json.loads(proof.read_bytes()) == {"attempted_at": "4"}


def test_intermediate_checkpoint_defers_listing_but_can_restore_latest_state(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.checkpoint()
    previous = checkpoint.document(memory, tmp_path)
    orphan = checkpoint.PREFIX + "f" * 64 + ".json.gz"
    memory.objects[orphan] = b"interrupted upload"
    (folder / "one.json").write_text('{"updated":true}')
    listing = memory.s3.get_paginator

    def unexpected_listing(*args, **kwargs):
        pytest.fail("Intermediate checkpoint listed the bucket")

    monkeypatch.setattr(memory.s3, "get_paginator", unexpected_listing)
    memory.checkpoint(cleanup_obsolete=False)
    memory.checkpoint(cleanup_obsolete=False)
    current = checkpoint.document(memory, tmp_path)
    obsolete = set(previous["blocks"].values()) - set(current["blocks"].values())
    assert obsolete
    for digest in obsolete:
        assert checkpoint.PREFIX + digest + ".json.gz" in memory.objects
        assert not memory.transfers().path(digest).exists()
    assert orphan in memory.objects
    (folder / "one.json").write_text("{}")
    memory.restore_checkpoint()
    assert json.loads((folder / "one.json").read_bytes()) == {"updated": True}

    monkeypatch.setattr(memory.s3, "get_paginator", listing)
    memory.checkpoint()
    assert orphan not in memory.objects


def test_orphan_cleanup_retries_without_touching_committed_checkpoint(tmp_path, monkeypatch):
    memory, folder = setup(tmp_path, monkeypatch)
    memory.checkpoint()
    orphan = checkpoint.PREFIX + "f" * 64 + ".json.gz"
    memory.objects[orphan] = b"unfinished upload"
    delete = memory.s3.delete_objects
    memory.s3.delete_objects = lambda **kwargs: {"Errors": [{"Key": orphan}]}
    with pytest.raises(RuntimeError, match="cleanup"):
        memory.checkpoint()
    memory.restore_checkpoint()
    assert json.loads((folder / "one.json").read_bytes()) == {"one": 1}
    memory.s3.delete_objects = delete
    memory.checkpoint()
    assert orphan not in memory.objects
