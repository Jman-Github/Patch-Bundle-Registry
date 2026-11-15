import json
from itertools import pairwise

import httpx
import pytest
from test_cloudflare_api_retries import cloud as api_cloud
from test_cloudflare_api_retries import success
from test_cloudflare_catalog import MemoryCloud
from test_cloudflare_cleanup import expected_cleanup, record_versions, seed_versions

from scripts import cloudflare_catalog as cloud
from scripts.cloudflare_http import is_d1_overloaded


@pytest.fixture
def clock(monkeypatch):
    state = {"now": 100.0, "sleeps": []}

    def sleep(delay):
        state["sleeps"].append(delay)
        state["now"] += delay

    monkeypatch.setattr(cloud.time, "monotonic", lambda: state["now"])
    monkeypatch.setattr(cloud.time, "sleep", sleep)
    return state


@pytest.mark.parametrize("matches", [False, True])
def test_cleanup_paces_scan_pages_and_mutation_batches(tmp_path, monkeypatch, clock, matches):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    monkeypatch.setattr(cloud, "D1_CLEANUP_SCAN_SIZE", 4)
    monkeypatch.setattr(cloud, "D1_CLEANUP_BATCH_SIZE", 2)
    # Re-enable the real pacing wrapper, disabled by the shared SQLite fixture.
    memory.cleanup_query = cloud.Cloud.cleanup_query.__get__(memory)
    seed_versions(memory, [(i + 1, 1, 2 if matches else None) for i in range(11)])
    statement, params = "DELETE FROM catalog_records WHERE to_seq<=?", [2]
    expected = expected_cleanup(memory, statement, params)
    sql = memory.sql
    starts, mutations = [], []

    def query(statement, params=()):
        starts.append(clock["now"])
        if statement.startswith("DELETE"):
            mutations.extend(json.loads(params[-1]))
        return sql(statement, params)

    memory.sql = query
    memory.cleanup_records(statement, params)
    assert len(starts) >= 3
    assert all(b - a >= 1 for a, b in pairwise(starts))
    assert record_versions(memory.database) == expected
    assert mutations == (list(range(1, 12)) if matches else [])
    # Pacing carries over to a second cleanup, including when there are no matches.
    memory.cleanup_records(statement, params)
    assert all(b - a >= 1 for a, b in pairwise(starts))


def test_cleanup_pacing_counts_execution_time_and_failures(clock):
    instance = cloud.Cloud.__new__(cloud.Cloud)
    starts = []

    def sql(*args):
        starts.append(clock["now"])
        clock["now"] += 3
        if len(starts) == 1:
            raise RuntimeError("Uncertain response")
        return []

    instance.sql = sql
    with pytest.raises(RuntimeError, match="Uncertain"):
        instance.cleanup_query("SELECT", [])
    assert instance.cleanup_query("SELECT", []) == []
    clock["now"] += 5  # Time outside cleanup already satisfies the pause.
    assert instance.cleanup_query("SELECT", []) == []
    assert starts == [100, 104, 112]
    assert clock["sleeps"] == [1]


@pytest.mark.parametrize("code", [7429, "7429"])
def test_d1_overload_waits_a_full_resource_window_and_then_recovers(monkeypatch, code):
    response = httpx.Response(429, json={"errors": [{"code": code, "message": "overloaded"}]})
    instance = api_cloud(monkeypatch, [response, success()])
    delays = []
    monkeypatch.setattr(cloud.time, "sleep", delays.append)
    instance.api("POST", "/d1/database/offline/query", retry_safe=True)
    assert delays == [11]
    assert instance.http.calls == 2


@pytest.mark.parametrize("hint,expected", [
    ("0", [11.5, 22.5, 44.5, 60]), ("30", [30, 30, 44.5, 60]),
])
def test_d1_overload_backoff_is_bounded_and_honors_retry_after(monkeypatch, hint, expected):
    response = httpx.Response(429, headers={"Retry-After": hint}, json={
        "errors": [{"code": 7429}]
    })
    instance = api_cloud(monkeypatch, [response] * 5)
    delays = []
    monkeypatch.setattr(cloud.time, "sleep", delays.append)
    monkeypatch.setattr(cloud.random, "uniform", lambda low, high: .5)
    with pytest.raises(RuntimeError, match="7429"):
        instance.api("POST", "/d1/database/offline/query", retry_safe=True)
    assert delays == expected
    assert instance.http.calls == 5


@pytest.mark.parametrize("response", [
    httpx.Response(429, json={"errors": [{"code": 123, "message": "7429"}]}),
    httpx.Response(429, text="7429"),
    httpx.Response(429, json={"errors": "7429"}),
    httpx.Response(429, json=[]),
    httpx.Response(503, json={"errors": [{"code": 7429}]}),
])
def test_other_errors_do_not_get_d1_overload_cooldown(monkeypatch, response):
    assert not is_d1_overloaded(response)
    instance = api_cloud(monkeypatch, [response, success()])
    delays = []
    monkeypatch.setattr(cloud.time, "sleep", delays.append)
    instance.api("POST", "/d1/database/offline/query", retry_safe=True)
    assert delays == [1]


def test_overload_cooldown_does_not_enable_unsafe_write_retries(monkeypatch):
    instance = api_cloud(monkeypatch, [httpx.Response(503, json={
        "errors": [{"code": 7429}]
    })])
    with pytest.raises(RuntimeError, match="uncertain"):
        instance.api("POST", "/d1/database/offline/query")
    assert instance.http.calls == 1


def test_long_retry_after_still_stops_without_retrying_early(monkeypatch):
    instance = api_cloud(monkeypatch, [httpx.Response(429, headers={"Retry-After": "61"}, json={
        "errors": [{"code": 7429}]
    })])
    with pytest.raises(RuntimeError, match="cooldown"):
        instance.api("POST", "/d1/database/offline/query", retry_safe=True)
    assert instance.http.calls == 1


def test_overload_code_on_other_api_paths_uses_normal_backoff(monkeypatch):
    instance = api_cloud(monkeypatch, [
        httpx.Response(429, json={"errors": [{"code": 7429}]}), success()
    ])
    delays = []
    monkeypatch.setattr(cloud.time, "sleep", delays.append)
    instance.api("GET", "/r2/buckets")
    assert delays == [1]
