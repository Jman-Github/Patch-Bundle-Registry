import threading
from http.server import ThreadingHTTPServer

import httpx
from test_generate_database import db, fixture, write

from scripts.preview_site import prepare_preview, preview_handler


def test_preview_generates_app_indexes_without_changing_tracked_catalog(tmp_path):
    fixture(tmp_path)
    db.build_database(tmp_path)
    write(
        tmp_path / "config/apps.json",
        {"com.video": {"app_name": "Video App", "icon_url": "https://images.test/video.png"}},
    )
    (tmp_path / "web").mkdir()
    (tmp_path / "web/index.html").write_text("Current uncommitted UI", encoding="utf-8")
    (tmp_path / "web/api-docs").mkdir()
    (tmp_path / "web/api-docs/index.html").write_text("API explorer", encoding="utf-8")
    before = (tmp_path / "database/manifest.json").read_bytes()
    preview = prepare_preview(tmp_path)
    assert (tmp_path / "database/manifest.json").read_bytes() == before
    manifest = db.read_json(preview / "database/manifest.json")
    apps = db.read_json(preview / "database" / manifest["snapshot"] / "apps.json")
    assert apps[0]["app_name"] == "Video App"
    assert apps[0]["icon_url"] == "https://images.test/video.png"
    assert apps[0]["bundle_count"] == 1
    server = ThreadingHTTPServer(("127.0.0.1", 0), preview_handler(tmp_path, preview))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(
            base_url=f"http://127.0.0.1:{server.server_port}", trust_env=False
        ) as client:
            assert client.get("/").text == "Current uncommitted UI"
            assert client.get("/api-docs/").text == "API explorer"
            config = client.get("/config.json").json()
            assert config["explorer_api"] == str(client.base_url).rstrip("/")
            assert config["live_data"] is False
            assert client.get("/database/manifest.json").json() == manifest
            assert client.get("/database/%2e%2e/%2e%2e/config/site.json").status_code == 404
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
