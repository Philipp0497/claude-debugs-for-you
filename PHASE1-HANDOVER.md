# Phase 1 Handover — Frame/Thread Resolution Fix

**Status:** implemented, reviewed, type-checks, lints, builds clean. Ready to test on a real STM32 + ThreadX target.
**Adversarial review:** done. 4 must-fix items found (all in the new resolution code, all silent wrong-thread/stale-frame defects) and **all fixed**:

- Don't trust `activeStackItem` once the tracker knows the session resumed (was returning a previous stop's stale frame).
- Only honor a focused frame if it's on the authoritative stopped thread (was letting the UI hint override the `stopped` event during an A→B re-stop race).
- Refuse to guess on a multi-thread target when nothing resolves a thread (was silently picking `threads[0]`, often the idle thread) — now returns a clear error.
- Made the `SessionStateTracker` a mandatory, registered dependency of `DebugServer`.

**Relay bug (separate, also fixed):** the evaluate step switched from `context: 'repl'` → `context: 'watch'`. Verified against cortex-debug source that `repl` routes the value to the Debug Console (`OutputEvent`) and returns a valueless node in `response.result`, *and* ignores `frameId`; `watch` returns the value and is frame-pinned. Use **bare** expressions now (not `p/x …`/`info registers`). See the test section.

> If you already pressed F5 before this update, reload the Extension Development Host window (Ctrl/Cmd+R in it) to pick up the rebuilt `out/`.

---

## What changed

The inspection path no longer guesses the thread. A new live session-state model captures the *actual* stopped thread from the DAP `stopped` event and routes everything through the correct top frame.

- **New:** [src/session-state.ts](src/session-state.ts) — `SessionStateTracker`.
  - Registers a `DebugAdapterTracker` for **all** debug types (`'*'`, stays generic) + session lifecycle listeners.
  - Captures `stopped` / `continued` / `terminated` events → tracks `isStopped`, `stoppedThreadId`, `reason`.
  - `resolveActiveFrame()` — ordered, never-hardcoded resolution: (1) stopped thread from the event → (2) `vscode.debug.activeStackItem` (follows *your* focused frame in the shared session) → (3) last-resort `threads` query → (4) top frame via `stackTrace`.
- **Fixed** in [src/debug-server.ts](src/debug-server.ts):
  - `evaluate` step — **deleted the hardcoded `threadId: 1`** ([was line 493](src/debug-server.ts)); now uses `resolveActiveFrame()`.
  - `continue` step — drives the actually-stopped thread, not `threads[0]`.
  - `handleLaunch` breakpoint check — resolves the stopped thread, tolerant of "not stopped yet".
- **Wired** in [src/extension.ts](src/extension.ts): tracker created and registered *before* the server so the first `stopped` is rarely missed.

No cortex-specific code in Phase 1 — the fix is generic (it also fixes any multi-thread adapter, e.g. the Unity case).

---

## Load the dev build into VS Code

This build is **not** installed as a `.vsix` yet — run it from source via the Extension Development Host:

1. Open **this repo** (`/home/philipprpe/dev/claude-debugs-for-you`) in VS Code.
2. Press **F5** (the "Run Extension" launch config). A second VS Code window opens with the patched extension loaded.
   - Already built (`out/` + `mcp/build/index.js` are current). If you edit source, rebuild with `npm run compile`.
3. In that **second window**, open your **firmware project** (the one with the `cortex-debug` `launch.json`).
4. Confirm the **"✓ Claude Debugs For You"** item in the status bar (check = MCP server running on port 4711).

---

## Fastest validation — curl, no MCP client needed

This hits the exact Phase 1 code path directly, isolating the fix from any client variability.

> **Use BARE expressions — not GDB CLI.** The evaluate step now uses cortex-debug's `watch` context (see the relay-bug note below), which evaluates a value and is frame-pinned. `p/x …`, `info registers`, `x/…`, `monitor …` are **not** valid here (they move to the Phase 4 `gdb_exec` tool). For hex, append a `,x` suffix.

1. In the firmware window, start your cortex-debug session and **stop at a breakpoint inside a ThreadX thread**.
2. From a terminal:

```bash
# CONTROL CANARY FIRST — a constant, frame-independent. Proves the value relay works.
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"debug","arguments":{"steps":[
        {"type":"evaluate","file":"x","expression":"0xdeadbeef"}]}}'

# Then the real test (at bp app_threadx.c:204): which thread + locals/registers
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"debug","arguments":{"steps":[
        {"type":"evaluate","file":"x","expression":"huart"},
        {"type":"evaluate","file":"x","expression":"&huart7"},
        {"type":"evaluate","file":"x","expression":"&huart8"},
        {"type":"evaluate","file":"x","expression":"$pc"},
        {"type":"evaluate","file":"x","expression":"$sp"}]}}'
```

(`"file"` is required by the tool schema but unused by `evaluate` — any string works.)

### How to read the results

- **Control `0xdeadbeef` → `3735928559`** (decimal) = **relay is fixed**, value path works. Judge the rest on value match.
  - If it instead returns an `^done`/JSON blob or empty → the relay is *not* fixed (wrong build flashed / dev-host not reloaded). Tell me.
- **Real test — pass criteria (the Phase 1 gate):** `huart` equals either `&huart7` or `&huart8`, and that matches **whichever thread VS Code's Call Stack shows as stopped** (`mb-uart7` ⇒ `&huart7`, `mb-uart8` ⇒ `&huart8`). `$pc`/`$sp`/`huart` reflect the **stopped** thread's frame.
  - Constant works **but** `huart` matches the *wrong* uart / `$pc` is from the idle/scheduler context ⇒ relay fixed, **thread resolution wrong** → that's the Phase 1 bug, send me the output.

Before this fix, all of these returned a valueless blob (relay bug) **and** the wrong thread (`threadId:1`) under ThreadX.

---

## Full integration — connect Claude Code

In your **firmware repo** (project scope so it's committable):

```bash
# In the firmware-window VS Code: run the command "Claude Debugs For You: Show All Commands"
#   → "Copy stdio path"  (gives the exact mcp-debug.js path)

claude mcp add --transport stdio debug --scope project -- node "<paste the copied stdio path>"
```

- Stdio servers load at session start → **restart the Claude Code session**, then run `/mcp` to confirm `debug` is connected.
- The extension must be running (status-bar check) — the stdio server proxies to its HTTP server on port 4711.
- Then, while stopped at a breakpoint, ask Claude to evaluate bare expressions (locals, `&symbol`, `$pc`, `$sp`) and compare to the panels.

> SSE (`http://localhost:4711/sse`) also works but Claude Code is moving to streamable-HTTP — that endpoint is **Phase 5**. Use stdio for now.

---

## Known nuances to watch (runtime-only, can't verify off-hardware)

1. **Does the `stopped` event carry `threadId`?** Expected yes (cortex-debug reports the active ThreadX thread). If it's ever omitted, resolution falls back to `activeStackItem` then the first listed thread — still not `1`, but tell me if eval picks the wrong thread and I'll add a trace.
2. **`evaluate` now uses `context: 'watch'`** (changed from `repl`). Verified against cortex-debug source: `repl` emits the value to the Debug Console as an `OutputEvent` and returns a *valueless* serialized node in `response.result` (the "relay bug" you flagged) **and** ignores `frameId`. `watch` returns the value in `response.result` and is **frame-pinned** to the resolved RTOS thread/frame. Cost: GDB CLI verbs (`p/x`, `info registers`, `x/…`, `monitor`) aren't valid here — they belong to the Phase 4 `gdb_exec` tool (repl + OutputEvent capture).
3. **RTOS awareness must be on** in your `launch.json` (OpenOCD `-rtos` / J-Link RTOS plugin) with ThreadX kernel symbols in the ELF, or only one thread appears.

## Explicitly deferred (not bugs)

- `get_debug_state` + observing your manual UI actions → **Phase 2**.
- `list_threads` / `select_thread` / `get_registers` / `get_variables` / `gdb_exec` / watchpoints / per-thread stacks → **Phase 4–5**.
- Streamable-HTTP MCP endpoint → **Phase 5**.

---

## If you hit something

Report: what you evaluated, what the tool returned, and what the VS Code panel showed for the same thread/frame. That, plus whether the `stopped` event had a `threadId`, pinpoints it fast.
