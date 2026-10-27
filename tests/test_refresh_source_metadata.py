import importlib.util
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
SPEC = importlib.util.spec_from_file_location(
    "repository_metadata",
    Path(__file__).resolve().parents[1] / "scripts/refresh_source_metadata.py",
)
metadata = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(metadata)


def inventory(root, repositories):
    path = root / "config/sources.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        metadata.encoded({str(i): {"patches": url} for i, url in enumerate(repositories)})
    )


def test_github_enrichment_etag_and_daily_throttle(tmp_path, monkeypatch):
    monkeypatch.delenv("GH_PAT", raising=False)
    inventory(tmp_path, ["https://api.github.com/repos/demo/patches"])
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 2:
            assert request.headers["if-none-match"] == "etag"
            return httpx.Response(304)
        return httpx.Response(
            200,
            headers={"etag": "etag"},
            json={
                "owner": {"login": "demo", "avatar_url": "https://example.test/avatar"},
                "name": "patches",
                "stargazers_count": 12,
                "archived": False,
            },
        )

    now = datetime(2026, 10, 7, tzinfo=UTC)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        first = metadata.refresh(tmp_path, client, now=now)
        assert metadata.refresh(tmp_path, client, now=now + timedelta(hours=1)) == first
        updated = metadata.refresh(tmp_path, client, now=now + timedelta(days=1))
    assert len(calls) == 2
    assert updated["https://github.com/demo/patches"]["source_metadatum"]["repo_stars"] == 12


def test_gitlab_subgroup_metadata(tmp_path):
    inventory(tmp_path, ["https://gitlab.com/api/v4/projects/group%2Fteam%2Frepo"])

    def handler(request):
        assert request.url.raw_path.endswith(b"group%2Fteam%2Frepo")
        return httpx.Response(
            200,
            json={
                "namespace": {"full_path": "group/team", "avatar_url": "/avatar.png"},
                "path": "repo",
                "star_count": 4,
                "archived": True,
            },
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    row = result["https://gitlab.com/group/team/repo"]["source_metadatum"]
    assert row["is_repo_archived"] and row["owner_avatar_url"] == "https://gitlab.com/avatar.png"


def test_upstream_failure_preserves_cached_metadata_and_other_sources(tmp_path):
    inventory(tmp_path, ["github.com/demo/a", "github.com/demo/b"])
    path = tmp_path / "database/repository-metadata.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        metadata.encoded({"https://github.com/demo/a": {"source_metadatum": {"repo_stars": 5}}})
    )

    def handler(request):
        return httpx.Response(
            404 if request.url.path.endswith("/a") else 200,
            json={"name": "b", "stargazers_count": 8},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    assert result["https://github.com/demo/a"]["source_metadatum"]["repo_stars"] == 5
    assert result["https://github.com/demo/b"]["source_metadatum"]["repo_stars"] == 8


def test_unauthorized_token_stops_excessive_requests(tmp_path):
    inventory(tmp_path, ["github.com/demo/a", "github.com/demo/b"])
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(401)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        metadata.refresh(tmp_path, client)
    assert len(calls) == 1


@pytest.mark.parametrize(
    ("headers", "message"),
    [
        ({"retry-after": "120", "x-ratelimit-remaining": "4999"}, ""),
        ({"x-ratelimit-remaining": "4999"}, "You have exceeded a secondary rate limit."),
    ],
)
def test_secondary_limit_stops_requests_to_other_repositories(tmp_path, headers, message):
    inventory(tmp_path, ["github.com/demo/a", "github.com/demo/b"])
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(403, headers=headers, text=message)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    assert len(calls) == 1
    assert result["https://github.com/demo/a"]["http_status"] == 403
    assert result["https://github.com/demo/b"] == {}


@pytest.mark.parametrize("status", [301, 302, 307, 308])
def test_repository_rename_refreshes_recorded_names(tmp_path, monkeypatch, status):
    inventory(tmp_path, ["github.com/old-owner/old-name"])
    monkeypatch.setenv("GH_PAT", "test-token")
    calls = []

    def handler(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer test-token"
        if len(calls) == 1:
            return httpx.Response(status, headers={"location": "/repositories/123"})
        assert request.url == "https://api.github.com/repositories/123"
        return httpx.Response(
            200, headers={"etag": "renamed"},
            json={"owner": {"login": "new-owner"}, "name": "new-name", "stargazers_count": 9},
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    row = result["https://github.com/old-owner/old-name"]
    assert row["source_metadatum"]["owner_name"] == "new-owner"
    assert row["source_metadatum"]["repo_name"] == "new-name"
    assert row["etag"] == "renamed"
    assert len(calls) == 2


@pytest.mark.parametrize(
    "location", ["https://untrusted.example/repo", "http://api.github.com/repositories/123"]
)
def test_metadata_redirect_keeps_credentials_on_the_original_origin(
    tmp_path, monkeypatch, location
):
    inventory(tmp_path, ["github.com/old-owner/old-name"])
    monkeypatch.setenv("GH_PAT", "test-token")
    path = tmp_path / "database/repository-metadata.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(metadata.encoded({
        "https://github.com/old-owner/old-name": {"source_metadatum": {"repo_stars": 7}},
    }))
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(301, headers={"location": location})

    # A caller's client settings must not accidentally forward credentials.
    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        result = metadata.refresh(tmp_path, client)
    assert len(calls) == 1
    assert result["https://github.com/old-owner/old-name"]["source_metadatum"]["repo_stars"] == 7


def test_metadata_redirect_loop_is_bounded_and_other_sources_continue(tmp_path):
    inventory(tmp_path, ["github.com/demo/a", "github.com/demo/b"])
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("/a"):
            return httpx.Response(301, headers={"location": "/repos/demo/a"})
        return httpx.Response(200, json={"name": "b"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    assert len(calls) <= 12
    assert result["https://github.com/demo/b"]["source_metadatum"]["repo_name"] == "b"


def morphe_catalog(root, url):
    folder = root / "database/snapshots/test"
    folder.mkdir(parents=True)
    (root / "database/manifest.json").write_bytes(metadata.encoded({"snapshot": "snapshots/test"}))
    (folder / "sources.json").write_bytes(metadata.encoded([{"id": "one", "url": url}]))
    (folder / "bundles.json").write_bytes(metadata.encoded([
        {"source_id": "one", "bundle_type": "Morphe:V1"}
    ]))


def test_morphe_root_icon_is_cached_and_removed_on_404(tmp_path, monkeypatch):
    monkeypatch.setenv("GH_PAT", "private-api-token")
    url = "https://github.com/demo/patches"
    inventory(tmp_path, [url])
    morphe_catalog(tmp_path, url)
    requests = []
    icon_status = 200

    def handler(request):
        requests.append(request)
        if request.method == "HEAD":
            assert request.url == "https://raw.githubusercontent.com/demo/patches/refs/heads/main/patches-bundle.png"
            assert "authorization" not in request.headers
            assert "private-token" not in request.headers
            if icon_status != 200:
                assert request.headers["if-none-match"] == "icon-etag"
            return httpx.Response(
                icon_status, headers={"content-type": "image/png", "etag": "icon-etag"}
            )
        assert request.headers["authorization"] == "Bearer private-api-token"
        if len(requests) > 2:
            assert request.headers["if-none-match"] == "repo-etag"
            return httpx.Response(304)
        return httpx.Response(200, headers={"etag": "repo-etag"}, json={
            "name": "patches", "owner": {"login": "demo", "avatar_url": "https://avatar.test/demo"},
            "default_branch": "main"
        })

    now = datetime(2026, 10, 10, tzinfo=UTC)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client, now=now)
        icon = result[url]["source_metadatum"]["bundle_icon_url"]
        assert icon.endswith("/patches-bundle.png")
        metadata.refresh(tmp_path, client, now=now + timedelta(hours=1))
        assert len(requests) == 2
        icon_status = 304
        result = metadata.refresh(tmp_path, client, now=now + timedelta(days=1))
        assert result[url]["source_metadatum"]["bundle_icon_url"] == icon
        icon_status = 503
        result = metadata.refresh(tmp_path, client, now=now + timedelta(days=2))
        assert result[url]["source_metadatum"]["bundle_icon_url"] == icon
        icon_status = 404
        result = metadata.refresh(tmp_path, client, now=now + timedelta(days=3))
        assert result[url]["source_metadatum"]["bundle_icon_url"] is None


@pytest.mark.parametrize("url, expected", [
    ("https://gitlab.com/team/patches", "https://gitlab.com/team/patches/-/raw/dev%2Fnext/patches-bundle.png"),
    ("https://codeberg.org/team/patches", "https://codeberg.org/team/patches/raw/branch/dev%2Fnext/patches-bundle.png"),
])
def test_other_hosts_use_default_branch_root_icon(tmp_path, url, expected):
    inventory(tmp_path, [url])
    morphe_catalog(tmp_path, url)
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "HEAD":
            assert str(request.url) == expected
            return httpx.Response(200, headers={"content-type": "image/png"})
        return httpx.Response(200, json={
            "owner": {"login": "team"}, "namespace": {"full_path": "team"},
            "name": "patches", "path": "patches", "default_branch": "dev/next"
        })

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    assert len(requests) == 2
    assert result[url]["source_metadatum"]["bundle_icon_url"] == expected


def test_old_etag_cache_backfills_branch_and_ignores_html_icon(tmp_path):
    url = "https://github.com/demo/patches"
    inventory(tmp_path, [url])
    morphe_catalog(tmp_path, url)
    path = tmp_path / "database/repository-metadata.json"
    now = datetime(2026, 10, 10, tzinfo=UTC)
    path.write_bytes(metadata.encoded({url: {
        "etag": "old", "checked_at": now.isoformat(),
        "source_metadatum": {"bundle_icon_url": "https://raw.test/previous.png"}
    }}))

    def handler(request):
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-type": "text/html"})
        assert "if-none-match" not in request.headers
        return httpx.Response(200, json={"name": "patches", "default_branch": "main"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client, now=now)
    assert not result[url]["source_metadatum"].get("bundle_icon_url")


def test_revanced_official_source_routes_to_gitlab_metadata(tmp_path):
    url = "https://github.com/ReVanced/revanced-patches"
    inventory(tmp_path, [url])
    requests = []

    def handler(request):
        requests.append(request)
        assert str(request.url) == "https://gitlab.com/api/v4/projects/ReVanced%2Frevanced-patches"
        return httpx.Response(200, json={
            "namespace": {"full_path": "ReVanced", "avatar_url": None},
            "path": "revanced-patches",
            "description": "Official ReVanced patches",
            "star_count": 136,
            "default_branch": "main",
        })

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = metadata.refresh(tmp_path, client)
    assert len(requests) == 1
    canonical = url.lower()
    assert result[canonical]["http_status"] == 200
    assert result[canonical]["source_metadatum"]["owner_name"] == "ReVanced"
    assert result[canonical]["source_metadatum"]["repo_name"] == "revanced-patches"
    assert result[canonical]["source_metadatum"]["repo_stars"] == 136
