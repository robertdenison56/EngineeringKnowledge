"""The README's ``inspect eval caltrans_bench/task.py …`` invocation must keep working.

Inspect loads a file-path task as a standalone module (no parent package, so relative
imports break) and runs it with the working directory set to ``caltrans_bench/`` (so
research-relative ``-T`` paths break). Calling the task function from Python hides both
traps, which is why this drives the real CLI in a subprocess, exactly as documented.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from inspect_ai.log import list_eval_logs, read_eval_log

from caltrans_bench import RESEARCH_DIR

# The console script that ships with inspect-ai, taken from the interpreter running
# pytest so the test never picks up a different environment's `inspect`.
INSPECT_CLI = shutil.which("inspect", path=str(Path(sys.executable).parent))


def test_readme_inspect_eval_file_path_invocation(tmp_path: Path) -> None:
    assert INSPECT_CLI, f"no `inspect` console script next to {sys.executable}"
    log_dir = tmp_path / "logs"
    cmd = [
        INSPECT_CLI,
        "eval",
        "caltrans_bench/task.py",
        "-T",
        "condition=closed_book",
        "-T",
        "questions=questions/smoke.jsonl",  # research-relative, as the README writes it
        "--model",
        "mockllm/model",
        "--limit",
        "1",
        "--log-dir",
        str(log_dir),
        "--display",
        "plain",
    ]
    proc = subprocess.run(cmd, cwd=RESEARCH_DIR, capture_output=True, text=True, timeout=300)
    assert proc.returncode == 0, f"{' '.join(cmd)}\n--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"

    logs = list_eval_logs(str(log_dir))
    assert len(logs) == 1, logs
    log = read_eval_log(logs[0])
    assert log.status == "success", log.error
    assert log.eval.task_args["condition"] == "closed_book"
    assert log.eval.dataset.name == "caltrans-bench:smoke"
    assert log.results is not None and log.results.completed_samples == 1


def test_research_path_resolves_readme_relative_paths(tmp_path: Path, monkeypatch) -> None:
    from caltrans_bench.task import research_path

    monkeypatch.chdir(tmp_path)  # anywhere but research/, like Inspect's chdir into caltrans_bench/
    assert research_path("questions/smoke.jsonl") == RESEARCH_DIR / "questions" / "smoke.jsonl"
    local = tmp_path / "local.jsonl"
    local.write_text("")
    assert research_path("local.jsonl") == Path("local.jsonl")  # exists from the cwd: used as given
    assert research_path(str(local)) == local  # absolute: used as given
