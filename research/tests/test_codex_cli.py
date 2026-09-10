import json

from caltrans_bench.codex_cli import config_toml, parse_events


def test_parse_events_folds_text_tools_and_usage():
    lines = [
        json.dumps({"type": "thread.started", "thread_id": "t1"}),
        json.dumps({"type": "turn.started"}),
        json.dumps({"type": "item.completed", "item": {
            "id": "i0", "type": "mcp_tool_call", "server": "ekg", "tool": "search",
            "arguments": {"query": "x"}, "status": "completed"}}),
        json.dumps({"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": "ls",
                                                        "status": "completed"}}),
        json.dumps({"type": "item.completed", "item": {
            "id": "i2", "type": "agent_message", "text": "ANSWER: 1\nCITE: none"}}),
        "not json",
        json.dumps({"type": "turn.completed", "usage": {"input_tokens": 10, "output_tokens": 2}}),
    ]
    p = parse_events(lines)
    assert p["text"] == "ANSWER: 1\nCITE: none"
    assert [t["tool"] for t in p["tool_calls"]] == ["mcp_tool_call", "command_execution"]
    assert p["tool_calls"][0]["name"] == "search" and p["tool_calls"][1]["name"] == "ls"
    assert p["usage"]["input_tokens"] == 10 and p["thread_id"] == "t1" and p["error"] is None


def test_config_toml_is_hermetic_and_adds_gateway_only_for_ekg(tmp_path):
    plain = config_toml("gpt-5.6-sol", "low", None)
    assert "memories = false" in plain and "shell_tool = false" in plain and 'web_search = "disabled"' in plain
    assert "mcp_servers" not in plain
    for flag in ("unified_exec", "apps", "plugins", "remote_plugin", "browser_use", "computer_use"):
        assert f"{flag} = false" in plain
    db = tmp_path / "snap.db"
    ekg = config_toml("gpt-5.6-sol", "low", db)
    assert "[mcp_servers.ekg]" in ekg and str(db) in ekg and '"search"' in ekg
