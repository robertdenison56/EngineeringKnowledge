"""Deterministic scoring (task 12 of the Arc 1 plan).

Pure functions with no Inspect imports, so they are unit-testable and reusable
from the agentic-study and fine-tune scripts. The Inspect wrappers live in
``task.py``.

Every solver condition is asked to end its response with the same protocol::

    ANSWER: <value, or NOT IN DOCUMENT>
    CITE: <doc-id> p<page>; <doc-id> p<page>

The scorer reads only those two lines. Prose before them is ignored, which is
what lets closed-book, RAG, and tool-using runs be scored identically.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass

REFUSAL_TOKEN = "NOT IN DOCUMENT"

_ANSWER_RE = re.compile(r"^[ \t]*\**ANSWER\**[ \t]*:[ \t]*(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_CITE_RE = re.compile(r"^[ \t]*\**CITE\**[ \t]*:[ \t]*(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
# Page markers on a CITE line. Each one ends an item; the document is whatever
# precedes it, back to the previous marker. Scanning for the marker rather than
# for a document-shaped token is what makes "HDM Table 309.2A p6" cite the HDM
# and not "A", and the leading \b is what keeps the "p" of "hdm-chp0200" from
# being read as the marker (it is mid-token, so no boundary precedes it).
_PAGE_MARKER_RE = re.compile(r"\b(?:p|pg|page)\.?[ \t]*(\d+)", re.IGNORECASE)
#: Separators between the document and its page, and between items.
_ITEM_TRIM = " \t,;."
_QUANTITY_RE = re.compile(r"(-?\d[\d,]*(?:\.\d+)?)[ \t]*([A-Za-z/%°]+(?:/[A-Za-z]+)?|'|\")?")
_REFUSAL_PHRASES = (
    "not in document",
    "not in the document",
    "not found in the document",
    "not found in the provided",
    "does not contain",
    "do not contain",
    "cannot be determined from",
    "not specified in",
    "not addressed in",
    "does not specify",
    "do not specify",
    "not provided in",
    "no information",
    "no value",
    "not applicable",
    "not given",
    "not listed",
    "not stated",
    "not established",
    "not available",
    "no entry",
)
# An ANSWER line that is only a dash placeholder or N/A is a refusal in substance
# (models copy a table's "---" cell or write "N/A (no value given)").
_BARE_REFUSAL_RE = re.compile(r"^\s*(?:-{2,}|—|–|n/?a\b|none\s*\.?\s*$)", re.IGNORECASE)

# Number words → digits, for text answers such as "two curb ramps" to a number question.
_ONES = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_NUMBER_WORD_RE = re.compile(
    r"\b(?:(" + "|".join(_TENS) + r")(?:[ -](" + "|".join(k for k in _ONES if _ONES[k] and _ONES[k] < 10) + r"))?|("
    + "|".join(_ONES) + r"))\b",
    re.IGNORECASE,
)


def fold_number_words(text: str) -> str:
    """'two curb ramps' → '2 curb ramps'; only when the text carries no digit at all."""
    if re.search(r"\d", text):
        return text

    def repl(m: re.Match[str]) -> str:
        if m.group(3):
            return str(_ONES[m.group(3).lower()])
        return str(_TENS[m.group(1).lower()] + (_ONES[m.group(2).lower()] if m.group(2) else 0))

    return _NUMBER_WORD_RE.sub(repl, text, count=1)

# Unit spellings → canonical symbol.
UNIT_ALIASES: dict[str, str] = {
    "ft": "ft",
    "feet": "ft",
    "foot": "ft",
    "'": "ft",
    "m": "m",
    "meter": "m",
    "meters": "m",
    "metre": "m",
    "metres": "m",
    "in": "in",
    "inch": "in",
    "inches": "in",
    '"': "in",
    "mm": "mm",
    "millimeter": "mm",
    "millimeters": "mm",
    "millimetre": "mm",
    "mi": "mi",
    "mile": "mi",
    "miles": "mi",
    "km": "km",
    "kilometer": "km",
    "kilometers": "km",
    "mph": "mph",
    "mi/h": "mph",
    "km/h": "km/h",
    "kph": "km/h",
    "kmh": "km/h",
    "%": "%",
    "percent": "%",
    "pct": "%",
    "deg": "deg",
    "degree": "deg",
    "degrees": "deg",
    "°": "deg",
    "psi": "psi",
    "ksi": "ksi",
    "mpa": "MPa",
    "kpa": "kPa",
    "s": "s",
    "sec": "s",
    "second": "s",
    "seconds": "s",
    "yr": "yr",
    "year": "yr",
    "years": "yr",
}

# (dimension, factor to base unit)
_TO_BASE: dict[str, tuple[str, float]] = {
    "ft": ("length", 0.3048),
    "m": ("length", 1.0),
    "in": ("length", 0.0254),
    "mm": ("length", 0.001),
    "mi": ("length", 1609.344),
    "km": ("length", 1000.0),
    "mph": ("speed", 0.44704),
    "km/h": ("speed", 1 / 3.6),
    "psi": ("pressure", 6894.757),
    "ksi": ("pressure", 6_894_757.0),
    "MPa": ("pressure", 1_000_000.0),
    "kPa": ("pressure", 1_000.0),
}


@dataclass(frozen=True)
class Verdict:
    correct: bool
    reason: str


def canonical_unit(text: str | None) -> str | None:
    if text is None:
        return None
    return UNIT_ALIASES.get(text.strip().lower(), UNIT_ALIASES.get(text.strip()))


def final_answer(response: str) -> str | None:
    """The value on the last ANSWER: line, or None when the protocol was not followed."""
    matches = _ANSWER_RE.findall(response)
    return matches[-1].strip() if matches else None


def normalize_doc_token(doc: str) -> str:
    """Fold a cited document name to the form ``doc_aliases`` keys on.

    Lower-case, everything non-alphanumeric to single spaces: ``2025-Standard-Plans``,
    ``2025 Standard Plans`` and ``2025_standard_plans`` are one key.
    """
    return re.sub(r"[^a-z0-9]+", " ", doc.lower()).strip()


#: An HDM section or table number: 201.1, 309.2A, 1003.1. The leading digits are
#: the section, and its chapter is the hundred it falls in — 201.1 is chapter 200,
#: 1003.1 is chapter 1000. Caltrans numbering, so "HDM Table 201.1" names a
#: chapter exactly as precisely as the chapter's own id does.
_HDM_SECTION_RE = re.compile(r"\b(\d{3,4})\.\d")


def canonical_doc(doc: str, aliases: Mapping[str, str] | None = None) -> str:
    """A cited document name mapped to its manifest id, or the normalized name.

    Models name a document every way it appears to them: the manifest id, the
    gateway's entity id (``ingest:e3673a7430de``) or file stem, the title
    ("2025 Standard Specifications"), or a chapter by its table number ("HDM
    Table 201.1"). All of those identify one document, so all of them resolve.

    Tried in order: the whole phrase; its last colon segment (a namespaced entity
    id); the longest run of words inside it that is an alias (so "see 2025
    Standard Plans" still lands); and finally, for the HDM, the chapter implied
    by a section number. A bare "HDM" resolves to nothing — 38 chapters carry
    that name and the citation does not say which.
    """
    key = normalize_doc_token(doc)
    if not aliases:
        return key
    if key in aliases:
        return aliases[key]
    tail = normalize_doc_token(doc.rsplit(":", 1)[-1])
    if tail in aliases:
        return aliases[tail]
    words = key.split()
    for size in range(len(words) - 1, 0, -1):
        for start in range(len(words) - size + 1):
            window = " ".join(words[start : start + size])
            if window in aliases:
                return aliases[window]
    if "hdm" in words or "highway design manual" in key:
        # On the raw text: normalizing turns "201.1" into "201 1".
        section = _HDM_SECTION_RE.search(doc)
        if section:
            chapter = aliases.get(f"hdm chapter {int(section.group(1)) // 100 * 100}")
            if chapter:
                return chapter
    return key


def cited_pages(response: str, aliases: Mapping[str, str] | None = None) -> set[tuple[str, int]]:
    """All (doc-id, page) pairs on CITE: lines, with document ids canonicalised.

    An item runs from the end of the previous page marker to the end of this one,
    so the document is the whole phrase in front of the page rather than the one
    token touching it.
    """
    pairs: set[tuple[str, int]] = set()
    for line in _CITE_RE.findall(response):
        at = 0
        current: str | None = None
        for marker in _PAGE_MARKER_RE.finditer(line):
            doc = line[at : marker.start()].strip(_ITEM_TRIM)
            at = marker.end()
            # "hdm-chp0200 p2, p5" cites two pages of one document: a page with no
            # document in front of it belongs to the last one named on the line.
            if doc:
                current = canonical_doc(doc, aliases)
            if current is not None:
                pairs.add((current, int(marker.group(1))))
    return pairs


_UNICODE_FRACTIONS = {
    "½": ".5",
    "¼": ".25",
    "¾": ".75",
    "⅓": ".333",
    "⅔": ".667",
    "⅛": ".125",
    "⅜": ".375",
    "⅝": ".625",
    "⅞": ".875",
}
_MIXED_RE = re.compile(r"(?<![\d.])(\d+)[- ](\d)/(\d+)(?!\d)")
_BARE_FRACTION_RE = re.compile(r"(?<![\d./-])(\d)/(\d+)(?![\d/])")


_FEET_INCHES_RE = re.compile(r"(\d+)\s*(?:'|′|ft\b|feet\b)\s*[-–]?\s*(\d+(?:\.\d+)?)\s*(?:\"|″|in\b|inches\b)")


def fold_fractions(text: str) -> str:
    """16½ → 16.5, 1-1/2 → 1.5, 16 1/2 → 16.5, ½ → 0.5, 23'-4" → 23.3333 ft.

    Drawing-style values then score as ordinary numbers.
    """
    text = (
        text.replace("\u202f", " ").replace("\u00a0", " ").replace("\u2009", " ")
    )  # narrow/no-break spaces before units
    text = _FEET_INCHES_RE.sub(lambda m: f"{int(m.group(1)) + float(m.group(2)) / 12:.4f} ft", text)
    for glyph, dec in _UNICODE_FRACTIONS.items():
        text = re.sub(rf"(\d)\s*{glyph}", rf"\1{dec}", text)
        text = text.replace(glyph, f"0{dec}")
    text = _MIXED_RE.sub(lambda m: f"{int(m.group(1)) + int(m.group(2)) / int(m.group(3)):g}", text)
    text = _BARE_FRACTION_RE.sub(lambda m: f"{int(m.group(1)) / int(m.group(2)):g}", text)
    return text


def parse_quantity(text: str) -> tuple[float, str | None] | None:
    """First number in `text` with its unit, if any. Commas in numbers are ignored."""
    m = _QUANTITY_RE.search(fold_fractions(fold_number_words(text)))
    if not m:
        return None
    value = float(m.group(1).replace(",", ""))
    return value, canonical_unit(m.group(2))


def convert(value: float, from_unit: str | None, to_unit: str | None) -> float | None:
    """Convert between units of the same dimension; None when incomparable.

    A missing unit on either side is taken to mean "same as the other side".
    """
    if from_unit is None or to_unit is None or from_unit == to_unit:
        return value
    src = _TO_BASE.get(from_unit)
    dst = _TO_BASE.get(to_unit)
    if src is None or dst is None or src[0] != dst[0]:
        return None
    return value * src[1] / dst[1]


def is_refusal(response: str) -> bool:
    answer = final_answer(response)
    if answer is not None and _BARE_REFUSAL_RE.match(answer):
        return True
    haystack = (answer if answer is not None else response).lower()
    return any(phrase in haystack for phrase in _REFUSAL_PHRASES)


def score_number(response: str, expected: float, unit: str | None, tolerance: float) -> Verdict:
    if is_refusal(response):
        return Verdict(False, "refused a question that has an answer")
    answer = final_answer(response)
    source = answer if answer is not None else response
    parsed = parse_quantity(source) if answer is not None else _last_quantity(source)
    if parsed is None:
        return Verdict(False, "no number found")
    value, found_unit = parsed
    converted = convert(value, found_unit, canonical_unit(unit))
    if converted is None:
        return Verdict(False, f"unit {found_unit} not comparable with {unit}")
    ok = abs(converted - expected) <= tolerance + 1e-9
    return Verdict(ok, f"got {value} {found_unit or ''} → {converted:g} vs {expected:g} ±{tolerance:g}")


def _last_quantity(text: str) -> tuple[float, str | None] | None:
    matches = list(_QUANTITY_RE.finditer(fold_fractions(fold_number_words(text))))
    if not matches:
        return None
    m = matches[-1]
    return float(m.group(1).replace(",", "")), canonical_unit(m.group(2))


def score_citation(
    response: str,
    anchors: list[tuple[str, int]],
    page_slack: int = 0,
    aliases: Mapping[str, str] | None = None,
) -> Verdict:
    """Correct when any cited (doc, page) lands on an anchor, within `page_slack` pages.

    Both sides fold through `normalize_doc_token`, so an anchor's id matches a
    citation of that id whatever separators it was written with, and with or
    without an alias map to resolve it.
    """
    cited = cited_pages(response, aliases)
    if not cited:
        return Verdict(False, "no CITE line")
    wanted = {(normalize_doc_token(doc), page) for doc, page in anchors}
    for doc, page in cited:
        key = normalize_doc_token(doc)
        for want_doc, want_page in wanted:
            if key == want_doc and abs(page - want_page) <= page_slack:
                return Verdict(True, f"cited {doc} p{page}")
    return Verdict(False, f"cited {sorted(cited)} but anchors are {sorted((d, p) for d, p in anchors)}")


def score_refusal(response: str) -> Verdict:
    if is_refusal(response):
        return Verdict(True, "refused")
    return Verdict(False, f"answered {final_answer(response) or '(no ANSWER line)'!r} instead of refusing")


def _normalize_text(text: str) -> str:
    """Lower-case, fold intra-word hyphens (sub-base == subbase), collapse the rest to spaces."""
    folded = re.sub(r"(?<=[a-z])-(?=[a-z])", "", text.lower())
    return re.sub(r"[^a-z0-9]+", " ", folded).strip()


def score_text(response: str, expected: str, aliases: list[str] | None = None) -> Verdict:
    """Normalized containment of the expected string or any alias in the ANSWER line.

    This is the deterministic half of text scoring; prose that needs judgment
    goes to the model-graded scorer in task.py.
    """
    if is_refusal(response):
        return Verdict(False, "refused a question that has an answer")
    answer = final_answer(response)
    if answer is None:
        return Verdict(False, "no ANSWER line")
    hay = _normalize_text(answer)
    for candidate in [expected, *(aliases or [])]:
        if _normalize_text(candidate) and _normalize_text(candidate) in hay:
            return Verdict(True, f"matched {candidate!r}")
    return Verdict(False, f"{answer!r} does not contain {expected!r}")
