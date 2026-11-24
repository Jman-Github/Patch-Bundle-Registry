import json

import pytest

from scripts import snapshot_retention as retention


def make_snapshot(output, generation, size=1):
    name = "snapshots/" + f"{generation:024x}"
    target = output / name
    target.mkdir(parents=True)
    (target / "data.json").write_bytes(b"x" * size)
    return name


def test_retention_uses_recorded_order_after_fresh_checkout(tmp_path, monkeypatch):
    monkeypatch.setattr(retention, "MAX_SNAPSHOT_GENERATIONS", 3)
    names = [make_snapshot(tmp_path, i) for i in range(1, 6)]
    # Checkout mtimes can no longer establish chronological order.
    lineage = [names[3], names[1], names[0], names[2], names[4]]
    (tmp_path / "snapshot-history.json").write_text(json.dumps(lineage))
    plan = retention.retention_plan(tmp_path, names[4], names[2])
    assert plan[0] == lineage[-3:]
    retention.apply_retention(tmp_path, plan)
    assert all((tmp_path / name).is_dir() for name in lineage[-3:])
    assert all(not (tmp_path / name).exists() for name in lineage[:2])


def test_retention_enforces_byte_budget_and_protects_previous(tmp_path, monkeypatch):
    names = [make_snapshot(tmp_path, i, 10) for i in range(1, 5)]
    monkeypatch.setattr(retention, "MAX_SNAPSHOT_BYTES", 20)
    retained, expired = retention.retention_plan(tmp_path, names[3], names[1])
    assert set(retained) == {names[3], names[1]}
    assert set(expired) == {names[0], names[2]}
    monkeypatch.setattr(retention, "MAX_SNAPSHOT_BYTES", 19)
    with pytest.raises(ValueError, match="publication budget"):
        retention.retention_plan(tmp_path, names[3], names[1])
    assert all((tmp_path / name).exists() for name in names)


def test_d1_retention_keeps_current_and_previous_beyond_the_pages_budget(tmp_path, monkeypatch):
    names = [make_snapshot(tmp_path, i, 10) for i in range(1, 5)]
    monkeypatch.setattr(retention, "MAX_SNAPSHOT_BYTES", 1)
    retained, expired = retention.retention_plan(tmp_path, names[3], names[1], published=False)
    assert retained == [names[1], names[3]]
    assert set(expired) == {names[0], names[2]}
    # The legacy Pages backend still refuses oversized publications.
    with pytest.raises(ValueError, match="publication budget"):
        retention.retention_plan(tmp_path, names[3], names[1])


@pytest.mark.parametrize(
    "name", ["../outside", "snapshots/../../outside", "snapshots/not-a-generation"]
)
def test_recursive_pruning_rejects_paths_outside_snapshot_directory(tmp_path, name):
    with pytest.raises(ValueError, match="snapshot path"):
        retention.snapshot_path(tmp_path, name)
