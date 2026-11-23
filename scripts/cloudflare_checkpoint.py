"""Private incremental refresh checkpoints with complete atomic manifests."""

import gzip
import hashlib
import io
import json
import re
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

from scripts.cloudflare_storage import BlobCache

MANIFEST_KEY = "checkpoints/latest.json"
LEGACY_KEY = "checkpoints/latest.tgz"
PREFIX = "checkpoints/objects/"


def missing(error, key):
    absent = isinstance(error, KeyError) and error.args == (key,)
    code = getattr(error, "response", {}).get("Error", {}).get("Code")
    return absent or code in ("NoSuchKey", "404")


def target(root, name):
    if not isinstance(name, str) or "\\" in name:
        raise ValueError("Unsafe checkpoint entry")
    relative = PurePosixPath(name)
    if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != name:
        raise ValueError("Unsafe checkpoint entry")
    path = (root / name).resolve()
    if not path.is_relative_to(root.resolve()) or path.suffix != ".json" or not (
        path.is_relative_to((root / "internal/cache").resolve())
        or path in ((root / "database/ids.json").resolve(),
                    (root / "database/repository-metadata.json").resolve())
    ):
        raise ValueError("Unsafe checkpoint entry")
    return path


def bucket(name, version=3):
    number = int(hashlib.sha256(name.encode()).hexdigest()[:2], 16)
    if version == 2:
        return f"{number % 64:02x}"
    # Keep unchanged patch lists apart from frequently changing proofs and state.
    if name.endswith("-patches-list.json"):
        family, count = "patches", 64
    elif name.endswith("-extraction.json"):
        family, count = "extractions", 16
    elif name.endswith("-patches-bundle.json"):
        family, count = "bundles", 16
    elif name.startswith("internal/cache/release-pages/"):
        family, count = "releases", 32
    else:
        family, count = "state", 16
    return f"{family}/{number % count:02x}"


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def document(cloud, root):
    try:
        body = cloud.get(MANIFEST_KEY)
    except Exception as error:
        if missing(error, MANIFEST_KEY):
            return None
        raise
    result = json.loads(body)
    if (result.get("format_version") not in (2, 3) or not isinstance(result.get("files"), dict)
            or not isinstance(result.get("blocks"), dict)):
        raise ValueError("Invalid checkpoint manifest")
    for name in result["files"]:
        target(root, name)
    for digest in list(result["files"].values()) + list(result["blocks"].values()):
        if not isinstance(digest, str) or not re.fullmatch("[a-f0-9]{64}", digest):
            raise ValueError("Invalid checkpoint digest")
    expected = {bucket(name, result["format_version"]) for name in result["files"]}
    if set(result["blocks"]) != expected:
        raise ValueError("Checkpoint block index mismatch")
    return result


def retained_keys(cloud, root):
    current = document(cloud, root)
    if current is None:
        return {LEGACY_KEY}
    return {MANIFEST_KEY} | {PREFIX + digest + ".json.gz" for digest in current["blocks"].values()}


def evict_key(cloud, key):
    if key.startswith(PREFIX) and key.endswith(".json.gz"):
        digest = key[len(PREFIX):-len(".json.gz")]
        if re.fullmatch("[a-f0-9]{64}", digest):
            cloud.transfers().path(digest).unlink(missing_ok=True)


def block_cache(cloud):
    transfers = cloud.transfers()
    # Same immutable byte cache, with a private remote namespace for checkpoint data.
    cache = BlobCache(
        transfers.directory,
        lambda key: gzip.decompress(cloud.get(PREFIX + key[8:] + ".json.gz")),
        lambda key, body: cloud.put(
            PREFIX + key[8:] + ".json.gz", gzip.compress(body, compresslevel=1, mtime=0)
        ),
        workers=transfers.workers,
    )
    cache.metrics, cache.guard, cache.locks = transfers.metrics, transfers.guard, transfers.locks
    return cache


def save(cloud, root, *, cleanup_obsolete=True):
    previous = document(cloud, root)
    known = set(previous["blocks"].values()) if previous else set()
    paths = list((root / "internal/cache").rglob("*.json"))
    paths += [root / "database/ids.json", root / "database/repository-metadata.json"]
    (root / "internal").mkdir(parents=True, exist_ok=True)
    # Stream into bounded blocks instead of keeping the full extraction history in RAM.
    with tempfile.TemporaryDirectory(
        prefix="checkpoint-blocks-", dir=root / "internal"
    ) as temporary:
        files, streams = {}, {}
        try:
            # Validate all files before uploading anything or replacing the pointer.
            for path in sorted(paths, key=lambda item: item.relative_to(root).as_posix()):
                if not path.is_file() or path.is_symlink():
                    continue
                name = path.relative_to(root).as_posix()
                target(root, name)
                body = path.read_bytes()
                json.loads(body)
                files[name] = hashlib.sha256(body).hexdigest()
                group = bucket(name)
                if group not in streams:
                    block = Path(temporary) / group
                    block.parent.mkdir(parents=True, exist_ok=True)
                    streams[group] = block.open("wb")
                    streams[group].write(b"{")
                stream = streams[group]
                if stream.tell() > 1:
                    stream.write(b",")
                stream.write(encode(name) + b":" + encode(body.decode("utf-8")))
            for stream in streams.values():
                stream.write(b"}")
        finally:
            for stream in streams.values():
                stream.close()
        blocks = {}
        for group in streams:
            with (Path(temporary) / group).open("rb") as stream:
                blocks[group] = hashlib.file_digest(stream, "sha256").hexdigest()
        manifest = {"format_version": 3, "files": files, "blocks": blocks}
        if manifest == previous:
            print("Checkpoint unchanged; no uploads", flush=True)
            if cleanup_obsolete:
                cleanup(cloud, previous)
            return
        cache = block_cache(cloud)
        changed = {digest for digest in blocks.values() if digest not in known}

        def upload(item):
            group, digest = item
            if digest in known:
                cache.add("uploads_avoided")
                return
            cache.upload((Path(temporary) / group).read_bytes(), known)

        cache.parallel(upload, sorted(blocks.items()))
        cloud.put(MANIFEST_KEY, encode(manifest))
        if cleanup_obsolete:
            cleanup(cloud, manifest)
        elif previous:
            # Defer R2 cleanup without growing the runner's local cache.
            for digest in set(previous["blocks"].values()) - set(blocks.values()):
                cache.path(digest).unlink(missing_ok=True)
        print(f"Checkpoint: {len(files)} files, {len(changed)} changed blocks uploaded", flush=True)


def cleanup(cloud, current):
    """Only a committed complete manifest makes old private blocks disposable.

    All checkpoint writers/readers run under the catalog-refresh workflow lock.
    Listing also removes leftovers from interrupted uploads on the next success.
    """
    retained = {PREFIX + digest + ".json.gz" for digest in current["blocks"].values()}
    obsolete = []
    for page in cloud.s3.get_paginator("list_objects_v2").paginate(
        Bucket=cloud.bucket, Prefix="checkpoints/"
    ):
        for item in page.get("Contents", []):
            key = item["Key"]
            if (key.startswith(PREFIX) or key == LEGACY_KEY) and key not in retained:
                obsolete.append(key)

    def delete(keys):
        result = cloud.s3.delete_objects(
            Bucket=cloud.bucket,
            Delete={"Objects": [{"Key": key} for key in keys], "Quiet": True},
        )
        failed = {row["Key"] for row in result.get("Errors", [])}
        for key in set(keys) - failed:
            evict_key(cloud, key)
        if failed:
            raise RuntimeError("Checkpoint cleanup could not delete all obsolete blocks")

    cloud.transfers().parallel(
        delete, [obsolete[start:start + 1000] for start in range(0, len(obsolete), 1000)]
    )


def payloads(cloud, root, current):
    cache = block_cache(cloud)
    items = sorted(current["blocks"].items())
    restored = {}
    for start in range(0, len(items), cache.workers):
        loaded = cache.parallel(
            lambda item: (item[0], json.loads(cache.read(item[1]))),
            items[start:start + cache.workers],
        )
        for group, entries in loaded:
            if not isinstance(entries, dict):
                raise ValueError("Invalid checkpoint block")
            for name, text in entries.items():
                target(root, name)
                if (name not in current["files"] or bucket(name, current["format_version"]) != group
                        or not isinstance(text, str)):
                    raise ValueError("Checkpoint block membership mismatch")
                body = text.encode("utf-8")
                if hashlib.sha256(body).hexdigest() != current["files"][name]:
                    raise ValueError("Checkpoint file integrity mismatch")
                json.loads(body)
                restored[name] = body
    if set(restored) != set(current["files"]):
        raise ValueError("Checkpoint file set mismatch")
    return restored


def restore(cloud, root, merge_ids, clean_inputs):
    current = document(cloud, root)
    restored = {}
    if current is None:
        try:
            body = cloud.get(LEGACY_KEY)
        except Exception as error:
            if missing(error, LEGACY_KEY):
                return
            raise
        with tarfile.open(fileobj=io.BytesIO(body), mode="r:gz") as archive:
            for member in archive:
                path = target(root, member.name)
                if not member.isfile() or path in restored:
                    raise ValueError("Unsafe checkpoint entry")
                payload = archive.extractfile(member).read()
                json.loads(payload)
                restored[path] = payload
    else:
        restored = {
            target(root, name): body for name, body in payloads(cloud, root, current).items()
        }
    ids_path = root / "database/ids.json"
    if ids_path in restored:
        published = json.loads(ids_path.read_bytes()) if ids_path.exists() else {}
        restored[ids_path] = encode(merge_ids(published, json.loads(restored[ids_path])))
    # Check every hash, path and ID conflict before the first local write.
    for path, payload in restored.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                output.write(payload)
            temporary.replace(path)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    if (root / "config/sources.json").exists():
        clean_inputs(root)
