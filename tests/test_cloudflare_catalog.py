import json
import sqlite3

import pytest
from test_generate_database import db, fixture

from scripts import cloudflare_catalog as cloud
from scripts.release_archive import reconcile_archive

SOURCE = "https://github.com/owner/demo"


def archive(root, releases):
    path = root / "config/sources.json"
    inventory = json.loads(path.read_text()) if path.exists() else {"demo": {"patches": SOURCE}}
    return reconcile_archive(
        root, inventory, {SOURCE.lower(): releases, "https://gitlab.com/team/empty": []}
    )


def release(index, **extra):
    return {
        "id": index,
        "tag_name": "v" + str(index),
        "body": "# Notes\n\n**original**",
        "published_at": "2026-01-01T00:00:00Z",
        "prerelease": index % 2 == 1,
        "assets": [
            {"name": "patch.rvp", "browser_download_url": "https://test/patch.rvp", "size": 123}
        ],
        **extra,
    }


def test_full_metadata_survives_deletion_edits_and_source_removal(tmp_path):
    first = archive(tmp_path, [release(index) for index in range(237)])
    assert len(first["releases"]) == 237
    row = next(row for row in first["releases"].values() if row["upstream_id"] == "1")
    identity = row["id"]
    edited = archive(tmp_path, [release(1, body="# Edited\nExact text", prerelease=False)])
    assert edited["releases"][identity]["changelog"] == "# Edited\nExact text"
    assert not edited["releases"][identity]["is_prerelease"]
    assert sum(row["availability"] == "unavailable" for row in edited["releases"].values()) == 236
    removed = reconcile_archive(tmp_path, {}, {})
    assert removed == {"releases": {}, "sources": {}}


def test_failed_inventory_preserves_history_and_unchanged_release_hash(tmp_path):
    first = archive(tmp_path, [release(1)])
    second = archive(tmp_path, [release(1)])
    assert first["releases"] == second["releases"]
    assert first["sources"] == second["sources"]
    failed = reconcile_archive(tmp_path, {"demo": {"patches": SOURCE}}, {})
    assert failed["releases"] == first["releases"]
    assert failed["sources"][SOURCE]["status"] == "incomplete"


class MemoryCloud(cloud.Cloud):
    def __init__(self, root):
        self.database = sqlite3.connect(":memory:")
        self.database.row_factory = sqlite3.Row
        schema = (cloud.ROOT / "worker/migrations/0001_catalog.sql").read_text()
        self.database.executescript(schema)
        from types import SimpleNamespace

        self.objects = {}
        self.bucket = "test"
        self.s3 = SimpleNamespace(
            get_paginator=lambda name: SimpleNamespace(
                paginate=lambda **kwargs: [{"Contents": [{"Key": key} for key in self.objects]}]
            ),
            delete_object=lambda **kwargs: self.objects.pop(kwargs["Key"], None),
            delete_objects=lambda **kwargs: {
                "Deleted": [
                    self.objects.pop(row["Key"], None) for row in kwargs["Delete"]["Objects"]
                ]
            },
        )
        self.fail_insert = False
        self.inserts = 0

    def sql(self, sql, params=()):
        if sql.startswith("INSERT INTO catalog_records"):
            if self.fail_insert:
                raise RuntimeError("Interrupted import")
            self.inserts += 1
        cursor = self.database.execute(sql, params)
        self.database.commit()
        return [dict(row) for row in cursor.fetchall()]

    def put(self, key, body):
        self.objects[key] = body

    def get(self, key):
        return self.objects[key]


def catalog(root):
    fixture(root)
    # This fixture has another configured source without a bundle.
    inventory = json.loads((root / "config/sources.json").read_text())
    releases = {SOURCE: [release(1)], "https://gitlab.com/team/empty": []}
    reconcile_archive(root, inventory, releases)
    db.build_database(root)


def test_publish_is_incremental_verified_and_atomic(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    first = memory.active()
    insert_count = memory.inserts
    memory.publish()
    assert memory.active() == first
    assert memory.inserts == insert_count
    archive(tmp_path, [release(1, body="Changed original notes")])
    memory.fail_insert = True
    with pytest.raises(RuntimeError, match="Interrupted"):
        memory.publish()
    assert memory.active() == first
    memory.fail_insert = False
    memory.publish()
    assert memory.active()["seq"] > first["seq"]
    assert memory.document(memory.active())["complete"]
    assert (
        memory.sql(
            "SELECT COUNT(*) AS n FROM catalog_records WHERE kind='history_release'"
            " AND to_seq IS NULL"
        )[0]["n"]
        == 1
    )


def test_incomplete_inventory_and_corrupt_backup_cannot_publish(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    first = memory.active()
    incomplete = reconcile_archive(tmp_path, {"demo": {"patches": SOURCE}}, {})
    assert incomplete["sources"][SOURCE]["status"] == "incomplete"
    with pytest.raises(ValueError, match="incomplete"):
        memory.publish()
    assert memory.active() == first
    document = memory.document(first)
    memory.objects["objects/" + document["record_blocks"][0]] = b"corrupt"
    with pytest.raises(ValueError, match="integrity"):
        memory.verify_document(document)


def test_publication_after_rollback_uses_newest_physical_versions(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    first = memory.active()
    archive(tmp_path, [release(1, body="second")])
    memory.publish()
    memory.sql("UPDATE catalog_state SET active_seq=? WHERE id=1", [first["seq"]])
    archive(tmp_path, [release(1, body="third")])
    memory.publish()
    seq = memory.active()["seq"]
    rows = memory.sql(
        "SELECT data FROM catalog_records WHERE kind='history_release'"
        " AND from_seq<=? AND (to_seq IS NULL OR to_seq>?)",
        [seq, seq],
    )
    assert len(rows) == 1
    assert json.loads(rows[0]["data"])["changelog"] == "third"


def test_retired_records_and_relationships_remain_recoverable(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    original = memory.read_records(memory.document(memory.active()))
    baseline = {(row["kind"], row["key"]) for row in original if row["kind"] != "refresh_jobs"}
    inventory = json.loads((tmp_path / "config/sources.json").read_bytes())
    from scripts.release_history import save_history

    reconcile_archive(tmp_path, inventory, {SOURCE: [], "https://gitlab.com/team/empty": []})
    save_history(tmp_path, inventory, {SOURCE: [], "https://gitlab.com/team/empty": []})
    db.build_database(tmp_path)
    memory.publish()
    document = memory.document(memory.active())
    records = memory.read_records(document)
    assert baseline <= {(row["kind"], row["key"]) for row in records}
    assert all(row["data"]["enabled"] for row in records if row["kind"] == "source")
    assert all(not row["data"]["is_latest"] for row in records if row["kind"] == "bundle")
    memory.verify_database(memory.active()["seq"], document)


def test_oversized_originals_verify_and_rebuild_from_r2(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    archive(tmp_path, [release(1, body="Original 🌍 notes\n" * 40000)])
    memory.publish()
    document = memory.document(memory.active())
    row = json.loads(
        memory.sql("SELECT data FROM catalog_records WHERE kind='history_release'")[0]["data"]
    )
    assert "document_key" in row
    assert "changelog" not in row
    assert json.loads(memory.get("objects/" + row["document_key"]))["changelog"].startswith(
        "Original 🌍"
    )
    memory.verify_document(document)
    memory.verify_database(memory.active()["seq"], document)
    with pytest.raises(ValueError, match="REBUILD"):
        memory.rebuild(document, None)
    uploads = memory.transfers().metrics["object_uploads"]
    memory.rebuild(document, "REBUILD")
    assert memory.transfers().metrics["object_uploads"] == uploads
    memory.verify_database(1, document)
    # Older backups lack the external-object index, but verification still
    # proves their originals exist before rebuilding.
    legacy = {key: value for key, value in document.items() if key != "record_objects"}
    memory.rebuild(legacy, "REBUILD")
    assert memory.transfers().metrics["object_uploads"] == uploads
    memory.verify_database(1, legacy)
    memory.objects["objects/" + row["document_key"]] = b"corrupt"
    with pytest.raises(ValueError, match="integrity"):
        memory.verify_document(document)


def test_retention_dry_run_and_active_rollback_protection(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    first = memory.active()
    for number in range(2, 5):
        archive(tmp_path, [release(1, body=str(number))])
        memory.publish()
    newest = memory.active()
    monkeypatch.setenv("CATALOG_RETENTION_GENERATIONS", "2")
    memory.sql("UPDATE catalog_state SET active_seq=? WHERE id=1", [first["seq"]])

    class S3:
        def get_paginator(self, name):
            return self

        def paginate(self, **kwargs):
            return [{"Contents": [{"Key": key} for key in memory.objects]}]

        def delete_object(self, **kwargs):
            del memory.objects[kwargs["Key"]]

        def delete_objects(self, **kwargs):
            for row in kwargs["Delete"]["Objects"]:
                del memory.objects[row["Key"]]
            return {}

    memory.s3 = S3()
    memory.bucket = "test"
    before = set(memory.objects)
    memory.prune(None)
    assert set(memory.objects) == before
    memory.prune("PRUNE")
    assert set(memory.objects) < before
    assert memory.active() == first
    for generation in (first, newest):
        document = memory.verify_document(memory.document(generation))
        memory.verify_database(generation["seq"], document)


def test_cloud_refresh_checkpoints_periodically_without_building_or_pushing(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from scripts import run_catalog_refresh as refresh

    uploads = []
    clock = [1000]
    monkeypatch.setattr(refresh, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    monkeypatch.setattr(
        cloud, "Cloud", lambda: SimpleNamespace(checkpoint=lambda: uploads.append(clock[0]))
    )
    monkeypatch.setattr(
        refresh, "build_database", lambda *a, **k: pytest.fail("Cloud checkpoint rebuilt catalog")
    )
    state = refresh.Refresh(tmp_path, cloudflare=True)
    monkeypatch.setattr(state, "push", lambda: pytest.fail("Cloud checkpoint pushed Git"))
    state.checkpoint(force=True)
    clock[0] += 2
    state.checkpoint()
    assert len(uploads) == 1
    clock[0] += 300
    state.checkpoint()
    assert len(uploads) == 2


def test_cloudflare_retries_accept_second_or_date_retry_after(monkeypatch):
    from types import SimpleNamespace

    def response(status, headers=None, body=None):
        return SimpleNamespace(
            status_code=status,
            headers=headers or {},
            is_success=200 <= status < 300,
            json=lambda: body or {},
        )

    cloud_api = cloud.Cloud.__new__(cloud.Cloud)
    replies = [
        response(429, {"Retry-After": "7"}),
        response(503, {"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}),
        response(502, {"Retry-After": "\u0663\u0660"}),
        response(200, body={"success": True, "result": ["ok"]}),
    ]
    cloud_api.http = SimpleNamespace(request=lambda *args, **kwargs: replies.pop(0))
    delays = []
    monkeypatch.setattr(cloud.time, "sleep", delays.append)
    assert cloud_api.api("GET", "/user") == ["ok"]
    assert delays == [7, 2, 4]


def test_checkpoint_validates_json_before_replacing_saved_progress(tmp_path, monkeypatch):
    from scripts.cloudflare_checkpoint import document, payloads

    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    folder = tmp_path / "internal/cache"
    folder.mkdir(parents=True)
    (folder / "valid.json").write_text('{"progress": 1}')
    memory.checkpoint()
    previous = memory.objects["checkpoints/latest.json"]
    entries = payloads(memory, tmp_path, document(memory, tmp_path))
    assert json.loads(entries["internal/cache/valid.json"]) == {"progress": 1}
    (folder / "partial.json").write_text('{"unfinished":')
    with pytest.raises(ValueError):
        memory.checkpoint()
    assert memory.objects["checkpoints/latest.json"] == previous


def test_checkpoint_merges_published_and_unpublished_numeric_ids(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    ids = tmp_path / "database/ids.json"
    ids.parent.mkdir(parents=True)
    saved = {"source": {"first": 1}, "bundle": {"old": 1, "pending": 3}}
    ids.write_text(json.dumps(saved))
    memory.checkpoint()
    current = {"source": {"first": 1, "second": 2}, "bundle": {"old": 1, "new": 2}}
    ids.write_text(json.dumps(current))
    memory.restore_checkpoint()
    assert json.loads(ids.read_text()) == {
        "source": {"first": 1, "second": 2},
        "bundle": {"old": 1, "new": 2, "pending": 3},
    }


@pytest.mark.parametrize("saved", [{"first": 2}, {"other": 1}, {"first": True}])
def test_conflicting_checkpoint_ids_leave_local_files_unchanged(tmp_path, monkeypatch, saved):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    ids = tmp_path / "database/ids.json"
    ids.parent.mkdir(parents=True)
    ids.write_text(json.dumps({"source": saved}))
    cache = tmp_path / "internal/cache/progress.json"
    cache.parent.mkdir(parents=True)
    cache.write_text('{"checkpoint": true}')
    memory.checkpoint()
    ids.write_text('{"source": {"first": 1}}')
    cache.write_text('{"published": true}')
    with pytest.raises(ValueError):
        memory.restore_checkpoint()
    assert json.loads(ids.read_text()) == {"source": {"first": 1}}
    assert json.loads(cache.read_text()) == {"published": True}


@pytest.mark.parametrize("refresh_inputs", [False, True])
def test_rollback_download_reserves_ids_from_newer_ready_generations(
    tmp_path, monkeypatch, refresh_inputs
):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    first = memory.active()
    ids_path = tmp_path / "database/ids.json"
    identifiers = json.loads(ids_path.read_text())
    package_ids = identifiers["package"]
    reserved = max(package_ids.values()) + 1
    package_ids['["com.retained","1.0"]'] = reserved
    ids_path.write_text(json.dumps(identifiers))
    db.build_database(tmp_path)
    memory.publish()
    newest = memory.active()
    assert newest["seq"] > first["seq"]
    memory.sql("UPDATE catalog_state SET active_seq=? WHERE id=1", [first["seq"]])
    ids_path.unlink()  # Simulate a fresh checkout with no recent checkpoint.
    memory.download_catalog(memory.document(first), refresh_inputs=refresh_inputs)
    recovered = json.loads(ids_path.read_text())
    assert recovered["package"]['["com.retained","1.0"]'] == reserved
    assert all(
        recovered[table][key] == value
        for table, mapping in identifiers.items()
        for key, value in mapping.items()
    )


def test_lost_checkpoint_does_not_leave_removed_sources_configured(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    (tmp_path / "internal/cache/history/archive.json").unlink()
    inventory = {"empty-dev": {"patches": "https://gitlab.com/team/empty", "prerelease": True}}
    (tmp_path / "config/sources.json").write_text(json.dumps(inventory))
    reconcile_archive(tmp_path, inventory, {"https://gitlab.com/team/empty": []})
    db.build_database(tmp_path)
    memory.publish()
    records = memory.read_records(memory.document(memory.active()))
    assert not any(item["kind"] == "history_source" and item["key"] == SOURCE for item in records)
    assert not any(item["kind"] == "history_release" for item in records)
    assert len(memory.sql("SELECT * FROM catalog_generations")) == 1


def test_cloud_refresh_stops_if_discovery_crashes_before_reconciliation(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from scripts import run_catalog_refresh as refresh

    catalog(tmp_path)  # A previously complete inventory must not hide the failed new check.
    monkeypatch.setattr(refresh, "restore_catalog_cache", lambda root: None)
    monkeypatch.setattr(
        refresh.subprocess,
        "Popen",
        lambda *a, **k: SimpleNamespace(poll=lambda: 1, returncode=1),
    )
    monkeypatch.setattr(
        refresh.subprocess,
        "run",
        lambda *a, **k: pytest.fail("Refresh continued after failed upstream reconciliation"),
    )
    state = refresh.Refresh(tmp_path, cloudflare=True)
    monkeypatch.setattr(state, "checkpoint", lambda *a, **k: None)
    with pytest.raises(RuntimeError, match="BUNDLES refresh exited"):
        state._run()
    assert state.jobs[0]["status"] == "FAILED"


@pytest.mark.parametrize("previous", ["missing", "removed", "disabled"])
def test_publication_requires_current_enabled_source_coverage(tmp_path, monkeypatch, previous):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    active = memory.active()
    objects = dict(memory.objects)
    path = tmp_path / "config/sources.json"
    inventory = json.loads(path.read_text())
    new_source = "https://github.com/owner/new"
    archive_path = tmp_path / "internal/cache/history/archive.json"
    saved = json.loads(archive_path.read_text())
    if previous != "missing":
        saved["sources"][new_source] = {
            "source_url": new_source,
            "configured": previous == "disabled",
            "required": previous != "disabled",
            "status": previous,
        }
        archive_path.write_text(json.dumps(saved))
    inventory["new"] = {"patches": new_source, "disabled": False}
    path.write_text(json.dumps(inventory))
    db.build_database(tmp_path)
    with pytest.raises(ValueError, match="incomplete"):
        memory.publish()
    assert memory.active() == active
    assert memory.objects == objects
    reconcile_archive(
        tmp_path,
        inventory,
        {
            SOURCE: [release(1)],
            "https://gitlab.com/team/empty": [],
            new_source: [],
        },
    )
    memory.publish()
    assert memory.document(memory.active())["complete"] is True


def test_repaired_public_inventory_does_not_restore_old_helpers_from_d1(tmp_path, monkeypatch):
    from test_generate_database import write

    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    folder = tmp_path / "internal/cache/bundles/demo-patch-bundles"
    helper = {"name": None, "compatiblePackages": {"com.helper.only": None}}
    for repaired in (False, True):
        for channel in ("latest", "stable"):
            path = folder / f"demo-{channel}-patches-list.json"
            payload = db.read_json(path)
            if repaired:
                payload["patches"][0]["loader_excluded"] = True
            else:
                payload["patches"].insert(0, helper.copy())
            write(path, payload)
            status_path = folder / f"demo-{channel}-extraction.json"
            status = db.read_json(status_path)
            status.update(patch_list_hash=db.digest(path.read_bytes()),
                          completeness_version=4 if repaired else 0)
            write(status_path, status)
        db.build_database(tmp_path, restore=False)
        memory.publish()
        records = memory.read_records(memory.document(memory.active()))
        patches = [row["data"] for row in records if row["kind"] == "patch"]
        if not repaired:
            assert len(patches) == 2
            named_id = next(p["id"] for p in patches if p["name"])
        else:
            assert len(patches) == 1 and patches[0]["name"] == "Hide ads"
            assert patches[0]["id"] == named_id
            assert all(row["data"]["name"] != "com.helper.only"
                       for row in records if row["kind"] == "package")
            assert all(row["key"] != "com.helper.only"
                       for row in records if row["kind"] == "app")
            memory.verify_database(memory.active()["seq"], memory.document(memory.active()))


@pytest.mark.parametrize(
    "family,completeness", [("ReVanced:v22", 0), ("Reseam", 1), ("Morphe:V1", 4)]
)
def test_verified_repair_replaces_obsolete_compatibility_relationships(
    tmp_path, monkeypatch, family, completeness
):
    from test_generate_database import write

    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    folder = tmp_path / "internal/cache/bundles/demo-patch-bundles"
    for channel in ("latest", "stable"):
        raw_path = folder / f"demo-{channel}-patches-bundle.json"
        raw = db.read_json(raw_path)
        raw["bundle_type"] = family
        write(raw_path, raw)
        status_path = folder / f"demo-{channel}-extraction.json"
        status = db.read_json(status_path)
        status["completeness_version"] = completeness
        write(status_path, status)
    db.build_database(tmp_path, restore=False)
    memory.publish()
    for channel in ("latest", "stable"):
        patch_path = folder / f"demo-{channel}-patches-list.json"
        payload = db.read_json(patch_path)
        payload["patches"][0]["compatiblePackages"] = {"com.video": ["1.0"]}
        write(patch_path, payload)
        status_path = folder / f"demo-{channel}-extraction.json"
        status = db.read_json(status_path)
        status.update(
            patch_list_hash=db.digest(patch_path.read_bytes()), completeness_version=completeness
        )
        write(status_path, status)
    db.build_database(tmp_path, restore=False)
    memory.publish()
    records = memory.read_records(memory.document(memory.active()))
    packages = [item["data"] for item in records if item["kind"] == "package"]
    assert [(row["name"], row["version"]) for row in packages] == [("com.video", "1.0")]
    associations = [item["data"] for item in records if item["kind"] == "patch_package"]
    assert len(associations) == 1
    memory.verify_database(memory.active()["seq"], memory.document(memory.active()))


def test_reseam_internal_patches_are_superseded_and_never_retained(tmp_path, monkeypatch):
    from test_generate_database import write

    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    folder = tmp_path / "internal/cache/bundles/demo-patch-bundles"
    for channel in ("latest", "stable"):
        raw_path = folder / f"demo-{channel}-patches-bundle.json"
        raw = db.read_json(raw_path)
        raw["bundle_type"] = "Reseam"
        write(raw_path, raw)
        status_path = folder / f"demo-{channel}-extraction.json"
        status = db.read_json(status_path)
        status["completeness_version"] = 1
        write(status_path, status)
    db.build_database(tmp_path, restore=False)
    memory.publish()

    bundles = memory.sql("SELECT record_key FROM catalog_records WHERE kind='bundle'")
    bundle_id = bundles[0]["record_key"]
    internal_row = {
        "kind": "patch",
        "key": f"{bundle_id}:internal",
        "data": {
            "id": f"{bundle_id}:internal",
            "bundle_id": bundle_id,
            "name": "internal.patch",
            "hidden": True,
        },
    }
    memory.sql(
        "INSERT INTO catalog_records(kind, record_key, from_seq, to_seq, data, content_hash) "
        "VALUES('patch', ?, 1, NULL, ?, 'digest')",
        [
            internal_row["key"],
            json.dumps(internal_row["data"]),
        ],
    )
    first_gen = memory.active()["generation"]
    original_read_records = memory.read_records

    def mock_read_records(doc):
        rows = original_read_records(doc)
        if doc["manifest"]["generation"] == first_gen:
            return [*rows, internal_row]
        return rows

    monkeypatch.setattr(memory, "read_records", mock_read_records)
    archive(tmp_path, [release(1, body="New release notes")])
    memory.publish()
    records = memory.read_records(memory.document(memory.active()))
    patch_keys = [item["key"] for item in records if item["kind"] == "patch"]
    assert f"{bundle_id}:internal" not in patch_keys
    d1_patches = memory.sql(
        "SELECT record_key, data FROM catalog_records WHERE kind='patch' AND to_seq IS NULL"
    )
    assert all("internal.patch" not in row["data"] for row in d1_patches)

