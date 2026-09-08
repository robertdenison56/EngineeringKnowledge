"""Excel round-trip for question sets.

The JSONL file stays the validated source of truth; the workbook is the editing
surface. ``export_xlsx`` writes a Questions sheet (one row per question, anchors
flattened to three column groups, dropdowns for the enumerated fields and for
document ids), a Docs sheet from the manifest, a Stats sheet of COUNTIF formulas
against the bucket targets, and a Guide sheet. ``import_xlsx`` reads the
Questions sheet back, validates every row through the schema, and writes JSONL.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from openpyxl import Workbook, load_workbook
from openpyxl.comments import Comment
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from .manifest import Manifest
from .schema import Question, dump_questions

FONT = "Arial"
ALIAS_SEP = " | "
MAX_ANCHORS = 3
MAX_ROWS = 5000  # rows covered by the dropdown validations
BUCKETS = ["lookup", "multihop", "trap", "refusal"]
ANSWER_TYPES = ["number", "citation", "text", "refusal"]
SPLITS = ["smoke", "dev", "test", "train"]
TARGETS = {"lookup": 60, "multihop": 40, "trap": 30, "refusal": 30}
BENCH_GROUPS = {"hdm", "std-2025", "dib"}

# (header, width, wrap)
COLUMNS: list[tuple[str, int, bool]] = [
    ("id", 11, False),
    ("bucket", 10, False),
    ("question", 72, True),
    ("answer", 24, True),
    ("answer_type", 12, False),
    ("unit", 7, False),
    ("tolerance", 10, False),
    ("aliases", 30, True),
]
for n in range(1, MAX_ANCHORS + 1):
    COLUMNS += [
        (f"anchor{n}_doc", 17, False),
        (f"anchor{n}_page", 8, False),
        (f"anchor{n}_table", 14, False),
        (f"anchor{n}_quote", 48, True),
    ]
COLUMNS += [("edition", 26, False), ("split", 7, False), ("notes", 44, True)]
HEADERS = [c[0] for c in COLUMNS]
COL = {name: i + 1 for i, name in enumerate(HEADERS)}

HEADER_FILL = PatternFill("solid", fgColor="D9E1F2")
INPUT_FILL = PatternFill("solid", fgColor="FFFFF0")
OUT_OF_SCOPE_FILL = PatternFill("solid", fgColor="EEEEEE")


def _cell_text(value) -> str | None:
    """Excel gives numbers back as floats; keep integers clean and blanks as None."""
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    text = str(value).strip()
    return text or None


def question_to_row(q: Question) -> list:
    if len(q.anchors) > MAX_ANCHORS:
        raise ValueError(f"{q.id}: {len(q.anchors)} anchors; the sheet holds {MAX_ANCHORS}")
    row: list = [
        q.id,
        q.bucket,
        q.question,
        q.answer,
        q.answer_type,
        q.unit,
        q.tolerance,
        ALIAS_SEP.join(q.aliases) or None,
    ]
    for n in range(MAX_ANCHORS):
        if n < len(q.anchors):
            a = q.anchors[n]
            row += [a.doc, a.page, a.table, a.quote]
        else:
            row += [None, None, None, None]
    row += [q.edition, q.split, q.notes]
    return row


def row_to_question(values: dict[str, object]) -> Question:
    aliases_raw = _cell_text(values.get("aliases"))
    anchors = []
    for n in range(1, MAX_ANCHORS + 1):
        doc = _cell_text(values.get(f"anchor{n}_doc"))
        if not doc:
            continue
        page = values.get(f"anchor{n}_page")
        anchors.append(
            {
                "doc": doc,
                "page": int(float(page)) if page not in (None, "") else None,
                "table": _cell_text(values.get(f"anchor{n}_table")),
                "quote": _cell_text(values.get(f"anchor{n}_quote")),
            }
        )
    tol = values.get("tolerance")
    payload = {
        "id": _cell_text(values.get("id")),
        "bucket": _cell_text(values.get("bucket")),
        "question": _cell_text(values.get("question")),
        "answer": _cell_text(values.get("answer")),
        "answer_type": _cell_text(values.get("answer_type")),
        "unit": _cell_text(values.get("unit")),
        "tolerance": float(tol) if tol not in (None, "") else 0.0,
        "aliases": [a.strip() for a in aliases_raw.split("|") if a.strip()] if aliases_raw else [],
        "anchors": anchors,
        "edition": _cell_text(values.get("edition")),
        "split": _cell_text(values.get("split")) or "dev",
        "notes": _cell_text(values.get("notes")),
    }
    return Question.model_validate(payload)


def export_xlsx(questions: list[Question], manifest: Manifest, out: Path, source_name: str) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "Questions"
    header_font = Font(name=FONT, bold=True, size=10)
    body_font = Font(name=FONT, size=10)

    for col, (name, width, _wrap) in enumerate(COLUMNS, start=1):
        cell = ws.cell(row=1, column=col, value=name)
        cell.font = header_font
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.column_dimensions[get_column_letter(col)].width = width
    ws.cell(row=1, column=COL["question"]).comment = Comment(
        "Every cell in this sheet is editable. Add new questions as new rows at the bottom; keep the header row. "
        "Then run: caltrans-bench questions import-xlsx <this file> and questions validate.",
        "caltrans-bench",
    )
    ws.cell(row=1, column=COL["anchor1_page"]).comment = Comment(
        "1-based PDF page index of the file named in the doc column (NOT the printed folio). "
        "Standard Plans 2025: PDF page = printed page + 23.",
        "caltrans-bench",
    )
    ws.cell(row=1, column=COL["anchor1_quote"]).comment = Comment(
        "A short verbatim string from that page. The validator must find it there (case and whitespace are ignored). "
        "Prefer a quote that contains the answer.",
        "caltrans-bench",
    )

    for r, q in enumerate(questions, start=2):
        for col, value in enumerate(question_to_row(q), start=1):
            cell = ws.cell(row=r, column=col, value=value)
            cell.font = body_font
            cell.alignment = Alignment(vertical="top", wrap_text=COLUMNS[col - 1][2])
    ws.freeze_panes = "D2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(COLUMNS))}{max(len(questions) + 1, 2)}"

    # Docs sheet: in-scope documents first, used by the anchor doc dropdowns.
    docs_ws = wb.create_sheet("Docs")
    docs_headers = ["doc_id", "in_scope", "group", "title", "edition", "pages", "url"]
    for col, name in enumerate(docs_headers, start=1):
        c = docs_ws.cell(row=1, column=col, value=name)
        c.font = header_font
        c.fill = HEADER_FILL
    docs = sorted(
        manifest.documents,
        key=lambda d: (not (d.group in BENCH_GROUPS and d.id != "hdm-combined"), d.group, d.id),
    )
    for r, d in enumerate(docs, start=2):
        in_scope = d.group in BENCH_GROUPS and d.id != "hdm-combined"
        row = [d.id, "yes" if in_scope else "no", d.group, d.title, d.edition, d.pages, d.url]
        for col, value in enumerate(row, start=1):
            c = docs_ws.cell(row=r, column=col, value=value)
            c.font = body_font
            if not in_scope:
                c.fill = OUT_OF_SCOPE_FILL
    for col, width in zip(range(1, 8), (20, 9, 11, 60, 18, 8, 80), strict=True):
        docs_ws.column_dimensions[get_column_letter(col)].width = width
    docs_ws.freeze_panes = "A2"
    docs_ws.cell(row=1, column=2).comment = Comment(
        "yes = current HDM chapter files and the 2025 Standard Plans / Specifications, the benchmark corpus. "
        "Grey rows are in the manifest for the grounding study only; do not anchor questions to them.",
        "caltrans-bench",
    )

    # Dropdowns on the Questions sheet.
    last = MAX_ROWS
    for name, options in (("bucket", BUCKETS), ("answer_type", ANSWER_TYPES), ("split", SPLITS)):
        dv = DataValidation(type="list", formula1='"' + ",".join(options) + '"', allow_blank=True)
        dv.error = f"Pick one of: {', '.join(options)}"
        dv.errorTitle = name
        ws.add_data_validation(dv)
        letter = get_column_letter(COL[name])
        dv.add(f"{letter}2:{letter}{last}")
    doc_range = f"Docs!$A$2:$A${len(docs) + 1}"
    for n in range(1, MAX_ANCHORS + 1):
        dv = DataValidation(type="list", formula1=f"={doc_range}", allow_blank=True)
        dv.error = "Use a doc_id from the Docs sheet"
        dv.errorTitle = "document id"
        ws.add_data_validation(dv)
        letter = get_column_letter(COL[f"anchor{n}_doc"])
        dv.add(f"{letter}2:{letter}{last}")
        page_dv = DataValidation(type="whole", operator="greaterThanOrEqual", formula1="1", allow_blank=True)
        page_dv.error = "PDF page index, 1 or more"
        ws.add_data_validation(page_dv)
        letter = get_column_letter(COL[f"anchor{n}_page"])
        page_dv.add(f"{letter}2:{letter}{last}")

    # Stats sheet: live counts against the bucket targets.
    st = wb.create_sheet("Stats")
    bucket_col = get_column_letter(COL["bucket"])
    type_col = get_column_letter(COL["answer_type"])
    split_col = get_column_letter(COL["split"])
    id_col = get_column_letter(COL["id"])
    blue = Font(name=FONT, size=10, color="0000FF")
    r = 1
    for name in ("Bucket", "Count", "Target", "Remaining"):
        c = st.cell(row=r, column=("Bucket", "Count", "Target", "Remaining").index(name) + 1, value=name)
        c.font = header_font
        c.fill = HEADER_FILL
    for b in BUCKETS:
        r += 1
        st.cell(row=r, column=1, value=b).font = body_font
        st.cell(
            row=r, column=2, value=f'=COUNTIF(Questions!${bucket_col}$2:${bucket_col}${last},"{b}")'
        ).font = body_font
        tcell = st.cell(row=r, column=3, value=TARGETS[b])
        tcell.font = blue
        tcell.fill = INPUT_FILL
        st.cell(row=r, column=4, value=f"=MAX(0,C{r}-B{r})").font = body_font
    r += 1
    st.cell(row=r, column=1, value="total").font = header_font
    st.cell(row=r, column=2, value=f"=COUNTA(Questions!${id_col}$2:${id_col}${last})").font = body_font
    st.cell(row=r, column=3, value=f"=SUM(C2:C{r - 1})").font = body_font
    st.cell(row=r, column=3).comment = Comment(
        "Targets (blue, editable) are the bucket mix from DATASET_CARD.md: lookup 60, multihop 40, trap 30, refusal 30.",
        "caltrans-bench",
    )
    r += 2
    for name in ("Answer type", "Count"):
        c = st.cell(row=r, column=("Answer type", "Count").index(name) + 1, value=name)
        c.font = header_font
        c.fill = HEADER_FILL
    for t in ANSWER_TYPES:
        r += 1
        st.cell(row=r, column=1, value=t).font = body_font
        st.cell(row=r, column=2, value=f'=COUNTIF(Questions!${type_col}$2:${type_col}${last},"{t}")').font = body_font
    r += 2
    for name in ("Split", "Count"):
        c = st.cell(row=r, column=("Split", "Count").index(name) + 1, value=name)
        c.font = header_font
        c.fill = HEADER_FILL
    for s_ in SPLITS:
        r += 1
        st.cell(row=r, column=1, value=s_).font = body_font
        st.cell(
            row=r, column=2, value=f'=COUNTIF(Questions!${split_col}$2:${split_col}${last},"{s_}")'
        ).font = body_font
    for col, width in ((1, 14), (2, 9), (3, 9), (4, 11)):
        st.column_dimensions[get_column_letter(col)].width = width

    # Guide sheet.
    g = wb.create_sheet("Guide")
    g.column_dimensions["A"].width = 118
    lines = [
        ("Caltrans design-standards QA — question authoring workbook", True),
        (
            f"Exported from {source_name} on {date.today().isoformat()}. The JSONL file is the validated source of truth; "
            "this workbook is the editing surface.",
            False,
        ),
        ("", False),
        ("HOW TO ADD QUESTIONS", True),
        (
            "1. On the Questions sheet, add one row per question at the bottom. Every cell is editable; the existing rows show the "
            "expected format. Keep the header row and column order.",
            False,
        ),
        (
            "2. id: unique, e.g. cb-176. bucket: lookup | multihop | trap | refusal (dropdown). answer_type: number | citation | "
            "text | refusal (dropdown).",
            False,
        ),
        (
            "3. answer: the canonical value. Numbers as plain digits (580, 0.60, 1105); refusals must be exactly NOT IN DOCUMENT. "
            "unit: ft, in, mm, m, mph, %, s, day, psi, MPa, yr … (blank when the value is unitless). tolerance: absolute, in that unit "
            "(0 for exact).",
            False,
        ),
        (
            "4. aliases: alternate accepted surface forms for text answers, separated by | (for example: Section 39 | Sec. 39).",
            False,
        ),
        (
            "5. anchors: up to three. doc = a doc_id from the Docs sheet (dropdown; use in_scope = yes rows). page = the 1-based PDF "
            "page index of that file, not the printed folio (Standard Plans 2025: printed page + 23). table = the table label if the "
            "fact is in a table (Table 201.1). quote = a short verbatim string from that page; the validator must find it there, so "
            "prefer a quote that contains the answer.",
            False,
        ),
        (
            "6. Refusal questions need bucket = refusal, answer_type = refusal, answer = NOT IN DOCUMENT; an anchor is optional but "
            "useful (the page a reader would look at). Multihop questions need at least two anchors.",
            False,
        ),
        (
            "7. split: dev while authoring. edition: HDM 7th edition / 2025 / Standard Plans 2025. notes: anything a reviewer should "
            "know (why a value is a trap, what the table's range is).",
            False,
        ),
        ("", False),
        ("BUCKET GUIDANCE", True),
        (
            "lookup — one value read from one table row or clause. multihop — the answer needs a second document or clause reached "
            "through a cross-reference (HDM → Standard Plan sheet, HDM → Standard Specifications section, clause → clause). "
            "trap — unit conversions (metric vs US customary, short tons, psi/MPa); edition traps are parked while the set targets "
            "2025 editions only. refusal — a plausible question the documents do not answer (a speed outside a table's range, a row "
            "that does not exist).",
            False,
        ),
        ("Targets and live counts are on the Stats sheet.", False),
        ("", False),
        ("SCOPE", True),
        (
            "Current HDM chapter files, the 2025 Standard Plans and Standard Specifications, and DIB 82-06 (Docs sheet, in_scope = yes). "
            "Older editions and the District 3 bid documents are in the manifest for the grounding study and must not be anchored.",
            False,
        ),
        ("", False),
        ("BRINGING EDITS BACK", True),
        ("cd research", False),
        (
            "uv run caltrans-bench questions import-xlsx questions/caltrans-v0.xlsx --out questions/caltrans-v0.jsonl",
            False,
        ),
        (
            "uv run caltrans-bench questions validate questions/caltrans-v0.jsonl      # opens every anchored page and checks the quotes",
            False,
        ),
        (
            "uv run caltrans-bench questions export-xlsx questions/caltrans-v0.jsonl   # regenerates this workbook from the JSONL",
            False,
        ),
        (
            "Import refuses to write when any row fails the schema and prints the row numbers; fix them here and re-run.",
            False,
        ),
        (
            'Finding facts: uv run caltrans-bench corpus grep "<regex>" --docs hdm-chp0300 --pages 1-20   and   '
            "uv run caltrans-bench corpus page stdspecs-2025 319",
            False,
        ),
    ]
    for r, (text, bold) in enumerate(lines, start=1):
        c = g.cell(row=r, column=1, value=text)
        c.font = Font(name=FONT, size=10, bold=bold)
        c.alignment = Alignment(wrap_text=True, vertical="top")

    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out


def import_xlsx(path: Path) -> tuple[list[Question], list[str]]:
    """Read the Questions sheet; returns (questions, errors). Rows with no id and no question are skipped."""
    wb = load_workbook(path, data_only=True, read_only=True)
    if "Questions" not in wb.sheetnames:
        return [], [f"{path}: no 'Questions' sheet"]
    ws = wb["Questions"]
    rows = ws.iter_rows(values_only=True)
    header = [(_cell_text(h) or "") for h in next(rows)]
    missing = [h for h in HEADERS if h not in header]
    if missing:
        return [], [f"{path}: missing columns {missing}"]
    index = {name: header.index(name) for name in HEADERS}
    questions: list[Question] = []
    errors: list[str] = []
    seen: set[str] = set()
    for row_no, raw in enumerate(rows, start=2):
        values = {name: (raw[i] if i < len(raw) else None) for name, i in index.items()}
        if not _cell_text(values["id"]) and not _cell_text(values["question"]):
            continue
        try:
            q = row_to_question(values)
        except Exception as exc:  # pydantic ValidationError or int() failure
            errors.append(f"row {row_no}: {str(exc).splitlines()[0]}")
            continue
        if q.id in seen:
            errors.append(f"row {row_no}: duplicate id {q.id}")
            continue
        seen.add(q.id)
        questions.append(q)
    return questions, errors


def write_jsonl(questions: list[Question], out: Path, source: Path) -> None:
    header = (
        f"# Imported from {source.name} by `caltrans-bench questions import-xlsx` on {date.today().isoformat()}. "
        "Edit the workbook or this file, then run `questions validate`.\n"
    )
    out.write_text(header, encoding="utf-8")
    with out.open("a", encoding="utf-8") as fh:
        for q in questions:
            fh.write(q.model_dump_json(exclude_none=True) + "\n")


__all__ = ["dump_questions", "export_xlsx", "import_xlsx", "write_jsonl"]
