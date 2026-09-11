"""EKG's MCP gateway as an Inspect tool source (the "EKG tools" condition).

The gateway is the TypeScript server in ``apps/mcp-server`` run over stdio
against a pinned snapshot database (``scripts/build-ekg-snapshot.sh``). Only
the read tools are exposed to the model; write tools stay out of the study.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from . import REPO_ROOT
from .scoring import normalize_doc_token

READ_TOOLS = ["search", "fetch", "traverse", "get_project_context", "find_experts"]
GATEWAY_ENTRY = REPO_ROOT / "apps" / "mcp-server" / "dist" / "index.js"


#: Gateway settings a retrieval study may vary, passed through from the parent
#: environment when set. ``EKG_FETCH_PREVIEW_CHARS`` sets how much document body a
#: ``fetch`` without a ``section`` returns — the lever between one expensive
#: unanchored preview and several cheap anchored section fetches.
#: ``EKG_SEARCH_PASSAGES`` is the other side of that lever: how many top search
#: results carry their cited passage in full, so an answer needs no fetch at all.
PASSTHROUGH_ENV = ("EKG_FETCH_PREVIEW_CHARS", "EKG_SEARCH_PASSAGES")


def gateway_env(db_path: Path) -> dict[str, str]:
    env = {
        "EKG_DB_PATH": str(db_path),
        "EKG_TRANSPORT": "stdio",
        "EKG_DISABLE_OCR": "1",
        "EKG_DB_MIGRATE": "0",
        "PATH": os.environ.get("PATH", ""),
    }
    for name in PASSTHROUGH_ENV:
        if os.environ.get(name):
            env[name] = os.environ[name]
    return env


def doc_aliases(manifest, db_path: Path | None = None) -> dict[str, str]:
    """Names a model may cite → manifest document id, for the citation scorer.

    A document has as many names as there are ways to meet it. The gateway shows
    an entity id (``ingest:e3673a7430de``) and a title that is the file stem
    (``chp0200-092923-a11y``); the RAG context shows the manifest id
    (``hdm-chp0200``); a model working from the documents themselves writes what
    is printed on them ("2025 Standard Specifications", "HDM Chapter 620"). Every
    one of those identifies exactly one document, so every one of them maps here,
    and the citation metric stays comparable across conditions.

    A name that identifies more than one document is dropped rather than pointed
    at either of them: "Standard Specifications" without an edition is two
    documents, and scoring it right would be scoring a coin flip. That is why a
    bare "HDM" never resolves — 38 chapters answer to it.
    """
    collisions: set[str] = set()
    aliases: dict[str, str] = {}

    def add(name: str, doc_id: str) -> None:
        key = normalize_doc_token(name)
        if not key or key in collisions:
            return
        if aliases.setdefault(key, doc_id) != doc_id:
            del aliases[key]
            collisions.add(key)

    stem_to_id: dict[str, str] = {}
    for doc in manifest.documents:
        stem = Path(doc.file).stem
        stem_to_id[stem.lower()] = doc.id
        add(doc.id, doc.id)
        add(stem, doc.id)
        # The same stem as a human would retype it, without the accessibility or
        # locked-PDF suffix and without the edition year Caltrans prefixes.
        add(re.sub(r"[-_](a11y|locked)$", "", stem), doc.id)
        add(re.sub(r"^\d{4}[-_]", "", stem), doc.id)
        add(re.sub(r"^\d{4}[-_]|[-_](a11y|locked)$", "", stem), doc.id)
        # The title, and the title with its trailing edition moved to the front —
        # "Standard Specifications, 2025 edition" is cited as "2025 Standard
        # Specifications" far more often than as its own title.
        add(doc.title, doc.id)
        edition = re.match(r"(?P<name>.+?),\s*(?P<year>\d{4})\s+edition\b", doc.title)
        if edition:
            add(f"{edition.group('year')} {edition.group('name')}", doc.id)
        chapter = re.match(r"hdm-chp(\d+)$", doc.id)
        if chapter:
            number = int(chapter.group(1))
            for form in (f"hdm chapter {number}", f"chapter {number}", f"hdm {number}", f"chp{chapter.group(1)}"):
                add(form, doc.id)

    if db_path is not None and db_path.exists():
        import sqlite3

        con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        try:
            rows = con.execute("select id, title from entities where type='document'").fetchall()
        finally:
            con.close()
        for entity_id, title in rows:
            doc_id = stem_to_id.get((title or "").lower())
            if doc_id:
                add(entity_id, doc_id)
                add(entity_id.rsplit(":", 1)[-1], doc_id)
    return aliases


def ekg_tool_source(db_path: Path, tools: list[str] | None = None):
    """Inspect ToolSource for the gateway; imported lazily so other conditions need no MCP."""
    from inspect_ai.tool import mcp_server_stdio, mcp_tools

    if not GATEWAY_ENTRY.exists():
        raise FileNotFoundError(f"gateway not built: {GATEWAY_ENTRY} (run `npm run build` at the repo root)")
    if not db_path.exists():
        raise FileNotFoundError(f"snapshot database not found: {db_path} (run scripts/build-ekg-snapshot.sh)")
    server = mcp_server_stdio(command="node", args=[str(GATEWAY_ENTRY)], env=gateway_env(db_path))
    return mcp_tools(server, tools=tools or READ_TOOLS)
