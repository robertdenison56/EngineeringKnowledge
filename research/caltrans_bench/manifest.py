"""Corpus manifest (task 1 of the Arc 1 plan).

``corpus/manifest.json`` is the single source of truth for which source PDFs
the benchmark is built on. The curated fields (id, group, title, edition,
revision date, URL, file name) are hand-written; ``build`` fills the measured
fields (bytes, sha256, pages) from the downloaded files, and ``verify``
re-checks them so a mismatch between a collaborator's copy and the published
manifest is caught before any number is reported.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx

from . import MANIFEST_PATH, RAW_DIR

MANIFEST_SCHEMA_VERSION = 1
USER_AGENT = "EKG-research-manifest/0.1 (+https://github.com/robertdenison56/EngineeringKnowledge)"
CHUNK = 1 << 20


@dataclass
class Document:
    id: str
    group: str
    kind: str
    title: str
    file: str
    edition: str | None = None
    revision_date: str | None = None
    url: str | None = None
    source_note: str | None = None
    bytes: int | None = None
    sha256: str | None = None
    pages: int | None = None

    @property
    def relative_path(self) -> Path:
        return Path(self.group) / self.file

    def path(self, raw_dir: Path = RAW_DIR) -> Path:
        return raw_dir / self.relative_path


@dataclass
class Manifest:
    schema_version: int
    corpus: str
    documents: list[Document] = field(default_factory=list)
    generated: str | None = None
    notes: str | None = None

    def by_id(self) -> dict[str, Document]:
        return {d.id: d for d in self.documents}

    def select(self, only: list[str] | None = None, group: str | None = None) -> list[Document]:
        docs = self.documents
        if group:
            wanted_groups = {g.strip() for g in group.split(",") if g.strip()}
            docs = [d for d in docs if d.group in wanted_groups]
        if only:
            wanted = set(only)
            unknown = wanted - {d.id for d in self.documents}
            if unknown:
                raise KeyError(f"unknown document id(s): {sorted(unknown)}")
            docs = [d for d in docs if d.id in wanted]
        return docs


def load_manifest(path: Path = MANIFEST_PATH) -> Manifest:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema_version") != MANIFEST_SCHEMA_VERSION:
        raise ValueError(f"{path}: schema_version {data.get('schema_version')} != {MANIFEST_SCHEMA_VERSION}")
    docs = [Document(**d) for d in data["documents"]]
    ids = [d.id for d in docs]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        raise ValueError(f"{path}: duplicate document ids {sorted(dupes)}")
    return Manifest(
        schema_version=data["schema_version"],
        corpus=data["corpus"],
        documents=docs,
        generated=data.get("generated"),
        notes=data.get("notes"),
    )


def save_manifest(manifest: Manifest, path: Path = MANIFEST_PATH) -> None:
    payload = {
        "schema_version": manifest.schema_version,
        "corpus": manifest.corpus,
        "generated": manifest.generated,
        "notes": manifest.notes,
        "documents": [asdict(d) for d in manifest.documents],
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def page_count(path: Path) -> int:
    import pymupdf  # imported lazily so manifest verify works without it

    with pymupdf.open(path) as pdf:
        return pdf.page_count


def fetch(
    manifest: Manifest,
    raw_dir: Path = RAW_DIR,
    only: list[str] | None = None,
    group: str | None = None,
    local_dir: Path | None = None,
    force: bool = False,
    timeout: float = 900.0,
) -> list[tuple[Document, str]]:
    """Download URL-backed documents; copy URL-less ones from `local_dir`.

    Returns (document, outcome) pairs where outcome is one of
    ``downloaded``, ``copied``, ``present``, ``missing-local``, ``no-source``.
    """
    results: list[tuple[Document, str]] = []
    with httpx.Client(follow_redirects=True, timeout=timeout, headers={"User-Agent": USER_AGENT}) as client:
        for doc in manifest.select(only, group):
            dest = doc.path(raw_dir)
            if dest.exists() and dest.stat().st_size > 0 and not force:
                results.append((doc, "present"))
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            if doc.url:
                part = dest.with_suffix(dest.suffix + ".part")
                with client.stream("GET", doc.url) as resp:
                    resp.raise_for_status()
                    with part.open("wb") as fh:
                        for chunk in resp.iter_bytes(CHUNK):
                            fh.write(chunk)
                part.replace(dest)
                results.append((doc, "downloaded"))
            elif local_dir is not None:
                src = local_dir / doc.file
                if src.exists():
                    shutil.copy2(src, dest)
                    results.append((doc, "copied"))
                else:
                    results.append((doc, "missing-local"))
            else:
                results.append((doc, "no-source"))
    return results


def build(manifest: Manifest, raw_dir: Path = RAW_DIR, with_pages: bool = True) -> list[Document]:
    """Fill bytes/sha256/pages from files on disk. Returns the documents not found."""
    missing: list[Document] = []
    for doc in manifest.documents:
        path = doc.path(raw_dir)
        if not path.exists():
            missing.append(doc)
            continue
        doc.bytes = path.stat().st_size
        doc.sha256 = sha256_of(path)
        if with_pages:
            doc.pages = page_count(path)
    manifest.generated = datetime.now(UTC).replace(microsecond=0).isoformat()
    return missing


def verify(
    manifest: Manifest,
    raw_dir: Path = RAW_DIR,
    only: list[str] | None = None,
    group: str | None = None,
    offline: bool = False,
) -> list[str]:
    """Return a list of problems; empty means the corpus matches the manifest.

    ``offline`` checks only the manifest's own consistency (every document has
    a measured hash and either a URL or a source note) without touching files.
    """
    problems: list[str] = []
    for doc in manifest.select(only, group):
        if not doc.url and not doc.source_note:
            problems.append(f"{doc.id}: no url and no source_note")
        if doc.sha256 is None or doc.bytes is None:
            problems.append(f"{doc.id}: not yet hashed (run `manifest build`)")
            continue
        if offline:
            continue
        path = doc.path(raw_dir)
        if not path.exists():
            problems.append(f"{doc.id}: missing {path}")
            continue
        size = path.stat().st_size
        if size != doc.bytes:
            problems.append(f"{doc.id}: size {size} != manifest {doc.bytes}")
            continue
        digest = sha256_of(path)
        if digest != doc.sha256:
            problems.append(f"{doc.id}: sha256 {digest[:12]}… != manifest {doc.sha256[:12]}…")
    return problems
