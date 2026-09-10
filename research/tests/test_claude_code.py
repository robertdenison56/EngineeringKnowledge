"""Pure parts of the claudecode provider (no CLI spawned)."""
import json

import pytest
from inspect_ai.model import ChatMessageAssistant, ChatMessageSystem, ChatMessageUser
from inspect_ai.tool import ToolInfo, ToolParams

from caltrans_bench import claude_code as cc


def test_split_messages_single_turn():
    system, prompt = cc._split_messages([ChatMessageSystem(content="SYS"), ChatMessageUser(content="Q?")])
    assert system == "SYS" and prompt == "Q?"


def test_split_messages_flattens_history():
    system, prompt = cc._split_messages(
        [
            ChatMessageSystem(content="SYS"),
            ChatMessageUser(content="a"),
            ChatMessageAssistant(content="b"),
            ChatMessageUser(content="c"),
        ]
    )
    assert system == "SYS"
    assert prompt == "[user]\na\n\n[assistant]\nb\n\n[user]\nc"


def test_child_env_strips_session_plumbing(monkeypatch):
    monkeypatch.setenv("CLAUDECODE", "1")
    monkeypatch.setenv("CLAUDE_CODE_SESSION_ID", "x")
    monkeypatch.setenv("CLAUDE_CODE_MESSAGING_TOKEN", "x")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "keep-me")  # a user-supplied long-lived token must survive
    env = cc._child_env()
    assert "CLAUDECODE" not in env and "CLAUDE_CODE_SESSION_ID" not in env and "CLAUDE_CODE_MESSAGING_TOKEN" not in env
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "keep-me" and "PATH" in env


def _api(tmp_path, monkeypatch):
    monkeypatch.setenv("CALTRANS_CLAUDE_BIN", "/bin/true")
    db = tmp_path / "snap.db"
    db.write_bytes(b"")
    return cc.ClaudeCodeAPI("sonnet", ekg_db=str(db), max_connections=2)


def test_mcp_config_none_without_tools(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    assert api._mcp_config([]) == (None, [])
    assert api.max_connections() == 2


def test_mcp_config_for_ekg_tools(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    monkeypatch.setattr(cc, "GATEWAY_ENTRY", tmp_path / "index.js")
    cc.GATEWAY_ENTRY.write_text("")
    tools = [ToolInfo(name=n, description="", parameters=ToolParams()) for n in ("search", "fetch")]
    cfg, allowed = api._mcp_config(tools)
    server = json.loads(cfg)["mcpServers"]["ekg"]
    assert server["command"] == "node" and server["env"]["EKG_DB_PATH"] == str(api.ekg_db)
    assert allowed == ["mcp__ekg__search", "mcp__ekg__fetch"]


def test_mcp_config_rejects_unknown_tools(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    with pytest.raises(cc.ClaudeCodeError):
        api._mcp_config([ToolInfo(name="bash", description="", parameters=ToolParams())])


def test_retry_only_on_capacity_errors(tmp_path, monkeypatch):
    api = _api(tmp_path, monkeypatch)
    assert api.should_retry(cc.ClaudeCodeError("claude error: Rate limit reached, try again"))
    assert not api.should_retry(cc.ClaudeCodeError("claude error: Not logged in · Please run /login"))
    assert not api.should_retry(RuntimeError("rate limit"))
