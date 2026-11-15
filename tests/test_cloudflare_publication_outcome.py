import pytest
from test_cloudflare_catalog import MemoryCloud, catalog

from scripts import cloudflare_catalog as module


def test_cleanup_failure_reports_successful_activation_and_can_retry(
    tmp_path, monkeypatch, capsys
):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    catalog(tmp_path)
    prune = memory.prune

    def fail(*args, **kwargs):
        raise RuntimeError("HTTP 429 during retention")

    monkeypatch.setattr(memory, "prune", fail)
    with pytest.raises(RuntimeError, match="HTTP 429") as failure:
        memory.publish()
    active = memory.active()
    assert active
    outcome = memory.publication_metrics["publication_outcome"]
    assert outcome == {
        "generation": active["generation"], "published": True, "retention": "failed"
    }
    assert "published successfully; retention cleanup failed" in failure.value.__notes__[0]
    assert '"retention": "failed"' in capsys.readouterr().out
    memory.verify_database(active["seq"], memory.document(active))

    monkeypatch.setattr(memory, "prune", prune)
    memory.publish()
    assert memory.active() == active
    assert memory.publication_metrics["publication_outcome"]["retention"] == "completed"


def test_failed_insert_does_not_report_publication_success(tmp_path, monkeypatch):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    catalog(tmp_path)
    memory.fail_insert = True
    with pytest.raises(RuntimeError, match="Interrupted"):
        memory.publish()
    assert memory.active() is None
    assert "publication_outcome" not in memory.publication_metrics


@pytest.mark.parametrize("report_fails", [False, True])
def test_cli_writes_actions_summary_even_when_cleanup_fails(tmp_path, monkeypatch, report_fails):
    memory = MemoryCloud(tmp_path)
    monkeypatch.setattr(module, "ROOT", tmp_path)
    catalog(tmp_path)

    def fail(*args, **kwargs):
        raise RuntimeError("Cleanup unavailable")

    monkeypatch.setattr(memory, "prune", fail)
    if report_fails:
        def failed_report(*args):
            raise OSError("Diagnostic file unavailable")

        monkeypatch.setattr(memory, "report", failed_report)
    monkeypatch.setattr(module, "Cloud", lambda: memory)
    monkeypatch.setattr("sys.argv", ["cloudflare_catalog", "publish"])
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    with pytest.raises(RuntimeError, match="Cleanup unavailable"):
        module.main()
    text = summary.read_text()
    assert "published successfully" in text and "**failed**" in text
