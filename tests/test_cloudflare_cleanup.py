import json
import sqlite3

import httpx
import pytest
from test_cloudflare_catalog import MemoryCloud, archive, catalog, release

from scripts import cloudflare_catalog as cloud

RESTRICTION = " AND rowid IN (SELECT value FROM json_each(?))"
CLEANUPS = [
    pytest.param("DELETE FROM catalog_records WHERE from_seq=?", (4,), id="abandoned-rows"),
    pytest.param(
        "UPDATE catalog_records SET to_seq=NULL WHERE to_seq=?", (4,), id="abandoned-boundaries"
    ),
    pytest.param(
        "DELETE FROM catalog_records WHERE NOT (from_seq<=? AND (to_seq IS NULL OR to_seq>?))",
        (3, 3),
        id="source-purge",
    ),
    pytest.param(
        "UPDATE catalog_records SET to_seq=NULL WHERE to_seq>?", (3,), id="future-boundaries"
    ),
    pytest.param("DELETE FROM catalog_records WHERE to_seq<=?", (3,), id="retention"),
]
ROW_VERSIONS = [
    (-20, 1, None), (-7, 1, 2), (0, 2, 3), (4, 3, None),
    (15, 4, None), (22, 1, 4), (91, 2, None), (305, 4, None),
    (1001, 1, 3), (1007, 4, 5), (4096, 3, 4), (8191, 5, None),
]


@pytest.fixture
def memory(tmp_path, monkeypatch):
    instance = MemoryCloud(tmp_path)  # Read the real schema before redirecting ROOT.
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    monkeypatch.setenv("CATALOG_RETENTION_GENERATIONS", "8")
    yield instance
    instance.database.close()


def seed_versions(memory, rows=ROW_VERSIONS):
    memory.database.executemany(
        "INSERT INTO catalog_records(rowid,kind,record_key,from_seq,to_seq,data,content_hash)"
        " VALUES(?,'patch',?,?,?,'{}','digest')",
        [(rowid, f"record-{index}", start, end)
         for index, (rowid, start, end) in enumerate(rows)],
    )
    memory.database.commit()


def record_versions(database):
    return [dict(row) for row in database.execute(
        "SELECT rowid,* FROM catalog_records ORDER BY rowid"
    )]


def expected_cleanup(memory, statement, params):
    reference = sqlite3.connect(":memory:")
    reference.row_factory = sqlite3.Row
    try:
        memory.database.backup(reference)
        reference.execute(statement, params)
        return record_versions(reference)
    finally:
        reference.close()


def capture_sql(memory, monkeypatch):
    calls = []
    original = memory.sql

    def sql(statement, params=()):
        calls.append((statement, list(params)))
        return original(statement, params)

    monkeypatch.setattr(memory, "sql", sql)
    return calls


def matching_rows(memory, statement, params):
    # The predicate comes from a fixed cleanup statement; values remain bound.
    predicate = statement.split(" WHERE ", 1)[1]
    return memory.database.execute(
        "SELECT COUNT(*) FROM catalog_records WHERE " + predicate, params  # noqa: S608
    ).fetchone()[0]


def interrupt_cleanup(memory, monkeypatch, prefix, after_write):
    original = memory.sql
    matching_batches = []

    def sql(statement, params=()):
        if statement.startswith(prefix):
            assert statement.endswith(RESTRICTION)
            assert len(json.loads(params[-1])) <= cloud.D1_CLEANUP_BATCH_SIZE
            if matching_rows(memory, statement, params):
                matching_batches.append(list(params))
                if len(matching_batches) == 2:
                    if after_write:
                        original(statement, params)
                    raise RuntimeError("Interrupted cleanup")
        return original(statement, params)

    monkeypatch.setattr(memory, "sql", sql)
    return original, matching_batches


def add_staging_versions(memory, active):
    abandoned = active["seq"] + 1
    memory.sql(
        "INSERT INTO catalog_generations(seq,generation,manifest_key,status)"
        " VALUES(?,?,?,'staging')",
        [abandoned, "f" * 24, "generations/" + "f" * 24 + ".json"],
    )
    rows = memory.read_records(memory.document(active))[:7]
    assert len(rows) == 7
    changed = [{**row["data"], "unpublished": True} for row in rows]
    memory.insert_rows([
        (row["kind"], row["key"], abandoned, cloud.encode(data).decode(), cloud.record_hash(data))
        for row, data in zip(rows, changed, strict=True)
    ])
    return abandoned


@pytest.mark.parametrize("statement,params", CLEANUPS)
def test_cleanup_matches_unbounded_sql_using_fixed_rowid_pages(
    memory, monkeypatch, statement, params
):
    monkeypatch.setattr(cloud, "D1_CLEANUP_BATCH_SIZE", 3)
    monkeypatch.setattr(cloud, "D1_CLEANUP_SCAN_SIZE", 5)
    seed_versions(memory)
    expected = expected_cleanup(memory, statement, params)
    predicate = statement.split(" WHERE ", 1)[1]
    targets = [
        row[0]
        for row in memory.database.execute(
            "SELECT rowid FROM catalog_records WHERE (" + predicate + ") ORDER BY rowid",  # noqa: S608
            params,
        )
    ]
    calls = capture_sql(memory, monkeypatch)
    memory.cleanup_records(statement, params)
    assert record_versions(memory.database) == expected

    scanned_pages = [ROW_VERSIONS[start:start + 5] for start in range(0, len(ROW_VERSIONS), 5)]
    matched_pages = [[row[0] for row in page if row[0] in targets] for page in scanned_pages]
    pages = [page[start:start + 3] for page in matched_pages for start in range(0, len(page), 3)]
    mutations = [(query, bindings) for query, bindings in calls if query == statement + RESTRICTION]
    assert [json.loads(bindings[-1]) for _, bindings in mutations] == pages
    assert all(bindings[:-1] == list(params) and len(bindings) < 100 for _, bindings in mutations)
    selects = [(query, bindings) for query, bindings in calls
               if query.startswith("SELECT rowid")]
    assert selects == [
        ("SELECT rowid, (" + predicate + ") AS matches FROM catalog_records"  # noqa: S608
         + " ORDER BY rowid LIMIT ?", [*params, 5]),
        *[("SELECT rowid, (" + predicate + ") AS matches FROM catalog_records"  # noqa: S608
           + " WHERE rowid>? ORDER BY rowid LIMIT ?", [*params, page[-1][0], 5])
          for page in scanned_pages[:-1]],
    ]
    assert len(calls) == len(mutations) + len(selects)
    assert memory.transfers().metrics["d1_cleanup_batches"] == len(pages)
    plan = memory.sql("EXPLAIN QUERY PLAN " + mutations[0][0], mutations[0][1])
    assert any("SEARCH catalog_records USING INTEGER PRIMARY KEY" in row["detail"] for row in plan)
    assert not any("SCAN catalog_records" in row["detail"] for row in plan)


@pytest.mark.parametrize("statement,params", CLEANUPS)
def test_empty_cleanup_does_not_issue_mutations(memory, monkeypatch, statement, params):
    calls = capture_sql(memory, monkeypatch)
    memory.cleanup_records(statement, params)
    assert calls == [
        ("SELECT rowid, (" + statement.split(" WHERE ", 1)[1]  # noqa: S608
         + ") AS matches FROM catalog_records ORDER BY rowid LIMIT ?",
         [*params, cloud.D1_CLEANUP_SCAN_SIZE])
    ]
    assert memory.transfers().metrics.get("d1_cleanup_batches", 0) == 0


def test_cleanup_default_batch_size_stays_below_d1_binding_limit(memory, monkeypatch):
    assert cloud.D1_CLEANUP_BATCH_SIZE == 1000
    seed_versions(memory, [(index + 1, 1, 2) for index in range(2501)])
    calls = capture_sql(memory, monkeypatch)
    statement = "DELETE FROM catalog_records WHERE to_seq<=?"
    memory.cleanup_records(statement, [2])
    mutations = [bindings for query, bindings in calls if query == statement + RESTRICTION]
    assert [len(json.loads(bindings[-1])) for bindings in mutations] == [1000, 1000, 501]
    assert all(len(bindings) == 2 for bindings in mutations)
    assert [rowid for bindings in mutations for rowid in json.loads(bindings[-1])] == list(
        range(1, 2502)
    )
    assert record_versions(memory.database) == []
    assert memory.transfers().metrics["d1_cleanup_batches"] == 3


@pytest.mark.parametrize("statement,params", CLEANUPS[:2])
@pytest.mark.parametrize("failure", ["http-503", "read-timeout"])
def test_cleanup_retries_the_same_targets_after_an_uncertain_write(
    memory, monkeypatch, statement, params, failure
):
    monkeypatch.setattr(cloud, "D1_CLEANUP_BATCH_SIZE", 3)
    seed_versions(memory)
    expected = expected_cleanup(memory, statement, params)
    targets = [
        row[0]
        for row in memory.database.execute(
            "SELECT rowid FROM catalog_records WHERE ("  # noqa: S608
            + statement.split(" WHERE ", 1)[1]
            + ") ORDER BY rowid",
            params,
        )
    ]
    calls, failures, delays = [], [], []
    monkeypatch.setattr(cloud.random, "uniform", lambda low, high: 0)
    monkeypatch.setattr(cloud.time, "sleep", delays.append)

    def request(request):
        payload = json.loads(request.content)
        query, bindings = payload["sql"], payload["params"]
        calls.append(payload)
        matched = query == statement + RESTRICTION and matching_rows(memory, query, bindings)
        result = memory.sql(query, bindings)
        if matched and not failures:
            failures.append(len(calls) - 1)
            if failure == "read-timeout":
                raise httpx.ReadTimeout("Write committed, response lost", request=request)
            return httpx.Response(503)
        return httpx.Response(
            200, json={"success": True, "result": [{"success": True, "results": result}]}
        )

    obj = cloud.Cloud.__new__(cloud.Cloud)
    obj.database = "offline"
    obj._transfers = memory.transfers()
    with httpx.Client(
        base_url="https://cloudflare.test", transport=httpx.MockTransport(request)
    ) as client:
        obj.http = client
        obj.cleanup_records(statement, params)
    assert record_versions(memory.database) == expected
    assert len(failures) == 1
    index = failures[0]
    assert calls[index] == calls[index + 1]
    mutations = [payload for payload in calls if payload["sql"] == statement + RESTRICTION]
    pages = [targets[start : start + 3] for start in range(0, len(targets), 3)]
    repeated = json.loads(calls[index]["params"][-1])
    expected_pages = [page for page in pages for _ in range(2 if page == repeated else 1)]
    assert [json.loads(payload["params"][-1]) for payload in mutations] == expected_pages
    assert obj.transfers().metrics["d1_cleanup_batches"] == len(pages)
    assert delays == [1]


@pytest.mark.parametrize("phase", ["rows", "boundaries"])
@pytest.mark.parametrize("after_write", [False, True], ids=["before-write", "after-write"])
def test_interrupted_source_purge_resumes_before_reusing_a_discarded_sequence(
    memory, tmp_path, monkeypatch, phase, after_write
):
    catalog(tmp_path)
    memory.publish()
    active = memory.active()
    abandoned = add_staging_versions(memory, active)
    (tmp_path / "internal/cache/source-removals.json").write_text(
        json.dumps(["https://github.com/owner/unpublished"])
    )
    monkeypatch.setattr(cloud, "D1_CLEANUP_BATCH_SIZE", 3)
    statement, params = (
        (CLEANUPS[2].values[0], [active["seq"], active["seq"]])
        if phase == "rows" else (CLEANUPS[3].values[0], [active["seq"]])
    )
    before = matching_rows(memory, statement, params)
    original, batches = interrupt_cleanup(memory, monkeypatch, statement, after_write)
    with pytest.raises(RuntimeError, match="Interrupted cleanup"):
        memory.publish()
    assert len(batches) == 2
    assert 0 < matching_rows(memory, statement, params) < before
    assert memory.active() == active
    assert memory.document(active)["source_purge_pending"] is True
    memory.verify_document(memory.document(active))
    memory.verify_database(active["seq"], memory.document(active))

    monkeypatch.setattr(memory, "sql", original)
    memory.publish()
    assert memory.active() == active
    assert memory.document(active)["source_purge_pending"] is False
    assert memory.sql("SELECT seq FROM catalog_generations") == [{"seq": active["seq"]}]
    rows = memory.sql("SELECT from_seq,to_seq FROM catalog_records")
    assert all(row["from_seq"] <= active["seq"] and row["to_seq"] is None for row in rows)
    assert not (tmp_path / "internal/cache/source-removals.json").exists()
    archive(tmp_path, [release(1, body="Published after abandoned cleanup")])
    memory.publish()
    assert memory.active()["seq"] == abandoned
    memory.verify_database(abandoned, memory.document(memory.active()))


def test_publication_cleans_abandoned_staging_rows_and_boundaries_in_batches(
    memory, tmp_path, monkeypatch
):
    catalog(tmp_path)
    memory.publish()
    abandoned = add_staging_versions(memory, memory.active())
    monkeypatch.setattr(cloud, "D1_CLEANUP_BATCH_SIZE", 3)
    statements = [CLEANUPS[index].values[0] for index in (0, 1)]
    targets = [
        {row["rowid"] for row in memory.sql(query, [abandoned])}
        for query in (
            "SELECT rowid FROM catalog_records WHERE from_seq=?",
            "SELECT rowid FROM catalog_records WHERE to_seq=?",
        )
    ]
    archive(tmp_path, [release(1, body="Published after staging cleanup")])
    calls = capture_sql(memory, monkeypatch)
    memory.publish()
    assert memory.active()["seq"] == abandoned + 1
    for statement, rowids in zip(statements, targets, strict=True):
        mutations = [bindings for query, bindings in calls if query == statement + RESTRICTION]
        pages = [json.loads(bindings[-1]) for bindings in mutations]
        assert all(0 < len(page) <= 3 for page in pages)
        assert len([page for page in pages if rowids.intersection(page)]) >= 3
    assert not memory.sql("SELECT seq FROM catalog_generations WHERE status='staging'")
    assert not memory.sql(
        "SELECT rowid FROM catalog_records WHERE from_seq=? OR to_seq=?", [abandoned, abandoned]
    )
    memory.verify_database(memory.active()["seq"], memory.document(memory.active()))


@pytest.mark.parametrize("after_write", [False, True], ids=["before-write", "after-write"])
def test_interrupted_retention_finishes_record_cleanup_before_deleting_backups(
    memory, tmp_path, monkeypatch, after_write
):
    catalog(tmp_path)
    for index in range(4):
        archive(tmp_path, [release(1, body=f"Generation {index}")])
        memory.publish()
    generations = memory.sql("SELECT * FROM catalog_generations ORDER BY seq")
    assert len(generations) == 4
    active = memory.active()
    maximum = memory.sql("SELECT MAX(rowid) AS maximum FROM catalog_records")[0]["maximum"]
    seed_versions(memory, [(maximum + index + 1, 1, 2) for index in range(7)])
    objects = dict(memory.objects)
    monkeypatch.setenv("CATALOG_RETENTION_GENERATIONS", "2")
    monkeypatch.setattr(cloud, "D1_CLEANUP_BATCH_SIZE", 3)
    statement, params = CLEANUPS[4].values
    params = [generations[-2]["seq"]]
    before = matching_rows(memory, statement, params)
    original, batches = interrupt_cleanup(memory, monkeypatch, statement, after_write)
    with pytest.raises(RuntimeError, match="Interrupted cleanup"):
        memory.prune("PRUNE")
    assert len(batches) == 2
    assert 0 < matching_rows(memory, statement, params) < before
    assert memory.sql("SELECT * FROM catalog_generations ORDER BY seq") == generations
    assert memory.objects == objects
    assert memory.active() == active
    for generation in generations[-2:]:
        document = memory.verify_document(memory.document(generation))
        memory.verify_database(generation["seq"], document)

    monkeypatch.setattr(memory, "sql", original)
    memory.prune("PRUNE")
    assert matching_rows(memory, statement, params) == 0
    assert memory.sql("SELECT * FROM catalog_generations ORDER BY seq") == generations[-2:]
    assert set(memory.objects) < set(objects)
    assert memory.active() == active
    for generation in generations[-2:]:
        document = memory.verify_document(memory.document(generation))
        memory.verify_database(generation["seq"], document)
