"""Plan understanding work — Tier 1b competitors for the sheet context block.

Two prediction sources feed ``plans score`` alongside the product parser:

* **Text-layer baseline** (``textlayer_context``): regexes over the page's extracted
  text. It is the BM25 of this tier — cheap, honest about what the text layer alone
  gives, and the floor any vision or parser approach must clear. It emits only the
  ``context`` block, so its Tier 1 label fields score as missed by construction.
* **Model output** (``parse_model_json`` / ``import_eval_log``): the JSON a vision or
  text model returns from the Inspect task in ``plans_task.py``, written back into
  the same prediction JSONL shape so one scorer compares every system.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from . import RAW_DIR
from .manifest import Document
from .plans import COUNTY_ABBREVIATIONS, SheetContext, StationLimit, parse_station, sheet_id

_ROUTE = re.compile(r"\bROUTE\s+(\d{1,3})\b")
_COUNTY = re.compile(r"\b([A-Z][A-Z]{2,})\s+COUNTY\b")
_COUNTIES = re.compile(r"\bIN\s+([A-Z]+(?:,?\s+[A-Z]+)*?)\s+AND\s+([A-Z]+)\s+COUNTIES\b")
_POST_MILES = re.compile(r"\b(R?\d{1,3}\.\d/R?\d{1,3}\.\d)\b")
_ROAD_LINE = re.compile(
    r"^([A-Z][A-Za-z'.]+(?:\s+[A-Z][A-Za-z'.]+){0,3})\s+(Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Hwy|Highway|"
    r"Dr|Drive|Ln|Lane|Pkwy|Parkway)\.?$"
)
_ROUTE_LINE = re.compile(r"\bROUTE\s+\d{1,3}\b")
_ALIGN_LINE = re.compile(r'"([A-Z]{1,2}\d{0,2})"\s*(?:LINE|Line)\b')
_ALIGN_STATION = re.compile(r'"([A-Z]{1,2}\d{0,2})"\s*(?:LINE\s+)?(?:Sta\.?\s*)?(\d{1,5}\+\s?\d{2}(?:\.\d+)?)')
_BARE_STATION = re.compile(r"(?<![\d+.])(\d{1,5}\+\d{2}(?:\.\d+)?)(?![\d.])")
_BRIDGE_NO = re.compile(r"^(?:Br|Bridge|BRIDGE)\.?\s+No\.?\s*([0-9]{1,3}-[0-9A-Z]{3,}(?:\s*[LR/]+)?)\s*$")
_BRIDGE_NAME = re.compile(r"^([A-Z][A-Z .'-]{2,40}\bBRIDGE)$")
_DIRECTION_JUNK = re.compile(r"^(?:SB|NB|EB|WB|R/W|Exist|To)\b")


def _lines(text: str) -> list[str]:
    return [" ".join(line.split()) for line in text.splitlines() if line.strip()]


def textlayer_context(text: str) -> SheetContext:
    """Context a regex reader gets from the page text alone."""
    lines = _lines(text)
    flat = " ".join(lines)

    counties: list[str] = []
    for m in _COUNTY.finditer(flat):
        name = m.group(1).title()
        if name not in counties and name not in ("Total", "Dist"):
            counties.append(name)
    for m in _COUNTIES.finditer(flat):
        for name in re.split(r",?\s+", m.group(1)) + [m.group(2)]:
            if name and name.title() not in counties:
                counties.append(name.title())
    # The Dist/COUNTY title block prints Caltrans abbreviations as bare lines ("Sol", "Yol")
    # next to the post miles and route number. Direction labels collide with some of them
    # ("SB" is Santa Barbara), so only lines in that neighbourhood count.
    pm_lines = {i for i, line in enumerate(lines) if _POST_MILES.search(line)}
    number_lines = {i for i, line in enumerate(lines) if re.fullmatch(r"\d{1,3}", line)}
    abbrev_lines = [
        i
        for i, line in enumerate(lines)
        if len(line) <= 3
        and line.lower() in COUNTY_ABBREVIATIONS
        and (any(abs(i - j) <= 3 for j in pm_lines) or any(abs(i - j) == 1 for j in number_lines))
    ]
    for i in abbrev_lines:
        name = COUNTY_ABBREVIATIONS[lines[i].lower()].title()
        if name not in counties:
            counties.append(name)

    routes = [m.group(1) for m in _ROUTE.finditer(flat)]
    route = max(set(routes), key=routes.count) if routes else None
    if route is None:
        # No "ROUTE n" label on the sheet: the title block still prints the bare number
        # beside the county abbreviation(s).
        for i in abbrev_lines:
            for j in (i - 1, i + 1):
                if 0 <= j < len(lines) and re.fullmatch(r"\d{1,3}", lines[j]):
                    route = lines[j]
                    break
            if route:
                break

    pms = [m.group(1) for m in _POST_MILES.finditer(flat)]
    post_miles = next((pm for pm in pms if pm.startswith("R")), pms[0] if pms else None)

    roads: list[str] = []
    for line in lines:
        if _DIRECTION_JUNK.match(line):
            continue
        m = _ROAD_LINE.match(line)
        if m and m.group(0) not in roads:
            roads.append(m.group(0))
    for m in _ROUTE_LINE.finditer(flat):
        if m.group(0) not in roads:
            roads.append(m.group(0))

    alignments: list[str] = []
    for m in [*_ALIGN_LINE.finditer(flat), *_ALIGN_STATION.finditer(flat)]:
        if m.group(1) not in alignments:
            alignments.append(m.group(1))

    by_alignment: dict[str | None, list[str]] = defaultdict(list)
    for m in _ALIGN_STATION.finditer(flat):
        by_alignment[m.group(1)].append(m.group(2).replace(" ", ""))
    tagged = {s for values in by_alignment.values() for s in values}
    for m in _BARE_STATION.finditer(flat):
        if m.group(1) not in tagged:
            by_alignment[None].append(m.group(1))
    stations: list[StationLimit] = []
    for alignment, values in by_alignment.items():
        distinct = sorted(set(values), key=lambda v: parse_station(v) or 0.0)
        if alignment is None and len(distinct) < 2:
            continue  # a lone bare number is more likely a dimension than a station
        if len(distinct) == 1:
            stations.append(StationLimit(alignment=alignment, begin=distinct[0]))
        else:
            stations.append(StationLimit(alignment=alignment, begin=distinct[0], end=distinct[-1]))

    structures: list[str] = []
    for line in lines:
        m = _BRIDGE_NO.match(line)
        if m and line not in structures:
            structures.append(line)
            continue
        m = _BRIDGE_NAME.match(line)
        if m and len(line.split()) <= 4 and line not in structures:
            structures.append(line)

    return SheetContext(
        route=route,
        counties=counties,
        post_miles=post_miles,
        roads=roads,
        alignments=alignments,
        stations=stations,
        structures=structures,
    )


def write_textlayer_predictions(doc: Document, out: Path, raw_dir: Path = RAW_DIR) -> int:
    """One prediction line per page carrying only the text-layer context (no Tier 1 fields)."""
    from .text import page_texts

    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with out.open("w", encoding="utf-8") as fh:
        for page, text in enumerate(page_texts(doc, raw_dir), start=1):
            context = textlayer_context(text)
            facts = {"context": context.model_dump(exclude_none=True)} if text.strip() else None
            fh.write(json.dumps({"doc": doc.id, "page": page, "ms": 0, "facts": facts}) + "\n")
            n += 1
    return n


# --- Model output -----------------------------------------------------------------

_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def parse_model_json(text: str) -> dict[str, Any] | None:
    """The first JSON object in a model reply: bare, fenced, or embedded in prose."""
    if not text:
        return None
    candidates = [text.strip()]
    candidates.extend(m.group(1) for m in _FENCE.finditer(text))
    start, end = text.find("{"), text.rfind("}")
    if 0 <= start < end:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            obj = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


def import_eval_log(log_path: Path, out_dir: Path) -> tuple[int, list[Path]]:
    """Write the model replies in an Inspect log as prediction JSONL, one file per document.

    Each sample of the ``plan_sheets`` task carries ``doc`` and ``page`` in its
    metadata; the reply is parsed with ``parse_model_json`` and stored as ``facts``
    (``null`` with an ``error`` when no JSON came back, which scores as unextracted).
    """
    from inspect_ai.log import read_eval_log

    log = read_eval_log(str(log_path))
    per_doc: dict[str, list[dict[str, Any]]] = defaultdict(list)
    n = 0
    for sample in log.samples or []:
        meta = sample.metadata or {}
        doc, page = meta.get("doc"), meta.get("page")
        if not doc or not page:
            continue
        completion = sample.output.completion if sample.output else ""
        obj = parse_model_json(completion)
        line: dict[str, Any] = {"doc": doc, "page": int(page), "ms": None, "facts": obj}
        if obj is None:
            line["error"] = "no JSON object in the reply"
        if sample.error:
            line["error"] = str(sample.error.message)[:200]
        per_doc[doc].append(line)
        n += 1
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for doc, lines in per_doc.items():
        out = out_dir / f"{doc}.jsonl"
        with out.open("w", encoding="utf-8") as fh:
            for line in sorted(lines, key=lambda x: x["page"]):
                fh.write(json.dumps(line) + "\n")
        written.append(out)
    return n, written


__all__ = [
    "import_eval_log",
    "parse_model_json",
    "sheet_id",
    "textlayer_context",
    "write_textlayer_predictions",
]
