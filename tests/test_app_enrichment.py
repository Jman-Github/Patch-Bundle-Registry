"""Enrichment uses new extraction outputs and never caches transient pages as absent apps."""

from datetime import timedelta

import httpx
from test_app_catalog import NOW, play, prepare
from test_generate_database import write

from scripts import refresh_app_metadata as metadata


def test_fresh_extraction_packages_are_enriched_in_the_same_refresh(tmp_path, monkeypatch):
    prepare(tmp_path, ["com.old"])
    write(
        tmp_path / "config/sources.json",
        {"example": {"patches": "https://github.com/owner/repo", "disabled": False}},
    )
    folder = tmp_path / "internal/cache/bundles/example-patch-bundles"
    write(
        folder / "example-latest-patches-bundle.json",
        {"version": "v1", "download_url": "https://example.test/a.rvp"},
    )
    write(
        folder / "example-latest-patches-list.json",
        {"version": "v1", "patches": [{"name": "New", "compatiblePackages": {"com.new": None}}]},
    )
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    monkeypatch.setattr(metadata, "PLAY_COUNTRIES", ("US",))
    calls = []

    def handler(request):
        calls.append(request.url.params["id"])
        return httpx.Response(200, text=play("Found"))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        state = metadata.refresh(tmp_path, client, now=NOW, sleep=lambda _: None)
    assert set(calls) == {"com.old", "com.new"}
    assert state["apps"]["com.new"]["app_name"] == "Found"


def test_unknown_pages_and_isolated_failures_do_not_hide_other_packages(tmp_path, monkeypatch):
    prepare(tmp_path, ["com.a", "com.b", "com.c"])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    monkeypatch.setattr(metadata, "PLAY_COUNTRIES", ("US",))
    calls = []

    def handler(request):
        package = request.url.params["id"]
        calls.append(package)
        if package == "com.a":
            return httpx.Response(200, text="<title>Unexpected markup</title>")
        if package == "com.b":
            raise httpx.ConnectTimeout("temporary", request=request)
        return httpx.Response(200, text=play("C"))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        state = metadata.refresh(tmp_path, client, now=NOW, sleep=lambda _: None)
    assert calls == ["com.a", "com.b", "com.b", "com.c"]
    assert state["apps"]["com.a"]["play_status"] == "unrecognized"
    assert "checked_at" not in state["apps"]["com.a"]
    assert state["apps"]["com.b"]["play_status"] == "temporary_failure"
    assert state["apps"]["com.c"]["app_name"] == "C"
    assert "play_retry_after" not in state


def test_extra_markets_recover_a_negative_listing_after_its_base_cache_expires(
    tmp_path, monkeypatch
):
    prepare(tmp_path, ["com.regional"])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    monkeypatch.setattr(metadata, "APKMIRROR_LIMIT", 0)
    calls = []

    def handler(request):
        country = request.url.params["gl"]
        calls.append(country)
        return (
            httpx.Response(200, text=play("Regional")) if country == "JP" else httpx.Response(404)
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        metadata.refresh(tmp_path, client, now=NOW, sleep=lambda _: None)
        state = metadata.refresh(
            tmp_path, client, now=NOW + timedelta(days=8), sleep=lambda _: None
        )
    assert calls == ["US", "GB", "IN", "US", "GB", "IN", "DE", "BR", "JP"]
    assert state["apps"]["com.regional"]["play_country"] == "JP"


def test_retry_requests_consume_the_shared_lookup_budget(tmp_path, monkeypatch):
    prepare(tmp_path, ["com.one"])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(502)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        state = metadata.refresh(tmp_path, client, now=NOW, max_play=1, sleep=lambda _: None)
    assert len(calls) == 1
    assert not state["apps"].get("com.one", {}).get("checked_at")


def test_nested_jsonld_and_image_objects_are_supported():
    parser = metadata.PlayMetadata()
    parser.feed(
        '<script type="application/ld+json">{"@graph":[{"@type":"https://schema.org/MobileApplication","name":"Nested","image":[{"contentUrl":"https://img.test/icon.png"}]}]}</script>'
    )
    assert parser.metadata() == {
        "app_name": "Nested",
        "icon_url": "https://img.test/icon.png",
        "metadata_source": "google_play",
    }


def test_fresh_package_handoff_avoids_reading_patch_history_and_excludes_removed_sources(
    tmp_path, monkeypatch
):
    write(
        tmp_path / "config/sources.json",
        {"example": {"patches": "https://github.com/owner/repo", "disabled": False}},
    )
    write(
        tmp_path / "internal/fresh-app-packages.json",
        {
            "folders": {
                "example-patch-bundles": {"com.new": 2},
                "removed-patch-bundles": {"com.removed": 1},
            }
        },
    )
    read = metadata.read_json

    def guarded(path, default=None):
        assert not path.name.endswith("-patches-list.json")
        return read(path, default)

    monkeypatch.setattr(metadata, "read_json", guarded)
    assert metadata.fresh_packages(tmp_path) == {
        "com.new": {"package_name": "com.new", "bundle_count": 2}
    }


def test_short_transport_retry_can_recover_without_skipping_the_package(tmp_path, monkeypatch):
    prepare(tmp_path, ["com.one"])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(502)
        return httpx.Response(200, text=play("Recovered"))

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        state = metadata.refresh(tmp_path, client, now=NOW, max_play=2, sleep=lambda _: None)
    assert len(calls) == 2
    assert state["apps"]["com.one"]["app_name"] == "Recovered"


def test_successful_extra_market_remains_preferred_after_positive_cache_expires(
    tmp_path, monkeypatch
):
    prepare(tmp_path, ["com.regional"])
    monkeypatch.setattr(metadata, "REPOSITORIES", ())
    monkeypatch.setattr(metadata, "APKMIRROR_LIMIT", 0)
    calls = []

    def handler(request):
        country = request.url.params["gl"]
        calls.append(country)
        return (
            httpx.Response(200, text=play("Regional")) if country == "JP" else httpx.Response(404)
        )

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        metadata.refresh(tmp_path, client, now=NOW, sleep=lambda _: None)
        metadata.refresh(tmp_path, client, now=NOW + timedelta(days=8), sleep=lambda _: None)
        calls.clear()
        state = metadata.refresh(
            tmp_path, client, now=NOW + timedelta(days=39), sleep=lambda _: None
        )
    assert calls == ["JP"]
    assert state["apps"]["com.regional"]["play_country"] == "JP"
    assert state["apps"]["com.regional"]["app_name"] == "Regional"
