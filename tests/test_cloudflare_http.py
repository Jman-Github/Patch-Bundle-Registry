from email.utils import formatdate
from types import SimpleNamespace

import httpx
import pytest
from test_cloudflare_api_retries import cloud, success

from scripts import cloudflare_catalog as module
from scripts import cloudflare_http as helpers


@pytest.mark.parametrize("header,expected", [
    ("2.5", 2.5), (".5", .5), ("0", 0), ("-1", 0), ("NaN", 0),
    ("Infinity", 0), ("\uff11\uff12", 0), ("nonsense", 0),
])
def test_retry_after_numeric_and_invalid_values(header, expected):
    assert helpers.retry_after(header) == expected


def test_retry_after_http_dates(monkeypatch):
    monkeypatch.setattr(helpers.time, "time", lambda: 1000)
    assert helpers.retry_after(formatdate(1012, usegmt=True)) == 12
    assert helpers.retry_after(formatdate(999, usegmt=True)) == 0


@pytest.mark.parametrize("header,expected", [("2.5", 2.5), ("bad", 1.25)])
def test_retry_delay_honors_hint_and_adds_bounded_jitter(monkeypatch, header, expected):
    obj = cloud(monkeypatch, [httpx.Response(429, headers={"Retry-After": header}), success()])
    delays = []
    monkeypatch.setattr(module.time, "sleep", delays.append)
    monkeypatch.setattr(module.random, "uniform", lambda low, high: .25)
    obj.api("GET", "/query")
    assert delays == [expected]


def test_long_http_date_cooldown_stops_without_retrying_early(monkeypatch):
    monkeypatch.setattr(helpers.time, "time", lambda: 1000)
    obj = cloud(monkeypatch, [
        httpx.Response(429, headers={"Retry-After": formatdate(1100, usegmt=True)})
    ])
    with pytest.raises(RuntimeError, match="cooldown"):
        obj.api("GET", "/query")
    assert obj.http.calls == 1


def test_errors_and_retry_headers_survive_exhaustion_without_credentials(monkeypatch, capsys):
    secret = "private-cloudflare-credential"  # noqa: S105
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", secret)
    response = httpx.Response(429, headers={
        "Retry-After": "0", "CF-Ray": "trace-id", "Authorization": "never-log-this",
        "X-RateLimit-Remaining": "0"
    }, json={
        "errors": [{"code": 10000, "message": "Rate limit: " + secret}],
        "request": {"sql": "never-log-sql"},
    })
    obj = cloud(monkeypatch, [response] * 5)
    with pytest.raises(RuntimeError) as failure:
        obj.api("POST", "/query", retry_safe=True, json={"params": [secret]})
    text = str(failure.value) + capsys.readouterr().out
    assert "10000" in text and "Rate limit" in text and "trace-id" in text
    assert secret not in text and "never-log-this" not in text and "never-log-sql" not in text
    assert "[REDACTED]" in text
    assert "x-ratelimit-remaining" in text
    assert obj.http.calls == 5


@pytest.mark.parametrize("response", [
    httpx.Response(400, text="<html>private raw response</html>"),
    httpx.Response(400, json={"errors": "malformed"}),
    httpx.Response(400, json=[]),
])
def test_nonstandard_error_bodies_do_not_mask_http_failure(monkeypatch, response):
    obj = cloud(monkeypatch, [response])
    with pytest.raises(RuntimeError, match="HTTP 400"):
        obj.api("GET", "/query")


def test_unsuccessful_json_response_reports_cloudflare_error(monkeypatch):
    obj = cloud(monkeypatch, [httpx.Response(200, json={
        "success": False, "errors": [{"code": 123, "message": "Quota exhausted"}]
    })])
    with pytest.raises(RuntimeError, match="Quota exhausted"):
        obj.api("GET", "/query")


def test_enormous_numeric_cooldown_is_not_retried_early(monkeypatch):
    obj = cloud(monkeypatch, [httpx.Response(429, headers={"Retry-After": "9" * 400})])
    with pytest.raises(RuntimeError, match="cooldown"):
        obj.api("GET", "/query")
    assert obj.http.calls == 1


def test_bearer_credentials_are_redacted_without_environment_hint():
    assert helpers.safe_diagnostic("Authorization: Bearer unconfigured-credential") == (
        "Authorization: Bearer [REDACTED]"
    )


@pytest.mark.parametrize("failure", [
    {"errors": [{"code": 7500, "message": "Query limit: test-private-credential"}]},
    {"error": "Query limit: test-private-credential"},
])
def test_failed_d1_result_retains_redacted_details(monkeypatch, failure):
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "test-private-credential")
    obj = cloud(monkeypatch, [httpx.Response(200, json={
        "success": True,
        "result": [{"success": True, "results": []}, {"success": False, **failure}],
    })])
    obj.database = "offline"
    obj.transfers = lambda: SimpleNamespace(add=lambda *args: None)
    with pytest.raises(RuntimeError, match="D1 query failed") as error:
        obj.sql("SELECT ?", ["never-log-parameter"])
    text = str(error.value)
    assert "Query limit" in text and "[REDACTED]" in text
    assert "test-private-credential" not in text and "never-log-parameter" not in text
    if "errors" in failure:
        assert "7500" in text
    assert obj.http.calls == 1
