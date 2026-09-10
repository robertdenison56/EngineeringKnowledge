"""Claude Code (the CLI bundled with the Claude desktop app) as an Inspect model provider.

    --model claudecode/sonnet          # alias resolved by the CLI
    --model claudecode/claude-sonnet-5 # full model name

Why: the benchmark can then run on the user's Claude subscription (the desktop
app's login) instead of an Anthropic API key. Each ``generate()`` spawns the CLI
in headless print mode with the harness's own system prompt, no built-in tools,
no hooks/CLAUDE.md, and reads one ``stream-json`` transcript back.

Conditions:
  closed_book / rag  - plain text generation (``--tools ""``).
  ekg                - the CLI is given the EKG MCP gateway over the pinned
                       snapshot database and runs the tool loop itself; the
                       final text comes back as one assistant message and the
                       tool calls it made are recorded in the ModelCall.
                       (Inspect's own tool loop is bypassed on purpose: this is
                       "Claude + EKG MCP" exactly as the desktop app would run it.)

Auth: the CLI must be logged in once (``claude auth login``); this module never
touches credentials. ``--bare`` is deliberately NOT used because it restricts
auth to API keys.

Env knobs: CALTRANS_CLAUDE_BIN (path to the binary), CALTRANS_EKG_DB (snapshot).
Model args (``-M``): ekg_db=<path>, max_connections=<n>, max_turns=<n>.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import time
from pathlib import Path
from typing import Any

from inspect_ai.model import (
    ChatMessage,
    ChatMessageSystem,
    GenerateConfig,
    ModelAPI,
    ModelCall,
    ModelOutput,
    ModelUsage,
    modelapi,
)
from inspect_ai.tool import ToolChoice, ToolInfo

from . import SNAPSHOT_DIR
from .ekg_tools import GATEWAY_ENTRY, READ_TOOLS, gateway_env

DESKTOP_CLI_ROOT = Path.home() / "Library" / "Application Support" / "Claude" / "claude-code"
DEFAULT_SNAPSHOT = SNAPSHOT_DIR / "ekg-caltrans.db"
# Session/host plumbing the desktop app injects into *its* Claude Code processes.
# A child spawned with these set tries to attach to the parent session; strip them.
_STRIP_ENV_PREFIXES = ("CLAUDECODE", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_HOST_", "CLAUDE_CODE_CHILD",
                       "CLAUDE_CODE_MESSAGING", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SDK_HAS")
_RETRYABLE = re.compile(
    r"rate.?limit|usage limit|overloaded|too many requests|\b429\b|\b529\b|try again|temporarily", re.I
)


def find_claude_binary() -> str:
    """CALTRANS_CLAUDE_BIN, then `claude` on PATH, then the newest desktop-app bundle."""
    override = os.environ.get("CALTRANS_CLAUDE_BIN")
    if override:
        return override
    on_path = shutil.which("claude")
    if on_path:
        return on_path
    candidates = sorted(DESKTOP_CLI_ROOT.glob("*/claude.app/Contents/MacOS/claude"),
                        key=lambda p: [int(x) if x.isdigit() else x for x in p.parts[-5].split(".")])
    if candidates:
        return str(candidates[-1])
    raise FileNotFoundError(
        "no Claude Code binary: set CALTRANS_CLAUDE_BIN, install `claude`, or run the Claude desktop app once"
    )


def _child_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if not k.startswith(_STRIP_ENV_PREFIXES)}


def _split_messages(input: list[ChatMessage]) -> tuple[str, str]:
    """System prompt text and a single user prompt (multi-turn history is flattened)."""
    system = "\n\n".join(m.text for m in input if isinstance(m, ChatMessageSystem))
    rest = [m for m in input if not isinstance(m, ChatMessageSystem)]
    if len(rest) == 1:
        return system, rest[0].text
    return system, "\n\n".join(f"[{m.role}]\n{m.text}" for m in rest)


class ClaudeCodeError(RuntimeError):
    pass


@modelapi(name="claudecode")
class ClaudeCodeAPI(ModelAPI):
    def __init__(self, model_name: str, base_url: str | None = None, api_key: str | None = None,
                 config: GenerateConfig | None = None, **model_args: Any) -> None:
        super().__init__(
            model_name=model_name, base_url=base_url, api_key=api_key, api_key_vars=[],
            config=config if config is not None else GenerateConfig(),
        )
        self.binary = find_claude_binary()
        self.ekg_db = Path(model_args.get("ekg_db") or os.environ.get("CALTRANS_EKG_DB") or DEFAULT_SNAPSHOT)
        self._max_connections = int(model_args.get("max_connections", 4))
        self.max_turns = int(model_args.get("max_turns", 30))

    def max_connections(self) -> int:
        return self._max_connections

    def connection_key(self) -> str:
        return "claudecode"

    def should_retry(self, ex: Exception) -> bool:
        return isinstance(ex, ClaudeCodeError) and bool(_RETRYABLE.search(str(ex)))

    def _mcp_config(self, tools: list[ToolInfo]) -> tuple[str | None, list[str]]:
        """EKG gateway config when the task offers the EKG read tools; else none."""
        names = [t.name for t in tools]
        if not names:
            return None, []
        unknown = sorted(set(names) - set(READ_TOOLS))
        if unknown:
            raise ClaudeCodeError(f"claudecode provider only knows the EKG read tools; task offered {unknown}")
        if not GATEWAY_ENTRY.exists():
            raise FileNotFoundError(f"gateway not built: {GATEWAY_ENTRY}")
        if not self.ekg_db.exists():
            raise FileNotFoundError(f"snapshot database not found: {self.ekg_db}")
        server = {"command": "node", "args": [str(GATEWAY_ENTRY)], "env": gateway_env(self.ekg_db)}
        cfg = {"mcpServers": {"ekg": server}}
        return json.dumps(cfg), [f"mcp__ekg__{n}" for n in names]

    async def generate(self, input: list[ChatMessage], tools: list[ToolInfo], tool_choice: ToolChoice,
                       config: GenerateConfig) -> ModelOutput | tuple[ModelOutput | Exception, ModelCall]:
        system, prompt = _split_messages(input)
        mcp_json, allowed = self._mcp_config(tools)
        cmd = [self.binary, "-p", "--model", self.model_name, "--output-format", "stream-json", "--verbose",
               "--no-session-persistence", "--restricted", "--strict-mcp-config", "--tools", "",
               "--max-turns", str(self.max_turns if allowed else 1)]
        if system:
            cmd += ["--system-prompt", system]
        if mcp_json:
            cmd += ["--mcp-config", mcp_json, "--allowedTools", ",".join(allowed), "--permission-mode", "dontAsk"]
        if config.reasoning_effort:
            cmd += ["--effort", str(config.reasoning_effort)]

        t0 = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="claudecode-") as cwd:  # no CLAUDE.md, no project settings
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=cwd, env=_child_env(),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await proc.communicate(prompt.encode())
        elapsed = time.monotonic() - t0

        events = [json.loads(line) for line in out.decode(errors="replace").splitlines() if line.startswith("{")]
        result = next((e for e in events if e.get("type") == "result"), None)
        init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
        tool_calls = [{"tool": b.get("name"), "input": b.get("input")}
                      for e in events if e.get("type") == "assistant"
                      for b in (e.get("message") or {}).get("content", [])
                      if isinstance(b, dict) and b.get("type") == "tool_use"]
        request = {"cmd": [c if len(c) < 200 else c[:200] + "…" for c in cmd], "system": system, "prompt": prompt}
        response = {
            "result": result, "tool_calls": tool_calls, "n_events": len(events),
            "stderr": err.decode(errors="replace")[-2000:],
        }
        call = ModelCall.create(request=request, response=response, time=elapsed)

        if result is None or proc.returncode != 0:
            msg = err.decode(errors="replace").strip()[-800:] or out.decode(errors="replace").strip()[-800:]
            return ClaudeCodeError(f"claude exited {proc.returncode} with no result event: {msg}"), call
        if result.get("is_error"):
            return ClaudeCodeError(f"claude error: {result.get('result')}"), call

        text = result.get("result") or ""
        model_id = next(iter((result.get("modelUsage") or {}).keys()), None) or init.get("model") or self.model_name
        usage = result.get("usage") or {}
        output = ModelOutput.from_content(model=model_id, content=text,
                                          stop_reason="max_tokens" if result.get("subtype") == "error_max_turns"
                                          else "stop")
        output.usage = ModelUsage(
            input_tokens=int(usage.get("input_tokens", 0)), output_tokens=int(usage.get("output_tokens", 0)),
            total_tokens=int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0)),
            input_tokens_cache_write=usage.get("cache_creation_input_tokens"),
            input_tokens_cache_read=usage.get("cache_read_input_tokens"))
        output.metadata = {"num_turns": result.get("num_turns"), "total_cost_usd": result.get("total_cost_usd"),
                           "tool_calls": tool_calls, "cli_model": model_id}
        return output, call
