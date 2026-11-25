"""Resolve exact package metadata from APKMirror's public app listings.

Inspired by Fresh Morphe's APKMirror fallback:
https://github.com/drnx64/fresh-morphe/blob/1a9c2aabf7b1e8588da7d1f243773ee5572ee0c7/scripts/apkmirror_source.py

Like apkmirror-downloader, apps are addressed by their ``/apk/<org>/<repo>/`` page
when it is known, and Cloudflare challenge pages are reported rather than parsed:
https://github.com/tanishqmanuja/apkmirror-downloader
"""

import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit

ORIGIN = "https://www.apkmirror.com"
APP_PATH = re.compile(r"/apk/[a-zA-Z0-9_-]+/[a-zA-Z0-9_-]+/")
MAX_CANDIDATES = 4


class UnrecognizedSearchPage(ValueError):
    """APKMirror did not return a usable search page."""


class ChallengePage(UnrecognizedSearchPage):
    """APKMirror answered with a browser challenge instead of content."""


CHALLENGE_MARKERS = (
    "Enable JavaScript and cookies to continue",
    "<title>Just a moment...</title>",
)


def app_path(value):
    """Return a normalized ``/apk/<org>/<repo>/`` path, or None when invalid."""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value.startswith("/"):
        value = "/apk/" + value.strip("/") + "/"
    return value if APP_PATH.fullmatch(value) else None


def checked(content):
    if content is not None and any(marker in content for marker in CHALLENGE_MARKERS):
        raise ChallengePage("APKMirror returned a browser challenge")
    return content


class SearchResults(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.div_depth = 0
        self.search_depth = None
        self.recognized = False
        self.in_result_title = False
        self.paths = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "div":
            self.div_depth += 1
            if attrs.get("id") == "content" and "search-area" in classes:
                self.search_depth = self.div_depth
                self.recognized = True
        if self.search_depth is None:
            return
        if tag == "h5" and "appRowTitle" in classes:
            self.in_result_title = True
        href = attrs.get("href") or ""
        if (
            tag == "a"
            and self.in_result_title
            and len(self.paths) < MAX_CANDIDATES
            and APP_PATH.fullmatch(href)
        ):
            self.paths[href] = None

    def handle_endtag(self, tag):
        if tag == "div":
            if self.div_depth == self.search_depth:
                self.search_depth = None
                self.in_result_title = False
            self.div_depth -= 1
        elif tag == "h5":
            self.in_result_title = False


class AppListing(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_title = False
        self.title = []
        self.icon = None
        self.packages = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "h1" and "app-title" in classes:
            self.in_title = True
        elif tag == "img" and attrs.get("id") == "primaryimage":
            self.icon = attrs.get("src")
        elif tag == "a" and "tab-button" in classes and attrs.get("title") == "View on Play Store":
            try:
                link = urlsplit(attrs.get("href") or "")
                if (
                    link.scheme == "https"
                    and link.netloc == "play.google.com"
                    and (link.path == "/store/apps/details")
                ):
                    ids = parse_qs(link.query, keep_blank_values=True).get("id", [])
                    if len(ids) == 1:
                        self.packages.add(ids[0])
            except ValueError:
                pass

    def handle_data(self, data):
        if self.in_title:
            self.title.append(data)

    def handle_endtag(self, tag):
        if tag == "h1":
            self.in_title = False


def icon_url(raw):
    if not raw:
        return None
    try:
        resolved = urljoin(ORIGIN, raw)
        url = urlsplit(resolved)
    except ValueError:
        return None
    if url.scheme == "https" and url.netloc in {
        "www.apkmirror.com",
        "apkmirror.com",
        "downloadr2.apkmirror.com",
        "download.apkmirror.com",
    }:
        return resolved
    return None


def read_listing(package, path, fetch_page):
    """Return metadata when the listing names exactly this package.

    False means the listing exists but could not be read; None means no match.
    """
    content = checked(fetch_page(ORIGIN + path))
    if content is None:  # An individual listing may have been removed.
        return None
    app = AppListing()
    app.feed(content)
    name = " ".join("".join(app.title).split())
    if not name:
        return False
    if app.packages != {package}:
        return None
    return {
        "app_name": name,
        "icon_url": icon_url(app.icon),
        "metadata_source": "apkmirror",
        "apkmirror_path": path,
    }


def lookup(package, fetch_page, known_path=None):
    """Find a package's APKMirror listing.

    A known app page (remembered from an earlier match) is read
    directly, which takes one request instead of a search plus listings. A known
    page that no longer names the package falls back to search.
    """
    known_path = app_path(known_path)
    # An unreadable candidate may be the right app, so retry instead of caching a miss.
    unreadable_listing = False
    if known_path:
        found = read_listing(package, known_path, fetch_page)
        if found:
            return found
        unreadable_listing = found is False
    query = urlencode({"post_type": "app_release", "searchtype": "app", "s": package})
    search = SearchResults()
    search.feed(checked(fetch_page(f"{ORIGIN}/?{query}")) or "")
    if not search.recognized:
        raise UnrecognizedSearchPage("Unrecognized APKMirror search page")
    for path in search.paths:
        if path == known_path:
            continue
        found = read_listing(package, path, fetch_page)
        if found is False:
            unreadable_listing = True
        elif found:
            return found
    if unreadable_listing:
        raise ValueError("Unrecognized APKMirror app page")
    return None
