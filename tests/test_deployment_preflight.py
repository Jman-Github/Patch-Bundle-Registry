import shlex
from pathlib import Path

import pytest
from test_cloudflare_catalog import SOURCE, MemoryCloud, catalog

from scripts import cloudflare_catalog as cloud
from scripts.refresh_issues import record_issue
from scripts.release_archive import reconcile_archive
from scripts.source_policy import save_availability


@pytest.fixture
def deployment(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(cloud, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.publish()
    workflow = Path(__file__).resolve().parents[1] / ".github/workflows/catalog-worker.yml"
    command = next(
        line.strip() for line in workflow.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("python -m scripts.cloudflare_catalog verify ")
    )
    monkeypatch.setattr("sys.argv", shlex.split(command)[2:])
    monkeypatch.setattr(cloud, "Cloud", lambda: memory)
    return memory


def forbid_full_audit(memory, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Deployment attempted a full catalog data scan")

    monkeypatch.setattr(memory, "verify_database", forbidden)
    monkeypatch.setattr(memory, "verified_blob", forbidden)
    monkeypatch.setattr(memory, "read_records", forbidden)


def test_actual_deployment_command_checks_only_ready_metadata(deployment, monkeypatch, capsys):
    memory = deployment
    active = memory.active()
    reads = []
    original_get = memory.get

    def read(key):
        reads.append(key)
        return original_get(key)

    monkeypatch.setattr(memory, "get", read)
    forbid_full_audit(memory, monkeypatch)
    cloud.main()
    assert reads == [active["manifest_key"]]
    assert '"verification": "metadata-only"' in capsys.readouterr().out


@pytest.mark.parametrize("upstream_error", ["403: Forbidden", "404: Not Found"])
def test_deployment_accepts_ready_catalog_with_upstream_failure(
    deployment, monkeypatch, capsys, upstream_error
):
    memory = deployment
    inventory = {"demo": {"patches": SOURCE}, "empty": {"patches": "https://gitlab.com/team/empty"}}
    save_availability(cloud.ROOT, {SOURCE: upstream_error})
    reconcile_archive(cloud.ROOT, inventory, {"https://gitlab.com/team/empty": []})
    record_issue(cloud.ROOT, SOURCE, "Release check", upstream_error)
    memory.publish()
    assert memory.document(memory.active())["complete"] is False

    with monkeypatch.context() as strict:
        strict.setattr("sys.argv", ["catalog", "verify", "--require-complete", "--metadata-only"])
        with pytest.raises(ValueError, match="backfill is not complete"):
            cloud.main()

    forbid_full_audit(memory, monkeypatch)
    cloud.main()
    assert '"complete": false' in capsys.readouterr().out


@pytest.mark.parametrize("problem", ["inactive", "unready", "mismatch", "corrupt"])
def test_deployment_rejects_invalid_ready_metadata(deployment, monkeypatch, problem):
    memory = deployment
    active = memory.active()
    document = memory.document(active)
    if problem in ("inactive", "unready"):
        if problem == "inactive":
            memory.sql("UPDATE catalog_state SET active_seq=NULL")
        else:
            memory.sql("UPDATE catalog_generations SET status='staging'")
        expected = "No active catalog"
    elif problem == "mismatch":
        document["manifest"]["generation"] = "f" * 24
        expected = "Generation manifest mismatch"
    else:
        document["base_generation"] = "f" * 24
        expected = "integrity mismatch"
    memory.put(active["manifest_key"], cloud.encode(document))
    forbid_full_audit(memory, monkeypatch)
    with pytest.raises(ValueError, match=expected):
        cloud.main()


def test_normal_maintenance_verify_still_audits_storage_and_database(
    deployment, monkeypatch, capsys
):
    memory = deployment
    calls = []
    original_document = memory.verify_document
    original_database = memory.verify_database

    def document(value, **kwargs):
        calls.append(("r2", kwargs.get("metadata_only", False)))
        return original_document(value, **kwargs)

    def database(sequence, value):
        calls.append(("d1", sequence))
        return original_database(sequence, value)

    monkeypatch.setattr(memory, "verify_document", document)
    monkeypatch.setattr(memory, "verify_database", database)
    monkeypatch.setattr("sys.argv", ["catalog", "verify", "--require-complete"])
    cloud.main()
    assert calls == [("r2", False), ("d1", memory.active()["seq"])]
    assert '"verification": "full"' in capsys.readouterr().out


def test_metadata_only_cannot_be_applied_to_recovery_operations(monkeypatch):
    def forbidden():
        pytest.fail("Invalid arguments initialized Cloudflare access")

    monkeypatch.setattr(cloud, "Cloud", forbidden)
    monkeypatch.setattr(
        "sys.argv", ["catalog", "restore", "--metadata-only", "--confirm", "RESTORE"]
    )
    with pytest.raises(SystemExit) as failure:
        cloud.main()
    assert failure.value.code == 2
