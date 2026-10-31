"""Write-volume regressions use the real SQLite schema and in-memory R2."""

import json

import pytest
from test_cloudflare_catalog import MemoryCloud, archive, catalog, release

from scripts import cloudflare_catalog as cloud


@pytest.mark.parametrize("complete", [False, True], ids=["partial-batch", "all-batches"])
def test_retry_reuses_staged_rows_without_deleting_or_reinserting_them(
    tmp_path, monkeypatch, complete
):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    active = memory.active()
    archive(tmp_path, [release(1, body="Changed original notes")])
    insert = memory.insert_rows

    def interrupted(rows):
        insert(rows if complete else rows[:1])
        raise RuntimeError("Interrupted after D1 write")

    monkeypatch.setattr(memory, "insert_rows", interrupted)
    with pytest.raises(RuntimeError, match="Interrupted after D1 write"):
        memory.publish()
    assert memory.active() == active
    staging = memory.sql("SELECT seq FROM catalog_generations WHERE status='staging'")[0]["seq"]
    saved = memory.sql(
        "SELECT rowid,* FROM catalog_records WHERE from_seq=? ORDER BY rowid", [staging]
    )
    assert saved
    memory.verify_database(active["seq"], memory.document(active))

    # SQLite triggers count actual writes, so ignored INSERT attempts don't
    # masquerade as savings. Observe mutations only on already-staged rows.
    memory.database.executescript(
        "CREATE TABLE repeated_writes(operation TEXT);"
        "CREATE TRIGGER count_repeat_delete AFTER DELETE ON catalog_records "
        f"WHEN OLD.from_seq={staging} BEGIN "
        "INSERT INTO repeated_writes VALUES('delete'); END;"
        "CREATE TRIGGER count_repeat_insert AFTER INSERT ON catalog_records "
        f"WHEN NEW.from_seq={staging} BEGIN "
        "INSERT INTO repeated_writes VALUES('insert'); END;"
        "CREATE TRIGGER count_repeat_update AFTER UPDATE ON catalog_records "
        f"WHEN OLD.from_seq={staging} BEGIN "
        "INSERT INTO repeated_writes VALUES('update'); END;"
    )
    monkeypatch.setattr(memory, "insert_rows", insert)
    memory.publish()
    assert memory.active()["seq"] == staging
    assert memory.sql(
        "SELECT rowid,* FROM catalog_records WHERE rowid IN "
        "(SELECT value FROM json_each(?)) ORDER BY rowid",
        [json.dumps([row["rowid"] for row in saved])],
    ) == saved
    assert not memory.sql("SELECT * FROM repeated_writes WHERE operation='delete'")
    assert not memory.sql("SELECT * FROM repeated_writes WHERE operation='update'")
    expected = memory.sql(
        "SELECT COUNT(*) AS n FROM catalog_records WHERE from_seq=?", [staging]
    )[0]["n"] - len(saved)
    assert len(memory.sql("SELECT * FROM repeated_writes WHERE operation='insert'")) == expected
    memory.verify_database(staging, memory.document(memory.active()))


@pytest.mark.parametrize("damage", ["hash", "data", "extra", "missing", "boundary"])
def test_resumed_publication_repairs_damaged_staging_before_activation(
    tmp_path, monkeypatch, damage
):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    active = memory.active()
    archive(tmp_path, [release(1, body="Changed notes")])
    insert = memory.insert_rows

    def interrupted(rows):
        insert(rows)
        raise RuntimeError("Interrupted")

    monkeypatch.setattr(memory, "insert_rows", interrupted)
    with pytest.raises(RuntimeError, match="Interrupted"):
        memory.publish()
    staging = memory.sql("SELECT seq FROM catalog_generations WHERE status='staging'")[0]["seq"]
    if damage == "hash":
        memory.sql("UPDATE catalog_records SET content_hash='corrupt' WHERE from_seq=?", [staging])
    elif damage == "data":
        memory.sql("UPDATE catalog_records SET data='{}' WHERE from_seq=?", [staging])
    elif damage == "extra":
        memory.insert_rows = insert
        memory.insert_rows([("source", "unexpected", staging, "{}", "unexpected")])
    elif damage == "boundary":
        memory.sql("UPDATE catalog_records SET to_seq=NULL WHERE to_seq=?", [staging])
    else:
        memory.sql("DELETE FROM catalog_records WHERE from_seq=?", [staging])
    monkeypatch.setattr(memory, "insert_rows", insert)
    memory.publish()
    assert memory.active()["seq"] == staging
    document = memory.document(memory.active())
    memory.verify_database(staging, document)
    expected = {
        (row["kind"], row["key"]): memory.storage_row(row["kind"], row["data"])
        for row in memory.read_records(document)
    }
    actual = {
        (row["kind"], row["record_key"]): row["data"]
        for row in memory.sql(
            "SELECT kind,record_key,data FROM catalog_records WHERE from_seq<=?"
            " AND (to_seq IS NULL OR to_seq>?)",
            [staging, staging],
        )
    }
    assert actual == expected
    memory.verify_database(active["seq"], memory.document(active))
