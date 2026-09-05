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
from dataclasses import dataclass

REFUSAL_TOKEN = "NOT IN DOCUMENT"

_ANSWER_RE = re.compile(r"^[ \t]*\**ANSWER\**[ \t]*:[ \t]*(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_CITE_RE = re.compile(r"^[ \t]*\**CITE\**[ \t]*:[ \t]*(.+?)[ \t]*$", re.IGNORECASE | re.MULTILINE)
_CITATION_ITEM_RE = re.compile(r"([A-Za-z][A-Za-z0-9._-]*)[ \t]*,?[ \t]*(?:p\.?|pg\.?|page)[ \t]*(\d+)", re.IGNORECASE)
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
)

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


def cited_pages(response: str) -> set[tuple[str, int]]:
    """All (doc-id, page) pairs on CITE: lines."""
    pairs: set[tuple[str, int]] = set()
    for line in _CITE_RE.findall(response):
        for doc, page in _CITATION_ITEM_RE.findall(line):
            pairs.add((doc.lower(), int(page)))
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
    text = _FEET_INCHES_RE.sub(lambda m: f"{int(m.group(1)) + float(m.group(2)) / 12:.4f} ft", text)
    for glyph, dec in _UNICODE_FRACTIONS.items():
        text = re.sub(rf"(\d)\s*{glyph}", rf"\1{dec}", text)
        text = text.replace(glyph, f"0{dec}")
    text = _MIXED_RE.sub(lambda m: f"{int(m.group(1)) + int(m.group(2)) / int(m.group(3)):g}", text)
    text = _BARE_FRACTION_RE.sub(lambda m: f"{int(m.group(1)) / int(m.group(2)):g}", text)
    return text


def parse_quantity(text: str) -> tuple[float, str | None] | None:
    """First number in `text` with its unit, if any. Commas in numbers are ignored."""
    m = _QUANTITY_RE.search(fold_fractions(text))
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
    matches = list(_QUANTITY_RE.finditer(fold_fractions(text)))
    if not matches:
        return None
    m = matches[-1]
    return float(m.group(1).replace(",", "")), canonical_unit(m.group(2))


def score_citation(response: str, anchors: list[tuple[str, int]], page_slack: int = 0) -> Verdict:
    """Correct when any cited (doc, page) lands on an anchor, within `page_slack` pages."""
    cited = cited_pages(response)
    if not cited:
        return Verdict(False, "no CITE line")
    wanted = {(doc.lower(), page) for doc, page in anchors}
    for doc, page in cited:
        for want_doc, want_page in wanted:
            if doc == want_doc and abs(page - want_page) <= page_slack:
                return Verdict(True, f"cited {doc} p{page}")
    return Verdict(False, f"cited {sorted(cited)} but anchors are {sorted(wanted)}")


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
