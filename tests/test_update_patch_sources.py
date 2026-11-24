import json

import httpx
import pytest

from scripts.source_policy import source_channels
from scripts.update_patch_sources import FEED, update_sources


def test_updates_sources_and_prunes_only_confirmed_404(tmp_path):
    source_file = tmp_path / "config/sources.json"
    source_file.parent.mkdir()
    inventory = {
        name: {"patches": f"https://github.com/owner/{name}", "disabled": name == "403"}
        for name in (
            "404", "403", "429", "500", "timeout", "moved", "api-only-404", "renamed", "existing"
        )
    }
    inventory["existing"]["integrations"] = True
    inventory["existing"]["integration"] = "https://github.com/owner/integrations"
    source_file.write_text(json.dumps(inventory), encoding="utf-8")
    retained = {name: value for name, value in inventory.items() if name != "404"}

    def respond(request):
        if str(request.url) == "https://morphe-patches.software/json/bundles.json":
            return httpx.Response(
                200,
                json={
                    "bundles": [
                        {"source": "github", "repo": "Owner/EXISTING"},
                        {"source": "github", "repo": "owner/404"},
                        {"source": "github", "repo": "another/existing"},
                        {"source": "github", "repo": "Another/EXISTING"},
                        {"source": "gitlab", "repo": "team/subgroup/new"},
                    ]
                },
            )
        if request.url.host == "api.github.com":
            assert request.headers["authorization"] == "Bearer test-token"
            repo = request.url.path.rsplit("/", 1)[1]
            if repo == "timeout":
                raise httpx.ReadTimeout("timeout", request=request)
            codes = {
                "404": 404,
                "403": 403,
                "429": 429,
                "500": 500,
                "moved": 301,
                "api-only-404": 404,
                "renamed": 404,
            }
            return httpx.Response(codes.get(repo, 200))
        assert "authorization" not in request.headers
        if request.url.path == "/owner/renamed":
            return httpx.Response(301, headers={"Location": "/owner/new-name"})
        return httpx.Response(404 if request.url.path == "/owner/404" else 200)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        added, removed = update_sources(tmp_path, client, "test-token")
        assert added == ["existing-2", "new"]
        assert removed == ["404"]
        after = source_file.read_bytes()
        assert update_sources(tmp_path, client, "test-token") == ([], [])
        assert source_file.read_bytes() == after

    assert json.loads(after) == {
        **retained,
        "existing-2": {
            "patches": "https://github.com/another/existing",
            "integrations": False,
            "disabled": False,
        },
        "new": {
            "patches": "https://gitlab.com/team/subgroup/new",
            "integrations": False,
            "disabled": False,
        },
    }


def test_aliases_avoid_existing_legacy_channels(tmp_path):
    path = tmp_path / "config/sources.json"
    path.parent.mkdir()
    legacy = {"patches": "https://github.com/legacy/repo", "latest": False}
    path.write_text(json.dumps({"demo-stable": legacy}), encoding="utf-8")

    def respond(request):
        if str(request.url) == FEED:
            return httpx.Response(
                200,
                json={
                    "bundles": [
                        {"source": "github", "repo": "owner/demo"},
                        {"source": "github", "repo": "owner/other-latest"},
                    ]
                },
            )
        return httpx.Response(200)

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        assert update_sources(tmp_path, client) == (["demo-2", "other-latest-2"], [])
        assert update_sources(tmp_path, client) == ([], [])
    updated = json.loads(path.read_bytes())
    assert updated["demo-stable"] == legacy
    assert set(source_channels(updated, tmp_path)) == {
        "demo-stable",
        "demo-2-latest",
        "demo-2-stable",
        "demo-2-dev",
        "other-latest-2-latest",
        "other-latest-2-stable",
        "other-latest-2-dev",
    }


@pytest.mark.parametrize(
    "feed",
    [
        httpx.Response(503),
        httpx.Response(200, text="<html>try later</html>"),
        httpx.Response(200, json={"bundles": []}),
        httpx.Response(200, json={"bundles": [{"source": "github", "repo": "../bad"}]}),
    ],
)
def test_invalid_feed_leaves_inventory_untouched(tmp_path, feed):
    source_file = tmp_path / "config/sources.json"
    source_file.parent.mkdir()
    before = b'{"old":{"patches":"https://github.com/owner/old"}}\n'
    source_file.write_bytes(before)

    def respond(request):
        assert str(request.url) == FEED
        return feed

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises((ValueError, httpx.HTTPError)):
            update_sources(tmp_path, client)
    assert source_file.read_bytes() == before
