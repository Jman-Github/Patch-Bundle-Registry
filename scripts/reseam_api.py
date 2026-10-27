"""Adapt the official Reseam API inventory to the shared release pipeline."""

from urllib.parse import urlsplit

OFFICIAL_SOURCE = "https://git.reseam.app/reseam/patches"
GIT_RELEASES_URL = "https://git.reseam.app/api/v1/repos/reseam/patches/releases"
HISTORY_URL = "https://api.reseam.app/patches.json"


def release_inventory(document):
    """The prerelease history includes both stable and prerelease releases."""
    if not isinstance(document, dict) or not isinstance(document.get("bundle"), dict):
        raise ValueError("Invalid Reseam bundle metadata")
    rows = document.get("releases")
    if not isinstance(rows, list):
        raise ValueError("Reseam history must contain a release list")
    releases = []
    tags = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Invalid Reseam release")
        version = row.get("version")
        if not isinstance(version, str) or not version.strip():
            raise ValueError("Reseam release has no version")
        tag = "v" + version.removeprefix("v")
        if tag in tags or any(char in tag for char in "/?#"):
            raise ValueError("Invalid or duplicate Reseam release version")
        tags.add(tag)
        for field in ("created_at", "description", "download_url"):
            if not isinstance(row.get(field), str):
                raise ValueError(f"Invalid Reseam release {field}")
        if not row["created_at"] or not isinstance(row.get("prerelease"), bool):
            raise ValueError("Invalid Reseam release date or channel")
        download = row["download_url"]
        parsed = urlsplit(download)
        if (
            parsed.scheme != "https"
            or not parsed.netloc
            or parsed.username
            or parsed.password
            or not parsed.path.lower().endswith(".reseam")
        ):
            raise ValueError("Invalid Reseam bundle download URL")
        releases.append({
            "tag_name": tag,
            "name": tag,
            "created_at": row["created_at"],
            "published_at": row["created_at"],
            "body": row["description"],
            "prerelease": row["prerelease"],
            "html_url": f"{OFFICIAL_SOURCE}/releases/tag/{tag}",
            "assets": [{
                "name": parsed.path.rsplit("/", 1)[-1],
                "browser_download_url": download,
            }],
        })
    return releases
