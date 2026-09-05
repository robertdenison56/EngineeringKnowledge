"""Question schema (task 5 of the Arc 1 plan) and JSONL loader.

One question per line. Every non-refusal question carries at least one anchor:
the manifest document id plus the 1-based PDF page index (not the printed
folio), optionally the table label. `quote` is a short verbatim string the
anchor validator must find on that page; when it is absent the validator
falls back to the answer and its aliases.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator

Bucket = Literal["lookup", "multihop", "trap", "refusal"]
AnswerType = Literal["number", "citation", "text", "refusal"]
Split = Literal["smoke", "dev", "test", "train"]


class Anchor(BaseModel):
    doc: str = Field(description="manifest document id, e.g. hdm-chp0200")
    page: int = Field(ge=1, description="1-based PDF page index")
    table: str | None = Field(default=None, description="table or figure label, e.g. 'Table 201.1'")
    quote: str | None = Field(default=None, description="verbatim string that must appear on the page")


class Question(BaseModel):
    id: str
    bucket: Bucket
    question: str
    answer: str = Field(description="canonical answer; NOT IN DOCUMENT for refusals")
    answer_type: AnswerType
    unit: str | None = None
    tolerance: float = Field(default=0.0, ge=0.0, description="absolute tolerance in `unit`")
    aliases: list[str] = Field(default_factory=list)
    anchors: list[Anchor] = Field(default_factory=list)
    edition: str | None = None
    split: Split = "test"
    notes: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> Question:
        if self.answer_type == "refusal":
            if self.bucket != "refusal":
                raise ValueError(f"{self.id}: answer_type refusal requires bucket refusal")
            if self.answer.strip().upper() != "NOT IN DOCUMENT":
                raise ValueError(f"{self.id}: refusal answer must be 'NOT IN DOCUMENT'")
        else:
            if not self.anchors:
                raise ValueError(f"{self.id}: non-refusal questions need at least one anchor")
        if self.answer_type == "number":
            try:
                float(self.answer.replace(",", ""))
            except ValueError as exc:
                raise ValueError(f"{self.id}: number answer must parse as float") from exc
        if self.bucket == "multihop" and len(self.anchors) < 2:
            raise ValueError(f"{self.id}: multihop questions need at least two anchors")
        return self


def load_questions(path: Path, split: str | None = None) -> list[Question]:
    """Read a JSONL file of questions; blank lines and `#` comments are skipped."""
    questions: list[Question] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            try:
                q = Question.model_validate(json.loads(line))
            except Exception as exc:  # re-raise with location
                raise ValueError(f"{path}:{line_no}: {exc}") from exc
            if q.id in seen:
                raise ValueError(f"{path}:{line_no}: duplicate id {q.id}")
            seen.add(q.id)
            if split is None or q.split == split:
                questions.append(q)
    return questions


def dump_questions(questions: Iterable[Question], path: Path) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for q in questions:
            fh.write(q.model_dump_json(exclude_none=True) + "\n")
