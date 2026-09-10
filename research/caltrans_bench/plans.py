"""Plan understanding work — Tier 1: sheet-level extraction against gold labels.

The parser in ``services/ingestion`` (``extractSheetFacts`` in describe.ts) reads
a drawing sheet's title block, scales, view labels, match lines, cross-sheet
references, and schedules from PDF geometry. This module measures how well it
does that, with the same discipline as the question set:

* **One gold row per PDF page** of a plan set (``SheetGold``). Scalar fields
  that are ``None`` mean *not printed on this sheet*; empty lists mean *none
  printed*. "Not printed" is a first-class answer, and a parser that invents a
  value for a blank field is scored as ``fabricated``, separately from a miss.
* **Every labelled string is verified against the page's text layer** before it
  ships (``validate_gold``), with the same tolerance the grounding gate uses for
  CAD text (letter-spaced words, stacked fractions). Strings that are genuinely
  not in the text layer (raster text, outlines) go in ``visual_only``.
* **Deterministic scoring** (``score``): exact match for scalars after field
  normalization, precision/recall/F1 for set fields, and a scorecard JSON that a
  CI gate can compare against a committed baseline (``regressions``).

Predictions come from ``scripts/extract-sheet-facts.mjs``, which calls the real
product function page by page and writes one JSON line per page
(``run_extraction``). Nothing here imports the TypeScript side; the boundary is
that JSONL file, so the Python scorer stays testable without a Node build.

Field meanings (what a labeler records):

``sheet_number``   the sheet id in the title block (``L-1``), not the SHEET No. integer
``sheet_index``    the SHEET No. integer; ``sheet_total`` the TOTAL SHEETS integer
``title``          the sheet title as printed (``LAYOUT``), not a note or a view label
``revision``       the LAST REVISION box as printed (``00-00-00`` is a value, not blank)
``scales``         every scale statement on the sheet (``1"=50'``, ``NO SCALE``), deduped
``views``          labels of drawn views (``SECTION A-A``, ``DETAIL 3``), not the sheet title
``match_lines``    target sheet ids of match lines (``MATCH LINE SEE SHEET L-2`` → ``L-2``)
``references``     sheet ids this sheet points at in text or callouts (``SEE SHEET X-2``,
                   ``3/S-101`` → ``S-101``); ``SEE STRUCTURE PLANS`` is not a reference
``schedules``      titles of tabular schedules (``CURVE DATA``); untitled tables → ``table``

Dimensions and CAD layers are not Tier 1 fields: the parser returns a *sample*
of dimensions, so an exhaustive gold list would score the sample size, not the
reading. They belong to the grounded-description tier.

Tier 1b — ``context`` (``SheetContext``): what the sheet is *about*. Route,
counties and post miles from the title block; every road name shown; alignment
line names; station limits with the line they belong to; structures; and a short
description plus ``facts``, short phrases a correct description must contain
(scored by containment, so an identifier, a station, a quantity, a component).
Predictions may come from the parser, the text-layer regex baseline
(``plans_context.py``), or a model reading the rendered sheet (``plans_task.py``);
one scorer compares them.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from . import RAW_DIR, REPO_ROOT, RESEARCH_DIR
from .manifest import Document, Manifest

PLANS_DIR = RESEARCH_DIR / "plans"
GOLD_DIR = PLANS_DIR / "gold"
PREDS_DIR = PLANS_DIR / "preds"
SCORECARDS_DIR = PLANS_DIR / "scorecards"
RENDERS_DIR = PLANS_DIR / "renders"
DEFAULT_GOLD = GOLD_DIR / "sheets-v0.jsonl"
EXTRACT_SCRIPT = RESEARCH_DIR / "scripts" / "extract-sheet-facts.mjs"
INGESTION_DIST = REPO_ROOT / "services" / "ingestion" / "dist" / "describe.js"

# Split by plan set, not by sheet, so the held-out score measures generalization
# across CAD exports. The two dev sets are small and were studied in the June
# spike (docs/spikes/2026-06-11-caltrans-upload-eval.md, ADR 0007).
DEV_PLAN_SETS = ("d3-03-3H3904-plans", "d3-03-2H4504-plans")
TEST_PLAN_SETS = ("d3-03-0J8704-plans", "d3-03-0J9234-plans", "d3-03-1J0104-plans", "d3-03-3H5404-plans")

SheetKind = Literal[
    "title",
    "index",
    "layout",
    "typical",
    "profile",
    "drainage",
    "structure",
    "electrical",
    "traffic",
    "quantities",
    "utility",
    "landscape",
    "detail",
    "other",
]
PlanSplit = Literal["dev", "test"]
Status = Literal["todo", "labelled"]

SCALAR_FIELDS = ("sheet_number", "sheet_index", "sheet_total", "title", "revision")
SET_FIELDS = ("scales", "views", "match_lines", "references", "schedules")
TEXT_FIELDS = ("sheet_number", "title", "revision")  # scalars the text-layer check applies to
# Tier 1b — sheet context: what the sheet is about, beyond the printed labels.
CONTEXT_SCALARS = ("route", "post_miles")
CONTEXT_SETS = ("counties", "roads", "alignments", "structures")
STATION_TOLERANCE_FT = 0.51  # "564+20.3" and "564+20.30" agree; adjacent 1-ft ticks do not


def default_split(doc_id: str) -> PlanSplit:
    return "dev" if doc_id in DEV_PLAN_SETS else "test"


# --- Schema -----------------------------------------------------------------


class StationLimit(BaseModel):
    """A station or station range printed on the sheet, e.g. ``"P1" 11+85 to 15+45``."""

    alignment: str | None = Field(default=None, description="line name as printed inside the quotes: P1, B, A3")
    begin: str = Field(description="station as printed, e.g. 10+00.00")
    end: str | None = Field(default=None, description="end station for a range; null for a single station")
    what: str | None = Field(default=None, description="what the limits bound: layout, temporary barrier, boring")


class SheetContext(BaseModel):
    """What a sheet is about: the civil context a reader takes from it, not just its labels.

    Strings are as printed on the sheet (the validator checks them against the text
    layer); ``description`` and ``facts`` are the labeler's words. ``facts`` are short
    phrases a correct description must convey; they are scored by containment, so keep
    each one a checkable phrase (an identifier, a station, a quantity, a component).
    """

    route: str | None = Field(default=None, description="highway route number from the title block, e.g. 505")
    counties: list[str] = Field(default_factory=list, description="county names as printed (Sol/Yol fold to full)")
    post_miles: str | None = Field(default=None, description="POST MILES TOTAL PROJECT as printed, e.g. R10.6/0.0")
    roads: list[str] = Field(default_factory=list, description="road names shown: ROUTE 505, PUTAH CREEK Rd")
    alignments: list[str] = Field(default_factory=list, description="alignment line names: P1, B, A3")
    stations: list[StationLimit] = Field(default_factory=list)
    structures: list[str] = Field(default_factory=list, description="bridge names/numbers: Br No. 22-0072L")
    description: str | None = Field(default=None, description="one or two sentences: what the sheet shows")
    facts: list[str] = Field(default_factory=list, description="short phrases a correct description must contain")

    def labelled_strings(self) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        for name in CONTEXT_SCALARS:
            value = getattr(self, name)
            if value:
                out.append((name, value))
        for name in CONTEXT_SETS:
            out.extend((name, v) for v in getattr(self, name))
        for s in self.stations:
            out.append(("stations", s.begin))
            if s.end:
                out.append(("stations", s.end))
        return out


class SheetGold(BaseModel):
    """Gold labels for one drawing sheet (one PDF page of a plan set)."""

    id: str = Field(description="<doc>:p<page>")
    doc: str = Field(description="manifest document id of the plan set")
    page: int = Field(ge=1, description="1-based PDF page index")
    status: Status = "labelled"
    split: PlanSplit = "test"
    sheet_kind: SheetKind | None = None
    sheet_number: str | None = None
    sheet_index: int | None = Field(default=None, ge=1)
    sheet_total: int | None = Field(default=None, ge=1)
    title: str | None = None
    revision: str | None = None
    scales: list[str] = Field(default_factory=list)
    views: list[str] = Field(default_factory=list)
    match_lines: list[str] = Field(default_factory=list)
    references: list[str] = Field(default_factory=list)
    schedules: list[str] = Field(default_factory=list)
    visual_only: list[str] = Field(
        default_factory=list,
        description="labelled strings the text layer cannot confirm (raster, outlines); exempt from validation",
    )
    context: SheetContext | None = Field(default=None, description="Tier 1b: what the sheet is about")
    labeler: str | None = None
    notes: str | None = None

    @model_validator(mode="after")
    def _consistent(self) -> SheetGold:
        if self.id != sheet_id(self.doc, self.page):
            raise ValueError(f"{self.id}: id must be {sheet_id(self.doc, self.page)!r}")
        if (self.sheet_index is None) != (self.sheet_total is None):
            raise ValueError(f"{self.id}: sheet_index and sheet_total go together")
        if self.sheet_index is not None and self.sheet_total is not None and self.sheet_index > self.sheet_total:
            raise ValueError(f"{self.id}: sheet_index {self.sheet_index} exceeds sheet_total {self.sheet_total}")
        for name in SET_FIELDS:
            items = getattr(self, name)
            if len({norm_field(name, v) for v in items}) != len(items):
                raise ValueError(f"{self.id}: duplicate {name} entries after normalization")
        if self.context is not None:
            for name in CONTEXT_SETS:
                items = getattr(self.context, name)
                if len({norm_field(name, v) for v in items}) != len(items):
                    raise ValueError(f"{self.id}: duplicate context.{name} entries after normalization")
            for s in self.context.stations:
                for value in (s.begin, s.end):
                    if value is not None and parse_station(value) is None:
                        raise ValueError(f"{self.id}: station {value!r} is not <n>+<nn>[.<n>]")
            if self.context.facts and not self.context.description:
                raise ValueError(f"{self.id}: facts need a description to be checked against")
        return self

    def labelled_strings(self) -> list[tuple[str, str]]:
        """(field, string) pairs the text-layer validator must find on the page."""
        out: list[tuple[str, str]] = []
        for name in TEXT_FIELDS:
            value = getattr(self, name)
            if value:
                out.append((name, value))
        for name in SET_FIELDS:
            out.extend((name, v) for v in getattr(self, name))
        if self.context is not None:
            out.extend(self.context.labelled_strings())
        return out


def sheet_id(doc: str, page: int) -> str:
    return f"{doc}:p{page}"


class SheetPrediction(BaseModel):
    """What the parser returned for one page, in the gold's vocabulary."""

    doc: str
    page: int = Field(ge=1)
    extracted: bool = True
    ms: float | None = None
    error: str | None = None
    sheet_number: str | None = None
    sheet_index: int | None = None
    sheet_total: int | None = None
    title: str | None = None
    revision: str | None = None
    scales: list[str] = Field(default_factory=list)
    views: list[str] = Field(default_factory=list)
    dimensions: list[str] = Field(default_factory=list)
    callouts: list[str] = Field(default_factory=list)
    match_lines: list[str] = Field(default_factory=list)
    schedules: list[str] = Field(default_factory=list)
    layers: list[str] = Field(default_factory=list)
    context: SheetContext | None = None

    @classmethod
    def from_facts(
        cls, doc: str, page: int, facts: Mapping[str, Any] | None, ms: float | None = None, error: str | None = None
    ) -> SheetPrediction:
        """Map a facts object onto the gold vocabulary.

        Accepts the parser's ``SheetFacts`` (camelCase, from describe.ts) and the
        snake_case shape a model is asked to emit (``plans_task.py``), including an
        optional ``context`` block. Unknown keys are ignored; a malformed ``context``
        is dropped rather than failing the whole prediction.
        """
        if facts is None:
            return cls(doc=doc, page=page, extracted=False, ms=ms, error=error)

        def get(*keys: str) -> Any:
            for k in keys:
                if k in facts and facts[k] is not None:
                    return facts[k]
            return None

        def items(*keys: str) -> list[str]:
            raw = get(*keys) or []
            return [str(v) for v in raw if v is not None and str(v).strip()] if isinstance(raw, list) else []

        context = None
        raw_context = get("context")
        if isinstance(raw_context, Mapping):
            try:
                context = SheetContext.model_validate(_coerce_context(raw_context))
            except Exception:
                context = None
        return cls(
            doc=doc,
            page=page,
            ms=ms,
            error=error,
            sheet_number=_opt_str(get("sheetNumber", "sheet_number")),
            sheet_index=_opt_int(get("sheetIndex", "sheet_index")),
            sheet_total=_opt_int(get("sheetTotal", "sheet_total")),
            title=_opt_str(get("title")),
            revision=_opt_str(get("revision")),
            scales=items("scales"),
            views=items("views"),
            dimensions=items("dimensions"),
            callouts=items("callouts"),
            match_lines=items("matchLines", "match_lines"),
            schedules=items("schedules"),
            layers=items("layers"),
            context=context,
        )

    @property
    def id(self) -> str:
        return sheet_id(self.doc, self.page)

    def set_items(self, name: str) -> list[str]:
        """Prediction items for a gold set field, mapped onto the gold's vocabulary.

        ``references`` come from callouts (``3/S-101`` → ``S-101``); ``match_lines`` from
        the parser's ``→ <sheet>`` items — a match line it found but could not resolve
        carries no target and is left out here (counted as ``unresolved`` in the scorecard).
        """
        if name == "references":
            return [c.rsplit("/", 1)[-1] for c in self.callouts]
        if name == "match_lines":
            return [m[2:].strip() for m in self.match_lines if m.startswith("→ ")]
        return list(getattr(self, name))

    @property
    def unresolved_match_lines(self) -> int:
        return sum(1 for m in self.match_lines if not m.startswith("→ "))


def _opt_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _opt_int(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_context(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Tolerate the shapes a model emits: scalars as lists, stations as strings, nulls."""
    out: dict[str, Any] = {}
    for name in CONTEXT_SCALARS:
        v = raw.get(name)
        out[name] = _opt_str(v[0] if isinstance(v, list) and v else v)
    for name in CONTEXT_SETS:
        v = raw.get(name) or []
        out[name] = [str(x).strip() for x in (v if isinstance(v, list) else [v]) if x is not None and str(x).strip()]
    stations: list[dict[str, Any]] = []
    for s in raw.get("stations") or []:
        if isinstance(s, Mapping):
            begin = _opt_str(s.get("begin") or s.get("station") or s.get("from"))
            end = _opt_str(s.get("end") or s.get("to"))
            if begin and parse_station(begin) is not None and (end is None or parse_station(end) is not None):
                stations.append(
                    {
                        "alignment": _opt_str(s.get("alignment")),
                        "begin": begin,
                        "end": end,
                        "what": _opt_str(s.get("what")),
                    }
                )
        elif isinstance(s, str) and parse_station(s) is not None:
            stations.append({"begin": s.strip()})
    out["stations"] = stations
    out["description"] = _opt_str(raw.get("description"))
    facts = raw.get("facts") or []
    out["facts"] = [str(f) for f in facts if isinstance(f, str) and f.strip()] if isinstance(facts, list) else []
    return out


# --- JSONL --------------------------------------------------------------------


def load_gold(path: Path, split: str | None = None, include_todo: bool = False) -> list[SheetGold]:
    rows: list[SheetGold] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8") as fh:
        for line_no, raw in enumerate(fh, start=1):
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            try:
                row = SheetGold.model_validate(json.loads(line))
            except Exception as exc:
                raise ValueError(f"{path}:{line_no}: {exc}") from exc
            if row.id in seen:
                raise ValueError(f"{path}:{line_no}: duplicate id {row.id}")
            seen.add(row.id)
            if split is not None and row.split != split:
                continue
            if row.status == "todo" and not include_todo:
                continue
            rows.append(row)
    return rows


def dump_gold(rows: Iterable[SheetGold], path: Path, header: str | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        if header:
            for line in header.splitlines():
                fh.write(f"# {line}\n")
        for row in rows:
            fh.write(row.model_dump_json(exclude_none=True, exclude_defaults=True) + "\n")


def load_predictions(paths: Iterable[Path]) -> dict[str, SheetPrediction]:
    """Read extraction JSONL (one ``{"doc","page","ms","facts"}`` line per page); later lines win."""
    preds: dict[str, SheetPrediction] = {}
    for path in paths:
        with path.open(encoding="utf-8") as fh:
            for line_no, raw in enumerate(fh, start=1):
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                try:
                    obj = json.loads(line)
                    pred = SheetPrediction.from_facts(
                        obj["doc"], int(obj["page"]), obj.get("facts"), obj.get("ms"), obj.get("error")
                    )
                except Exception as exc:
                    raise ValueError(f"{path}:{line_no}: {exc}") from exc
                preds[pred.id] = pred
    return preds


def prediction_files(preds: Path) -> list[Path]:
    if preds.is_dir():
        return sorted(preds.glob("*.jsonl"))
    return [preds]


# --- Normalization ------------------------------------------------------------

_QUOTES = str.maketrans({"″": '"', "“": '"', "”": '"', "′": "'", "‘": "'", "’": "'", "–": "-", "—": "-"})
_UNTITLED_TABLE = re.compile(r"^(?:\d+\s*[x×]\s*\d+\s+)?table$", re.IGNORECASE)


def _ascii(text: str) -> str:
    """Strip diacritics and fold compatibility glyphs: CAD text layers print stacked
    fractions as single code points (``¾`` → ``3⁄4``), so NFKD, not NFD."""
    folded = "".join(ch for ch in unicodedata.normalize("NFKD", text) if not unicodedata.combining(ch))
    return folded.replace("\u2044", "/")  # NFKD leaves a FRACTION SLASH behind


def norm_words(text: str) -> str:
    """Case, punctuation, and whitespace-insensitive: titles, view labels, schedule titles."""
    return re.sub(r"[^a-z0-9]+", " ", _ascii(text).casefold()).strip()


def norm_compact(text: str) -> str:
    """Whitespace-insensitive but quote-preserving: scales (``1" = 50'`` == ``1"=50'``) and dates."""
    return re.sub(r"\s+", "", _ascii(text.translate(_QUOTES)).casefold())


def norm_sheet(text: str) -> str:
    """Mirror of the parser's ``normalizeSheetNumber``: upper-case, no spaces or dashes."""
    return re.sub(r"[\s\-–—]+", "", _ascii(text.translate(_QUOTES)).upper())


# Caltrans county abbreviations as printed in the Dist/COUNTY title block.
COUNTY_ABBREVIATIONS: dict[str, str] = {
    "ala": "alameda", "alp": "alpine", "ama": "amador", "but": "butte", "cal": "calaveras", "col": "colusa",
    "cc": "contra costa", "dn": "del norte", "ed": "el dorado", "fre": "fresno", "gle": "glenn", "hum": "humboldt",
    "imp": "imperial", "iny": "inyo", "ker": "kern", "kin": "kings", "lak": "lake", "las": "lassen",
    "la": "los angeles", "mad": "madera", "mrn": "marin", "mpa": "mariposa", "men": "mendocino", "mer": "merced",
    "mod": "modoc", "mno": "mono", "mon": "monterey", "nap": "napa", "nev": "nevada", "ora": "orange",
    "pla": "placer", "plu": "plumas", "riv": "riverside", "sac": "sacramento", "sbt": "san benito",
    "sbd": "san bernardino", "sd": "san diego", "sf": "san francisco", "sj": "san joaquin",
    "slo": "san luis obispo", "sm": "san mateo", "sb": "santa barbara", "scl": "santa clara", "scr": "santa cruz",
    "sha": "shasta", "sie": "sierra", "sis": "siskiyou", "sol": "solano", "son": "sonoma", "sta": "stanislaus",
    "sut": "sutter", "teh": "tehama", "tri": "trinity", "tul": "tulare", "tuo": "tuolumne", "ven": "ventura",
    "yol": "yolo", "yub": "yuba",
}  # fmt: skip
_ROAD_SUFFIXES = {
    "rd": "road", "st": "street", "ave": "avenue", "av": "avenue", "blvd": "boulevard", "hwy": "highway",
    "dr": "drive", "ln": "lane", "pkwy": "parkway", "ct": "court", "pl": "place", "cir": "circle", "way": "way",
}  # fmt: skip
_ROUTE_WORDS = re.compile(r"^(?:state\s+route|route|rte|sr|hwy|highway|us|i)[\s\-]*", re.IGNORECASE)
_STATION_RE = re.compile(r"^\s*(?:sta\.?\s*)?(\d{1,5})\s*\+\s*(\d{2}(?:\.\d+)?)\s*$", re.IGNORECASE)
_SCALE_PREFIX = re.compile(r"^\s*scales?\s*[:=]?\s*", re.IGNORECASE)
_BRIDGE_NO_RE = re.compile(
    r"\b(?:br|bridge)\.?\s*(?:no|number)\.?\s*([0-9]{1,3}-[0-9A-Za-z]+(?:\s*/\s*[A-Za-z0-9]+)?(?:\s*[LR](?:/[LR])?)?)",
    re.IGNORECASE,
)


def split_structure(value: str) -> list[str]:
    """``PUTAH CREEK BRIDGE Br No. 22-0072L`` → ``["Br No. 22-0072L", "PUTAH CREEK BRIDGE"]``.

    A model tends to join a bridge's name and number into one string where the sheet
    (and the gold) print them apart; both readings are defensible, so structures are
    compared part by part.
    """
    numbers = [m.group(0).strip() for m in _BRIDGE_NO_RE.finditer(value)]
    if not numbers:
        return [value.strip()]
    remainder = _BRIDGE_NO_RE.sub(" ", value)
    remainder = re.sub(r"[\s,;:()\-]+", " ", remainder).strip()
    parts = list(numbers)
    if re.search(r"[A-Za-z]{2,}", remainder):
        parts.append(remainder)
    return parts


def norm_route(value: str) -> str:
    return norm_sheet(_ROUTE_WORDS.sub("", _ascii(value).strip()))


def norm_county(value: str) -> str:
    words = norm_words(value)
    words = re.sub(r"\s+county$", "", words)
    return COUNTY_ABBREVIATIONS.get(words, words)


def norm_road(value: str) -> str:
    """``PUTAH CREEK Rd`` == ``Putah Creek Road``; ``ROUTE 505`` == ``SR 505`` == ``Route 505``."""
    words = norm_words(value).split()
    if not words:
        return ""
    if words[0] in ("route", "rte", "sr", "hwy", "highway") and len(words) > 1:
        words = ["route", *words[1:]]
    elif words[0] in ("state",) and len(words) > 2 and words[1] == "route":
        words = ["route", *words[2:]]
    words[-1] = _ROAD_SUFFIXES.get(words[-1], words[-1])
    return " ".join(words)


def norm_alignment(value: str) -> str:
    """``"P1" LINE`` == ``P1`` == ``p1 line``."""
    text = re.sub(r"\b(line|alignment)\b", "", _ascii(value), flags=re.IGNORECASE)
    return norm_sheet(text.replace('"', "").replace("'", ""))


def norm_structure(value: str) -> str:
    """``Br No. 22-0072L`` == ``Bridge No 22-0072L`` == ``22-0072L``; ``PUTAH CREEK BRIDGE`` == ``Putah Creek Br``."""
    words = norm_words(value).split()
    words = [("bridge" if w in ("br", "brdg") else w) for w in words if w not in ("no", "number")]
    if words and words[0] == "bridge" and len(words) > 1 and any(ch.isdigit() for ch in words[-1]):
        words = words[1:]  # the number identifies it; "bridge" is filler before a number
    if len(words) > 1 and words[-1] == "bridge" and not any(ch.isdigit() for ch in words[-2]):
        words = words[:-1]  # "Putah Creek Bridge" and "Putah Creek Br" name the same structure
    return " ".join(words)


def parse_station(value: str) -> float | None:
    """``564+20.30`` → 56420.30 ft; ``10+00`` → 1000.0; None when not a station."""
    m = _STATION_RE.match(_ascii(value).replace(" ", " "))
    if not m:
        return None
    return int(m.group(1)) * 100 + float(m.group(2))


def norm_field(name: str, value: str) -> str:
    if name in ("sheet_number", "match_lines", "references"):
        return norm_sheet(value)
    if name == "scales":
        return norm_compact(_SCALE_PREFIX.sub("", value))
    if name in ("revision", "post_miles"):
        return norm_compact(value)
    if name == "schedules":
        return "table" if _UNTITLED_TABLE.match(value.strip()) else norm_words(value)
    if name == "route":
        return norm_route(value)
    if name == "counties":
        return norm_county(value)
    if name == "roads":
        return norm_road(value)
    if name == "alignments":
        return norm_alignment(value)
    if name == "structures":
        return norm_structure(value)
    return norm_words(value)


# --- Text-layer check (port of the grounding gate's matching rules) ----------


def normalize_for_grounding(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", _ascii(text).casefold()).strip()


def text_has(page_text: str, needle: str) -> bool:
    """Whether ``needle`` occurs in ``page_text`` as whole tokens.

    Tolerant of formatting noise (quotes, hyphens, stacked fractions), strict about
    substance: all alphanumeric tokens must appear contiguously. CAD text layers
    letter-space words (``ROUTE 505`` extracts as ``R OU TE 505``), so a token-exact
    miss gets a second, space-blind check that still respects token boundaries at
    the edges, and only for needles of six or more characters — a shorter needle
    would match inside almost any run of digits.
    """
    hay = normalize_for_grounding(page_text)
    want = normalize_for_grounding(needle)
    if not hay or not want:
        return False
    if f" {want} " in f" {hay} ":
        return True
    tight_needle = want.replace(" ", "")
    if len(tight_needle) < 6:
        return False
    tokens = hay.split(" ")
    starts: list[bool] = []
    for tok in tokens:
        starts.extend(i == 0 for i in range(len(tok)))
    tight = "".join(tokens)
    at = tight.find(tight_needle)
    while at >= 0:
        end = at + len(tight_needle)
        if starts[at] and (end == len(tight) or starts[end]):
            return True
        at = tight.find(tight_needle, at + 1)
    return _runs_match(hay, want)


def _runs_match(hay: str, want: str, max_runs: int = 4) -> bool:
    """Multi-line text on CAD sheets extracts one line at a time, often bottom-up, so a
    four-line schedule title is on the page but never contiguous. Accept a needle of
    three or more tokens when it splits (greedily, longest run first) into at most
    ``max_runs`` runs that each occur as whole tokens. A single-token run must be four
    or more characters, so a stray short word cannot complete a match by accident.
    """
    tokens = want.split(" ")
    if len(tokens) < 3:
        return False
    padded = f" {hay} "
    i, runs = 0, 0
    while i < len(tokens):
        j = len(tokens)
        while j > i and f" {' '.join(tokens[i:j])} " not in padded:
            j -= 1
        if j == i or (j - i == 1 and len(tokens[i]) < 4):
            return False
        runs += 1
        if runs > max_runs:
            return False
        i = j
    return True


def validate_gold(
    rows: Iterable[SheetGold], manifest: Manifest, raw_dir: Path = RAW_DIR, offline: bool = False
) -> list[str]:
    """Problems with a gold set: unknown documents, pages out of range, labelled strings not on the page."""
    from .text import page_text

    docs = manifest.by_id()
    problems: list[str] = []
    for row in rows:
        doc = docs.get(row.doc)
        if doc is None:
            problems.append(f"{row.id}: unknown doc {row.doc}")
            continue
        if doc.pages and row.page > doc.pages:
            problems.append(f"{row.id}: page {row.page} beyond {doc.pages} pages")
            continue
        if offline:
            continue
        try:
            text = page_text(doc, row.page, raw_dir)
        except (FileNotFoundError, IndexError) as exc:
            problems.append(f"{row.id}: {exc}")
            continue
        exempt = {norm_words(v) for v in row.visual_only}
        for name, value in row.labelled_strings():
            if norm_words(value) in exempt:
                continue
            if any(text_has(text, v) for v in _printed_forms(name, value)):
                continue
            problems.append(f"{row.id}: {name} {value!r} not in the text layer (add to visual_only if raster)")
    return problems


def _printed_forms(name: str, value: str) -> list[str]:
    """Spellings the sheet may use for a labelled value: a county's title-block abbreviation."""
    forms = [value]
    if name == "counties":
        full = norm_county(value)
        forms.extend(abbr for abbr, county in COUNTY_ABBREVIATIONS.items() if county == full)
    return forms


# --- Template + rendering (authoring aids) ------------------------------------


def template_rows(manifest: Manifest, doc_ids: Iterable[str], raw_dir: Path = RAW_DIR) -> list[SheetGold]:
    """One ``todo`` row per page of each plan set, split assigned by document."""
    from .text import page_texts

    docs = manifest.by_id()
    rows: list[SheetGold] = []
    for doc_id in doc_ids:
        doc = docs[doc_id]
        pages = doc.pages or len(page_texts(doc, raw_dir))
        for page in range(1, pages + 1):
            rows.append(
                SheetGold(id=sheet_id(doc_id, page), doc=doc_id, page=page, status="todo", split=default_split(doc_id))
            )
    return rows


def render_page(doc: Document, page: int, out_dir: Path = RENDERS_DIR, dpi: int = 80, raw_dir: Path = RAW_DIR) -> Path:
    """PNG of one sheet for labelling; rotation is applied so the sheet reads upright."""
    import pymupdf

    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{doc.id}-p{page}.png"
    with pymupdf.open(doc.path(raw_dir)) as pdf:
        if not 1 <= page <= len(pdf):
            raise IndexError(f"{doc.id}: page {page} out of range 1..{len(pdf)}")
        pdf[page - 1].get_pixmap(dpi=dpi).save(out)
    return out


# --- Extraction runner --------------------------------------------------------


def extraction_prerequisites() -> list[str]:
    problems = []
    if shutil.which("node") is None:
        problems.append("node not on PATH")
    if not INGESTION_DIST.exists():
        problems.append(f"ingestion not built: {INGESTION_DIST} (run `npm run build` at the repo root)")
    if not EXTRACT_SCRIPT.exists():
        problems.append(f"missing {EXTRACT_SCRIPT}")
    return problems


def run_extraction(doc: Document, out: Path, raw_dir: Path = RAW_DIR, pages: tuple[int, int] | None = None) -> int:
    """Run the parser over every page of ``doc`` (or a page range) and write prediction JSONL.

    Returns the number of page lines written. Raises on a missing prerequisite or a
    non-zero exit; the script itself records per-page parser errors in the JSONL.
    """
    problems = extraction_prerequisites()
    if problems:
        raise RuntimeError("; ".join(problems))
    pdf = doc.path(raw_dir)
    if not pdf.exists():
        raise FileNotFoundError(f"{doc.id}: {pdf} not present; run `caltrans-bench manifest fetch --only {doc.id}`")
    if pages is None:
        from .text import page_texts

        pages = (1, doc.pages or len(page_texts(doc, raw_dir)))
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "node",
        str(EXTRACT_SCRIPT),
        str(pdf),
        "--doc",
        doc.id,
        "--out",
        str(out),
        "--pages",
        f"{pages[0]}-{pages[1]}",
    ]
    subprocess.run(cmd, check=True, cwd=REPO_ROOT)
    return sum(1 for line in out.read_text(encoding="utf-8").splitlines() if line.strip())


# --- Scoring ------------------------------------------------------------------


@dataclass
class ScalarTally:
    correct: int = 0
    wrong: int = 0
    missed: int = 0  # gold has a value, parser returned nothing
    fabricated: int = 0  # gold is "not printed", parser returned a value
    both_null: int = 0

    @property
    def n(self) -> int:
        return self.correct + self.wrong + self.missed + self.fabricated + self.both_null

    def metrics(self) -> dict[str, float | int]:
        predicted = self.correct + self.wrong + self.fabricated
        printed = self.correct + self.wrong + self.missed
        return {
            "n": self.n,
            "correct": self.correct,
            "wrong": self.wrong,
            "missed": self.missed,
            "fabricated": self.fabricated,
            "both_null": self.both_null,
            "accuracy": _ratio(self.correct + self.both_null, self.n),
            "precision": _ratio(self.correct, predicted),
            "recall": _ratio(self.correct, printed),
            # Of the sheets where the field is not printed, how often the parser said so.
            "null_recall": _ratio(self.both_null, self.both_null + self.fabricated),
        }


@dataclass
class SetTally:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    sheets: int = 0
    sheets_exact: int = 0

    def metrics(self) -> dict[str, float | int]:
        p = _ratio(self.tp, self.tp + self.fp)
        r = _ratio(self.tp, self.tp + self.fn)
        return {
            "tp": self.tp,
            "fp": self.fp,
            "fn": self.fn,
            "precision": p,
            "recall": r,
            "f1": _ratio(2 * p * r, p + r) if (p + r) else 0.0,
            "sheets": self.sheets,
            "sheets_exact": self.sheets_exact,
            "exact_rate": _ratio(self.sheets_exact, self.sheets),
        }


@dataclass
class FactTally:
    facts: int = 0
    covered: int = 0
    sheets: int = 0  # gold sheets carrying facts
    sheets_described: int = 0  # of those, how many predictions carried any description

    def metrics(self) -> dict[str, float | int]:
        return {
            "facts": self.facts,
            "covered": self.covered,
            "coverage": _ratio(self.covered, self.facts),
            "sheets": self.sheets,
            "sheets_described": self.sheets_described,
            "described_rate": _ratio(self.sheets_described, self.sheets),
        }


@dataclass
class SheetError:
    id: str
    field: str
    kind: str  # wrong | missed | fabricated | fp | fn | no_prediction | uncovered
    gold: Any = None
    pred: Any = None


@dataclass
class Scorecard:
    scalars: dict[str, ScalarTally] = field(default_factory=lambda: {f: ScalarTally() for f in SCALAR_FIELDS})
    sets: dict[str, SetTally] = field(default_factory=lambda: {f: SetTally() for f in SET_FIELDS})
    context_scalars: dict[str, ScalarTally] = field(default_factory=lambda: {f: ScalarTally() for f in CONTEXT_SCALARS})
    context_sets: dict[str, SetTally] = field(default_factory=lambda: {f: SetTally() for f in CONTEXT_SETS})
    stations: SetTally = field(default_factory=SetTally)
    facts: FactTally = field(default_factory=FactTally)
    context_sheets: int = 0  # gold sheets with a context block
    gold: int = 0
    scored: int = 0
    missing_prediction: int = 0
    extracted: int = 0
    unresolved_match_lines: int = 0
    by_doc: dict[str, dict[str, Any]] = field(default_factory=dict)
    errors: list[SheetError] = field(default_factory=list)
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "meta": self.meta,
            "sheets": {
                "gold": self.gold,
                "scored": self.scored,
                "missing_prediction": self.missing_prediction,
                "extracted": self.extracted,
                "extracted_rate": _ratio(self.extracted, self.scored),
                "unresolved_match_lines": self.unresolved_match_lines,
            },
            "scalars": {name: t.metrics() for name, t in self.scalars.items()},
            "sets": {name: t.metrics() for name, t in self.sets.items()},
            "context": {
                "sheets": self.context_sheets,
                "scalars": {name: t.metrics() for name, t in self.context_scalars.items()},
                "sets": {name: t.metrics() for name, t in self.context_sets.items()},
                "stations": self.stations.metrics(),
                "facts": self.facts.metrics(),
            },
            "by_doc": self.by_doc,
            "errors": [e.__dict__ for e in self.errors],
        }


def _ratio(num: float, den: float) -> float:
    return round(num / den, 4) if den else 0.0


def _scalar_norm(name: str, value: Any) -> Any:
    if value is None:
        return None
    if name in ("sheet_index", "sheet_total"):
        return int(value)
    return norm_field(name, str(value))


def score(
    gold: Iterable[SheetGold], preds: Mapping[str, SheetPrediction], meta: Mapping[str, Any] | None = None
) -> Scorecard:
    """Deterministic Tier 1 scorecard: gold rows against the parser's predictions.

    A gold sheet with no prediction line counts as ``missing_prediction`` and every
    printed field on it as missed; a prediction that exists but ``extracted`` false
    (scan, outlines) is scored normally — the parser said "nothing here", which is
    right on a blank sheet and a miss on a drawn one.
    """
    card = Scorecard(meta=dict(meta or {}))
    per_doc: dict[str, dict[str, Any]] = defaultdict(
        lambda: {"sheets": 0, "scalar_correct": 0, "scalar_n": 0, "tp": 0, "fp": 0, "fn": 0}
    )
    for row in gold:
        card.gold += 1
        pred = preds.get(row.id)
        d = per_doc[row.doc]
        d["sheets"] += 1
        if pred is None:
            card.missing_prediction += 1
            card.errors.append(SheetError(row.id, "*", "no_prediction"))
            continue
        card.scored += 1
        card.extracted += 1 if pred.extracted else 0
        card.unresolved_match_lines += pred.unresolved_match_lines
        for name in SCALAR_FIELDS:
            g, p = _scalar_norm(name, getattr(row, name)), _scalar_norm(name, getattr(pred, name))
            tally = card.scalars[name]
            d["scalar_n"] += 1
            if g is None and p is None:
                tally.both_null += 1
                d["scalar_correct"] += 1
            elif g is None:
                tally.fabricated += 1
                card.errors.append(SheetError(row.id, name, "fabricated", None, getattr(pred, name)))
            elif p is None:
                tally.missed += 1
                card.errors.append(SheetError(row.id, name, "missed", getattr(row, name), None))
            elif g == p:
                tally.correct += 1
                d["scalar_correct"] += 1
            else:
                tally.wrong += 1
                card.errors.append(SheetError(row.id, name, "wrong", getattr(row, name), getattr(pred, name)))
        for name in SET_FIELDS:
            want = {norm_field(name, v): v for v in getattr(row, name)}
            got = {norm_field(name, v): v for v in pred.set_items(name)}
            tally = card.sets[name]
            tally.sheets += 1
            tp = want.keys() & got.keys()
            tally.tp += len(tp)
            fps, fns = got.keys() - want.keys(), want.keys() - got.keys()
            tally.fp += len(fps)
            tally.fn += len(fns)
            d["tp"] += len(tp)
            d["fp"] += len(fps)
            d["fn"] += len(fns)
            if not fps and not fns:
                tally.sheets_exact += 1
            for k in sorted(fps):
                card.errors.append(SheetError(row.id, name, "fp", None, got[k]))
            for k in sorted(fns):
                card.errors.append(SheetError(row.id, name, "fn", want[k], None))
        if row.context is not None:
            card.context_sheets += 1
            _score_context(card, row, pred)
    for doc, d in per_doc.items():
        p = _ratio(d["tp"], d["tp"] + d["fp"])
        r = _ratio(d["tp"], d["tp"] + d["fn"])
        card.by_doc[doc] = {
            "sheets": d["sheets"],
            "scalar_accuracy": _ratio(d["scalar_correct"], d["scalar_n"]),
            "set_f1": _ratio(2 * p * r, p + r) if (p + r) else 0.0,
        }
    return card


def _score_context(card: Scorecard, row: SheetGold, pred: SheetPrediction) -> None:
    """Tier 1b: the gold context block against the prediction's (missing → everything missed)."""
    gold = row.context
    assert gold is not None
    got = pred.context or SheetContext()
    for name in CONTEXT_SCALARS:
        g_raw, p_raw = getattr(gold, name), getattr(got, name)
        g = norm_field(name, g_raw) if g_raw else None
        p = norm_field(name, p_raw) if p_raw else None
        tally = card.context_scalars[name]
        if g is None and p is None:
            tally.both_null += 1
        elif g is None:
            tally.fabricated += 1
            card.errors.append(SheetError(row.id, f"context.{name}", "fabricated", None, p_raw))
        elif p is None:
            tally.missed += 1
            card.errors.append(SheetError(row.id, f"context.{name}", "missed", g_raw, None))
        elif g == p:
            tally.correct += 1
        else:
            tally.wrong += 1
            card.errors.append(SheetError(row.id, f"context.{name}", "wrong", g_raw, p_raw))
    for name in CONTEXT_SETS:
        gold_items, got_items = list(getattr(gold, name)), list(getattr(got, name))
        if name == "structures":
            gold_items = [part for v in gold_items for part in split_structure(v)]
            got_items = [part for v in got_items for part in split_structure(v)]
        want = {norm_field(name, v): v for v in gold_items}
        have = {norm_field(name, v): v for v in got_items}
        tally = card.context_sets[name]
        tally.sheets += 1
        tp = want.keys() & have.keys()
        fps, fns = have.keys() - want.keys(), want.keys() - have.keys()
        tally.tp += len(tp)
        tally.fp += len(fps)
        tally.fn += len(fns)
        if not fps and not fns:
            tally.sheets_exact += 1
        for k in sorted(fps):
            card.errors.append(SheetError(row.id, f"context.{name}", "fp", None, have[k]))
        for k in sorted(fns):
            card.errors.append(SheetError(row.id, f"context.{name}", "fn", want[k], None))
    # Stations: a gold limit matches an unmatched predicted one when begin (and end) agree
    # within tolerance and the alignments agree or either side left it blank.
    card.stations.sheets += 1
    unmatched = list(got.stations)
    endpoint_hits: dict[int, set[str]] = {}  # predicted ranges whose endpoints matched gold singles
    fns_st: list[StationLimit] = []
    for g_st in gold.stations:
        hit = next((p_st for p_st in unmatched if _station_match(g_st, p_st)), None)
        if hit is not None:
            unmatched.remove(hit)
            card.stations.tp += 1
            continue
        if g_st.end:
            # "Begin Work 554+00" + "End Work 578+00" is the range 554+00 to 578+00 read as two callouts.
            a = next((p for p in unmatched if p.end is None and _same_station(p.begin, g_st.begin, p, g_st)), None)
            b = next(
                (p for p in unmatched if p is not a and p.end is None and _same_station(p.begin, g_st.end, p, g_st)),
                None,
            )
            if a is not None and b is not None:
                unmatched.remove(a)
                unmatched.remove(b)
                card.stations.tp += 1
                continue
        else:
            # A gold single station at either end of a predicted range: each endpoint counts once.
            for p in unmatched:
                if p.end is None:
                    continue
                for key, value in (("begin", p.begin), ("end", p.end)):
                    if key not in endpoint_hits.get(id(p), set()) and _same_station(value, g_st.begin, p, g_st):
                        endpoint_hits.setdefault(id(p), set()).add(key)
                        break
                else:
                    continue
                break
            else:
                fns_st.append(g_st)
                continue
            card.stations.tp += 1
            continue
        fns_st.append(g_st)
    fps_st = [p for p in unmatched if id(p) not in endpoint_hits]
    card.stations.fp += len(fps_st)
    card.stations.fn += len(fns_st)
    if not fps_st and not fns_st:
        card.stations.sheets_exact += 1
    for s in fps_st:
        card.errors.append(SheetError(row.id, "context.stations", "fp", None, _station_text(s)))
    for s in fns_st:
        card.errors.append(SheetError(row.id, "context.stations", "fn", _station_text(s), None))
    # Facts: containment of each gold phrase in the predicted description.
    if gold.facts:
        card.facts.sheets += 1
        card.facts.facts += len(gold.facts)
        if got.description:
            card.facts.sheets_described += 1
            for fact in gold.facts:
                if text_has(got.description, fact):
                    card.facts.covered += 1
                else:
                    card.errors.append(SheetError(row.id, "context.facts", "uncovered", fact, None))
        else:
            for fact in gold.facts:
                card.errors.append(SheetError(row.id, "context.facts", "uncovered", fact, None))


def _same_station(a_text: str | None, b_text: str | None, a: StationLimit, b: StationLimit) -> bool:
    if not a_text or not b_text:
        return False
    av, bv = parse_station(a_text), parse_station(b_text)
    if av is None or bv is None or abs(av - bv) > STATION_TOLERANCE_FT:
        return False
    return not (a.alignment and b.alignment and norm_alignment(a.alignment) != norm_alignment(b.alignment))


def _station_match(a: StationLimit, b: StationLimit) -> bool:
    ab, bb = parse_station(a.begin), parse_station(b.begin)
    if ab is None or bb is None or abs(ab - bb) > STATION_TOLERANCE_FT:
        return False
    ae, be = (parse_station(a.end) if a.end else None), (parse_station(b.end) if b.end else None)
    if (ae is None) != (be is None) or (ae is not None and be is not None and abs(ae - be) > STATION_TOLERANCE_FT):
        return False
    if a.alignment and b.alignment and norm_alignment(a.alignment) != norm_alignment(b.alignment):
        return False
    return True


def _station_text(s: StationLimit) -> str:
    head = f'"{s.alignment}" ' if s.alignment else ""
    return f"{head}{s.begin}" + (f" to {s.end}" if s.end else "") + (f" ({s.what})" if s.what else "")


def format_scorecard(card: Scorecard | Mapping[str, Any], errors: int = 0) -> str:
    """Plain-text summary; ``errors`` > 0 appends that many triage lines."""
    data = card.to_dict() if isinstance(card, Scorecard) else card
    sheets = data["sheets"]
    lines = [
        f"sheets: gold={sheets['gold']} scored={sheets['scored']} missing_prediction={sheets['missing_prediction']} "
        f"extracted={sheets['extracted_rate']:.0%} unresolved_match_lines={sheets['unresolved_match_lines']}",
        f"  {'scalar':13}{'n':>5}{'acc':>7}{'prec':>7}{'rec':>7}{'fab':>5}{'miss':>6}{'wrong':>7}",
    ]
    for name, m in data["scalars"].items():
        lines.append(
            f"  {name:13}{m['n']:5d}{m['accuracy']:7.1%}{m['precision']:7.1%}{m['recall']:7.1%}"
            f"{m['fabricated']:5d}{m['missed']:6d}{m['wrong']:7d}"
        )
    lines.append(f"  {'set':13}{'tp':>5}{'fp':>5}{'fn':>5}{'prec':>7}{'rec':>7}{'f1':>7}{'exact':>7}")
    for name, m in data["sets"].items():
        lines.append(
            f"  {name:13}{m['tp']:5d}{m['fp']:5d}{m['fn']:5d}{m['precision']:7.1%}{m['recall']:7.1%}{m['f1']:7.1%}"
            f"{m['exact_rate']:7.1%}"
        )
    ctx = data.get("context") or {}
    if ctx.get("sheets"):
        lines.append(f"context ({ctx['sheets']} sheets with a context block):")
        lines.append(f"  {'scalar':13}{'n':>5}{'acc':>7}{'prec':>7}{'rec':>7}{'fab':>5}{'miss':>6}{'wrong':>7}")
        for name, m in ctx["scalars"].items():
            lines.append(
                f"  {name:13}{m['n']:5d}{m['accuracy']:7.1%}{m['precision']:7.1%}{m['recall']:7.1%}"
                f"{m['fabricated']:5d}{m['missed']:6d}{m['wrong']:7d}"
            )
        lines.append(f"  {'set':13}{'tp':>5}{'fp':>5}{'fn':>5}{'prec':>7}{'rec':>7}{'f1':>7}{'exact':>7}")
        for name, m in [*ctx["sets"].items(), ("stations", ctx["stations"])]:
            lines.append(
                f"  {name:13}{m['tp']:5d}{m['fp']:5d}{m['fn']:5d}{m['precision']:7.1%}{m['recall']:7.1%}"
                f"{m['f1']:7.1%}{m['exact_rate']:7.1%}"
            )
        f = ctx["facts"]
        lines.append(
            f"  facts: {f['covered']}/{f['facts']} covered ({f['coverage']:.1%}); "
            f"descriptions on {f['sheets_described']}/{f['sheets']} sheets"
        )
    if data["by_doc"]:
        lines.append(f"  {'plan set':30}{'sheets':>7}{'scalar acc':>12}{'set f1':>8}")
        for doc, m in data["by_doc"].items():
            lines.append(f"  {doc:30}{m['sheets']:7d}{m['scalar_accuracy']:12.1%}{m['set_f1']:8.1%}")
    if errors:
        lines.append("  errors:")
        for e in data["errors"][:errors]:
            lines.append(f"    {e['id']:28} {e['field']:13} {e['kind']:14} gold={e['gold']!r} pred={e['pred']!r}")
        if len(data["errors"]) > errors:
            lines.append(f"    … {len(data['errors']) - errors} more")
    return "\n".join(lines)


def scorecard_meta(gold_path: Path, pred_paths: Iterable[Path], split: str | None) -> dict[str, Any]:
    def rel(p: Path) -> str:
        try:
            return str(p.resolve().relative_to(RESEARCH_DIR))
        except ValueError:
            return str(p)

    commit = None
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    return {
        "generated": datetime.now(UTC).isoformat(timespec="seconds"),
        "commit": commit,
        "gold": rel(gold_path),
        "preds": [rel(p) for p in pred_paths],
        "split": split,
        "tier": 1,
    }


def regressions(current: Mapping[str, Any], baseline: Mapping[str, Any], tolerance: float = 0.0) -> list[str]:
    """Metrics that dropped against a committed scorecard (the CI gate)."""
    out: list[str] = []
    cur_rate, base_rate = current["sheets"]["extracted_rate"], baseline["sheets"]["extracted_rate"]
    if cur_rate + tolerance < base_rate:
        out.append(f"extracted_rate {base_rate:.3f} → {cur_rate:.3f}")
    for name, m in baseline.get("scalars", {}).items():
        cur = current["scalars"].get(name)
        if cur is None:
            continue
        for metric in ("accuracy", "precision", "recall"):
            if cur[metric] + tolerance < m[metric]:
                out.append(f"{name}.{metric} {m[metric]:.3f} → {cur[metric]:.3f}")
    for name, m in baseline.get("sets", {}).items():
        cur = current["sets"].get(name)
        if cur is None:
            continue
        if cur["f1"] + tolerance < m["f1"]:
            out.append(f"{name}.f1 {m['f1']:.3f} → {cur['f1']:.3f}")
    base_ctx, cur_ctx = baseline.get("context") or {}, current.get("context") or {}
    if base_ctx.get("sheets") and cur_ctx.get("sheets"):
        for name, m in base_ctx["scalars"].items():
            cur = cur_ctx["scalars"].get(name)
            if cur and cur["accuracy"] + tolerance < m["accuracy"]:
                out.append(f"context.{name}.accuracy {m['accuracy']:.3f} → {cur['accuracy']:.3f}")
        for name, m in [*base_ctx["sets"].items(), ("stations", base_ctx["stations"])]:
            cur = cur_ctx["stations"] if name == "stations" else cur_ctx["sets"].get(name)
            if cur and cur["f1"] + tolerance < m["f1"]:
                out.append(f"context.{name}.f1 {m['f1']:.3f} → {cur['f1']:.3f}")
        if cur_ctx["facts"]["coverage"] + tolerance < base_ctx["facts"]["coverage"]:
            out.append(
                f"context.facts.coverage {base_ctx['facts']['coverage']:.3f} → {cur_ctx['facts']['coverage']:.3f}"
            )
    return out


# --- Stats --------------------------------------------------------------------


def gold_stats(rows: Iterable[SheetGold]) -> dict[str, Counter]:
    rows = list(rows)
    stats: dict[str, Counter] = {
        "status": Counter(r.status for r in rows),
        "split": Counter(r.split for r in rows),
        "doc": Counter(r.doc for r in rows),
        "sheet_kind": Counter(r.sheet_kind or "(unset)" for r in rows),
    }
    labelled = [r for r in rows if r.status == "labelled"]
    filled: Counter = Counter()
    for r in labelled:
        for name in SCALAR_FIELDS:
            if getattr(r, name) is not None:
                filled[name] += 1
        for name in SET_FIELDS:
            filled[name] += len(getattr(r, name))
    stats["labelled_values"] = filled
    context: Counter = Counter()
    for r in labelled:
        if r.context is None:
            continue
        context["sheets"] += 1
        for name in CONTEXT_SETS:
            context[name] += len(getattr(r.context, name))
        context["stations"] += len(r.context.stations)
        context["facts"] += len(r.context.facts)
        context["described"] += 1 if r.context.description else 0
    stats["context"] = context
    return stats
