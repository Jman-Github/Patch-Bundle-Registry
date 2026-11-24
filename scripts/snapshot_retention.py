"""Bound generated snapshot storage while preserving active and in-flight generations."""

import json
import re
import shutil

MAX_SNAPSHOT_GENERATIONS = 8
MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024 * 1024
SNAPSHOT_PATTERN = re.compile(r"snapshots/[a-f0-9]{24}")


def snapshot_path(output, name):
    if not isinstance(name, str) or not SNAPSHOT_PATTERN.fullmatch(name):
        raise ValueError("Invalid retained snapshot path")
    parent = (output / "snapshots").resolve()
    if not parent.is_relative_to(output.resolve()):
        raise ValueError("Snapshot directory escaped database output")
    target = output / name
    if target.resolve().parent != parent:
        raise ValueError("Snapshot escaped database output")
    return target


def retention_plan(output, current, previous, *, published=True):
    """Choose local snapshot folders to keep.

    The byte budget bounds snapshots that the legacy backend publishes to GitHub
    Pages. With the D1 backend, R2 serves catalog data and the site copies no
    snapshot folders, so only the current and previous generations are kept,
    whatever their size.
    """
    directory = output / "snapshots"
    available = {}
    for folder in directory.iterdir():
        name = "snapshots/" + folder.name
        if folder.is_dir() and SNAPSHOT_PATTERN.fullmatch(name):
            target = snapshot_path(output, name)
            available[name] = target
    try:
        remembered = json.loads((output / "snapshot-history.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        remembered = []
    if not isinstance(remembered, list):
        remembered = []
    # Adopt pre-retention generations once; explicit lineage survives fresh Git checkouts.
    remembered = [name for name in remembered if isinstance(name, str) and name in available]
    fallback = sorted((name for name in available if name not in remembered),
                      key=lambda name: available[name].stat().st_mtime)
    lineage = list(dict.fromkeys([*fallback, *remembered]))
    lineage = [name for name in lineage if name != current] + [current]
    selected = {current}
    if previous in available:
        selected.add(previous)
    if not published:
        retained = [name for name in lineage if name in selected]
        return retained, [name for name in available if name not in selected]
    sizes = {name: sum(path.stat().st_size for path in folder.rglob("*") if path.is_file())
             for name, folder in available.items()}
    total = sum(sizes[name] for name in selected)
    if total > MAX_SNAPSHOT_BYTES:
        raise ValueError("Current and previous snapshots exceed the 3 GiB publication budget")
    for name in reversed(lineage):
        if name in selected:
            continue
        if len(selected) < MAX_SNAPSHOT_GENERATIONS and total + sizes[name] <= MAX_SNAPSHOT_BYTES:
            selected.add(name)
            total += sizes[name]
    retained = [name for name in lineage if name in selected]
    return retained, [name for name in available if name not in selected]


def apply_retention(output, plan):
    retained, expired = plan
    (output / "snapshot-history.json").write_text(
        json.dumps(retained, indent=2) + "\n", encoding="utf-8"
    )
    for name in expired:
        # Resolve and recheck every recursive deletion against the named output directory.
        shutil.rmtree(snapshot_path(output, name))


def published_snapshots(output, current):
    try:
        retained = json.loads((output / "snapshot-history.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        retained = [current]
    if not isinstance(retained, list) or current not in retained:
        raise ValueError("Current snapshot missing from retention registry")
    return [snapshot_path(output, name) for name in retained]
