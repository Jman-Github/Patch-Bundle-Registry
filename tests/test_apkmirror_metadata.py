"""APKMirror identity checks, provider priority, and bounded refresh behavior."""

from datetime import datetime, timedelta

import httpx
import pytest
from test_app_catalog import NOW, index_v2, play, prepare
from test_generate_database import write

from scripts import refresh_app_metadata as metadata
from scripts.apkmirror_metadata import ChallengePage, app_path, lookup

PACKAGE = "com.laurencedawson.reddit_sync"
LISTING = "/apk/red-apps-ltd/sync-for-reddit/"
SIMILAR = "/apk/other/dev-variant/"
ICON = "https://downloadr2.apkmirror.com/wp-content/uploads/sync.png"


def result(path):
    return f'<h5 class="appRowTitle"><a href="{path}">Sync for reddit</a></h5>'


def search(*paths):
    return (
        '<div id="content" class="content-area search-area">'
        + "".join(result(path) for path in paths)
        + '</div><div id="sidebar">'
        + result("/apk/other/popular/")
        + "</div>"
    )


def listing(package, icon=ICON, name="Sync &amp; Friends"):
    return (
        f'<h1 class="app-title">{name}</h1><img id="primaryimage" src="{icon}">'
        '<a class="accent_color tab-button" title="View on Play Store" '
        f'href="https://play.google.com/store/apps/details?id={package}&amp;hl=en">Play</a>'
    )


def play_miss(package=PACKAGE):
    return {
        package: {
            "checked_at": NOW.isoformat(),
            "play_status": "not_found",
            "play_checked_countries": list(metadata.PLAY_COUNTRIES),
        }
    }


def run(root, handler, **options):
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        return metadata.refresh(root, client, sleep=lambda _: None, **{"now": NOW, **options})


def test_apkmirror_follows_app_results_and_verifies_listing_package():
    seen = []

    def fetch(url):
        seen.append(httpx.URL(url).path)
        if len(seen) == 1:
            return search(
                "//external.test/apk/foreign/app/", "/apk/vendor/app/v2-release/", SIMILAR, LISTING
            )
        if len(seen) == 2:
            # Text mentions the requested ID, but the listing's own ID is a sibling.
            return listing(PACKAGE + ".pro") + f'<a href="?id={PACKAGE}">Another app</a>'
        return listing(PACKAGE, icon="/icons/sync.png")

    assert lookup(PACKAGE, fetch) == {
        "app_name": "Sync & Friends",
        "icon_url": "https://www.apkmirror.com/icons/sync.png",
        "metadata_source": "apkmirror",
        "apkmirror_path": LISTING,
    }
    assert seen == ["/", SIMILAR, LISTING]


@pytest.mark.parametrize("has_match", [True, False])
def test_malformed_listing_checks_later_candidates_without_caching_uncertain_misses(
    tmp_path, monkeypatch, has_match
):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    write(tmp_path / "database/app-metadata.json", {"apps": play_miss()})
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/":
            return httpx.Response(200, text=search(SIMILAR, LISTING))
        if request.url.path == SIMILAR:
            return httpx.Response(200, text="<h1>Listing unavailable</h1>")
        return httpx.Response(200, text=listing(PACKAGE if has_match else PACKAGE + ".pro"))

    app = run(tmp_path, handler, max_play=0, max_apkmirror=3)["apps"][PACKAGE]
    assert calls == ["/", SIMILAR, LISTING]
    assert bool(app.get("apkmirror_checked_at")) == has_match
    assert bool(app.get("app_name")) == has_match
    assert bool(app.get("apkmirror_retry_after")) != has_match


def test_apkmirror_ignores_sidebar_matches_and_foreign_icons():
    def fetch(url):
        if httpx.URL(url).path == "/":
            return search(LISTING)
        return listing(PACKAGE, icon="//external.test/icon.png")

    assert lookup(PACKAGE, fetch)["icon_url"] is None
    assert lookup(PACKAGE, lambda _: search()) is None
    with pytest.raises(ValueError, match="Unrecognized APKMirror search page"):
        lookup(PACKAGE, lambda _: "<html><body>Maintenance</body></html>")
    for page in ("<title>Just a moment...</title>", "Enable JavaScript and cookies to continue"):
        with pytest.raises(ChallengePage):
            lookup(PACKAGE, lambda _, page=page: page)


def test_known_app_page_is_read_directly_and_falls_back_to_search():
    seen = []

    def direct(url):
        seen.append(httpx.URL(url).path)
        return listing(PACKAGE)

    assert lookup(PACKAGE, direct, "red-apps-ltd/sync-for-reddit")["apkmirror_path"] == LISTING
    assert seen == [LISTING]

    seen.clear()

    def moved(url):
        path = httpx.URL(url).path
        seen.append(path)
        if path == SIMILAR:
            return listing("com.other")
        if path == "/":
            return search(SIMILAR, LISTING)
        return listing(PACKAGE)

    # A stale page is not requested twice; search finds the current listing.
    assert lookup(PACKAGE, moved, SIMILAR)["apkmirror_path"] == LISTING
    assert seen == [SIMILAR, "/", LISTING]
    assert app_path("../../etc") is None
    assert app_path("/apk/a/b/extra/") is None


def test_fallback_runs_after_play_misses_and_recovers_when_play_returns(tmp_path):
    prepare(tmp_path, [PACKAGE, "com.play", "org.example.free", "com.manual"])
    write(tmp_path / "config/apps.json", {"com.manual": {"app_name": "Manual"}})
    calls = []

    def handler(request):
        host = request.url.host
        if host not in {"www.apkmirror.com", "play.google.com"}:
            return httpx.Response(200, json=index_v2())
        calls.append((host, request.url.params.get("id") or request.url.path))
        if host == "play.google.com":
            package = request.url.params["id"]
            if package == "com.play" or request.url.params["gl"] == "JP":
                return httpx.Response(200, text=play("Play metadata"))
            assert package == PACKAGE
            return httpx.Response(404)
        if request.url.path == "/":
            assert request.url.params["s"] == PACKAGE
            assert request.url.params["searchtype"] == "app"
            return httpx.Response(200, text=search(LISTING))
        return httpx.Response(200, text=listing(PACKAGE))

    state = run(tmp_path, handler)
    assert calls.count(("play.google.com", PACKAGE)) == 3
    assert [host for host, _ in calls][-2:] == ["www.apkmirror.com"] * 2
    assert state["apps"][PACKAGE]["app_name"] == "Sync & Friends"
    assert state["apps"][PACKAGE]["metadata_source"] == "apkmirror"
    assert state["apps"]["com.play"]["metadata_source"] == "google_play"
    assert state["apps"]["org.example.free"]["metadata_source"] == "fdroid"
    calls.clear()
    run(tmp_path, handler, now=NOW + timedelta(days=1), max_play=0)
    assert calls == []
    state = run(tmp_path, handler, now=NOW + timedelta(days=8))
    assert state["apps"][PACKAGE]["metadata_source"] == "google_play"
    assert state["apps"][PACKAGE]["play_country"] == "JP"


def test_fallback_resumes_pending_work_and_caches_completed_misses(tmp_path, monkeypatch):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    calls = []

    def handler(request):
        assert request.url.host == "www.apkmirror.com"
        calls.append(request.url.path)
        if request.url.path == "/":
            return httpx.Response(200, text=search(LISTING))
        return httpx.Response(200, text=listing(PACKAGE + ".pro"))

    write(tmp_path / "database/app-metadata.json", {"apps": play_miss()})
    state = run(tmp_path, handler, max_play=0, max_apkmirror=1)
    assert calls == ["/"]
    assert "apkmirror_checked_at" not in state["apps"][PACKAGE]

    state = run(tmp_path, handler, max_play=0, max_apkmirror=2)
    assert calls == ["/", "/", LISTING]
    assert "apkmirror_checked_at" in state["apps"][PACKAGE]
    assert not state["apps"][PACKAGE].get("app_name")
    run(tmp_path, handler, now=NOW + timedelta(days=1), max_play=0)
    assert calls == ["/", "/", LISTING]


@pytest.mark.parametrize("status", [403, 429, 503, 200, None])
def test_unavailable_apkmirror_does_not_negative_cache_or_clear_existing_name(
    tmp_path, monkeypatch, status
):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    cached = play_miss()
    previous = (NOW - timedelta(days=31)).isoformat()
    cached[PACKAGE].update(
        app_name="Keep name",
        metadata_source="apkmirror",
        apkmirror_checked_at=previous,
        icon_url=ICON,
    )
    write(tmp_path / "database/app-metadata.json", {"apps": cached})
    calls = []

    def handler(request):
        assert request.url.host == "www.apkmirror.com"
        calls.append(request)
        if status is None:
            raise httpx.ReadTimeout("timeout", request=request)
        return httpx.Response(
            status, text="<title>Just a moment...</title>", headers={"Retry-After": "120"}
        )

    state = run(tmp_path, handler, max_play=0)
    assert state["apps"][PACKAGE]["app_name"] == "Keep name"
    assert state["apps"][PACKAGE]["icon_url"] == ICON
    assert state["apps"][PACKAGE]["apkmirror_checked_at"] == previous
    if status in {403, 429, 503}:
        assert datetime.fromisoformat(state["apkmirror_retry_after"]) >= NOW + timedelta(
            seconds=120
        )
    run(tmp_path, handler, now=NOW + timedelta(minutes=1), max_play=0)
    assert len(calls) == 1


def test_one_failed_apkmirror_lookup_does_not_block_later_packages(tmp_path, monkeypatch):
    following = "org.example.next"
    prepare(tmp_path, [PACKAGE, following])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    write(
        tmp_path / "database/app-metadata.json", {"apps": {**play_miss(), **play_miss(following)}}
    )
    calls = []

    def handler(request):
        assert request.url.host == "www.apkmirror.com"
        query = request.url.params.get("s")
        calls.append(query or request.url.path)
        if query == PACKAGE:
            return httpx.Response(500)
        if query == following:
            return httpx.Response(200, text=search(LISTING))
        return httpx.Response(200, text=listing(following, name="Next app"))

    state = run(tmp_path, handler, max_play=0, max_apkmirror=3)
    assert calls == [PACKAGE, following, LISTING]
    assert "apkmirror_checked_at" not in state["apps"][PACKAGE]
    assert state["apps"][PACKAGE]["apkmirror_retry_after"]
    assert "apkmirror_retry_after" not in state
    assert state["apps"][following]["app_name"] == "Next app"


def test_google_redirect_404_does_not_trigger_apkmirror(tmp_path, monkeypatch):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    monkeypatch.setattr(metadata, "PLAY_COUNTRIES", ("US",))
    calls = []

    def handler(request):
        calls.append(request.url.host)
        if request.url.host == "play.google.com":
            return httpx.Response(302, headers={"Location": "https://consent.google.com/continue"})
        assert request.url.host == "consent.google.com"
        return httpx.Response(404)

    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        state = metadata.refresh(tmp_path, client, now=NOW, sleep=lambda _: None)
    assert calls == ["play.google.com", "consent.google.com"]
    assert not state["apps"].get(PACKAGE, {}).get("checked_at")
    assert state["play_retry_after"]


def test_apkmirror_skips_unconfirmed_play_misses(tmp_path, monkeypatch):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    write(
        tmp_path / "database/app-metadata.json",
        {
            "apps": {
                PACKAGE: {"play_checked_countries": ["US"], "play_attempted_at": NOW.isoformat()}
            }
        },
    )

    def unexpected(request):
        pytest.fail(f"Unexpected request for {request.url}")

    state = run(tmp_path, unexpected, max_play=0)
    assert "apkmirror_checked_at" not in state["apps"][PACKAGE]


def test_refresh_remembers_app_pages(tmp_path, monkeypatch):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    write(tmp_path / "database/app-metadata.json", {"apps": play_miss()})
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path == "/":
            return httpx.Response(200, text=search(LISTING))
        return httpx.Response(200, text=listing(PACKAGE))

    state = run(tmp_path, handler, max_play=0, max_apkmirror=5)
    assert calls == ["/", LISTING]
    assert state["apps"][PACKAGE]["apkmirror_path"] == LISTING

    calls.clear()
    run(tmp_path, handler, now=NOW + timedelta(days=31), max_play=0, max_apkmirror=5)
    # A remembered page skips the search on the next recheck.
    assert calls == [LISTING]


def test_challenge_page_backs_off_like_a_block(tmp_path, monkeypatch, capsys):
    prepare(tmp_path, [PACKAGE])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    write(tmp_path / "database/app-metadata.json", {"apps": play_miss()})
    calls = []

    def handler(request):
        calls.append(request.url.path)
        return httpx.Response(200, text="<p>Enable JavaScript and cookies to continue</p>")

    state = run(tmp_path, handler, max_play=0)
    assert calls == ["/"]
    assert datetime.fromisoformat(state["apkmirror_retry_after"]) >= NOW + timedelta(minutes=59)
    assert "APKMirror unavailable (browser challenge)" in capsys.readouterr().out
    run(tmp_path, handler, now=NOW + timedelta(minutes=30), max_play=0)
    assert calls == ["/"]


def test_unreadable_known_page_is_retried_instead_of_cached_as_a_miss():
    def fetch(url):
        if httpx.URL(url).path == "/":
            return search(LISTING)
        return "<h1>Temporarily unavailable</h1>"

    with pytest.raises(ValueError, match="Unrecognized APKMirror app page"):
        lookup(PACKAGE, fetch, LISTING)
