"""OpenAI Codex CLI (``codex exec``) as an Inspect model provider.

    --model codex/gpt-5.6-sol

Why: the benchmark can then run on the user's ChatGPT login (``codex login``) with
Inspect logs, the same way ``claudecode/`` runs on the Claude subscription. Each
``generate()`` spawns ``codex exec --json`` headless in an empty working directory,
reads the JSONL event stream back, and records every tool the agent used.

Isolation: the CLI runs with its own ``CODEX_HOME`` (a minimal config.toml written by
this module: no plugins, no memories, no multi-agent, read-only sandbox, approvals
off) that only borrows ``auth.json`` from the user's real ``~/.codex`` via a symlink.
The harness system prompt is delivered as the working directory's ``AGENTS.md``,
which Codex loads as developer instructions.

Conditions:
  closed_book / rag  - plain generation with ``features.shell_tool = false`` and
                       ``web_search = "disabled"``, so the model can neither read the corpus
                       from disk nor consult OpenAI's web index; every tool item Codex still
                       reports (e.g. ``list_mcp_resources``) is recorded so runs can be audited.
  ekg                - the EKG MCP gateway over the pinned snapshot is registered in
                       the per-run config; Codex runs the tool loop itself.

Env knobs: CALTRANS_CODEX_BIN, CALTRANS_EKG_DB, CODEX_AUTH_HOME (default ~/.codex).
Model args (``-M``): ekg_db=<path>, max_connections=<n>, reasoning_effort=<low|medium|high>.
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

DEFAULT_SNAPSHOT = SNAPSHOT_DIR / "ekg-caltrans.db"
_USAGE_CAP = re.compile(r"usage limit|purchase more credits", re.I)
_RETRYABLE = re.compile(
    r"rate.?limit|usage limit|overloaded|too many requests|\b429\b|\b5\d\d\b|try again|temporarily|quota", re.I
)


def find_codex_binary() -> str:
    override = os.environ.get("CALTRANS_CODEX_BIN")
    if override:
        return override
    on_path = shutil.which("codex")
    if on_path:
        return on_path
    raise FileNotFoundError("no Codex CLI: set CALTRANS_CODEX_BIN or `npm i -g @openai/codex`")


def _split_messages(input: list[ChatMessage]) -> tuple[str, str]:
    system = "\n\n".join(m.text for m in input if isinstance(m, ChatMessageSystem))
    rest = [m for m in input if not isinstance(m, ChatMessageSystem)]
    if len(rest) == 1:
        return system, rest[0].text
    return system, "\n\n".join(f"[{m.role}]\n{m.text}" for m in rest)


def config_toml(model: str, reasoning_effort: str, ekg_db: Path | None) -> str:
    """Minimal, hermetic Codex config for one run; the EKG gateway only when asked."""
    lines = [
        f'model = "{model}"',
        f'model_reasoning_effort = "{reasoning_effort}"',
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',  # default "cached" is an OpenAI-maintained web index: closed book must not see it
        "",
        "[features]",
        # Every feature that hands the model a tool or a side channel is off: the two
        # command tools, ChatGPT connectors ("apps"), the plugin marketplace that a fresh
        # CODEX_HOME otherwise downloads on first run, browsers, skills, hooks.
        "shell_tool = false",
        "unified_exec = false",
        "apps = false",
        "plugins = false",
        "remote_plugin = false",
        "plugin_sharing = false",
        "browser_use = false",
        "browser_use_external = false",
        "browser_use_full_cdp_access = false",
        "in_app_browser = false",
        "computer_use = false",
        "image_generation = false",
        "code_mode_host = false",
        "hooks = false",
        "goals = false",
        "skill_search = false",
        "skill_mcp_dependency_install = false",
        "workspace_dependencies = false",
        "tool_suggest = false",
        "multi_agent = false",
        "memories = false",
        "js_repl = false",
        "",
        "[tools]",
        "view_image = false",
    ]
    if ekg_db is not None:
        env = gateway_env(ekg_db)
        env_toml = ", ".join(f'{k} = "{v}"' for k, v in env.items())
        lines += [
            "",
            "[mcp_servers.ekg]",
            'command = "node"',
            f'args = ["{GATEWAY_ENTRY}"]',
            f"env = {{ {env_toml} }}",
            f"enabled_tools = {json.dumps(READ_TOOLS)}",
        ]
    return "\n".join(lines) + "\n"


def parse_events(lines: list[str]) -> dict[str, Any]:
    """Fold a ``codex exec --json`` JSONL stream into the pieces the provider needs."""
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    usage: dict[str, Any] = {}
    thread_id: str | None = None
    error: str | None = None
    n = 0
    for line in lines:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        n += 1
        kind = e.get("type")
        if kind == "thread.started":
            thread_id = e.get("thread_id")
        elif kind == "turn.completed":
            usage = e.get("usage") or {}
        elif kind in ("turn.failed", "error"):
            error = json.dumps(e.get("error") or e.get("message") or e)[:800]
        elif kind == "item.completed":
            item = e.get("item") or {}
            itype = item.get("type")
            if itype == "agent_message":
                text_parts.append(item.get("text") or "")
            elif itype in ("command_execution", "mcp_tool_call", "web_search", "file_change"):
                # Keep every scalar field the CLI reports, so runs can be audited without
                # guessing the item schema; nested payloads are truncated.
                rec: dict[str, Any] = {"tool": itype}
                for k, v in item.items():
                    if k in ("id", "type", "tool"):  # "tool" is the item kind here; the MCP tool name goes in "name"
                        continue
                    rec[k] = v if isinstance(v, (str, int, float, bool)) or v is None else json.dumps(v)[:300]
                rec["name"] = item.get("tool") or item.get("name") or item.get("server") or item.get("command")
                tool_calls.append(rec)
    return {
        "text": "\n\n".join(p for p in text_parts if p),
        "tool_calls": tool_calls,
        "usage": usage,
        "thread_id": thread_id,
        "error": error,
        "n_events": n,
    }


class CodexError(RuntimeError):
    pass


@modelapi(name="codex")
class CodexAPI(ModelAPI):
    def __init__(self, model_name: str, base_url: str | None = None, api_key: str | None = None,
                 config: GenerateConfig | None = None, **model_args: Any) -> None:
        super().__init__(
            model_name=model_name, base_url=base_url, api_key=api_key, api_key_vars=[],
            config=config if config is not None else GenerateConfig(),
        )
        self.binary = find_codex_binary()
        self.ekg_db = Path(model_args.get("ekg_db") or os.environ.get("CALTRANS_EKG_DB") or DEFAULT_SNAPSHOT)
        self._max_connections = int(model_args.get("max_connections", 4))
        self.reasoning_effort = str(model_args.get("reasoning_effort", "low"))
        self.auth_home = Path(os.environ.get("CODEX_AUTH_HOME", Path.home() / ".codex"))
        self._homes: dict[bool, Path] = {}

    def max_connections(self) -> int:
        return self._max_connections

    def connection_key(self) -> str:
        return "codex"

    def should_retry(self, ex: Exception) -> bool:
        if not isinstance(ex, CodexError):
            return False
        # A plan usage cap ("You've hit your usage limit … try again at 11:02 PM") does not
        # clear within Inspect's backoff window; fail fast so a resume loop can sleep until
        # the stated reset and `eval-retry` the errored samples.
        if _USAGE_CAP.search(str(ex)):
            return False
        return bool(_RETRYABLE.search(str(ex)))

    def _home(self, with_ekg: bool) -> Path:
        """One hermetic CODEX_HOME per (run, condition); created lazily."""
        if with_ekg not in self._homes:
            if with_ekg:
                if not GATEWAY_ENTRY.exists():
                    raise FileNotFoundError(f"gateway not built: {GATEWAY_ENTRY}")
                if not self.ekg_db.exists():
                    raise FileNotFoundError(f"snapshot database not found: {self.ekg_db}")
            home = Path(tempfile.mkdtemp(prefix=f"codex-home-{'ekg' if with_ekg else 'plain'}-"))
            (home / "config.toml").write_text(
                config_toml(self.model_name, self.reasoning_effort, self.ekg_db if with_ekg else None)
            )
            auth = self.auth_home / "auth.json"
            if auth.exists():
                (home / "auth.json").symlink_to(auth)
            self._homes[with_ekg] = home
        return self._homes[with_ekg]

    async def generate(self, input: list[ChatMessage], tools: list[ToolInfo], tool_choice: ToolChoice,
                       config: GenerateConfig) -> ModelOutput | tuple[ModelOutput | Exception, ModelCall]:
        system, prompt = _split_messages(input)
        names = [t.name for t in tools]
        unknown = sorted(set(names) - set(READ_TOOLS))
        if unknown:
            raise CodexError(f"codex provider only knows the EKG read tools; task offered {unknown}")
        with_ekg = bool(names)
        home = self._home(with_ekg)

        t0 = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="codex-cwd-") as cwd:
            if system:
                Path(cwd, "AGENTS.md").write_text(system + "\n")
            cmd = [self.binary, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "-C", cwd,
                   "-m", self.model_name, prompt]
            env = {k: v for k, v in os.environ.items() if not k.startswith("CODEX_")}
            env["CODEX_HOME"] = str(home)
            proc = await asyncio.create_subprocess_exec(
                *cmd, cwd=cwd, env=env,
                stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await proc.communicate()
        elapsed = time.monotonic() - t0

        parsed = parse_events(out.decode(errors="replace").splitlines())
        stderr = err.decode(errors="replace")
        request = {"cmd": [c if len(c) < 200 else c[:200] + "…" for c in cmd], "system": system, "prompt": prompt,
                   "codex_home": str(home)}
        response = {**{k: v for k, v in parsed.items() if k != "text"}, "stderr": stderr[-2000:]}
        call = ModelCall.create(request=request, response=response, time=elapsed)

        if proc.returncode != 0 or parsed["error"] or not parsed["text"]:
            msg = parsed["error"] or stderr.strip()[-800:] or f"codex exited {proc.returncode} with no message"
            return CodexError(msg), call

        usage = parsed["usage"]
        output = ModelOutput.from_content(model=self.model_name, content=parsed["text"], stop_reason="stop")
        output.usage = ModelUsage(
            input_tokens=int(usage.get("input_tokens", 0)), output_tokens=int(usage.get("output_tokens", 0)),
            total_tokens=int(usage.get("input_tokens", 0)) + int(usage.get("output_tokens", 0)),
            input_tokens_cache_read=usage.get("cached_input_tokens"),
            input_tokens_cache_write=usage.get("cache_write_input_tokens"),
            reasoning_tokens=usage.get("reasoning_output_tokens"),
        )
        # Codex's built-in resource listings are inert (they only enumerate configured servers).
        allowed = {("mcp_tool_call", "list_mcp_resources"), ("mcp_tool_call", "list_mcp_resource_templates")}
        if with_ekg:
            allowed |= {("mcp_tool_call", n) for n in READ_TOOLS}
        foreign = [t for t in parsed["tool_calls"] if (t["tool"], t.get("name")) not in allowed]
        output.metadata = {"tool_calls": parsed["tool_calls"], "thread_id": parsed["thread_id"],
                           "shell_calls": sum(1 for t in parsed["tool_calls"] if t["tool"] == "command_execution"),
                           "mcp_calls": sum(1 for t in parsed["tool_calls"] if t["tool"] == "mcp_tool_call"),
                           # Anything outside the condition's tool budget (web search, connectors,
                           # commands) marks the sample as contaminated for the audit.
                           "foreign_tools": [(t["tool"], t.get("name")) for t in foreign]}
        return output, call
