from pathlib import Path

from caltrans_bench import MANIFEST_PATH, QUESTIONS_DIR
from caltrans_bench.manifest import load_manifest
from caltrans_bench.schema import load_questions
from caltrans_bench.xlsx import export_xlsx, import_xlsx, write_jsonl


def test_xlsx_round_trip(tmp_path: Path):
    src = QUESTIONS_DIR / "smoke.jsonl"
    original = load_questions(src)
    xlsx = export_xlsx(original, load_manifest(MANIFEST_PATH), tmp_path / "q.xlsx", src.name)
    back, errors = import_xlsx(xlsx)
    assert errors == []
    assert [q.model_dump() for q in back] == [q.model_dump() for q in original]
    out = tmp_path / "q.jsonl"
    write_jsonl(back, out, xlsx)
    assert [q.model_dump() for q in load_questions(out)] == [q.model_dump() for q in original]


def test_import_reports_bad_rows(tmp_path: Path):
    from openpyxl import load_workbook

    src = QUESTIONS_DIR / "smoke.jsonl"
    xlsx = export_xlsx(load_questions(src), load_manifest(MANIFEST_PATH), tmp_path / "q.xlsx", src.name)
    wb = load_workbook(xlsx)
    ws = wb["Questions"]
    ws.cell(row=2, column=2, value="mystery")  # bad bucket
    ws.cell(row=3, column=9).value = None  # drop the only anchor of a lookup (cell(value=None) would not clear it)
    wb.save(xlsx)
    qs, errors = import_xlsx(xlsx)
    assert len(errors) == 2 and errors[0].startswith("row 2") and errors[1].startswith("row 3")
    assert len(qs) == 8
