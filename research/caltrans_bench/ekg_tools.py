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


def gateway_env(db_path: Path) -> dict[str, str]:
    env = {
        "EKG_DB_PATH": str(db_path),
        "EKG_TRANSPORT": "stdio",
        "EKG_DISABLE_OCR": "1",
        "EKG_DB_MIGRATE": "0",
        "PATH": os.environ.get("PATH", ""),
    }
    return env


def ekg_tool_source(db_path: Path, tools: list[str] | None = None):
    """Inspect ToolSource for the gateway; imported lazily so other conditions need no MCP."""
    from inspect_ai.tool import mcp_server_stdio, mcp_tools

    if not GATEWAY_ENTRY.exists():
        raise FileNotFoundError(f"gateway not built: {GATEWAY_ENTRY} (run `npm run build` at the repo root)")
    if not db_path.exists():
        raise FileNotFoundError(f"snapshot database not found: {db_path} (run scripts/build-ekg-snapshot.sh)")
    server = mcp_server_stdio(command="node", args=[str(GATEWAY_ENTRY)], env=gateway_env(db_path))
    return mcp_tools(server, tools=tools or READ_TOOLS)
