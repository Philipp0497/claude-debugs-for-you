# Change Log

All notable changes to the "claude-debugs-for-you" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## 0.2.0 (Cortex/ThreadX fork)

First versioned release of the [Cortex/ThreadX fork](https://github.com/Philipp0497/claude-debugs-for-you):
a shared single-session pair-debugger for cortex-debug with 20 tools (session lifecycle, Cortex-M
forensics incl. `explain_fault`, ThreadX `inspect_tcb`/`thread_stack_usage`, SVD `read_peripheral`,
`gdb_exec`, hardware watchpoints) over three transports including streamable-HTTP `/mcp`.

- **SECURITY**: the HTTP server now binds to `127.0.0.1` only, rejects non-local `Host`/`Origin`
  headers (DNS rebinding / browser drive-by protection), and no longer sends wildcard CORS.
- Single tool registry: MCP registration, `/tcp` dispatch, and `listTools` all derive from one table;
  the stdio proxy now fetches the tool list from the extension instead of keeping a drifting copy.
- Fixed `removeBreakpoint` also removing same-line breakpoints in *other* files; `debug` plans now
  return the results of already-executed steps when a later step fails, instead of discarding them.
- stdio proxy: `CLAUDE_DEBUGS_PORT` env override; finds the extension's globalStorage under
  Code, Code - Insiders, VSCodium, and Code - OSS.
- Pure Cortex-M/ThreadX decode logic extracted to `src/cortex-decode.ts` with unit tests
  (`npm run test:unit`) and a CI workflow.

## 0.1.2

- Report exceptions to LLM
- Properly send threadId to comply with DAP, fixing issues with debugging with C++, etc.


## 0.1.1

- Fixes issue with Claude Desktop not detecting tools

## 0.1.0

- Fixes /sse use via fixing to properly use zod

## 0.0.9

- Fixes bug with tool descriptions

## 0.0.8

- Adds support to resume debugging if already running and LLM requests launch.

## 0.0.7

- Introduces the status menu
- Adds multi-window support
- Improves configuration capabilities and experience
- Simplifies first-time setup

## 0.0.6

- Adds automatic startup and stability improvements

## [0.0.4]
- Add /sse support

## [0.0.3]

- Change built mcp server to be CJS instead of ESM by @jasonjmcghee in #4
- Adds Windows compatibility by fixing a bug by @dkattan in #3, fixing #2

## [0.0.2]

- Adds ability to configure the port of the MCP Server

## [0.0.1]

- Initial release (built initial prototype in hackathon)
- Added support for conditional breakpoints
- Added support for automatically opening the file for debug
- Restructured to work well with .visx and to be language agnostic
