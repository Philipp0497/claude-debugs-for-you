# Claude Debugs For You — Cortex / ThreadX edition

> A fork of [jasonjmcghee/claude-debugs-for-you](https://github.com/jasonjmcghee/claude-debugs-for-you)
> that turns it into a **shared, single-session pair-debugger** for **STM32 / Cortex-M** firmware
> (cortex-debug + OpenOCD/J-Link + arm-none-eabi-gdb), with first-class **Azure RTOS / ThreadX** support.

An [MCP](https://modelcontextprotocol.io) server + VS Code extension that lets an LLM (Claude, or any
MCP client) **drive the same live debug session you're looking at**. The human steers from the VS Code
UI and Claude steers via MCP tools on the **one** `vscode.debug.activeDebugSession` — no second GDB
connection, no re-attach, no lost context. Hand the wheel back and forth freely.

The original upstream extension is language-agnostic (any DAP debugger with a valid `launch.json`); that
still works. **This fork adds** the shared-session awareness and a deep Cortex-M / ThreadX forensics
toolset on top.

---

## What's different in this fork

- **Shared single session.** Everything runs on `vscode.debug.activeDebugSession`. Claude's breakpoints
  show up in your gutter; Claude's stepping moves your highlighted line; your manual steps/breakpoints
  show up in Claude's `get_debug_state` — without telling it.
- **Correct multi-thread (RTOS) frame/thread resolution.** The inspection path resolves the *actual*
  stopped thread from the DAP `stopped` event instead of assuming thread 1 — the prerequisite for
  anything useful on a ThreadX target.
- **Relay-correct value reads.** Uses DAP `context:'watch'` (frame-pinned) for values; a separate
  `gdb_exec` captures raw GDB CLI output from the debug console.
- **A 20-tool surface** (below) spanning session control, inspection, Cortex-M forensics, ThreadX
  introspection, and SVD peripheral decode.
- **Three transports**, including **streamable-HTTP** (`/mcp`) for Claude Code, alongside stdio + SSE.

Validated end-to-end on a **Nucleo-F746ZG** (Cortex-M7F) running ThreadX + NetX Duo.

---

## Tool surface

All tools operate on the shared session and are meant to be re-checked after the human may have acted
(`get_debug_state`). Visible actions (breakpoints, stepping) use native VS Code APIs; invisible reads use
DAP `customRequest` and are narrated in chat.

### Session & flow

- `start_session` / `restart_session {config?, runToMain?}` — Claude (re)launches the cortex-debug
  session itself and recovers a dead/faulted one; `runToMain:true` lands at `main()`.
- `debug { steps: [...] }` — batch of: `setBreakpoint`, `removeBreakpoint`, `launch`, `continue`,
  `stepOver`, `stepInto`, `stepOut`, `pause`, `evaluate` (bare expression, frame-pinned `watch`).
- `get_debug_state` — running/stopped, stop reason, stopped thread, current location, all threads, all
  breakpoints, and a log of recent actions tagged `human` / `claude`.

### Inspection

- `get_stack {threadId?}` · `get_variables {threadId?, scope?}` · `get_registers {threadId?}`
- `read_memory {address, count?}` · `write_memory {address, data}` (guarded)
- `read_special_reg {name?, threadId?}` — `$msp/$psp/$control/$primask/$basepri/$faultmask`
  (+ `$msplim/$psplim` on ARMv8-M). CPU-global regs are nulled for a non-current thread.

### Threads

- `list_threads` · `select_thread {threadId}`

### Cortex-M forensics

- `gdb_exec {command}` — raw GDB CLI (`info registers`, `x/16xw $sp`, `monitor reset halt`) with console
  output captured.
- `set_watchpoint {expression|expr, kind}` — hardware data watchpoint (`watch`/`rwatch`/`awatch`).
- `explain_fault` — **core-aware** fault decoder. CPUID auto-detect; decodes CFSR/HFSR/MMFAR/BFAR
  (+ `UFSR.STKOF` and SecureFault SFSR/SFAR on ARMv8-M); ARMv6-M / Cortex-M23 are HardFault-only. Recovers
  the **pre-fault** context (faulting PC/LR/xPSR + R0-R3/R12) from the stacked exception frame.

### ThreadX (Azure RTOS)

- `inspect_tcb {name?}` — per thread: state, priority, run-count, stack bounds, **saved SP**, and for
  non-running threads a **real top frame** decoded from the TCB saved context (bypasses the gdb-server's
  RTOS unwinder).
- `thread_stack_usage {name?}` — per-thread stack high-water via the `0xEFEFEFEF` fill scan.

### Peripherals

- `read_peripheral {path, maxRegisters?}` — decode a register's bitfields from the device SVD
  (`launch.json` `svdFile`). `"ETH.MACCR"` resolves by prefix/group; `"RCC"` gives a live overview.

### Workspace (from upstream)

- `listFiles` · `getFileContent`

---

## Getting started

This is currently run as a **development build** (not published to the Marketplace).

1. Clone and build (builds the bundled MCP server + the extension):

   ```bash
   npm install && npm run compile
   ```

2. Open this repo in VS Code and press **F5** ("Run Extension") → a second VS Code window opens with the
   extension loaded.
3. In that window, open your firmware project (with a `cortex-debug` `launch.json`; set `svdFile` for
   `read_peripheral`, and `-rtos ThreadX` in your OpenOCD config for ThreadX threads).
4. Confirm the **"✓ Claude Debugs For You"** status-bar item (the MCP server is up; default port `4711`).
   Click it for commands (start/stop, set port, copy transport address).

### Connect your MCP client

The status-bar menu has **Copy MCP HTTP address**, **Copy stdio path**, and **Copy SSE address**.

**Claude Code (streamable-HTTP, recommended)** — run in your firmware repo:

```bash
claude mcp add --transport http debug http://localhost:4711/mcp --scope project
```

Then `/mcp` to confirm `debug` is connected with the tools available.

**stdio** (Claude Desktop, Continue, …):

```jsonc
{ "mcpServers": { "debug": { "command": "node", "args": ["/path/from/Copy stdio path"] } } }
```

**SSE**: use `http://localhost:4711/sse` (legacy; HTTP preferred).

The extension must be running (status-bar ✓) for any transport — stdio/SSE proxy to its HTTP server.

---

## Quick smoke test (no MCP client needed)

While stopped at a breakpoint, the legacy `/tcp` endpoint exercises a tool directly:

```bash
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"get_debug_state","arguments":{}}' | python3 -m json.tool
```

---

## Developing

- `npm run compile` rebuilds the bundled MCP server (`mcp/`) and the extension (`out/`).
- Reload the Extension Development Host (Ctrl/Cmd+R) to pick up a rebuild.
- Dependencies of note: `@modelcontextprotocol/sdk` (pinned alongside `zod` v3 — they must share one zod),
  `fast-xml-parser` (SVD parsing).

### Package

```bash
npx @vscode/vsce package
```

---

## Notes & caveats

- **Local-only server**: the HTTP server binds to `127.0.0.1` and rejects requests with a non-local
  `Host`/`Origin` header (DNS-rebinding / browser drive-by protection). These tools can flash/halt
  hardware and read workspace files — do not re-expose the port on a network interface.
- **Port override**: the stdio proxy honors `CLAUDE_DEBUGS_PORT`, and finds the extension's
  globalStorage under VS Code, Insiders, VSCodium, and Code - OSS.
- **Generic targets**: the session/flow/inspection tools are debugger-agnostic; the forensics, ThreadX,
  and peripheral tools are Cortex-M / ThreadX specific and degrade with a clear note elsewhere.
- **`runToEntryPoint:"main"`**: with this set, cortex-debug auto-drives reset→main; the tools account for
  the transient reset halt.
- **Cross-core `explain_fault`**: validated on Cortex-M7; the ARMv6-M (M0+) and ARMv8-M (M33) paths are
  implemented but await testing on that silicon.

## Credit

Forked from **[jasonjmcghee/claude-debugs-for-you](https://github.com/jasonjmcghee/claude-debugs-for-you)**
by Jason McGhee. The upstream project provides the MCP-server-in-extension architecture, the
files/get-content/`debug` tools, and the multi-window handoff. This fork adds the shared-session
awareness, the Cortex-M / ThreadX forensics toolset, and the streamable-HTTP transport.
