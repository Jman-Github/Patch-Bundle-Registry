"""Bounded transfers and verified, disposable caches for immutable R2 objects."""

import gzip
import hashlib
import io
import json
import os
import random
import re
import tarfile
import tempfile
import time
from collections import Counter
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from email.utils import parsedate_to_datetime
from pathlib import Path
from threading import BoundedSemaphore, Lock

from scripts.catalog_records import encode
from scripts.cloudflare_progress import Progress

REFRESH_FILES = (
    "history.json",
    "sources.json",
    "releases.json",
    "availability.json",
    "apps.json",
    "bundles.json",
    "packages.json",
)
REFRESH_ROOT_FILES = (
    "database/repository-metadata.json",
    "database/app-metadata.json",
    "database/source-availability.json",
)


def retry_after(response):
    headers = response.get("ResponseMetadata", {}).get("HTTPHeaders", {})
    header = headers.get("retry-after", "") if isinstance(headers, dict) else ""
    if not isinstance(header, str) or not header.isascii():
        return 0.0
    header = header.strip()
    if header.isdigit():
        return float(header)
    try:
        date = parsedate_to_datetime(header)
        return max(0.0, date.timestamp() - time.time()) if date.tzinfo else 0.0
    except (ValueError, TypeError, OverflowError, OSError):
        return 0.0


class R2Reader:
    """Bound R2 reads and coordinate backoff after transient service failures."""

    def __init__(self, get, workers=4, transport_errors=()):
        self.get = get
        self.transport_errors = transport_errors
        self.slots = BoundedSemaphore(min(4, max(1, workers)))
        self.guard = Lock()
        self.not_before = 0.0
        self.retries = 0

    def wait(self):
        while True:
            with self.guard:
                delay = self.not_before - time.monotonic()
            if delay <= 0:
                return
            time.sleep(delay)

    def read(self, key):
        # SDK GET retries are disabled so service/transport retries share this
        # cooldown. Include failures while consuming the response body.
        for attempt in range(3):
            with self.slots:
                self.wait()
                try:
                    return self.get(key)
                except Exception as error:
                    response = getattr(error, "response", {})
                    if not isinstance(response, dict):
                        response = {}
                    code = response.get("Error", {}).get("Code")
                    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
                    transient = (
                        code
                        in {
                            "SlowDown",
                            "ServiceUnavailable",
                            "InternalError",
                            "RequestTimeout",
                            "RequestTimeoutException",
                            "Conflict",
                            "TooManyRequests",
                            "BandwidthLimitExceeded",
                        }
                        or status in {408, 409, 429, 500, 502, 503, 504}
                        or isinstance(error, self.transport_errors)
                    )
                    if not transient or attempt == 2:
                        raise
                    requested = retry_after(response)
                    # Fail rather than retry early or wait indefinitely on a long hint.
                    if requested > 60:
                        raise
                    backoff = 2 ** (attempt + 1) + random.uniform(0, 1)  # noqa: S311
                    delay = max(requested, backoff)
                    with self.guard:
                        self.not_before = max(self.not_before, time.monotonic() + delay)
                        self.retries += 1


class BlobCache:
    def __init__(self, directory, get, put, workers=8):
        self.directory = Path(directory)
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
        except (FileExistsError, PermissionError):
            if not self.directory.is_dir():
                raise
        self.get = get
        self.put = put
        self.workers = min(16, max(1, workers))
        self.locks = [Lock() for _ in range(64)]
        self.guard = Lock()
        self.metrics = Counter()

    def add(self, name, value=1):
        with self.guard:
            self.metrics[name] += value

    def path(self, digest):
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid object digest")
        return self.directory / digest[:2] / (digest + ".blob")

    def remember(self, digest, body):
        path = self.path(digest)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except (FileExistsError, PermissionError):
            if not path.parent.is_dir():
                raise
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(body)
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def read(self, digest, fresh=False):
        path = self.path(digest)
        with self.locks[int(digest[:2], 16) % len(self.locks)]:
            if not fresh and path.is_file():
                body = path.read_bytes()
                if hashlib.sha256(body).hexdigest() == digest:
                    self.add("cache_hits")
                    os.utime(path, None)
                    return body
                self.add("cache_corruptions")
                path.unlink(missing_ok=True)
            body = self.get("objects/" + digest)
            self.add("object_downloads")
            self.add("download_bytes", len(body))
            if hashlib.sha256(body).hexdigest() != digest:
                raise ValueError("R2 object integrity mismatch")
            self.remember(digest, body)
            return body

    def upload(self, body, known):
        digest = hashlib.sha256(body).hexdigest()
        with self.locks[int(digest[:2], 16) % len(self.locks)]:
            if digest not in known:
                # A cached object may be an upload from an interrupted publication,
                # or belong to another retained snapshot. The cache is only a hint:
                # verify remote bytes before replacing a billed PUT with a GET.
                remote = None
                key = "objects/" + digest
                if self.path(digest).is_file():
                    try:
                        remote = self.get(key)
                    except Exception:
                        # This is an optional optimization, not a prerequisite for
                        # writing. Missing objects, corrupt compressed checkpoints,
                        # and failed probes all retain the normal upload path.
                        remote = None
                    else:
                        self.add("object_downloads")
                        self.add("download_bytes", len(remote))
                if remote == body:
                    self.add("uploads_avoided")
                else:
                    self.put(key, body)
                    self.add("object_uploads")
                    self.add("upload_bytes", len(body))
                with self.guard:
                    known.add(digest)
            else:
                self.add("uploads_avoided")
            self.remember(digest, body)
        return digest

    def parallel(self, action, items, operation="r2_transfer"):
        items = list(items)
        results = [None] * len(items)
        with (
            Progress(operation, len(items)) as progress,
            ThreadPoolExecutor(max_workers=self.workers) as pool,
        ):
            futures = {pool.submit(action, item): index for index, item in enumerate(items)}
            pending = set(futures)
            try:
                while pending:
                    # This is a reporting interval, not an operation deadline.
                    done, pending = wait(pending, timeout=10, return_when=FIRST_COMPLETED)
                    for future in done:
                        results[futures[future]] = future.result()
                    progress.update(len(items) - len(pending))
            except BaseException:
                for future in pending:
                    future.cancel()
                raise
        return results

    def prefetch(self, digests, fresh=False):
        def fetch(digest):
            self.read(digest, fresh=fresh)

        self.parallel(fetch, sorted(set(digests)), operation="r2_verify" if fresh else "r2_read")

    def upload_files(self, paths, known, expected=None):
        digests, unique = {}, {}
        for name, path in paths.items():
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if expected is not None and name in expected and digest != expected[name]["sha256"]:
                raise ValueError("Local catalog integrity mismatch")
            digests[name] = digest
            unique.setdefault(digest, path)
        self.add("duplicate_files_avoided", len(paths) - len(unique))

        def upload(item):
            digest, path = item
            body = path.read_bytes()
            if hashlib.sha256(body).hexdigest() != digest:
                raise ValueError("Local catalog changed during upload")
            self.upload(body, known)

        # Every file was hashed above. Ready generations already verified known objects;
        # only new objects need a second read to guard changes during upload.
        missing = [(digest, path) for digest, path in unique.items() if digest not in known]
        self.add("uploads_avoided", len(unique) - len(missing))
        self.parallel(upload, missing, operation="r2_upload_snapshot")
        return digests

    def trim(self, maximum):
        files = [
            (path.stat().st_mtime, path.stat().st_size, path)
            for path in self.directory.glob("*/*.blob")
        ]
        size = sum(item[1] for item in files)
        for _, length, path in sorted(files):
            if size <= maximum:
                break
            path.unlink(missing_ok=True)
            size -= length
            self.add("cache_evictions")
        self.add("cache_bytes", size)


def pack_refresh(entries, generation):
    metadata = {
        "version": 1,
        "generation": generation,
        "files": {name: hashlib.sha256(body).hexdigest() for name, body in entries.items()},
    }
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w") as archive:
            for name, body in sorted({**entries, "refresh-meta.json": encode(metadata)}.items()):
                json.loads(body)
                info = tarfile.TarInfo(name)
                info.size = len(body)
                archive.addfile(info, io.BytesIO(body))
    return output.getvalue()


def unpack_refresh(body, generation, allowed):
    entries = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
        for member in archive:
            total += member.size
            if (
                not member.isfile()
                or member.name not in allowed | {"refresh-meta.json"}
                or member.name in entries
                or len(entries) >= 16
                or total > 2_000_000_000
            ):
                raise ValueError("Unsafe refresh archive entry")
            content = archive.extractfile(member).read()
            json.loads(content)
            entries[member.name] = content
    metadata = json.loads(entries.pop("refresh-meta.json", b"{}"))
    hashes = {name: hashlib.sha256(content).hexdigest() for name, content in entries.items()}
    if (
        metadata.get("version") != 1
        or metadata.get("generation") != generation
        or metadata.get("files") != hashes
    ):
        raise ValueError("Refresh archive integrity mismatch")
    return entries
