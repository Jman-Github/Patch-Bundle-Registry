import httpx
import pytest

from scripts import cloudflare_catalog as module


class Client:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.calls = 0

    def request(self, *args, **kwargs):
        self.calls += 1
        result = next(self.responses)
        if isinstance(result, Exception):
            raise result
        return result


def cloud(monkeypatch, responses):
    obj = module.Cloud.__new__(module.Cloud)
    obj.http = Client(responses)
    monkeypatch.setattr(module.random, "uniform", lambda low, high: 0)
    monkeypatch.setattr(module.time, "sleep", lambda seconds: None)
    return obj


def success():
    return httpx.Response(200, json={"success": True, "result": []})


def test_safe_reads_retry_transient_transport_errors(monkeypatch):
    obj = cloud(monkeypatch, [httpx.ReadTimeout("temporary"), success()])
    assert obj.api("GET", "/test") == []
    assert obj.http.calls == 2


def test_idempotent_d1_requests_retry_without_duplicating_uncertain_writes(monkeypatch):
    obj = cloud(monkeypatch, [httpx.RemoteProtocolError("temporary"), success()])
    assert obj.api("POST", "/query", retry_safe=True) == []
    assert obj.http.calls == 2


def test_unknown_mutation_outcome_is_not_blindly_retried(monkeypatch):
    obj = cloud(monkeypatch, [httpx.ReadTimeout("uncertain"), success()])
    with pytest.raises(RuntimeError, match="uncertain write"):
        obj.api("POST", "/create")
    assert obj.http.calls == 1


def test_transport_retries_stop_after_five_attempts(monkeypatch):
    obj = cloud(monkeypatch, [httpx.ConnectError("temporary")] * 5)
    with pytest.raises(RuntimeError, match="Cloudflare connection failed"):
        obj.api("GET", "/test")
    assert obj.http.calls == 5


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_exhausted_http_retries_report_the_final_status(monkeypatch, status):
    obj = cloud(monkeypatch, [httpx.Response(503)] * 4 + [httpx.Response(status)])
    with pytest.raises(RuntimeError) as error:
        obj.api("GET", "/test")
    assert str(error.value) == f"Cloudflare API retries exhausted (HTTP {status})"
    assert obj.http.calls == 5


def test_long_cooldown_does_not_block_runner_indefinitely(monkeypatch):
    obj = cloud(monkeypatch, [httpx.Response(429, headers={"Retry-After": "3600"})])
    with pytest.raises(RuntimeError, match="cooldown"):
        obj.api("GET", "/test")
    assert obj.http.calls == 1
