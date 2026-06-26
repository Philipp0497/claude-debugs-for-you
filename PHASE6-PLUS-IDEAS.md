# Phase 6+ — Ideas Backlog

**Status:** Phases 1–5 done & HW-validated. **Feature 1 (`explain_fault`) DONE** (commit 713f409,
core-aware M0+/M7/M33; M7 HW-confirmed, M0+/M33 await silicon). **Feature 2 (session lifecycle) DONE**
(commit a33ed00, HW-confirmed — recovered a faulted session, no VS Code touch). Remaining items below,
ordered by leverage. Each has a one-line *why*, a *gate* (confirm on the live STM32+ThreadX board), and
an *impl sketch* against the real source.

Validated target for all gates: Nucleo-F746ZG (Cortex-M7F), ThreadX + NetX Duo, cortex-debug +
OpenOCD + arm-none-eabi-gdb, MCP over `http://localhost:3333/mcp` (+ `/tcp` + `/sse` + stdio).

---

## Carry-over rules (learned in Phases 1–5 — don't reintroduce)

- **Tool I/O goes through the value relay**, not GDB console. Use DAP `context:'watch'` (var-object)
  or the `gdb_exec` console-capture path — never `context:'repl'` for values. (Phase 1.)
- **Register per-session `/mcp` tools with a real `ZodRawShape`** (`{ addr: z.string() }`), never a
  `z.object(...)` or a serialized JSON schema, and keep `zod` deduped to one version shared with the
  SDK. (Phase 5 — the zod v3/v4 split crashed every arg-taking tool with `keyValidator._parse`.)
- **Attribute new actions** `human` vs `claude` in `session-state.ts` and keep `get_debug_state`
  read-noise out of `recentActions`. (Phase 2.)
- **Surface the real stop reason** in any stepping/halting result — single-stepping on this target
  lands in the TIM6 timebase ISR and returns `reason=exception` (benign). (Phase 3.)

Open findings to fix opportunistically:

- **#2** `read_special_reg{threadId}` for a *non-current* thread returns the running thread's global
  hardware regs (`psp`/`msp`/`control`); only `sp` is per-thread. Null the global-only regs for
  non-current threads (Feature 4 below fixes this properly).
- **ENV** OpenOCD's ThreadX unwinder produces garbage frames for non-stopped threads on the M7
  (FPU-stacking offset / `EXC_RETURN` FType not detected). Feature 4 sidesteps it.

---

## Top picks (build first)

### Feature 1 — Fault post-mortem decoder  `explain_fault`

**Status:** IMPLEMENTED + HW-validated on M7 (2026-06-26). Multi-core (ARMv6-M/v7-M/v8-M). M0+/M33
paths await their own silicon.

**Why:** every "Exception has occurred" in Phases 3–5 needed hand-decoding of CFSR/HFSR. Highest
single debugging payoff on Cortex-M.

**Gate:** force a fault (e.g. write to an illegal address), call `explain_fault`, and it returns:
the decoded fault class + bitfields in English, the **faulting** PC/LR (not the handler), and the
source line. Cross-check against a manual `gdb_exec` read of the same registers.

**Impl sketch:**

- New tool in `debug-server.ts` (and stdio mirror in `mcp/src/index.ts`).
- Read `CFSR@0xE000ED28`, `HFSR@0xE000ED2C`, `DFSR@0xE000ED30`, `MMFAR@0xE000ED34`, `BFAR@0xE000ED38`,
  `SHCSR@0xE000ED24` via the existing memory-read path.
- Decode bitfields (MMARVALID/BFARVALID/IMPRECISERR/PRECISERR/IBUSERR/UNDEFINSTR/INVSTATE/…).
- Determine the active stack from the handler's `EXC_RETURN` (`$lr` bit 2 → MSP vs PSP, bit 4 → FP
  frame present), then read the stacked `{R0–R3, R12, LR, PC, xPSR}` from that SP (+ FP regs if
  bit4==0) to recover the pre-fault context.
- Output: human summary + structured fields.
- **Subsumes** the benign-vs-real "Exception" call we did by hand (CFSR==0 && HFSR==0 → not a fault).

---

### Feature 2 — Session lifecycle control  `start_session` / `restart_session` / `attach`

**Why:** the dominant friction in Phases 1–5 was "the dev-host reload dropped the debug session —
please restart and say ready." Letting Claude (re)launch/attach the cortex-debug session closes the
loop and makes the pair-debug rhythm autonomous.

**Gate:** with no active session, Claude calls `restart_session`, the board halts at the configured
entry/breakpoint, and a subsequent `get_debug_state` shows `status: stopped` — without the human
touching VS Code.

**Impl sketch:**

- `vscode.debug.startDebugging(folder, nameOrConfig)` to launch a named `launch.json` config
  (e.g. "TCP board F746ZG (Cortex-Debug, pinned ST-Link)").
- Track the launched session via the existing `SessionStateTracker` (`session-state.ts`).
- Guard: refuse if a session is already live; expose the config name as an arg.
- Stretch: `flash` (load the ELF) as a separate verb if the workflow wants reflash-then-debug.

**DONE** (commit a33ed00): `start_session`/`restart_session`. HW-confirmed: recovered a session dead in
MemManage_Handler to stopped-at-entry, no VS Code touch; race-hardened (session-scoped stop detection +
waitForNewSession(excludeId)).
**Follow-up refinement:** recovers to entry (Reset_Handler), not main. Add a `runToMain?: true` option
(tbreak main → continue → wait for the main stop) so a workflow can resume *useful* firmware in one call
instead of entry + a manual continue/breakpoint.

---

## Strong candidates

### Feature 3 — SVD / peripheral register decode  `read_peripheral`

**Why:** decode `ETH`/`RCC`/`USART`/DMA by name with bitfields instead of raw `*(u32*)0x…`. Directly
serves the MAC/PHY bring-up work (MMC RX/TX counters as the "is RX alive" oracle, MACCR, etc.).

**Gate:** `read_peripheral "ETH.MACCR"` → value + decoded bits; `read_peripheral "ETH"` (or an MMC
group) → the counter set, matching a raw memory read of the same addresses.

**Impl sketch:** parse the device SVD (STM32F746 CMSIS-SVD) once; map `PERIPH.REG` → address + field
layout; reuse the memory-read path; pretty-print fields. Arg `{ path, fields? }`.

### Feature 4 — ThreadX TCB introspection  `thread_stack_usage` / `inspect_tcb`  (also fixes #2 + ENV)

**Why:** per-thread stack high-water marks (overflow early-warning) and a *correct* non-current-thread
unwind that doesn't depend on OpenOCD's broken ThreadX decoder.

**Gate:** `thread_stack_usage` reports a plausible high-water for each of the 7 threads (e.g. scan
`s_modbus7_stack[4096]`); `inspect_tcb mb-tcp` returns its saved SP/state/priority/run-count and a
**real** backtrace (not `??@0x4`).

**Impl sketch:**

- Walk `_tx_thread_created_ptr` → `tx_thread_created_next` linked list (TCB fields).
- Stack high-water: scan each stack region for the `0xEFEFEFEF` fill pattern (ThreadX stack fill must
  be enabled in the port) from the low end; first non-fill word = high-water.
- Non-current unwind: read the TCB `tx_thread_stack_ptr`, detect FP context from the saved
  `EXC_RETURN` FType bit, decode the saved register frame yourself, then synthesize frames — bypassing
  OpenOCD. This is the clean fix for finding #2 and the FPU-unwind ENV gap.

### Feature 5 — Device-log ingestion (RTT or SWO/ITM)  `read_device_log`

**Why:** read the firmware's own `modbus_log_str` output inline instead of staring at a serial term.

**Gate:** trigger a log line on the board (e.g. link up/down), call `read_device_log`, see it.

**Impl sketch:** RTT is lower-friction (OpenOCD `rtt setup`/`rtt server`); SWO/ITM via the TPIU path
already exercised in the sweep. Tool drains the buffered lines since last call.

---

## Nice-to-haves

### Feature 6 — Watchpoint forensics  `watch_who_writes(expr)`

Arm a write watchpoint (builds on the shipped `set_watchpoint`), on hit capture PC/LR/stack, then
auto-continue → "what's corrupting `s_shared_holding[0]`." Gate: deliberately write the cell from two
sites, confirm both are reported with correct call sites.

### Feature 7 — State diff  `diff_state`

Snapshot regs/memory/vars, continue, snapshot again, return the delta. Gate: across one
`ModbusApp_Poll` iteration, the diff shows only the cells that actually changed.

### Feature 8 — Non-halting variable sampling  `sample(expr, interval, count)`

Periodic quick halt/read/resume (or live-read if the server supports it) → time series of `uwTick`,
packet-pool free count, MMC counters. Gate: sample `uwTick` 10×/200ms and see it increase
monotonically.

---

## Bus diagnostics (UART / CAN / USB) — protocol-aware peripheral debugging

All specializations of Feature 3 (SVD decode): `read_peripheral` gives raw bitfields, these give a
**bring-up verdict**. Three cross-cutting tools are the foundation; the per-bus `diagnose_*` tools
layer on top. Highest value during peripheral bring-up, where you otherwise hand-decode status regs.

### Feature 9 — Pre-flight check  `check_peripheral`  (bus-generic, build first)

**Why:** ~80% of "dead peripheral" bugs are the boring layer — clock not enabled, wrong/missing GPIO
alternate-function, wrong prescaler. Floating RX + wrong AF is exactly the UART7 poison-callback hang
this project hit. One call should catch all of it.

**Gate:** `check_peripheral "USART7"` on a correctly-configured port → all-green; deliberately break
the AF (or clear the RCC enable) → it flags the exact missing piece. Cross-check against a manual
`read_peripheral` of RCC + the GPIO bank.

**Impl sketch:** table-driven from the SVD + a per-peripheral pin map. Verify (a) the RCC `*ENR` bit
for the peripheral, (b) the GPIO `MODER`=AF + `AFR[]` value matches the peripheral's AF for each
signal pin, (c) clock source + prescaler → computed baud/bitrate vs an `expected` arg. Generic across
USART/CAN/USB/SPI/I2C. New tool in `debug-server.ts` (+ stdio mirror), reuses the memory-read path.

### Feature 10 — Buffer / FIFO tap  `tap_rx` / `tap_fifo`

**Why:** read the actual bytes on the wire without a scope/logic-analyzer — a software bus sniffer.

**Gate:** with traffic on the line, `tap_rx "USART7"` returns the recent RX bytes **decoded as a
Modbus RTU PDU** (addr / func / data / CRC-ok); for CAN, a decoded `{ID, DLC, data}`.

**Impl sketch:** for DMA-to-ring UART, read the ring buffer region + head/tail (NDTR-derived) and
slice the unread window; for a peripheral FIFO, drain via the data register image. Optional
`decode: 'modbus-rtu' | 'can' | 'raw'` post-processor.

### Feature 11 — Non-halting error sampling  `sample_status`

**Why:** transient errors (UART ORE/FE/NE, CAN LEC, USB FIFO overrun) clear or get missed on a single
halt. Sampling catches them — the bus analog of the Ethernet "counters as oracle" approach.

**Gate:** sample `USART7.ISR` 10×/200 ms while the floating-RX condition is present and see ORE/NE
latch; on a healthy port they stay clear. Builds on the general `sample` idea (Feature 8) but
peripheral-aware (decodes which error bits fired).

### Feature 12 — Per-bus decode  `diagnose_uart` / `diagnose_can` / `diagnose_usb`

**Why:** one call → the meaningful health view, not raw hex.

**Gate (per bus):** call against the live peripheral and confirm the decoded summary matches a manual
register read.

**Impl sketch / what each surfaces:**

- **`diagnose_uart`** — ISR (`ORE/FE/NE/PE/RXNE/TXE/IDLE/TC`), CR1-3 (word len, parity, stop, RS485
  DE, DMA en), **computed baud from BRR + clock**, DMA stream (`NDTR`, enable, TC/HT/TE). Example:
  *"115200 8N1, RX on, ORE latched, DMA RX 37/64, PE7/PE8 AF8 ✓."*
- **`diagnose_can`** (bxCAN ×2) — ESR (**LEC decoded**, TEC/REC, bus-off/error-passive/warning), TSR
  mailboxes, RF0R/RF1R FIFO pending, BTR → **bitrate + sample point + SJW**, filter-bank config;
  mailbox/FIFO read → decoded frame. TEC/REC trend predicts bus-off.
- **`diagnose_usb`** (OTG FS) — GINTSTS, DSTS (**enumerated speed / suspend**), DCFG (address),
  GOTGCTL (**session/VBUS**), per-EP DIEPCTL/DOEPCTL (stall/NAK), FIFO sizing. Stretch: an
  **enumeration tracer** (setup → set-address → set-config) to pinpoint where enumeration stalls.

---

## Peripheral diagnostics — clocked / analog (Timer / I2C / ADC / DAC / SPI)

Same `diagnose_*` family as Features 9–12, but these need two foundations because their value is in
computed **frequencies and voltages**, not raw bits. Build the foundations first — they also
retroactively strengthen the UART/CAN baud decode (Features 9/12).

### Feature 13 — Clock-tree resolver  `resolve_clock`  (foundation, build first)

**Why:** every baud / PWM-frequency / SPI-SCK / I2C-timing / ADC-rate number depends on the *actual*
input clock a peripheral sees, which is a function of RCC (PLL, AHB/APB prescalers, the APB-timer
clock-doubling rule). Without this, all those numbers are guesses.

**Gate:** `resolve_clock "TIM8"` returns the timer's input clock; cross-check that `SystemCoreClock`
resolves to the known 216 MHz on the F746 and that an APBx-timer reflects the ×2 doubling when its
prescaler ≠ 1.

**Impl sketch:** read RCC (`PLLCFGR`, `CFGR` HPRE/PPRE1/PPRE2, clock source) via the memory path;
model the F7 clock tree; expose `{ peripheral -> Hz }`. Knows the "APB timer clock is ×2 when APB
prescaler > 1" rule. New tool in `debug-server.ts` (+ stdio mirror).

### Feature 14 — Units conversion  `read_as`

**Why:** turn raw register values into engineering units — ADC counts → volts, timer ticks → µs,
CCR → duty %.

**Gate:** `read_as "ADC1.DR" volts` (with VREF known) returns a plausible voltage matching a manual
`raw * VREF / fullscale`; `read_as "TIM8.CNT" us` matches `ticks / resolved_clock`.

**Impl sketch:** thin layer over `read_peripheral` + `resolve_clock`; arg `{ expr, units, ref? }`.
For ADC, fullscale from CFGR resolution; VREF/VDDA from an arg or VREFINT calibration.

### Feature 15 — `diagnose_timer` / `diagnose_pwm`  (highest value — timer math is the most error-prone)

**Why:** PSC/ARR→frequency and CCR→duty are constantly miscalculated; one call should report the real
output. Project uses htim6/7/8 (timebase + RTU T3.5 timing).

**Gate:** against a configured PWM channel, the reported frequency + duty match a scope / manual
`f = clk / ((PSC+1)*(ARR+1))`, `duty = CCR/(ARR+1)`. Live `CNT` sampled twice shows it advancing.

**Impl sketch:** decode CR1 (enable/dir/center-aligned), PSC+ARR (+ resolved clock → period/freq),
per-channel CCMR/CCER/CCR → PWM mode + polarity + duty, DIER. Input-capture mode → CCR → measured
input frequency.

### Feature 16 — `diagnose_i2c`  (+ stuck-bus detect + bus scan)

**Why:** the STM32 `TIMINGR` register is notoriously unreadable, and SDA-stuck-low lockups are a
recurring bring-up trap.

**Gate:** `diagnose_i2c "I2C1"` decodes TIMINGR back to an SCL frequency matching the intended rate;
with SDA forced low it reports "bus stuck (SDA held)". Bus-scan finds a known device address.

**Impl sketch:** decode ISR (BUSY/NACKF/BERR/ARLO/OVR/STOPF/TC), CR1/CR2 (addressing, autoend,
nbytes), **TIMINGR → SCL freq + setup/hold**; read SCL/SDA via GPIO `IDR` for stuck detection.
Stretch (`i2c_scan`): orchestrate address probes by poking I2C registers from the debugger.

### Feature 17 — `diagnose_adc` / `diagnose_dac`

**Why:** overrun, wrong sampling time, and "pin not in analog mode" are the top analog bring-up bugs.

**Gate:** `diagnose_adc "ADC1"` reports resolution/trigger/sequence + the latest reading **in volts**
(matching a manual conversion), and flags OVR if set; deliberately leave a channel pin non-analog → it
warns. `diagnose_dac` reads DHR/DOR → volts.

**Impl sketch:** ADC — CFGR (resolution/align/continuous/EXTSEL), SQR/SMPR (sequence + sampling),
ISR (OVR/EOC/ADRDY), calibration state, DR or DMA-buffer → volts (Feature 14), GPIO analog-mode
check. DAC — CR (enable/trigger/wave/buffer), DHR/DOR → volts, output-pin analog check.

### Feature 18 — `diagnose_spi`

**Why:** CPOL/CPHA mode mismatch is the classic SPI bug; decode it in plain English.

**Gate:** `diagnose_spi "SPI2"` reports master/slave, **SCK frequency** (prescaler + resolved clock),
**mode (CPOL/CPHA)**, data size, NSS handling, and flags OVR/MODF; cross-check SCK against the
prescaler math.

**Impl sketch:** decode SR (BSY/OVR/MODF/TXE/RXNE/FRE), CR1/CR2 (master/slave, baud prescaler → SCK,
CPOL/CPHA, data size, NSS mgmt, FIFO FRLVL/FTLVL on F7), NSS/CS pin state.

**Build order within this group:** 13 (clock resolver) → 15 (timer/PWM) → 16 (I2C) → 14/17/18 as
appetite allows.

---

## Suggested sequencing

1. **Feature 1** (fault decoder) — DONE on M7. M0+/M33 confirmation is a follow-up.
2. **Feature 2** (session lifecycle) — unblocks autonomous loops; removes the per-phase human restart.
3. **Feature 3 / 4** — lean into the Ethernet + ThreadX domain; #4 also retires open finding #2 + the
   OpenOCD unwind gap.
4. Features 5–8, then the bus/peripheral diagnostics (9–18), as appetite allows.

Each ships uncommitted → HW-confirm on the F746 → commit on `cortex-pair-debugger`, same as Phases 1–5.
