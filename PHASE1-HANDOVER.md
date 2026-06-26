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

- `list_threads` / `select_thread` / `get_registers` / `get_variables` / `gdb_exec` / watchpoints / per-thread stacks → **Phase 4–5**.
- Making Claude's actions visible via native VS Code APIs (gutter breakpoints, highlighted-line stepping) → **Phase 3**.
- Streamable-HTTP MCP endpoint → **Phase 5**.

---

## Phase 2 — Shared awareness (`get_debug_state`) — READY TO TEST

New `get_debug_state` MCP tool + a DebugAdapterTracker that watches the human's UI actions, so Claude can re-sync after the human drives manually. Reviewed by two agents; attribution hardened (object-identity for breakpoints, repl-only evaluate logging, log cleared when the session ends).

**Reload the dev host (Ctrl/Cmd+R)** to pick up the rebuilt `out/` + `mcp/build` first.

### What `get_debug_state` returns

`status` (stopped/running/no-session), `session`, `reason`, `stoppedThread` `{id,name}`, `location` `{file,line,function}` (live), `threads`, `breakpoints` (live from VS Code, 1-based lines), and `recentActions` — a log of recent flow-control, breakpoint, and console actions, each tagged `human` or `claude`.

### Test it (curl)

```bash
# Snapshot while stopped at a breakpoint
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"get_debug_state","arguments":{}}' | python3 -m json.tool
```

(Result is under `.data`.) Expect `status:"stopped"`, the correct `stoppedThread`/`location`, and your current breakpoints.

### The Phase 2 acceptance gate

1. Stop at a breakpoint. Take a `get_debug_state` snapshot.
2. **Now drive manually in the VS Code UI** (no MCP/Claude calls): press **Step Over (F10)** once, then **add a breakpoint** by clicking a gutter on another line.
3. Take another `get_debug_state`.

**Pass:** the second snapshot shows the **new `location`** (after the step), the **new breakpoint** in `breakpoints`, and `recentActions` containing a `step-over` and a `breakpoint-added` — both tagged **`source:"human"`** — even though Claude was never told. That's the handoff working: Claude can catch up on what you did.

---

## Phase 3 — Visible driving (Claude steps, you watch) — READY TO TEST

Claude's flow control now drives the **shared editor**: stepping uses VS Code's native `workbench.action.debug.*` commands, so the highlighted line moves in your editor exactly as if you'd clicked the toolbar. New `debug` step types: `stepOver`, `stepInto`, `stepOut`, `pause`. (Breakpoints were already native — they appear in your gutter — since Phase 1.) `continue` is unchanged (hardware-tested). The `file` field is now optional for steps/continue/evaluate (only `setBreakpoint`/`launch` need it).

Reviewed by two agents; fixes applied: step waiters drained on session end (no stall/cross-session wake), `pause`-when-already-stopped short-circuits, stop `reason` surfaced in the result, attribution TTL widened to 500ms.

**Reload the dev host (Ctrl/Cmd+R)** first.

### Test it (curl) — watch your editor while these run

```bash
# Stop at a breakpoint, then step — watch the highlighted line advance:
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"debug","arguments":{"steps":[{"type":"stepOver"}]}}'
# → "Stepped over → .../app_threadx.c:NNN (func) [step]"

curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"debug","arguments":{"steps":[{"type":"stepInto"}]}}'
```

### The Phase 3 acceptance gate

1. Stopped at a breakpoint, run a `stepOver` (or `stepInto`/`stepOut`) via curl. **Pass:** your editor's highlighted line advances, and the result reports the new `file:line`.
2. Have Claude set a breakpoint (the existing `setBreakpoint` step) — it appears in your gutter (already worked in Phase 1).
3. Optional: `continue` to resume, then `{"type":"pause"}` while running — the target halts and the highlight appears.

These complete **Definition of Done #2** — Claude's breakpoints show in your gutter and Claude's steps move your highlighted line. Stepping acts on the stopped/focused thread; if you've manually focused a *different* thread in the Call Stack, the step follows your focus (shared-session behavior).

---

## Phase 4 — Cortex-M/GDB forensics — READY TO TEST

Six new MCP tools for stack/register debugging on the shared session: `gdb_exec`, `read_special_reg`, `set_watchpoint`, `list_threads`, `select_thread`, `get_stack`. Designs verified against cortex-debug source; reviewed by three agents; fixes applied (attribution-in-queue, watchpoint success detection, stale-thread re-validation).

**Reload the dev host (Ctrl/Cmd+R)** first. If you use the **stdio MCP** connection, also **restart the Claude Code session** (`/mcp` to confirm the 6 new tools) — stdio tools load at session start. Curl/`/tcp` works immediately after the dev-host reload.

### Test it (curl) — stopped at a breakpoint

```bash
# Raw GDB CLI (output captured from the debug console):
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"gdb_exec","arguments":{"command":"info registers"}}'

# Special registers (hex). $psplim/$msplim read back null on the F746 (Cortex-M7,
# ARMv7-M) — that is CORRECT, not a bug; they exist only on the M33/STM32H5 (ARMv8-M).
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"read_special_reg","arguments":{}}'

# Enumerate ThreadX threads (each with its top frame):
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"list_threads","arguments":{}}'

# Pick a thread, then read ITS sp and walk ITS stack:
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"select_thread","arguments":{"threadId":<id from list_threads>}}'
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"read_special_reg","arguments":{"name":"sp"}}'
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"get_stack","arguments":{}}'

# Write watchpoint on a global (then `continue` and watch it trip, reason "data breakpoint"):
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"set_watchpoint","arguments":{"expression":"<a global var>","kind":"write"}}'
```

### The Phase 4 acceptance gate (DoD #4)

Confirm, all on the live session: **read the SP of a chosen ThreadX thread** (`select_thread` + `read_special_reg name:"sp"`), **set a write watchpoint** (`set_watchpoint`), and **report each thread's stack frame** (`list_threads` / `get_stack`). This is the forensics layer for the stack-overflow case (DoD #5).

**`read_special_reg` output shape:** `{ threadId, currentThread, registers: {...}, note? }`.

- `null` register = not present on this core (e.g. `$psplim`/`$msplim` on the M7 — expected; they have values on the STM32H5/M33), unknown convenience var (`$xpsr` reads `void`→`null`), or a global register on a non-current thread (see below).
- **Non-current thread:** when you `select_thread` a thread other than the stopped one, the CPU-global hardware registers (`msp`/`psp`/`control`/`primask`/`basepri`/`faultmask`/`msplim`/`psplim`) come back `null` with a `note` — a single hardware instance only reflects the running context, so reporting them under another thread's name would be a silent wrong value. **`sp` is the per-thread authority** (reconstructed from the saved frame).
- **`set_watchpoint`** accepts `expression` or the alias `expr`.

**Environment caveat (not the MCP layer):** on this F746/OpenOCD setup, non-current ThreadX threads unwind to **garbage top frames** (`??@0x4`, `<signal handler called>`) — OpenOCD's ThreadX awareness mis-decodes the saved frame offset (doesn't detect the EXC_RETURN FPU-context bit). `info threads` via `gdb_exec` shows the same garbage, confirming it's the gdb-server. Only the **stopped thread** unwinds reliably; `list_threads`/`get_stack` top frames for *non-current* threads are unreliable on this target. `sp` per-thread is still correct.

---

## Phase 5 — Consolidation + streamable-HTTP transport — READY TO TEST

**Additive surface:** four new inspection tools — `get_registers` (core registers via the Registers scope), `get_variables` (locals/globals/statics by scope), `read_memory` (hex dump), `write_memory` (hex bytes — DANGEROUS, mutates live state). The `debug` batch tool and all earlier tools are kept.

**Transport:** a streamable-HTTP endpoint at **`http://localhost:4711/mcp`** (Claude Code's preferred channel), alongside the existing stdio + SSE. The MCP SDK was upgraded 1.5.0 → ^1.13.0. The full handshake (initialize → session → tools/list → tools/call → terminate) is validated, including per-session cleanup (no transport leak).

**Reload the dev host (Ctrl/Cmd+R)** first.

### Connect Claude Code over HTTP (in your firmware repo)

```bash
# status-bar menu → "Copy MCP HTTP address"  → http://localhost:4711/mcp
claude mcp add --transport http debug http://localhost:4711/mcp --scope project
```

Then **restart the Claude Code session** and run `/mcp` — the `debug` server should show **connected** with the full tool set (listFiles, getFileContent, debug, get_debug_state, gdb_exec, read_special_reg, set_watchpoint, list_threads, select_thread, get_stack, get_registers, get_variables, read_memory, write_memory). The extension must be running (status-bar ✓). stdio (`claude mcp add --transport stdio ...`) and SSE remain available as fallbacks.

### Quick tool checks (curl, stopped at a breakpoint)

```bash
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"get_registers","arguments":{}}'         # r0-r15, sp, lr, pc, xPSR
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"get_variables","arguments":{}}'         # locals by scope
curl -s localhost:4711/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"read_memory","arguments":{"address":"0x20000000","count":32}}'
```

### The Phase 5 acceptance gate

From a fresh Claude Code session in the firmware repo, **`/mcp` shows the `debug` server connected over HTTP and the tools available**, and the new inspection tools return correct data on the live session. That closes out the plan — Phases 1–5 done; **DoD #5** (full human↔Claude handoff on the live STM32 session, no re-attach, no lost context) is now end-to-end.

---

## Feature 1 (Phase 6) — `explain_fault` (multi-core) — READY TO TEST

Decodes the current Cortex-M fault and recovers the **pre-fault** context (faulting PC/LR/xPSR + R0-R3/R12) from the stacked exception frame via EXC_RETURN, with the source line. The 15th tool. **Auto-detects the core via CPUID** and adapts:

- **ARMv7-M (M3/M4/M7):** decodes CFSR/HFSR/MMFAR/BFAR bitfields into English.
- **ARMv8-M Mainline (M33/M55/M85):** same + `UFSR.STKOF` (stack overflow → check MSPLIM/PSPLIM) + SecureFault `SFSR`/`SFAR`.
- **ARMv6-M (M0/M0+) & ARMv8-M Baseline (M23):** HardFault-only — no fault-status registers, so the verdict comes from `ICSR.VECTACTIVE` + the stacked PC (the `cfsr==0 ⇒ no fault` logic would be *wrong* on these, so it's correctly bypassed).

Every constant verified against the ARMv6-M / ARMv7-M / ARMv8-M ARMs. The stacked-frame recovery is common to all three.

**Reload the dev host (Ctrl/Cmd+R)** first. If on stdio MCP, restart the Claude Code session so the tool loads (`/mcp`).

### Test it

```bash
# 1. BENIGN case — at a normal breakpoint (no fault), expect {fault:false}:
curl -s localhost:3333/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"explain_fault","arguments":{}}'

# 2. FORCE a real fault, then decode. One deterministic way — make the CPU
#    execute from a bad address, then continue into the fault handler:
curl -s localhost:3333/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"gdb_exec","arguments":{"command":"set $pc = 0xfffffff0"}}'
curl -s localhost:3333/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"debug","arguments":{"steps":[{"type":"continue"}]}}'
# now stopped in HardFault/UsageFault handler:
curl -s localhost:3333/tcp -H 'content-type: application/json' \
  -d '{"type":"callTool","tool":"explain_fault","arguments":{}}'
```

(Use whatever fault trigger you prefer — a null-fn-pointer call, a bad store, etc. The `set $pc` trick is just the quickest deterministic one.)

### The gate (Feature 1)

`explain_fault` while stopped in the handler returns the decoded fault class + bitfields in English, the **faulting** PC/LR (the pre-fault context, not the handler), and the source line — **cross-checked** against a manual `gdb_exec "x/1xw 0xE000ED28"` (CFSR) and the stacked PC. The result includes `core` (auto-detected). And the benign case returns `{fault:false}` (subsuming the by-hand benign-exception check from Phase 3).

**Per-core gating:** the F746 (M7) validates the common machinery + the ARMv7-M path now. The **M0+** path (HardFault-only verdict via VECTACTIVE; confirm it does *not* read CFSR and still reports the fault + faulting PC) and the **M33** path (`STKOF` on a forced stack overflow; `SecureFault`/`SFSR` if you run TrustZone) want their own boards when you're on them — same build, just point it at the target.

---

## If you hit something

Report: what you evaluated, what the tool returned, and what the VS Code panel showed for the same thread/frame. That, plus whether the `stopped` event had a `threadId`, pinpoints it fast.
