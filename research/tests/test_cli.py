"""`caltrans-bench questions` behaviour that the schema tests cannot reach."""

from __future__ import annotations

import json
from pathlib import Path

from caltrans_bench import QUESTIONS_DIR
from caltrans_bench.cli import main


def _copy(src: Path, dst: Path, drop_shard_from: str | None = None) -> Path:
    out = []
    for line in src.read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            row = json.loads(line)
            if row["id"] == drop_shard_from:
                row.pop("shard", None)
            line = json.dumps(row)
        out.append(line)
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")
    return dst


def test_validate_rejects_a_part_sharded_set(tmp_path: Path, capsys):
    """`shard=a` filters on the field, so a question added since the last deal would
    sit out every run rather than error. Validation is where that has to surface."""
    src = QUESTIONS_DIR / "caltrans-v0.jsonl"
    whole = _copy(src, tmp_path / "whole.jsonl")
    assert main(["questions", "validate", str(whole), "--offline"]) == 0

    part = _copy(src, tmp_path / "part.jsonl", drop_shard_from="cb-002")
    assert main(["questions", "validate", str(part), "--offline"]) == 1
    out = capsys.readouterr().out
    assert "cb-002" in out and "questions shard" in out


def test_shard_deals_and_is_idempotent(tmp_path: Path, capsys):
    fresh = _copy(QUESTIONS_DIR / "caltrans-v0.jsonl", tmp_path / "q.jsonl")
    assert main(["questions", "shard", str(fresh), "--dry-run"]) == 0
    assert "nothing written" in capsys.readouterr().out
    assert main(["questions", "shard", str(fresh)]) == 0
    assert "0 line(s) updated" in capsys.readouterr().out  # already dealt: a no-op
