import json
from collections import Counter
from pathlib import Path

import pytest

from caltrans_bench import QUESTIONS_DIR
from caltrans_bench.schema import (
    MAX_SHARD,
    SHARDS,
    Question,
    load_questions,
    shard_count,
    stratify,
    write_shards,
)

BASE = {
    "id": "q1",
    "bucket": "lookup",
    "question": "What?",
    "answer": "580",
    "answer_type": "number",
    "unit": "ft",
    "anchors": [{"doc": "hdm-chp0200", "page": 12, "table": "Table 201.1"}],
}


def test_valid_question():
    q = Question.model_validate(BASE)
    assert q.split == "test" and q.tolerance == 0.0


def test_non_refusal_requires_anchor():
    with pytest.raises(ValueError):
        Question.model_validate({**BASE, "anchors": []})


def test_refusal_shape():
    q = Question.model_validate(
        {**BASE, "bucket": "refusal", "answer_type": "refusal", "answer": "NOT IN DOCUMENT", "anchors": []}
    )
    assert q.answer_type == "refusal"
    with pytest.raises(ValueError):
        Question.model_validate({**BASE, "answer_type": "refusal", "answer": "NOT IN DOCUMENT"})


def test_number_must_parse():
    with pytest.raises(ValueError):
        Question.model_validate({**BASE, "answer": "five"})


def test_multihop_needs_two_anchors():
    with pytest.raises(ValueError):
        Question.model_validate({**BASE, "bucket": "multihop"})


def test_loader_rejects_duplicate_ids(tmp_path: Path):
    p = tmp_path / "q.jsonl"
    p.write_text(json.dumps(BASE) + "\n# comment\n" + json.dumps(BASE) + "\n")
    with pytest.raises(ValueError, match="duplicate"):
        load_questions(p)


def test_smoke_set_loads():
    qs = load_questions(QUESTIONS_DIR / "smoke.jsonl")
    assert qs, "smoke.jsonl must hold at least one question"
    assert all(q.split == "smoke" for q in qs)


def test_shard_defaults_to_unassigned():
    assert Question.model_validate(BASE).shard is None
    assert Question.model_validate({**BASE, "shard": "c"}).shard == "c"
    with pytest.raises(ValueError):
        Question.model_validate({**BASE, "shard": "z"})


def test_shard_count_follows_the_cap():
    assert shard_count(1) == 1
    assert shard_count(MAX_SHARD) == 1
    assert shard_count(MAX_SHARD + 1) == 2
    assert shard_count(388) == 4
    with pytest.raises(ValueError, match="widen the Shard literal"):
        shard_count(MAX_SHARD * len(SHARDS) + 1)


def _spread(qs: list[Question]) -> dict:
    assigned = stratify(qs)
    per: dict[str, Counter] = {}
    for q in qs:
        per.setdefault(assigned[q.id], Counter())[q.bucket] += 1
    return per


def test_stratify_gives_every_shard_the_same_mix():
    qs = load_questions(QUESTIONS_DIR / "caltrans-v0.jsonl")
    per = _spread(qs)
    assert len(per) == shard_count(len(qs))
    sizes = [sum(c.values()) for c in per.values()]
    assert max(sizes) <= MAX_SHARD
    assert max(sizes) - min(sizes) <= 1
    # The point of the deal: no shard is short of a bucket the whole set has.
    for bucket in {q.bucket for q in qs}:
        counts = [c[bucket] for c in per.values()]
        assert max(counts) - min(counts) <= 1, f"{bucket} is uneven across shards: {counts}"


def test_stratify_is_deterministic_and_matches_the_committed_file():
    qs = load_questions(QUESTIONS_DIR / "caltrans-v0.jsonl")
    assigned = stratify(qs)
    assert assigned == stratify(qs)
    assert {q.id: q.shard for q in qs} == assigned, "run: caltrans-bench questions shard questions/caltrans-v0.jsonl"


def test_load_questions_filters_by_shard():
    path = QUESTIONS_DIR / "caltrans-v0.jsonl"
    everything = load_questions(path)
    one = load_questions(path, shard="a")
    assert 0 < len(one) < len(everything)
    assert all(q.shard == "a" for q in one)
    assert sum(len(load_questions(path, shard=s)) for s in SHARDS[: shard_count(len(everything))]) == len(everything)


def test_shard_filter_is_a_no_op_on_an_unsharded_set():
    """CI's smoke set carries no shards; asking for one must not silently empty it."""
    qs = load_questions(QUESTIONS_DIR / "smoke.jsonl", shard="a")
    assert len(qs) == len(load_questions(QUESTIONS_DIR / "smoke.jsonl"))


def test_write_shards_keeps_comments_and_field_order(tmp_path: Path):
    p = tmp_path / "q.jsonl"
    header = "# a section comment\n"
    p.write_text(header + json.dumps(BASE) + "\n\n" + json.dumps({**BASE, "id": "q2"}) + "\n")
    assert write_shards(p, {"q1": "a", "q2": "b"}) == 2
    lines = p.read_text().splitlines()
    assert lines[0] == header.rstrip() and lines[2] == ""
    first = json.loads(lines[1])
    assert list(first)[:-1] == list(BASE) and list(first)[-1] == "shard" and first["shard"] == "a"
    assert write_shards(p, {"q1": "a", "q2": "b"}) == 0  # a second pass is a no-op
