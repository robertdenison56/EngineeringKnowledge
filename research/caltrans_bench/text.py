"""Page text extraction with an on-disk cache keyed by the document's sha256."""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import CACHE_DIR, RAW_DIR
from .manifest import Document

_WS = re.compile(r"\s+")


def normalize(text: str) -> str:
    """Collapse whitespace and case so anchor quotes survive PDF line breaks."""
    return _WS.sub(" ", text).strip().lower()


def page_texts(doc: Document, raw_dir: Path = RAW_DIR, cache_dir: Path = CACHE_DIR) -> list[str]:
    """Text of every page (index 0 = PDF page 1), cached per document hash."""
    key = doc.sha256 or doc.id
    cache_path = cache_dir / f"{doc.id}.{key[:16]}.json"
    if cache_path.exists():
        return json.loads(cache_path.read_text(encoding="utf-8"))
    import pymupdf

    path = doc.path(raw_dir)
    if not path.exists():
        raise FileNotFoundError(f"{doc.id}: {path} not present; run `caltrans-bench manifest fetch --only {doc.id}`")
    with pymupdf.open(path) as pdf:
        texts = [page.get_text("text") for page in pdf]
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(json.dumps(texts), encoding="utf-8")
    return texts


def page_text(doc: Document, page: int, raw_dir: Path = RAW_DIR) -> str:
    """Text of 1-based `page`."""
    texts = page_texts(doc, raw_dir)
    if not 1 <= page <= len(texts):
        raise IndexError(f"{doc.id}: page {page} out of range 1..{len(texts)}")
    return texts[page - 1]


def contains(haystack: str, needle: str) -> bool:
    return normalize(needle) in normalize(haystack)
