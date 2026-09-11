"""Inspect task for plan understanding: a model reads a sheet and returns structured JSON.

Conditions (``-T condition=``):

* ``image``       the rendered sheet only (vision models)
* ``text``        the page's extracted text layer only (any text model)
* ``image_text``  both
* ``image_facts`` the image plus the product parser's facts for the page
                  (``-T facts_preds=plans/preds``), the ADR 0007 fusion made measurable

Every reply is scored in place (per-sheet title, sheet id, label F1, context F1,
fact coverage, and whether it was valid JSON) and can be written back as prediction
JSONL with ``caltrans-bench plans import-log`` for the full Tier 1 / 1b scorecard::

    uv run inspect eval caltrans_bench/plans_task.py -T condition=image -T split=dev --model anthropic/claude-sonnet-5
    uv run caltrans-bench plans import-log logs/<log>.eval --out-dir plans/preds-sonnet-image
    uv run caltrans-bench plans score --preds plans/preds-sonnet-image --split dev
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from inspect_ai import Task, task
from inspect_ai.dataset import MemoryDataset, Sample
from inspect_ai.model import ChatMessageUser, ContentImage, ContentText
from inspect_ai.scorer import Score, Scorer, Target, accuracy, mean, scorer
from inspect_ai.solver import TaskState, generate, system_message

from caltrans_bench import MANIFEST_PATH, RAW_DIR
from caltrans_bench.manifest import load_manifest
from caltrans_bench.plans import (
    CONTEXT_SETS,
    DEFAULT_GOLD,
    SET_FIELDS,
    SheetGold,
    SheetPrediction,
    load_gold,
    load_predictions,
    prediction_files,
    render_page,
    score,
)
from caltrans_bench.plans_context import parse_model_json
from caltrans_bench.task import research_path

SYSTEM_PROMPT = """You read Caltrans construction plan sheets and report what is printed on them.

Reply with ONE JSON object and nothing else, with exactly these keys:
{
  "sheet_number": "the sheet id in the title block, e.g. L-1 (not the SHEET No. integer), or null",
  "sheet_index": SHEET No. integer or null, "sheet_total": TOTAL SHEETS integer or null,
  "title": "the sheet title as printed in the title area, or null",
  "revision": "the LAST REVISION box as printed (00-00-00 is a value), or null",
  "scales": ["every scale statement on the sheet, as printed, e.g. 1\\" = 50'", "NO SCALE"],
  "views": ["labels of drawn views: SECTION A-A, DETAIL 3, PLAN, ELEVATION"],
  "match_lines": ["target sheet ids of match lines"],
  "references": ["sheet ids this sheet cites: SEE SHEET X-2, a SHEET No. column, Standard Plan ids"],
  "schedules": ["titles of tables"],
  "context": {
    "route": "route number from the title block, e.g. 505", "counties": ["as printed"],
    "post_miles": "POST MILES TOTAL PROJECT as printed", "roads": ["every road name shown, as printed"],
    "alignments": ["alignment line names printed in quotes, e.g. P1, B, A3"],
    "stations": [{"alignment": "P1", "begin": "10+00.00", "end": "16+95.81", "what": "what the limits bound"}],
    "structures": ["bridge names and numbers as printed"],
    "description": "two or three sentences on what the sheet shows: the work, where it is, and what it is for",
    "specifics": ["every printed station or station range with its line name", "every quantity with its unit",
                  "every identifier or code: detail numbers, sign codes, sheet ids, bridge numbers, boring ids",
                  "every named component or item: e.g. temporary barrier system, pipe seat extender, Bent 2"]
  }
}
Rules: copy strings exactly as printed; use null or [] when something is not printed rather than guessing;
stations are <number>+<two digits>[.<decimals>] with the line name they belong to; give a single station as
begin with end null; never invent a sheet id, revision, or station. The description names the work and the
place in prose; the specifics list carries the numbers, codes and component names exactly as printed —
a reader should be able to reconstruct the sheet's key facts from the two together."""


def _prompt(row: SheetGold, condition: str, text: str | None, facts: str | None) -> list[ContentText | ContentImage]:
    parts: list[ContentText | ContentImage] = [
        ContentText(text=f"Plan set {row.doc}, PDF page {row.page}. Report this sheet as JSON.")
    ]
    if condition in ("image", "image_text", "image_facts"):
        parts.append(ContentImage(image=str(render_page(load_manifest(MANIFEST_PATH).by_id()[row.doc], row.page))))
    if condition in ("text", "image_text") and text is not None:
        parts.append(ContentText(text=f"TEXT LAYER (extracted strings in draw order):\n{text[:8000]}"))
    if condition == "image_facts" and facts:
        parts.append(ContentText(text=f"DETERMINISTIC PARSE of this page (trust for identifiers):\n{facts}"))
    return parts


def _format_facts(pred: SheetPrediction | None) -> str | None:
    if pred is None or not pred.extracted:
        return None
    lines = []
    for name in ("sheet_number", "sheet_index", "sheet_total", "title", "revision"):
        value = getattr(pred, name)
        if value is not None:
            lines.append(f"{name}: {value}")
    for name in ("scales", "views", "callouts", "match_lines", "schedules", "dimensions"):
        values = getattr(pred, name)
        if values:
            lines.append(f"{name}: {'; '.join(values)}")
    return "\n".join(lines) or None


def score_sample(row: SheetGold, completion: str) -> dict[str, float]:
    """Per-sheet metrics from one model reply (pure; shared by the Inspect scorer and tests)."""
    obj = parse_model_json(completion)
    pred = SheetPrediction.from_facts(row.doc, row.page, obj)
    card = score([row], {row.id: pred}).to_dict()

    def f1(tallies: dict[str, dict[str, Any]], extra: dict[str, Any] | None = None) -> float:
        tp = sum(t["tp"] for t in tallies.values()) + (extra["tp"] if extra else 0)
        fp = sum(t["fp"] for t in tallies.values()) + (extra["fp"] if extra else 0)
        fn = sum(t["fn"] for t in tallies.values()) + (extra["fn"] if extra else 0)
        return round(2 * tp / (2 * tp + fp + fn), 4) if (tp + fp + fn) else 1.0

    ctx = card["context"]
    return {
        "json": 1.0 if obj is not None else 0.0,
        "sheet_number": card["scalars"]["sheet_number"]["accuracy"],
        "title": card["scalars"]["title"]["accuracy"],
        "labels_f1": f1({k: card["sets"][k] for k in SET_FIELDS}),
        "context_f1": f1({k: ctx["sets"][k] for k in CONTEXT_SETS}, ctx["stations"]) if ctx["sheets"] else 0.0,
        "facts": ctx["facts"]["coverage"] if ctx["facts"]["facts"] else 0.0,
    }


@scorer(
    metrics={
        "json": [accuracy()],
        "sheet_number": [accuracy()],
        "title": [accuracy()],
        "labels_f1": [mean()],
        "context_f1": [mean()],
        "facts": [mean()],
    }
)
def sheet_scorer() -> Scorer:
    async def score_fn(state: TaskState, target: Target) -> Score:
        row = SheetGold.model_validate(state.metadata["gold"])
        values = score_sample(row, state.output.completion)
        return Score(value=values, answer=state.output.completion[:500], explanation=json.dumps(values))

    return score_fn


@task
def plan_sheets(
    gold: str = str(DEFAULT_GOLD),
    split: str | None = None,
    docs: str | None = None,
    condition: str = "image",
    dpi: int = 80,
    facts_preds: str | None = None,
) -> Task:
    if condition not in ("image", "text", "image_text", "image_facts"):
        raise ValueError(f"unknown condition {condition!r}")
    rows = load_gold(research_path(gold), split=split)
    if docs:
        wanted = {d.strip() for d in docs.split(",") if d.strip()}
        rows = [r for r in rows if r.doc in wanted]
    if not rows:
        raise ValueError("no labelled gold sheets selected")
    manifest = load_manifest(MANIFEST_PATH).by_id()
    facts_by_id: dict[str, SheetPrediction] = {}
    if condition == "image_facts":
        if not facts_preds:
            raise ValueError("condition=image_facts needs -T facts_preds=<preds dir or file>")
        facts_by_id = load_predictions(prediction_files(research_path(facts_preds)))
    if condition in ("image", "image_text", "image_facts"):
        for row in rows:  # render up front so a missing PDF fails before any model call
            render_page(manifest[row.doc], row.page, dpi=dpi, raw_dir=RAW_DIR)
    from caltrans_bench.text import page_text

    samples = []
    for row in rows:
        text = page_text(manifest[row.doc], row.page, RAW_DIR) if condition in ("text", "image_text") else None
        facts = _format_facts(facts_by_id.get(row.id)) if condition == "image_facts" else None
        samples.append(
            Sample(
                id=row.id,
                input=[ChatMessageUser(content=_prompt(row, condition, text, facts))],
                target="",
                metadata={"doc": row.doc, "page": row.page, "gold": row.model_dump(mode="json")},
            )
        )
    return Task(
        dataset=MemoryDataset(samples, name=f"plan-sheets:{Path(gold).stem}"),
        # system_message() formats the template with sample metadata; the JSON braces must be escaped.
        solver=[system_message(SYSTEM_PROMPT.replace("{", "{{").replace("}", "}}")), generate()],
        scorer=sheet_scorer(),
        metadata={"condition": condition, "split": split, "dpi": dpi},
    )
