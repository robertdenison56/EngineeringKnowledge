import json
from pathlib import Path

from caltrans_bench import MANIFEST_PATH
from caltrans_bench.manifest import Document, Manifest, build, load_manifest, save_manifest, sha256_of, verify


def _tiny(tmp_path: Path) -> tuple[Manifest, Path]:
    raw = tmp_path / "raw"
    (raw / "g").mkdir(parents=True)
    (raw / "g" / "a.pdf").write_bytes(b"%PDF-1.4 fake")
    m = Manifest(
        schema_version=1,
        corpus="t",
        documents=[
            Document(id="a", group="g", kind="spec", title="A", file="a.pdf", url="https://example.invalid/a.pdf"),
        ],
    )
    return m, raw


def test_build_then_verify_roundtrip(tmp_path: Path):
    m, raw = _tiny(tmp_path)
    assert build(m, raw, with_pages=False) == []
    assert m.documents[0].sha256 == sha256_of(raw / "g" / "a.pdf")
    assert verify(m, raw) == []
    (raw / "g" / "a.pdf").write_bytes(b"%PDF-1.4 changed")
    problems = verify(m, raw)
    assert problems and "size" in problems[0]


def test_save_load_roundtrip(tmp_path: Path):
    m, raw = _tiny(tmp_path)
    build(m, raw, with_pages=False)
    p = tmp_path / "m.json"
    save_manifest(m, p)
    again = load_manifest(p)
    assert again.documents[0].sha256 == m.documents[0].sha256
    assert json.loads(p.read_text())["schema_version"] == 1


def test_committed_manifest_is_consistent():
    m = load_manifest(MANIFEST_PATH)
    assert verify(m, offline=True) == []
    assert len(m.documents) >= 40
    groups = {d.group for d in m.documents}
    assert {"hdm", "std-2025", "std-2018", "district3"} <= groups
