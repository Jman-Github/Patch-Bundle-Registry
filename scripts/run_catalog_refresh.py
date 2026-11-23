"""Refresh in phases with private cloud checkpoints or legacy Git publication.

Only --publish inside GitHub Actions commits or pushes. Local runs never change Git.
"""

import argparse
import base64
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path

try:
    from scripts.generate_database import (
        ROOT,
        build_database,
        build_site,
        encoded,
        read_json,
        restore_catalog_cache,
    )
    from scripts.source_policy import write_extraction_policy
    from scripts.validate_database import validate
except ModuleNotFoundError:
    from generate_database import (
        ROOT,
        build_database,
        build_site,
        encoded,
        read_json,
        restore_catalog_cache,
    )
    from source_policy import write_extraction_policy
    from validate_database import validate


def instant():
    return datetime.now(UTC).isoformat()


class Refresh:
    def __init__(self, root, publish=False, interval=30, cloudflare=False):
        self.root = Path(root)
        self.publish = publish
        self.cloudflare = cloudflare
        self.interval = max(300, interval) if cloudflare else interval
        self.last_publish = 0
        self.jobs = []
        self.run_id = os.environ.get("GITHUB_RUN_ID", str(uuid.uuid4()))
        self.run_attempt = int(os.environ.get("GITHUB_RUN_ATTEMPT", "1"))
        if publish and (
            os.environ.get("GITHUB_ACTIONS") != "true" or not os.environ.get("GIT_TOKEN")
        ):
            raise ValueError("Publishing requires GitHub Actions and GIT_TOKEN")
        for kind in ("BUNDLES", "PATCHES"):
            self.jobs.append(
                {
                    "job_id": str(
                        uuid.uuid5(uuid.NAMESPACE_URL, f"{self.run_id}/{self.run_attempt}/{kind}")
                    ),
                    "job_type": kind,
                    "actions_run_id": self.run_id,
                    "actions_run_attempt": self.run_attempt,
                    "status": "STARTED",
                    "started_at": instant(),
                    "completed_at": None,
                    "error": None,
                }
            )

    def save_jobs(self):
        path = self.root / "internal/cache/refresh-jobs.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_bytes(encoded(self.jobs))
        temp.replace(path)

    def checkpoint(self, force=False):
        if not force and time.monotonic() - self.last_publish < self.interval:
            return
        self.save_jobs()
        if self.cloudflare:
            from scripts.cloudflare_catalog import Cloud

            # Publication and the final checkpoint handle orphan cleanup under
            # the same workflow lock. Keep intermediate checkpoints lightweight.
            Cloud().checkpoint(cleanup_obsolete=False)
            self.last_publish = time.monotonic()
            return
        build_database(self.root, restore=False)
        validate(self.root)
        if self.publish:
            self.push()
        self.last_publish = time.monotonic()

    def push(self):
        executable = shutil.which("git")
        if not executable:
            raise RuntimeError("Git is required to publish catalog checkpoints")

        def git(*args, **kwargs):
            # Arguments are constructed here; no commands originate from catalog data.
            return subprocess.run([executable, *args], cwd=self.root, **kwargs)  # noqa: S603

        def commit(message):
            git(
                "-c",
                "user.name=github-actions[bot]",
                "-c",
                "user.email=41898282+github-actions[bot]@users.noreply.github.com",
                "commit",
                "-m",
                message,
                check=True,
            )

        git("add", "--", "database", check=True)
        if git("diff", "--cached", "--quiet").returncode:
            commit("chore: publish patch catalog progress")
        manifest_path = self.root / "database/manifest.json"
        manifest = read_json(manifest_path)
        if not manifest:
            raise ValueError("A catalog manifest is required for publication")
        if not manifest.get("snapshot_ref"):
            reference = git(
                "rev-parse", "HEAD", check=True, capture_output=True, text=True
            ).stdout.strip()
            if not re.fullmatch(r"[a-f0-9]{40}", reference):
                raise ValueError("Invalid publication commit")
            manifest["snapshot_ref"] = reference
            temporary = manifest_path.with_suffix(".tmp")
            temporary.write_bytes(encoded(manifest))
            temporary.replace(manifest_path)
            git("add", "--", "database/manifest.json", check=True)
            commit("chore: anchor catalog snapshot reads")
        # Always retry the push, even if an earlier attempt committed successfully.
        # Credentials stay out of command arguments and error messages.
        authorization = ("x-access-token:" + os.environ["GIT_TOKEN"]).encode()
        credentials = base64.b64encode(authorization).decode()
        env = {
            **os.environ,
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
            "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic " + credentials,
            "GIT_TRACE": "0",
            "GIT_CURL_VERBOSE": "0",
        }
        branch = read_json(self.root / "config/site.json")["data_branch"]
        git("push", "origin", "HEAD:refs/heads/" + branch, env=env, check=True)

    def phase(self, kind, command, optional=False):
        job = next(row for row in self.jobs if row["job_type"] == kind)
        job.update(status="STARTED", started_at=instant())
        self.checkpoint(force=True)
        try:
            # Commands come from run(), not repository metadata or API requests.
            process = subprocess.Popen(command, cwd=self.root)  # noqa: S603
        except OSError:
            job.update(status="FAILED", completed_at=instant(), error=f"Could not start {kind}")
            self.checkpoint(force=True)
            if not optional:
                raise
            return
        checkpoint_error = None
        try:
            while process.poll() is None:
                time.sleep(2)
                try:
                    self.checkpoint()
                except Exception as error:
                    checkpoint_error = error
                    print(
                        "Intermediate publication failed; the next checkpoint will retry.",
                        file=sys.stderr,
                    )
            code = process.returncode
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        job.update(
            status="COMPLETED" if code == 0 else "FAILED",
            completed_at=instant(),
            error=None if code == 0 else f"{kind} refresh exited with code {code}",
        )
        self.checkpoint(force=True)
        if code and not optional:
            raise RuntimeError(job["error"]) from checkpoint_error

    def run(self):
        try:
            self._run()
        except BaseException:
            for job in self.jobs:
                if job["status"] in ("STARTED", "PENDING", "RUNNING"):
                    job.update(
                        status="FAILED",
                        completed_at=instant(),
                        error="Refresh stopped before this phase completed",
                    )
            try:
                self.checkpoint(force=True)
            except Exception:
                print("Final progress publication failed.", file=sys.stderr)
            raise

    def _run(self):
        try:
            from scripts.refresh_issues import extraction_issues, read_issues
            from scripts.source_cleanup import clean_inputs
        except ModuleNotFoundError:
            from refresh_issues import extraction_issues, read_issues
            from source_cleanup import clean_inputs

        issues = self.root / "internal/cache/refresh-issues.json"
        issues.parent.mkdir(parents=True, exist_ok=True)
        issues.write_bytes(encoded([]))
        clean_inputs(self.root)
        restore_catalog_cache(self.root)
        python = sys.executable
        self.phase(
            "BUNDLES", [python, "scripts/discover_releases.py"], optional=not self.cloudflare
        )
        subprocess.run(  # noqa: S603 -- fixed interpreter and local script
            [python, "scripts/refresh_source_metadata.py"], cwd=self.root, check=False
        )
        write_extraction_policy(self.root)
        if self.cloudflare:
            from scripts.prepare_refresh import prepare_extraction

            prepare_extraction(self.root)
        wrapper = self.root / "bundle-parser" / ("gradlew.bat" if os.name == "nt" else "gradlew")
        if os.name != "nt":
            wrapper.chmod(wrapper.stat().st_mode | 0o111)
        command = [str(wrapper), "--project-dir", "bundle-parser", "run"]
        if self.cloudflare:
            # Release the extraction JVM before the memory-intensive catalog build and publish.
            command.append("--no-daemon")
        try:
            self.phase("PATCHES", command)
        finally:
            extraction_issues(self.root, self.jobs[1]["started_at"])
        subprocess.run(  # noqa: S603 -- fixed interpreter and local script
            [python, "scripts/refresh_app_metadata.py"], cwd=self.root, check=False
        )
        self.checkpoint(force=True)
        if read_issues(self.root):
            print(f"Refresh completed with {len(read_issues(self.root))} diagnostics")
        if self.cloudflare:
            build_database(self.root, restore=False)
            validate(self.root)
        build_site(self.root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--cloudflare", action="store_true")
    args = parser.parse_args()
    Refresh(ROOT, publish=args.publish, cloudflare=args.cloudflare).run()
