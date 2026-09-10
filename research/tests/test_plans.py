"""Plan understanding work — schema, text-layer check, normalization, scoring, and the extraction boundary."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from caltrans_bench import REPO_ROOT, plans
from caltrans_bench.manifest import Document, Manifest
from caltrans_bench.plans import (
    SheetGold,
    SheetPrediction,
    load_gold,
    load_predictions,
    norm_field,
    regressions,
    score,
    template_rows,
    text_has,
    validate_gold,
)

GOLD = {
    "id": "d3-03-2H4504-plans:p2",
    "doc": "d3-03-2H4504-plans",
    "page": 2,
    "split": "dev",
    "sheet_kind": "layout",
    "sheet_number": "L-1",
    "sheet_index": 2,
    "sheet_total": 27,
    "title": "LAYOUT",
    "revision": "00-00-00",
    "scales": ["1\" = 50'"],
    "schedules": ["CURVE DATA"],
}

PAGE_TEXT = (
    "PUTAH CREEK Rd|R OU TE 505|CURVE DATA|L-1|SCALE: 1\" = 50'|LAYOUT|SHEET|No.|TOTAL|SHEETS|"
    "00-00-00|ASTM C920|MATCH LINE SEE SHEET L-2"
).replace("|", "\n")


# --- schema -------------------------------------------------------------------


def test_gold_row_validates():
    row = SheetGold.model_validate(GOLD)
    assert row.status == "labelled" and row.sheet_index == 2


def test_id_must_match_doc_and_page():
    with pytest.raises(ValueError):
        SheetGold.model_validate({**GOLD, "id": "d3-03-2H4504-plans:p3"})


def test_index_and_total_go_together():
    with pytest.raises(ValueError):
        SheetGold.model_validate({**GOLD, "sheet_total": None})
    with pytest.raises(ValueError):
        SheetGold.model_validate({**GOLD, "sheet_index": 30})


def test_duplicate_set_items_rejected_after_normalization():
    with pytest.raises(ValueError):
        SheetGold.model_validate({**GOLD, "scales": ["1\" = 50'", "1\"=50'"]})


def test_todo_rows_are_skipped_unless_asked(tmp_path: Path):
    path = tmp_path / "gold.jsonl"
    todo = {"id": "d3-03-2H4504-plans:p3", "doc": "d3-03-2H4504-plans", "page": 3, "status": "todo"}
    path.write_text("# header\n" + json.dumps(GOLD) + "\n" + json.dumps(todo) + "\n")
    assert [r.id for r in load_gold(path)] == ["d3-03-2H4504-plans:p2"]
    assert len(load_gold(path, include_todo=True)) == 2
    assert load_gold(path, split="test") == []


def test_duplicate_ids_rejected(tmp_path: Path):
    path = tmp_path / "gold.jsonl"
    path.write_text(json.dumps(GOLD) + "\n" + json.dumps(GOLD) + "\n")
    with pytest.raises(ValueError, match="duplicate"):
        load_gold(path)


# --- text-layer check -----------------------------------------------------------


def test_text_has_whole_tokens_and_formatting_noise():
    assert text_has(PAGE_TEXT, "L-1")
    assert text_has(PAGE_TEXT, "1\"=50'")
    assert text_has(PAGE_TEXT, "curve data")
    assert text_has(PAGE_TEXT, "00-00-00")


def test_text_has_letter_spaced_cad_text():
    assert text_has(PAGE_TEXT, "ROUTE 505")  # extracts as "R OU TE 505"


def test_text_has_multi_line_titles_in_any_line_order():
    page = "CRASH CUSHION\nALTERNATIVE TEMPORARY\nSHEET No.\nTOTAL"
    assert text_has(page, "ALTERNATIVE TEMPORARY CRASH CUSHION")  # two lines, extracted bottom-up
    assert not text_has(page, "ALTERNATIVE PERMANENT CRASH CUSHION")
    assert not text_has("A B C D", "B D A")  # short single tokens never complete a run match
    assert not text_has(page, "CUSHION TOTAL")  # under three tokens: contiguous only
    four_lines = "(TYPE ESA)\nFENCE\nHIGH-VISIBILITY\nTEMPORARY"
    assert text_has(four_lines, "TEMPORARY HIGH-VISIBILITY FENCE (TYPE ESA)")
    assert not text_has(four_lines, "TEMPORARY LOW-VISIBILITY FENCE (TYPE ESA)")


def test_text_has_respects_token_boundaries():
    assert not text_has(PAGE_TEXT, "ASTM C92")  # only "ASTM C920" is on the page
    assert not text_has(PAGE_TEXT, "L-2X")
    assert not text_has(PAGE_TEXT, "")


def test_validate_gold_finds_missing_strings(monkeypatch):
    manifest = Manifest(
        schema_version=1,
        corpus="t",
        documents=[
            Document(id="d3-03-2H4504-plans", group="district3", kind="plans", title="P", file="p.pdf", pages=27)
        ],
    )
    monkeypatch.setattr("caltrans_bench.text.page_text", lambda doc, page, raw_dir: PAGE_TEXT)
    ok = SheetGold.model_validate(GOLD)
    assert validate_gold([ok], manifest) == []
    bad = SheetGold.model_validate({**GOLD, "title": "NOT ON SHEET", "views": ["SECTION A-A"]})
    problems = validate_gold([bad], manifest)
    assert len(problems) == 2 and "title" in problems[0] and "views" in problems[1]
    exempt = SheetGold.model_validate({**GOLD, "views": ["SECTION A-A"], "visual_only": ["SECTION A-A"]})
    assert validate_gold([exempt], manifest) == []
    out_of_range = SheetGold.model_validate({**GOLD, "id": "d3-03-2H4504-plans:p99", "page": 99})
    assert "beyond" in validate_gold([out_of_range], manifest)[0]
    unknown = SheetGold.model_validate({**GOLD, "id": "nope:p2", "doc": "nope"})
    assert "unknown doc" in validate_gold([unknown], manifest, offline=True)[0]


# --- normalization --------------------------------------------------------------


def test_field_normalization():
    assert norm_field("scales", "1\" = 50'") == norm_field("scales", "1″=50′")
    assert norm_field("sheet_number", "l - 1") == norm_field("sheet_number", "L-1") == "L1"
    assert norm_field("references", "3/S-101".rsplit("/", 1)[-1]) == "S101"
    assert norm_field("title", "Traffic  Handling — Plan") == "traffic handling plan"
    assert norm_field("schedules", "2×2 table") == norm_field("schedules", "table") == "table"
    assert norm_field("schedules", "CURVE DATA") == "curve data"
    assert norm_field("scales", '¾" = 1\'-0"') == norm_field("scales", '3/4" = 1\'-0"')
    assert text_has('SECTION A-A\n¾" = 1\'-0"', '3/4" = 1\'-0"')


# --- predictions ------------------------------------------------------------------


def test_prediction_from_facts_maps_vocabulary():
    facts = {
        "page": 5,
        "sheetNumber": "TH-1",
        "title": "TRAFFIC HANDLING PLAN",
        "revision": "00-00-00",
        "sheetIndex": 5,
        "sheetTotal": 27,
        "views": ["SECTION A-A"],
        "scales": ["1\" = 50'", "NO SCALE"],
        "dimensions": ["4'"],
        "callouts": ["3/S-101", "C-103"],
        "matchLines": ["→ C-103", "MATCH LINE"],
        "schedules": ["2×2 table"],
        "layers": [],
    }
    pred = SheetPrediction.from_facts("d", 5, facts, ms=12.0)
    assert pred.id == "d:p5" and pred.sheet_index == 5 and pred.extracted
    assert pred.set_items("references") == ["S-101", "C-103"]
    assert pred.set_items("match_lines") == ["C-103"]
    assert pred.unresolved_match_lines == 1
    assert not SheetPrediction.from_facts("d", 6, None).extracted


def test_load_predictions_later_lines_win(tmp_path: Path):
    p = tmp_path / "d.jsonl"
    p.write_text(
        json.dumps({"doc": "d", "page": 1, "ms": 1, "facts": None})
        + "\n"
        + json.dumps({"doc": "d", "page": 1, "ms": 2, "facts": {"sheetNumber": "A-1"}})
        + "\n"
    )
    preds = load_predictions([p])
    assert preds["d:p1"].sheet_number == "A-1" and preds["d:p1"].extracted


# --- scoring ------------------------------------------------------------------------


def _gold(page: int, **over) -> SheetGold:
    base = {"id": f"d:p{page}", "doc": "d", "page": page, "split": "dev"}
    return SheetGold.model_validate({**base, **over})


def test_score_scalar_confusion_and_set_metrics():
    gold = [
        _gold(
            1,
            sheet_number="L-1",
            sheet_index=1,
            sheet_total=3,
            title="LAYOUT",
            scales=["1\"=50'"],
            schedules=["CURVE DATA"],
        ),
        _gold(2, sheet_number="U-1", title="UTILITY PLAN", references=["X-2"], match_lines=["U-2"]),
        _gold(3),  # blank sheet: everything "not printed"
        _gold(4, sheet_number="Q-1"),  # no prediction at all
    ]
    preds = {
        "d:p1": SheetPrediction.from_facts(
            "d",
            1,
            {
                "sheetNumber": "L-1",
                "sheetIndex": 1,
                "sheetTotal": 3,
                "title": "RETROFIT WORK",
                "scales": ["1\" = 50'"],
                "schedules": ["CURVE DATA", "2×2 table"],
            },
        ),
        "d:p2": SheetPrediction.from_facts(
            "d",
            2,
            {
                "sheetNumber": "U-1",
                "callouts": ["X-2", "S-9"],
                "matchLines": ["MATCH LINE"],
            },
        ),
        "d:p3": SheetPrediction.from_facts("d", 3, {"title": "GHOST"}),
    }
    card = score(gold, preds, meta={"note": "test"})
    d = card.to_dict()
    assert d["sheets"] == {
        "gold": 4,
        "scored": 3,
        "missing_prediction": 1,
        "extracted": 3,
        "extracted_rate": 1.0,
        "unresolved_match_lines": 1,
    }
    sn = d["scalars"]["sheet_number"]
    assert (sn["correct"], sn["wrong"], sn["missed"], sn["fabricated"], sn["both_null"]) == (2, 0, 0, 0, 1)
    assert sn["accuracy"] == 1.0
    title = d["scalars"]["title"]
    assert (title["correct"], title["wrong"], title["missed"], title["fabricated"], title["both_null"]) == (
        0,
        1,
        1,
        1,
        0,
    )
    assert title["null_recall"] == 0.0
    idx = d["scalars"]["sheet_index"]
    assert idx["correct"] == 1 and idx["both_null"] == 2
    scales = d["sets"]["scales"]
    assert (
        (scales["tp"], scales["fp"], scales["fn"]) == (1, 0, 0) and scales["f1"] == 1.0 and scales["exact_rate"] == 1.0
    )
    sched = d["sets"]["schedules"]
    assert (sched["tp"], sched["fp"], sched["fn"]) == (1, 1, 0) and sched["sheets_exact"] == 2
    refs = d["sets"]["references"]
    assert (refs["tp"], refs["fp"], refs["fn"]) == (1, 1, 0)
    ml = d["sets"]["match_lines"]
    assert (ml["tp"], ml["fp"], ml["fn"]) == (0, 0, 1)
    kinds = {(e["id"], e["field"], e["kind"]) for e in d["errors"]}
    assert ("d:p4", "*", "no_prediction") in kinds
    assert ("d:p3", "title", "fabricated") in kinds
    assert ("d:p1", "title", "wrong") in kinds
    assert ("d:p2", "match_lines", "fn") in kinds
    assert d["by_doc"]["d"]["sheets"] == 4
    assert d["meta"] == {"note": "test"}
    text = plans.format_scorecard(card, errors=3)
    assert "sheet_number" in text and "… " in text


def test_regressions_against_baseline():
    gold = [_gold(1, sheet_number="L-1", scales=["NO SCALE"])]
    good = {"d:p1": SheetPrediction.from_facts("d", 1, {"sheetNumber": "L-1", "scales": ["NO SCALE"]})}
    bad = {"d:p1": SheetPrediction.from_facts("d", 1, {"sheetNumber": "L-2", "scales": []})}
    baseline = score(gold, good).to_dict()
    assert regressions(score(gold, good).to_dict(), baseline) == []
    drops = regressions(score(gold, bad).to_dict(), baseline)
    assert any(d.startswith("sheet_number.accuracy") for d in drops)
    assert any(d.startswith("scales.f1") for d in drops)
    assert regressions(score(gold, bad).to_dict(), baseline, tolerance=1.0) == []


# --- template ---------------------------------------------------------------------


def test_template_rows_assign_split_by_plan_set():
    manifest = Manifest(
        schema_version=1,
        corpus="t",
        documents=[
            Document(id="d3-03-2H4504-plans", group="district3", kind="plans", title="P", file="p.pdf", pages=2),
            Document(id="d3-03-3H5404-plans", group="district3", kind="plans", title="Q", file="q.pdf", pages=1),
        ],
    )
    rows = template_rows(manifest, ["d3-03-2H4504-plans", "d3-03-3H5404-plans"])
    assert [(r.id, r.split, r.status) for r in rows] == [
        ("d3-03-2H4504-plans:p1", "dev", "todo"),
        ("d3-03-2H4504-plans:p2", "dev", "todo"),
        ("d3-03-3H5404-plans:p1", "test", "todo"),
    ]


# --- extraction boundary (needs node + the TypeScript build; skipped otherwise) ------

SAMPLE = REPO_ROOT / "services" / "ingestion" / "samples" / "C-102 Drainage Plan (callouts).pdf"


@pytest.mark.skipif(
    shutil.which("node") is None or not plans.INGESTION_DIST.exists() or not SAMPLE.exists(),
    reason="needs node, the built ingestion package, and the authored sample sheet",
)
def test_extract_script_on_authored_sample(tmp_path: Path):
    out = tmp_path / "c102.jsonl"
    subprocess.run(
        ["node", str(plans.EXTRACT_SCRIPT), str(SAMPLE), "--doc", "c102", "--out", str(out), "--pages", "1-1"],
        check=True,
        cwd=REPO_ROOT,
        capture_output=True,
    )
    pred = load_predictions([out])["c102:p1"]
    assert pred.extracted and pred.ms is not None
    assert pred.set_items("references") == ["S-101"]
    assert pred.set_items("match_lines") == ["C-103"]
