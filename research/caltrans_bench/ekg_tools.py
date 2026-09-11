"""EKG's MCP gateway as an Inspect tool source (the "EKG tools" condition).

The gateway is the TypeScript server in ``apps/mcp-server`` run over stdio
against a pinned snapshot database (``scripts/build-ekg-snapshot.sh``). Only
the read tools are exposed to the model; write tools stay out of the study.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import REPO_ROOT

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

    The gateway exposes each document as an entity whose title is the file stem
    (``chp0200-092923-a11y``) and whose id is ``ingest:<hash>``; it never shows the
    manifest id (``hdm-chp0200``). The RAG context does show manifest ids. Mapping both
    forms onto the manifest id keeps the citation metric comparable across conditions.
    """
    stem_to_id = {Path(d.file).stem.lower(): d.id for d in manifest.documents}
    aliases: dict[str, str] = dict(stem_to_id)
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
                aliases[entity_id.lower()] = doc_id
                aliases[entity_id.lower().rsplit(":", 1)[-1]] = doc_id
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
