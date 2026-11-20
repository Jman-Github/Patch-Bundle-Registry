"""Preview uncommitted website code with an isolated, freshly generated catalog."""

import argparse
import mimetypes
import re
import shutil
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

try:
    from scripts.generate_database import ROOT, build_database, encoded, read_json
except ModuleNotFoundError:
    from generate_database import ROOT, build_database, encoded, read_json


def prepare_preview(root=ROOT, *, refresh_apps=False):
    root = Path(root)
    preview = root / "internal/site-preview"
    preview.mkdir(parents=True, exist_ok=True)
    shutil.copytree(root / "config", preview / "config", dirs_exist_ok=True)
    manifest = read_json(root / "database/manifest.json", {})
    snapshot = manifest.get("snapshot", "")
    if not re.fullmatch(r"snapshots/[a-f0-9]{24}", snapshot):
        raise ValueError("A generated local catalog is required for preview")
    destination = preview / "database"
    destination.mkdir(exist_ok=True)
    shutil.copytree(root / "database" / snapshot, destination / snapshot, dirs_exist_ok=True)
    (destination / "manifest.json").write_bytes(encoded(manifest))
    metadata = root / "database/app-metadata.json"
    cached = destination / "app-metadata.json"
    if metadata.exists() and (
        not cached.exists() or metadata.stat().st_mtime > cached.stat().st_mtime
    ):
        shutil.copyfile(metadata, cached)
    # Restore published extraction inputs, without modifying the working catalog.
    build_database(preview)
    if refresh_apps:
        import httpx

        try:
            from scripts.refresh_app_metadata import refresh
        except ModuleNotFoundError:
            from refresh_app_metadata import refresh
        with httpx.Client(
            timeout=httpx.Timeout(20, connect=10),
            follow_redirects=True,
            headers={"User-Agent": "Patch-Bundle-Registry/1.0"},
        ) as client:
            refresh(preview, client)
        build_database(preview, restore=False)
    return preview


def preview_handler(root, preview=None, *, live=False):
    root = Path(root)
    site_config = read_json(root / "config/site.json")
    api_base = site_config.get("api", "https://patch-bundles.api.jmancentral.com").rstrip("/")
    graphql_paths = ("/graphql", "/v1/graphql", "/hasura/v1/graphql")

    class Handler(BaseHTTPRequestHandler):
        def proxy(self, target_url, data=None):
            req_headers = {
                "User-Agent": self.headers.get("User-Agent")
                or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Patch-Bundle-Preview/1.0"
            }
            if if_none_match := self.headers.get("If-None-Match"):
                req_headers["If-None-Match"] = if_none_match
            if not target_url.startswith(("http://", "https://")):
                raise ValueError("Only http and https schemes are permitted")
            if data is not None:
                req_headers["Content-Type"] = "application/json"
            req = urllib.request.Request(target_url, data=data, headers=req_headers)  # noqa: S310
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:  # noqa: S310
                    body = resp.read()
                    self.send_response(resp.status)
                    self.send_header(
                        "Content-Type",
                        resp.headers.get("Content-Type", "application/json"),
                    )
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Access-Control-Expose-Headers", "ETag, X-Catalog-Generation")
                    self.send_header("Cache-Control", "no-store")
                    if gen := resp.headers.get("X-Catalog-Generation"):
                        self.send_header("X-Catalog-Generation", gen)
                    if etag := resp.headers.get("ETag"):
                        self.send_header("ETag", etag)
                    self.end_headers()
                    self.wfile.write(body)
            except urllib.error.HTTPError as err:
                body = err.read()
                self.send_response(err.code)
                self.send_header(
                    "Content-Type",
                    err.headers.get("Content-Type", "application/json"),
                )
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Expose-Headers", "ETag, X-Catalog-Generation")
                if gen := err.headers.get("X-Catalog-Generation"):
                    self.send_header("X-Catalog-Generation", gen)
                if etag := err.headers.get("ETag"):
                    self.send_header("ETag", etag)
                self.end_headers()
                self.wfile.write(body)
            except Exception as err:
                self.send_error(502, f"Proxy error: {err}")

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Access-Control-Expose-Headers", "ETag, X-Catalog-Generation")
            self.end_headers()

        def do_POST(self):
            if urlsplit(self.path).path not in graphql_paths:
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", ""))
            except ValueError:
                self.send_error(411)
                return
            if not 0 < length <= 2 * 1024 * 1024:
                self.send_error(413)
                return
            self.proxy(api_base + self.path, self.rfile.read(length))

        def do_GET(self):
            name = unquote(urlsplit(self.path).path).lstrip("/")
            if name == "config.json":
                config = dict(site_config)
                host = self.headers.get("Host") or f"localhost:{self.server.server_port}"
                config["explorer_api"] = f"http://{host}"
                if not live and preview:
                    config["live_data"] = False
                    config.pop("catalog_backend", None)
                else:
                    config["catalog_backend"] = "d1"
                    config["catalog_api"] = config["explorer_api"]
                body, kind = encoded(config), "application/json"
            elif (
                name.split("/", 1)[0]
                in {
                    "api",
                    "catalog",
                    "bundles",
                    "sources",
                    "releases",
                    "patches",
                    "packages",
                    "apps",
                    "availability",
                    "refresh-jobs",
                    "health",
                    "api.json",
                    "openapi.json",
                }
                or "/" + name in graphql_paths
            ):
                self.proxy(api_base + self.path)
                return
            elif (live or not preview) and name.startswith("database/"):
                site_base = site_config.get(
                    "website", "https://patch-bundles.jmancentral.com"
                ).rstrip("/")
                self.proxy(site_base + self.path)
                return
            else:
                if not live and preview and name.startswith("database/"):
                    base, relative = preview / "database", name.removeprefix("database/")
                elif name.startswith("shared/"):
                    base, relative = root / "shared", name.removeprefix("shared/")
                elif name == "config/git-hosts.json":
                    base, relative = root / "config", "git-hosts.json"
                else:
                    base = root / "web"
                    relative = name + "index.html" if not name or name.endswith("/") else name
                path = (base / relative).resolve()
                if not path.is_relative_to(base.resolve()) or not path.is_file():
                    self.send_error(404)
                    return
                body = path.read_bytes()
                kind = {
                    ".js": "text/javascript",
                    ".json": "application/json",
                    ".css": "text/css",
                }.get(path.suffix, mimetypes.guess_type(str(path))[0] or "application/octet-stream")
            self.send_response(200)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="Preview UI using live remote catalog data without generating a local database",
    )
    parser.add_argument(
        "--refresh-apps",
        action="store_true",
        help="Fetch cached F-Droid/Google Play names and icons",
    )
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    if args.live:
        preview = None
    else:
        try:
            preview = prepare_preview(refresh_apps=args.refresh_apps)
        except ValueError as err:
            if not (ROOT / "database/manifest.json").exists():
                print("Local database snapshot not found; defaulting to live catalog data.")
                preview = None
                args.live = True
            else:
                raise err
        if args.prepare_only:
            print("Preview catalog ready in " + str(preview))
            return
    print(f"Preview: http://localhost:{args.port} (Ctrl+C to stop)", flush=True)
    handler = preview_handler(ROOT, preview, live=args.live)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
