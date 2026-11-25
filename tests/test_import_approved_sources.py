import json
import sys

import httpx
import pytest

from scripts import import_approved_sources as importer
from scripts.import_approved_sources import add_approved_sources, approved_sources

FEED = "https://scraper.example.com/api/approved"
APPROVAL = {
    "forge": "github",
    "repository": "https://github.com/owner/demo",
    "projectId": 42,
    "tag": "v2",
    "extension": ".mpp",
}


def respond_to_release(request):
    if request.url.path == "/repos/owner/demo":
        return httpx.Response(200, json={"id": 42, "private": False})
    assert request.url.path == "/repos/owner/demo/releases/tags/v2"
    return httpx.Response(
        200,
        json={
            "tag_name": "v2",
            "assets": [{
                "name": "demo.mpp",
                "browser_download_url": "https://github.com/owner/demo/releases/download/v2/demo.mpp",
            }],
        },
    )


def inventory(tmp_path):
    path = tmp_path / "config/sources.json"
    path.parent.mkdir()
    path.write_text(
        '{"demo-stable":{"patches":"https://github.com/old/demo","latest":false}}\n',
        encoding="utf-8",
    )
    return path


def test_dry_run_and_repeat_import_preserve_existing_sources(tmp_path):
    path = inventory(tmp_path)
    before = path.read_bytes()
    with httpx.Client(transport=httpx.MockTransport(respond_to_release)) as client:
        assert add_approved_sources(tmp_path, client, [APPROVAL], dry_run=True) == (["demo-2"], [])
        assert path.read_bytes() == before
        assert add_approved_sources(tmp_path, client, [APPROVAL]) == (["demo-2"], [])
        applied = path.read_bytes()
        assert add_approved_sources(tmp_path, client, [APPROVAL]) == ([], [])
        assert applied == path.read_bytes()
    assert json.loads(applied) == {
        **json.loads(before),
        "demo-2": {"patches": APPROVAL["repository"], "integrations": False, "disabled": False},
    }


def test_missing_asset_and_reused_repository_name_cannot_be_imported(tmp_path):
    path = inventory(tmp_path)
    before = path.read_bytes()

    def respond(request):
        if request.url.path == "/repos/owner/demo":
            return httpx.Response(200, json={"id": 42, "private": False})
        return httpx.Response(200, json={"tag_name": "v2", "assets": []})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        added, issues = add_approved_sources(
            tmp_path, client, [APPROVAL, {**APPROVAL, "projectId": 5}]
        )
    assert not added
    assert "no longer lists a qualifying" in issues[0].message
    assert "identity changed" in issues[1].message
    assert not any(issue.deferred for issue in issues)
    assert path.read_bytes() == before


def test_feed_auth_is_sent_to_each_page_and_wrong_version_fails():
    def respond(request):
        assert request.url.host == "scraper.example.com"
        assert request.headers["CF-Access-Client-Id"] == "test-id"
        if request.url.params.get("cursor") is None:
            return httpx.Response(
                200, json={"version": 1, "sources": [APPROVAL], "next": "github:42"}
            )
        return httpx.Response(200, json={"version": 2, "sources": [], "next": None})

    with (
        httpx.Client(transport=httpx.MockTransport(respond)) as client,
        pytest.raises(ValueError, match="Unexpected approved feed"),
    ):
        approved_sources(client, FEED, {"CF-Access-Client-Id": "test-id"})


def test_workflow_reports_deferred_verification_after_import(tmp_path, monkeypatch):
    path = inventory(tmp_path)
    output = tmp_path / "github-output"
    deferred = {**APPROVAL, "repository": "https://github.com/owner/limited"}

    def respond(request):
        if str(request.url) == FEED:
            return httpx.Response(
                200, json={"version": 1, "sources": [deferred, APPROVAL], "next": None}
            )
        if request.url.path == "/repos/owner/limited":
            return httpx.Response(429)
        return respond_to_release(request)

    client = httpx.Client(transport=httpx.MockTransport(respond))
    monkeypatch.setattr(importer.httpx, "Client", lambda **_kwargs: client)
    monkeypatch.setattr(importer, "ROOT", tmp_path)
    monkeypatch.setattr(sys, "argv", ["import_approved_sources"])
    monkeypatch.setenv("APPROVED_SOURCES_URL", FEED)
    monkeypatch.setenv("IMPORT_ACCESS_CLIENT_ID", "fake-id")
    monkeypatch.setenv("IMPORT_ACCESS_CLIENT_SECRET", "fake-secret")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    importer.main()
    assert output.read_text(encoding="utf-8") == "verification_deferred=true\n"
    assert set(json.loads(path.read_bytes())) == {"demo-stable", "demo-2"}
