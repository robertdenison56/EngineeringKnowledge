"""Plan understanding work — Tier 1b context: schema, normalization, scoring, the text-layer baseline, model JSON."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from caltrans_bench.manifest import Document, Manifest
from caltrans_bench.plans import (
    SheetContext,
    SheetGold,
    SheetPrediction,
    StationLimit,
    norm_alignment,
    norm_county,
    norm_field,
    norm_road,
    norm_route,
    norm_structure,
    parse_station,
    regressions,
    score,
    validate_gold,
)
from caltrans_bench.plans_context import parse_model_json, textlayer_context

PAGE_TEXT = """PUTAH CREEK Rd
SB
GADDINI Rd
ROUTE 505
R/W
Br No. 22-0072L
PUTAH CREEK BRIDGE
Br No. 22-0072R
YOLO
COUNTY
SOLANO
COUNTY
L-1
SCALE: 1" = 50'
LAYOUT
"P1" 10+ 00.00 BEG
"P1" 16+ 95.81 END
"P1" 10+ 59.21 BC
"P1" LINE
Sol
505
R10.6/0.0
Yol
"""

GOLD = {
    "id": "d:p2",
    "doc": "d",
    "page": 2,
    "split": "dev",
    "sheet_number": "L-1",
    "title": "LAYOUT",
    "context": {
        "route": "505",
        "counties": ["Yolo", "Solano"],
        "post_miles": "R10.6/0.0",
        "roads": ["ROUTE 505", "PUTAH CREEK Rd", "GADDINI Rd"],
        "alignments": ["P1"],
        "stations": [{"alignment": "P1", "begin": "10+00.00", "end": "16+95.81", "what": "P1 line"}],
        "structures": ["Br No. 22-0072L", "Br No. 22-0072R", "PUTAH CREEK BRIDGE"],
        "description": "Layout of the P1 line along Putah Creek Rd under the Route 505 bridge.",
        "facts": ["P1", "Putah Creek Rd", "Route 505", "10+00.00"],
    },
}


# --- schema -----------------------------------------------------------------------


def test_context_schema_and_validation():
    row = SheetGold.model_validate(GOLD)
    assert row.context is not None and row.context.stations[0].end == "16+95.81"
    with pytest.raises(ValueError, match="station"):
        SheetGold.model_validate({**GOLD, "context": {**GOLD["context"], "stations": [{"begin": "abc"}]}})
    with pytest.raises(ValueError, match="facts need a description"):
        SheetGold.model_validate({**GOLD, "context": {"facts": ["x"], "description": None}})
    with pytest.raises(ValueError, match="duplicate context.roads"):
        SheetGold.model_validate({**GOLD, "context": {"roads": ["Putah Creek Rd", "PUTAH CREEK Road"]}})


def test_context_strings_are_validated_against_text_layer(monkeypatch):
    manifest = Manifest(
        schema_version=1,
        corpus="t",
        documents=[Document(id="d", group="district3", kind="plans", title="P", file="p.pdf", pages=27)],
    )
    monkeypatch.setattr("caltrans_bench.text.page_text", lambda doc, page, raw_dir: PAGE_TEXT)
    assert validate_gold([SheetGold.model_validate(GOLD)], manifest) == []
    bad = SheetGold.model_validate({**GOLD, "context": {**GOLD["context"], "roads": ["JOHNSON Rd"]}})
    problems = validate_gold([bad], manifest)
    assert len(problems) == 1 and "roads" in problems[0]
    # County abbreviations in the title block count as the printed form.
    abbrev_only = PAGE_TEXT.replace("YOLO\nCOUNTY\nSOLANO\nCOUNTY\n", "")
    monkeypatch.setattr("caltrans_bench.text.page_text", lambda doc, page, raw_dir: abbrev_only)
    assert validate_gold([SheetGold.model_validate(GOLD)], manifest) == []


# --- normalization ------------------------------------------------------------------


def test_context_normalization():
    assert norm_road("PUTAH CREEK Rd") == norm_road("Putah Creek Road") == "putah creek road"
    assert norm_road("ROUTE 505") == norm_road("SR 505") == norm_road("State Route 505") == "route 505"
    assert norm_route("Route 505") == norm_route("SR-505") == norm_route("505") == "505"
    assert norm_county("Sol") == norm_county("SOLANO COUNTY") == "solano"
    assert norm_alignment('"P1" LINE') == norm_alignment("p1") == "P1"
    assert norm_structure("Br No. 22-0072L") == norm_structure("Bridge No 22-0072L") == norm_structure("22-0072L")
    assert norm_structure("PUTAH CREEK BRIDGE") == "putah creek bridge"
    assert norm_field("post_miles", "R10.6 / 0.0") == "r10.6/0.0"
    assert parse_station("564+20.30") == 56420.30
    assert parse_station("Sta 10+00") == 1000.0
    assert parse_station("16+ 95.81") == 1695.81
    assert parse_station("4'-0\"") is None and parse_station("1+5") is None


# --- predictions ------------------------------------------------------------------------


def test_from_facts_accepts_snake_case_with_context_and_coerces_shapes():
    facts = {
        "sheet_number": "L-1",
        "title": "LAYOUT",
        "scales": ["1\" = 50'"],
        "context": {
            "route": ["Route 505"],
            "counties": "Yolo",
            "stations": ['"P1" 10+00.00', {"alignment": "P1", "from": "10+00.00", "to": "16+95.81"}, {"begin": "bad"}],
            "description": "Layout sheet.",
            "facts": "not a list",
        },
    }
    pred = SheetPrediction.from_facts("d", 2, facts)
    assert pred.sheet_number == "L-1" and pred.scales == ["1\" = 50'"]
    assert pred.context is not None
    assert pred.context.route == "Route 505" and pred.context.counties == ["Yolo"]
    assert [s.begin for s in pred.context.stations] == ['"P1" 10+00.00', "10+00.00"] or len(pred.context.stations) == 1
    assert pred.context.facts == []
    assert SheetPrediction.from_facts("d", 3, {"context": "garbage"}).context is None


# --- scoring ------------------------------------------------------------------------------


def test_context_scoring_tallies():
    gold = SheetGold.model_validate(GOLD)
    pred = SheetPrediction.from_facts(
        "d",
        2,
        {
            "sheet_number": "L-1",
            "title": "LAYOUT",
            "context": {
                "route": "SR 505",
                "counties": ["Sol", "Yol", "Napa"],
                "post_miles": None,
                "roads": ["Putah Creek Road", "Route 505"],
                "alignments": ['"P1" LINE'],
                "stations": [{"alignment": None, "begin": "10+00", "end": "16+95.8"}, {"begin": "12+00"}],
                "structures": ["Bridge No 22-0072L", "PUTAH CREEK BRIDGE"],
                "description": "Shows the P1 line along Putah Creek Rd under Route 505 starting at 10+00.00.",
            },
        },
    )
    card = score([gold], {gold.id: pred}).to_dict()
    ctx = card["context"]
    assert ctx["sheets"] == 1
    assert ctx["scalars"]["route"]["correct"] == 1
    assert ctx["scalars"]["post_miles"]["missed"] == 1
    assert (ctx["sets"]["counties"]["tp"], ctx["sets"]["counties"]["fp"]) == (2, 1)
    assert ctx["sets"]["roads"] == {**ctx["sets"]["roads"], "tp": 2, "fp": 0, "fn": 1}
    assert ctx["sets"]["alignments"]["tp"] == 1
    assert (ctx["sets"]["structures"]["tp"], ctx["sets"]["structures"]["fn"]) == (2, 1)
    assert (ctx["stations"]["tp"], ctx["stations"]["fp"], ctx["stations"]["fn"]) == (1, 1, 0)
    assert ctx["facts"] == {**ctx["facts"], "facts": 4, "covered": 4, "sheets": 1, "sheets_described": 1}
    kinds = {(e["field"], e["kind"]) for e in card["errors"]}
    assert ("context.counties", "fp") in kinds and ("context.stations", "fp") in kinds

    # No context in the prediction at all: everything printed is missed, facts uncovered.
    bare = SheetPrediction.from_facts("d", 2, {"sheet_number": "L-1"})
    ctx2 = score([gold], {gold.id: bare}).to_dict()["context"]
    assert ctx2["sets"]["roads"]["fn"] == 3 and ctx2["stations"]["fn"] == 1 and ctx2["facts"]["covered"] == 0
    assert ctx2["facts"]["sheets_described"] == 0


def test_station_matching_tolerance_and_alignment():
    gold = SheetGold.model_validate(
        {**GOLD, "context": {"stations": [{"alignment": "P1", "begin": "11+85", "end": "15+45"}]}}
    )
    ok = SheetPrediction.from_facts(
        "d", 2, {"context": {"stations": [{"alignment": "P1", "begin": "11+85.00", "end": "15+45.4"}]}}
    )
    assert score([gold], {gold.id: ok}).to_dict()["context"]["stations"]["tp"] == 1
    far = SheetPrediction.from_facts(
        "d", 2, {"context": {"stations": [{"alignment": "P1", "begin": "11+85", "end": "15+46"}]}}
    )
    assert score([gold], {gold.id: far}).to_dict()["context"]["stations"]["tp"] == 0
    other_line = SheetPrediction.from_facts(
        "d", 2, {"context": {"stations": [{"alignment": "B", "begin": "11+85", "end": "15+45"}]}}
    )
    assert score([gold], {gold.id: other_line}).to_dict()["context"]["stations"]["tp"] == 0
    single = SheetPrediction.from_facts("d", 2, {"context": {"stations": [{"alignment": "P1", "begin": "11+85"}]}})
    assert score([gold], {gold.id: single}).to_dict()["context"]["stations"]["tp"] == 0


def test_context_regressions_gate():
    gold = SheetGold.model_validate(GOLD)
    good = SheetPrediction.from_facts("d", 2, {"context": GOLD["context"]})
    baseline = score([gold], {gold.id: good}).to_dict()
    worse = SheetPrediction.from_facts("d", 2, {"context": {**GOLD["context"], "roads": [], "description": "nothing"}})
    drops = regressions(score([gold], {gold.id: worse}).to_dict(), baseline)
    assert any(d.startswith("context.roads.f1") for d in drops)
    assert any(d.startswith("context.facts.coverage") for d in drops)


# --- text-layer baseline ------------------------------------------------------------------


def test_textlayer_context_reads_route_counties_roads_alignments_stations_structures():
    ctx = textlayer_context(PAGE_TEXT)
    assert ctx.route == "505" and ctx.post_miles == "R10.6/0.0"
    assert set(ctx.counties) == {"Yolo", "Solano"}
    assert set(ctx.roads) == {"PUTAH CREEK Rd", "GADDINI Rd", "ROUTE 505"}
    assert ctx.alignments == ["P1"]
    assert [(s.alignment, s.begin, s.end) for s in ctx.stations] == [("P1", "10+00.00", "16+95.81")]
    assert set(ctx.structures) == {"Br No. 22-0072L", "Br No. 22-0072R", "PUTAH CREEK BRIDGE"}
    assert ctx.description is None
    assert textlayer_context("nothing here 4'-0\"").stations == []


def test_textlayer_title_block_abbreviations_route_and_post_miles():
    block = "Dist\nCOUNTY\nROUTE\nPOST MILES\nSol\n505\nR10.6/0.0\nYol\n03\n04\n0.0/11.6\nSHEET\n"
    ctx = textlayer_context(block)
    assert set(ctx.counties) == {"Solano", "Yolo"}
    assert ctx.route == "505"
    assert ctx.post_miles == "R10.6/0.0"
    assert textlayer_context("POST MILE\n0.0/11.6\n").post_miles == "0.0/11.6"


def test_textlayer_bare_station_ticks_become_an_unnamed_range():
    ctx = textlayer_context("561+00\n562+00\n571+00\nROUTE 505\n")
    assert [(s.alignment, s.begin, s.end) for s in ctx.stations] == [(None, "561+00", "571+00")]


# --- model JSON ------------------------------------------------------------------------------


def test_parse_model_json_shapes():
    assert parse_model_json('{"title": "LAYOUT"}') == {"title": "LAYOUT"}
    assert parse_model_json('Here you go:\n```json\n{"title": "LAYOUT", "scales": []}\n```\nDone.') == {
        "title": "LAYOUT",
        "scales": [],
    }
    assert parse_model_json('prose {"a": {"b": 1}} trailing') == {"a": {"b": 1}}
    assert parse_model_json("no json at all") is None
    assert parse_model_json("[1, 2]") is None


def test_score_sample_from_a_reply(tmp_path: Path):
    from caltrans_bench.plans_task import score_sample

    row = SheetGold.model_validate(GOLD)
    reply = json.dumps(
        {
            "sheet_number": "L-1",
            "title": "LAYOUT",
            "context": {
                **GOLD["context"],
                "description": "Layout of the P1 line along Putah Creek Rd under the Route 505 bridge from 10+00.00.",
            },
        }
    )
    values = score_sample(row, reply)
    assert values["json"] == 1.0 and values["title"] == 1.0 and values["sheet_number"] == 1.0
    assert values["context_f1"] == 1.0 and values["facts"] == 1.0
    assert score_sample(row, "I cannot read this sheet.")["json"] == 0.0


def test_station_limit_model():
    s = StationLimit(alignment="B", begin="564+35.87", end="568+55.12", what="BB to EB")
    assert SheetContext(stations=[s]).stations[0].what == "BB to EB"
