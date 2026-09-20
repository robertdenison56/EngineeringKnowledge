"""Question schema (task 5 of the Arc 1 plan) and JSONL loader.

One question per line. Every non-refusal question carries at least one anchor:
the manifest document id plus the 1-based PDF page index (not the printed
folio), optionally the table label. `quote` is a short verbatim string the
anchor validator must find on that page; when it is absent the validator
falls back to the answer and its aliases.

`shard` cuts the set into run-sized pieces. A shard is not a split: every shard
is the same population, dealt so that each one carries the whole mix, so one
shard is a runnable estimate of the set and a run that dies part way through
(a provider cap, a rate limit) still leaves a comparable number. `split` is the
separate, unfrozen dev/test question.
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
Shard = Literal["a", "b", "c", "d", "e", "f", "g", "h"]
SHARDS: tuple[Shard, ...] = ("a", "b", "c", "d", "e", "f", "g", "h")
MAX_SHARD = 100  # questions per shard; the deal uses as few shards as respects it
DEFAULT_SHARD = "a"  # a run is one shard unless it asks for another, or for ALL_SHARDS
ALL_SHARDS = "all"


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
    shard: Shard | None = Field(default=None, description="run shard; assigned by `questions shard`")
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


def load_questions(path: Path, split: str | None = None, shard: str | None = None) -> list[Question]:
    """Read a JSONL file of questions; blank lines and `#` comments are skipped.

    A `shard` is applied only to a set that has been dealt into shards, so asking
    for one from an unsharded file (`smoke.jsonl`) returns the whole file rather
    than nothing — the caller does not have to know which sets carry the field.
    """
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
    if shard is not None and any(q.shard for q in questions):
        questions = [q for q in questions if q.shard == shard]
    return questions


def shard_count(total: int) -> int:
    """How many shards a set of `total` questions needs to keep each at MAX_SHARD or under."""
    if total > MAX_SHARD * len(SHARDS):
        raise ValueError(f"{total} questions needs more than {len(SHARDS)} shards; widen the Shard literal")
    return max(1, -(-total // MAX_SHARD))


def stratify(questions: Iterable[Question], shards: int | None = None) -> dict[str, Shard]:
    """Deal the questions into shards that each carry the whole mix; id -> shard.

    `shards` defaults to the fewest that keep every shard at MAX_SHARD or under, so
    the deal stays inside the cap as the set grows. Growing past a multiple of it
    re-deals everything: a shard is a way to run the set, not a stable cohort, and
    a past run is identified by the ids it covered rather than by a letter.

    The stratum is (bucket, the document the first anchor names), and one stratum
    is dealt round-robin in file order: a run of near-duplicate questions off one
    table — four stopping sight distances at four design speeds — lands one per
    shard instead of four in one. The cursor carries across strata rather than
    restarting, so the leftovers of a stratum that does not divide evenly start the
    next one and no shard collects every remainder. The deal is a pure function of
    the file — same questions, same assignment — but not stable under edits: a
    question added to one stratum shifts the cursor for every stratum after it, so
    re-dealing can move questions that did not change. Runs are identified by the
    ids they covered.
    """
    strata: dict[tuple[str, str], list[str]] = {}
    for q in questions:
        strata.setdefault((q.bucket, q.anchors[0].doc if q.anchors else "-"), []).append(q.id)
    letters = SHARDS[: shards if shards is not None else shard_count(sum(len(v) for v in strata.values()))]
    assigned: dict[str, Shard] = {}
    cursor = 0
    for key in sorted(strata):
        for qid in strata[key]:
            assigned[qid] = letters[cursor % len(letters)]
            cursor += 1
    return assigned


def write_shards(path: Path, assigned: dict[str, Shard]) -> int:
    """Write shard assignments back into a JSONL set in place, line by line.

    Rewriting through the model would drop the `# ---- Table 201.1 ... ----`
    section comments that make the file readable and reorder every field, so each
    question line is edited as the object it already is: `shard` set last, and
    nothing else touched. Returns how many lines changed.
    """
    out: list[str] = []
    changed = 0
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            out.append(raw)
            continue
        row = json.loads(raw)
        shard = assigned.get(row["id"])
        if shard is None or row.get("shard") == shard:
            out.append(raw)
            continue
        row.pop("shard", None)
        row["shard"] = shard
        out.append(json.dumps(row, ensure_ascii=False))
        changed += 1
    path.write_text("\n".join(out) + "\n", encoding="utf-8")
    return changed


def dump_questions(questions: Iterable[Question], path: Path) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for q in questions:
            fh.write(q.model_dump_json(exclude_none=True) + "\n")
