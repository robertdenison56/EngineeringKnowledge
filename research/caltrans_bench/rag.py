"""Vanilla RAG baseline: page-level chunks over the manifest corpus.

Lexical BM25 is the default so the smoke pass has no model downloads; dense
retrieval (sentence-transformers) is opt-in via the `dense` extra. Both return
page-anchored passages so the RAG condition can cite ``<doc-id> p<page>``.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from . import RAW_DIR
from .manifest import Document, Manifest
from .text import page_texts

_TOKEN = re.compile(r"[a-z0-9]+(?:[.'-][a-z0-9]+)*")


def tokenize(text: str) -> list[str]:
    return _TOKEN.findall(text.lower())


@dataclass(frozen=True)
class Passage:
    doc: str
    page: int
    text: str
    score: float


class PageIndex:
    """BM25 over one page per chunk. Small enough to build in-process (a few thousand pages)."""

    def __init__(
        self,
        manifest: Manifest,
        raw_dir: Path = RAW_DIR,
        only: list[str] | None = None,
        group: str | None = None,
        k1: float = 1.5,
        b: float = 0.75,
    ) -> None:
        self.k1, self.b = k1, b
        self.pages: list[tuple[str, int, str]] = []
        self.tf: list[Counter[str]] = []
        self.df: Counter[str] = Counter()
        for doc in manifest.select(only, group):
            if not doc.path(raw_dir).exists():
                continue
            self._add(doc, page_texts(doc, raw_dir))
        self.n = len(self.pages)
        self.avgdl = (sum(sum(c.values()) for c in self.tf) / self.n) if self.n else 0.0

    def _add(self, doc: Document, texts: list[str]) -> None:
        for i, text in enumerate(texts, start=1):
            toks = tokenize(text)
            if not toks:
                continue
            counts = Counter(toks)
            self.pages.append((doc.id, i, text))
            self.tf.append(counts)
            self.df.update(counts.keys())

    def retrieve(self, query: str, k: int = 8) -> list[Passage]:
        if not self.n:
            return []
        q = [t for t in tokenize(query) if t in self.df]
        scores: list[tuple[float, int]] = []
        for idx, counts in enumerate(self.tf):
            dl = sum(counts.values())
            s = 0.0
            for t in q:
                f = counts.get(t)
                if not f:
                    continue
                idf = math.log(1 + (self.n - self.df[t] + 0.5) / (self.df[t] + 0.5))
                s += idf * f * (self.k1 + 1) / (f + self.k1 * (1 - self.b + self.b * dl / self.avgdl))
            if s > 0:
                scores.append((s, idx))
        scores.sort(reverse=True)
        return [Passage(self.pages[i][0], self.pages[i][1], self.pages[i][2], s) for s, i in scores[:k]]


def format_context(passages: list[Passage], max_chars: int | None = None) -> str:
    """Label each passage ``[doc-id pPAGE]`` so the model can cite it.

    Pages are passed whole by default. The former 3,000-character cap cut the answer off
    roughly half of the HDM and Standard Specifications pages it retrieved (they run 3,500+
    characters), which showed up as spurious refusals; k=8 whole pages is still well under
    50k characters. Pass ``max_chars`` only to study the effect of a cap deliberately.
    """
    parts = []
    for p in passages:
        body = p.text.strip()
        if max_chars is not None and len(body) > max_chars:
            body = body[:max_chars] + " …"
        parts.append(f"[{p.doc} p{p.page}]\n{body}")
    return "\n\n".join(parts)
