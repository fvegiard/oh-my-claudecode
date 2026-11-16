---
name: omc-tools
description: "Reach OMC's MCP tools (state_*, notepad_*, project_memory_*, wiki_*, lsp_*, ast_grep_*, python_repl, trace_*, shared_memory_*) through a shell bridge when they are not attached as native tools — the normal case in claude.ai / Cowork cloud sessions. Use whenever a skill or agent names an `mcp__plugin_oh-my-claudecode_t__*` tool that is missing."
aliases: []
---

# OMC tools over the shell bridge

Cowork and claude.ai cloud sessions start with `CLAUDE_CODE_SKIP_PLUGIN_MCP_SERVERS=1`, so the plugin's MCP server `t` is never attached. The server itself ships and works. This skill calls it through `scripts/cowork-mcp.cjs`.

## Steps

1. Check whether the tool exists natively (a `mcp__plugin_oh-my-claudecode_t__<name>` tool, loaded or found by ToolSearch). If it does, use it and stop here.
2. Otherwise set the bridge path once. It sits two levels above this skill's base directory:

   ```bash
   OMC_MCP="<this skill's base directory>/../../scripts/cowork-mcp.cjs"
   ```

3. Run from the project directory whose `.omc/` state you mean, because the server resolves state from its working directory:

   ```bash
   node "$OMC_MCP" list                      # tool names and summaries
   node "$OMC_MCP" schema notepad_write_working   # exact arguments of one tool
   node "$OMC_MCP" call state_list_active '{}'
   node "$OMC_MCP" call notepad_write_working '{"content":"…"}'
   echo '{"pattern":"console.log($A)","language":"typescript"}' | node "$OMC_MCP" call ast_grep_search -
   ```

4. Read `schema <tool>` before the first call to a tool you have not used in this session; do not guess argument names.

## What to expect

- Exit code is 1 and the text goes to stdout when the tool reports an error.
- One server process stays alive per working directory, so `python_repl` variables and warm LSP servers survive between calls. It stops after 30 idle minutes, and cloud sessions may stop it sooner between turns; anything written to `.omc/` persists regardless.
- `node "$OMC_MCP" status` shows the running daemon; `stop` ends it.
- `lsp_*` tools need the language server installed in the session (`lsp_servers` lists what is missing and how to install it).
- When another skill names `mcp__plugin_oh-my-claudecode_t__<name>`, call `<name>` through the bridge with the same arguments.
