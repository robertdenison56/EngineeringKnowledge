import json
from pathlib import Path

import pytest

from caltrans_bench import QUESTIONS_DIR
from caltrans_bench.schema import Question, load_questions

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
