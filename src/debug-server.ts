import * as net from 'net';
import * as http from 'http';
import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { z } from 'zod';

interface DebugServerEvents {
    on(event: 'started', listener: () => void): this;
    on(event: 'stopped', listener: () => void): this;
    emit(event: 'started'): boolean;
    emit(event: 'stopped'): boolean;
}
import { randomUUID } from 'crypto';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SessionStateTracker } from './session-state';

export interface DebugCommand {
    command: 'listFiles' | 'getFileContent' | 'debug';
    payload: any;
}

export interface DebugStep {
    type: 'setBreakpoint' | 'removeBreakpoint' | 'continue' | 'evaluate' | 'launch'
        | 'stepOver' | 'stepInto' | 'stepOut' | 'pause';
    file?: string;
    line?: number;
    expression?: string;
    condition?: string;
}

interface ToolRequest {
    type: 'listTools' | 'callTool';
    tool?: string;
    arguments?: any;
}

const debugDescription = `Execute a debug plan with breakpoints, launch, continues, stepping, and
expression evaluation. Step types: setBreakpoint, removeBreakpoint, launch, continue, stepOver, stepInto,
stepOut, pause, evaluate. ONLY SET BREAKPOINTS BEFORE LAUNCHING OR WHILE PAUSED. Be careful to keep track
of where you are, if paused on a breakpoint. Make sure to find and get the contents of any requested
files. Only use continue when ready to move to the next breakpoint. Launch will bring you to the first
breakpoint. DO NOT USE CONTINUE TO GET TO THE FIRST BREAKPOINT. stepOver/stepInto/stepOut advance one
line/into/out while paused and pause halts a running target; these drive the SHARED editor — the human
sees the highlighted line move, exactly as if they had clicked. They act on the stopped/focused thread.`;

const listFilesDescription = "List all files in the workspace. Use this to find any requested files.";

const getFileContentDescription = `Get file content with line numbers - you likely need to list files
to understand what files are available. Be careful to use absolute paths.`;

const getDebugStateDescription = `Get the current state of the SHARED debug session: running/stopped, stop
reason, the active stopped thread, current source location, all threads, all breakpoints, and a log of
recent actions (each tagged human or claude). The session is SHARED with a human who may step, set
breakpoints, or change focus at any time — call this after any pause in your activity to re-sync before
acting on a stale picture.`;

const gdbExecDescription = `Run a raw GDB CLI command on the SHARED debug session and return its console
output (cortex-debug). The escape hatch for anything not covered by a typed tool: 'info registers',
'x/16xw $sp', 'bt', 'info threads', 'monitor reset halt', etc. Output is captured from the debug console
(it is NOT returned in a normal evaluate result). Embedded double-quotes are not supported. For evaluating
a program expression's value prefer the debug 'evaluate' step; this is for debugger/CLI commands.`;

const readSpecialRegDescription = `Read ARM Cortex-M special/system registers on the SHARED session
(frame-pinned, hex). Omit 'name' to read the standard M-profile set ($msp, $psp, $control, $primask,
$basepri, $faultmask, plus $msplim/$psplim on ARMv8-M). Registers not present on the target read back as
null. Defaults to the selected/stopped thread; pass threadId to target another.`;

const setWatchpointDescription = `Set a hardware data watchpoint on the SHARED session via GDB
(watch/rwatch/awatch). 'expression' may be a variable or an address cast, e.g. 'g_flag' or
'*(uint32_t*)0x20000010'. kind: write (default), read, or access (both). Cortex-M has ~4 DWT comparators;
exceeding them fails. A hit stops with reason 'data breakpoint'; re-read the expression to see the value.`;

const listThreadsDescription = `List all threads on the SHARED session (one per RTOS/ThreadX thread when
RTOS-aware), each with its top stack frame, and which is stopped/selected. Only meaningful while stopped.`;

const selectThreadDescription = `Select a thread (id from list_threads) that the inspection/forensics tools
(get_stack, read_special_reg) will default to, until the next resume. Does not switch the human's UI.`;

const getStackDescription = `Get the call stack of a thread on the SHARED session (defaults to the
selected/stopped thread; pass threadId for another). Use to walk each ThreadX thread's stack / assess
stack usage.`;

// Zod schemas for the tools
const getDebugStateInputSchema = {};

const gdbExecInputSchema = {
    command: z.string().describe("Raw GDB CLI command, e.g. 'info registers', 'x/16xw $sp', 'bt', 'monitor reset halt'."),
};

const readSpecialRegInputSchema = {
    name: z.string().describe("Register name without '$' (e.g. 'msp', 'psp', 'psplim', 'control'). Omit to read the standard set.").optional(),
    threadId: z.number().describe("Thread to read from; defaults to the selected/stopped thread.").optional(),
};

const setWatchpointInputSchema = {
    expression: z.string().describe("Expression or address to watch, e.g. 'g_counter' or '*(uint32_t*)0x20000010'.").optional(),
    expr: z.string().describe("Alias for 'expression'.").optional(),
    kind: z.enum(["write", "read", "access"]).describe("write (default), read, or access (both).").optional(),
};

const listThreadsInputSchema = {};

const selectThreadInputSchema = {
    threadId: z.number().describe("Thread id from list_threads."),
};

const getStackInputSchema = {
    threadId: z.number().describe("Thread to get the stack for; defaults to the selected/stopped thread.").optional(),
    levels: z.number().describe("Max number of frames (default 20).").optional(),
};

const getRegistersDescription = `Read the CPU core registers (r0-r15, sp, lr, pc, xPSR, ...) of a thread on
the SHARED debug session via the 'Registers' scope, frame-pinned to the selected/stopped thread. For
M-profile special/system registers ($msp/$psp/$control/...) use read_special_reg. The session is shared —
re-check get_debug_state if the human may have acted since your last call.`;

const getVariablesDescription = `Read in-scope variables (locals, and globals/statics) of a thread's
current frame on the SHARED debug session, grouped by scope, frame-pinned to the selected/stopped thread.
A non-zero variablesReference marks an expandable structure. Re-check get_debug_state if the human may
have acted since your last call.`;

const readMemoryDescription = `Read target memory on the SHARED debug session. 'address' is a hex string or
decimal (e.g. '0x20000000'); returns 'count' bytes (default 64) as hex. Invisible read — narrate the
result to the human.`;

const writeMemoryDescription = `Write target memory on the SHARED debug session. 'address' is a hex
string/decimal; 'data' is hex bytes (e.g. 'deadbeef' or 'de ad be ef'). DANGEROUS: mutates live target
state — confirm intent and narrate to the human. Not all adapters support memory writes.`;

const getRegistersInputSchema = {
    threadId: z.number().describe("Thread to read from; defaults to the selected/stopped thread.").optional(),
};

const getVariablesInputSchema = {
    threadId: z.number().describe("Thread to read from; defaults to the selected/stopped thread.").optional(),
    scope: z.string().describe("Only return this scope (e.g. 'Local'). Omit for all non-register scopes.").optional(),
};

const readMemoryInputSchema = {
    address: z.string().describe("Address as a hex string or decimal, e.g. '0x20000000'."),
    count: z.number().describe("Number of bytes to read (default 64).").optional(),
    offset: z.number().describe("Byte offset from address (default 0).").optional(),
};

const writeMemoryInputSchema = {
    address: z.string().describe("Address as a hex string or decimal, e.g. '0x20000000'."),
    data: z.string().describe("Hex bytes to write, e.g. 'deadbeef' or 'de ad be ef'."),
};

const explainFaultDescription = `Decode the current ARM Cortex-M fault on the SHARED session. Auto-detects
the core via CPUID. On ARMv7-M (M3/M4/M7) and ARMv8-M Mainline (M33/M55/M85): decodes CFSR/HFSR/MMFAR/BFAR
(+ UFSR.STKOF stack-overflow and SecureFault SFSR/SFAR on v8-M) into plain English. On ARMv6-M (M0/M0+)
and ARMv8-M Baseline (M23): HardFault-only — verdict from ICSR.VECTACTIVE + the stacked PC. Always recovers
the PRE-FAULT context (faulting PC/LR/xPSR + R0-R3/R12) from the stacked exception frame via EXC_RETURN,
with the source line. Returns {fault:false} for a benign 'exception' stop. Call while stopped in the handler.`;

const explainFaultInputSchema = {};

// Standard ARM Cortex-M special/system registers to read when no specific name is
// given. msplim/psplim exist only on ARMv8-M (e.g. Cortex-M33); they read back as
// null (unavailable) on ARMv7-M (e.g. Cortex-M7).
const SPECIAL_REGS = ['sp', 'lr', 'pc', 'xpsr', 'msp', 'psp', 'primask', 'basepri', 'faultmask', 'control', 'msplim', 'psplim'];

// CPU-global hardware registers: a single physical instance that reflects only the
// CURRENT (running) context. For a NON-current thread these are meaningless (they
// would report the running thread's values), so they are reported as null. By
// contrast sp/lr/pc/xpsr are reconstructed from a thread's saved stack frame and
// are per-thread (note: non-current unwinds depend on the gdb-server's RTOS support).
const GLOBAL_ONLY_REGS = new Set(['msp', 'psp', 'control', 'primask', 'basepri', 'faultmask', 'msplim', 'psplim']);

// CPUID PartNo (bits[15:4]) -> core capabilities. configurableFaults = has the
// CFSR/HFSR/MMFAR/BFAR block (ARMv7-M and ARMv8-M Mainline). v8m = ARMv8-M (adds
// UFSR.STKOF + SecureFault SFSR/SFAR). NOTE: Cortex-M23 is v8-M but HardFault-only,
// so capability is keyed per-part, NOT off v8m.
const CORTEX_CORES: Record<number, { name: string; configurableFaults: boolean; v8m: boolean }> = {
    0xc20: { name: 'Cortex-M0', configurableFaults: false, v8m: false },
    0xc60: { name: 'Cortex-M0+', configurableFaults: false, v8m: false },
    0xc21: { name: 'Cortex-M1', configurableFaults: false, v8m: false },
    0xc23: { name: 'Cortex-M3', configurableFaults: true, v8m: false },
    0xc24: { name: 'Cortex-M4', configurableFaults: true, v8m: false },
    0xc27: { name: 'Cortex-M7', configurableFaults: true, v8m: false },
    0xd20: { name: 'Cortex-M23', configurableFaults: false, v8m: true },
    0xd21: { name: 'Cortex-M33', configurableFaults: true, v8m: true },
    0xd22: { name: 'Cortex-M55', configurableFaults: true, v8m: true },
    0xd23: { name: 'Cortex-M85', configurableFaults: true, v8m: true },
    0xd31: { name: 'Cortex-M35P', configurableFaults: true, v8m: true },
};

// ICSR.VECTACTIVE exception numbers that are CPU faults.
const FAULT_EXCEPTIONS: Record<number, string> = {
    3: 'HardFault',
    4: 'MemManage',
    5: 'BusFault',
    6: 'UsageFault',
    7: 'SecureFault',
};

function hex32(n: number): string {
    return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

const listFilesInputSchema = {
    includePatterns: z.array(z.string()).describe("Glob patterns to include (e.g. ['**/*.js'])").optional(),
    excludePatterns: z.array(z.string()).describe("Glob patterns to exclude (e.g. ['node_modules/**'])").optional(),
};

const getFileContentInputSchema = {
    path: z.string().describe("Path to the file. IT MUST BE AN ABSOLUTE PATH AND MATCH THE OUTPUT OF listFiles"),
};

const debugStepSchema = z.object({
    type: z.enum(["setBreakpoint", "removeBreakpoint", "continue", "evaluate", "launch", "stepOver", "stepInto", "stepOut", "pause"]).describe(""),
    file: z.string().describe("File path. Required for setBreakpoint and launch; ignored by flow-control/evaluate steps.").optional(),
    line: z.number().optional(),
    expression: z.string().describe("A bare expression to evaluate in the resolved stopped frame (e.g. a variable name, '&symbol', '$pc', '$sp'). NOT a debugger CLI command: 'p/x ...', 'info registers', 'x/...', 'monitor ...' are not supported here. For hex output append a ',x' format suffix (e.g. 'value,x').").optional(),
    condition: z.string().describe("If needed, a breakpoint condition may be specified to only stop on a breakpoint for some given condition.").optional(),
});

const debugInputSchema = {
    steps: z.array(debugStepSchema),
};

// Main tools array with Zod schemas
const tools = [
    {
        name: "listFiles",
        description: listFilesDescription, // Make sure this variable is defined in your code
        inputSchema: listFilesInputSchema,
    },
    {
        name: "getFileContent",
        description: getFileContentDescription, // Make sure this variable is defined in your code
        inputSchema: getFileContentInputSchema,
    },
    {
        name: "debug",
        description: debugDescription, // Make sure this variable is defined in your code
        inputSchema: debugInputSchema,
    },
    {
        name: "get_debug_state",
        description: getDebugStateDescription,
        inputSchema: getDebugStateInputSchema,
    },
    {
        name: "gdb_exec",
        description: gdbExecDescription,
        inputSchema: gdbExecInputSchema,
    },
    {
        name: "read_special_reg",
        description: readSpecialRegDescription,
        inputSchema: readSpecialRegInputSchema,
    },
    {
        name: "set_watchpoint",
        description: setWatchpointDescription,
        inputSchema: setWatchpointInputSchema,
    },
    {
        name: "list_threads",
        description: listThreadsDescription,
        inputSchema: listThreadsInputSchema,
    },
    {
        name: "select_thread",
        description: selectThreadDescription,
        inputSchema: selectThreadInputSchema,
    },
    {
        name: "get_stack",
        description: getStackDescription,
        inputSchema: getStackInputSchema,
    },
    {
        name: "get_registers",
        description: getRegistersDescription,
        inputSchema: getRegistersInputSchema,
    },
    {
        name: "get_variables",
        description: getVariablesDescription,
        inputSchema: getVariablesInputSchema,
    },
    {
        name: "read_memory",
        description: readMemoryDescription,
        inputSchema: readMemoryInputSchema,
    },
    {
        name: "write_memory",
        description: writeMemoryDescription,
        inputSchema: writeMemoryInputSchema,
    },
    {
        name: "explain_fault",
        description: explainFaultDescription,
        inputSchema: explainFaultInputSchema,
    },
];
export class DebugServer extends EventEmitter implements DebugServerEvents {
    private server: net.Server | null = null;
    private port: number = 4711;
    private portConfigPath: string | null = null;
    private activeTransports: Record<string, SSEServerTransport> = {};
    private streamableTransports: Record<string, StreamableHTTPServerTransport> = {};
    private mcpServer: McpServer;
    private _isRunning: boolean = false;
    private tracker: SessionStateTracker;

    constructor(port: number | undefined, portConfigPath: string | undefined, tracker: SessionStateTracker) {
        super();
        this.port = port || 4711;
        this.portConfigPath = portConfigPath || null;
        // The tracker is the single source of truth for "where the session is".
        // It is mandatory and must already be register()-ed by the extension host;
        // an unregistered tracker would have an empty state map and silently
        // degrade resolution back to the wrong-thread bug this fork removes.
        this.tracker = tracker;
        this.mcpServer = this.createMcpServer();
    }

    /**
     * Build an McpServer with every tool registered against this DebugServer's
     * handlers. A fresh instance is used PER streamable-HTTP session, because the
     * SDK's Protocol binds a single `_transport` per server and routes all
     * responses through it — one server cannot correctly serve concurrent
     * sessions. All instances share the same handlers (and thus the same live
     * debug-session state via the tracker).
     */
    private createMcpServer(): McpServer {
        const server = new McpServer({
            name: "Debug Server",
            version: "1.0.0",
        });

        server.tool("listFiles", listFilesDescription, listFilesInputSchema, async (args: any) => {
            const files = await this.handleListFiles(args);
            return { content: [{ type: "text", text: JSON.stringify(files) }] };
        });

        server.tool("getFileContent", getFileContentDescription, getFileContentInputSchema, async (args: any) => {
            const content = await this.handleGetFile(args);
            return { content: [{ type: "text", text: content }] };
        });

        server.tool("debug", debugDescription, debugInputSchema, async (args: any) => {
            const results = await this.handleDebug(args);
            return { content: [{ type: "text", text: results.join('\n') }] };
        });

        server.tool("get_debug_state", getDebugStateDescription, getDebugStateInputSchema, async () => {
            const state = await this.handleGetDebugState();
            return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
        });

        server.tool("gdb_exec", gdbExecDescription, gdbExecInputSchema, async (args: any) => {
            const out = await this.handleGdbExec(args);
            return { content: [{ type: "text", text: out }] };
        });

        server.tool("read_special_reg", readSpecialRegDescription, readSpecialRegInputSchema, async (args: any) => {
            const regs = await this.handleReadSpecialReg(args);
            return { content: [{ type: "text", text: JSON.stringify(regs, null, 2) }] };
        });

        server.tool("set_watchpoint", setWatchpointDescription, setWatchpointInputSchema, async (args: any) => {
            const result = await this.handleSetWatchpoint(args);
            return { content: [{ type: "text", text: result }] };
        });

        server.tool("list_threads", listThreadsDescription, listThreadsInputSchema, async () => {
            const threads = await this.handleListThreads();
            return { content: [{ type: "text", text: JSON.stringify(threads, null, 2) }] };
        });

        server.tool("select_thread", selectThreadDescription, selectThreadInputSchema, async (args: any) => {
            const result = await this.handleSelectThread(args);
            return { content: [{ type: "text", text: result }] };
        });

        server.tool("get_stack", getStackDescription, getStackInputSchema, async (args: any) => {
            const stack = await this.handleGetStack(args);
            return { content: [{ type: "text", text: JSON.stringify(stack, null, 2) }] };
        });

        server.tool("get_registers", getRegistersDescription, getRegistersInputSchema, async (args: any) => {
            const regs = await this.handleGetRegisters(args);
            return { content: [{ type: "text", text: JSON.stringify(regs, null, 2) }] };
        });

        server.tool("get_variables", getVariablesDescription, getVariablesInputSchema, async (args: any) => {
            const vars = await this.handleGetVariables(args);
            return { content: [{ type: "text", text: JSON.stringify(vars, null, 2) }] };
        });

        server.tool("read_memory", readMemoryDescription, readMemoryInputSchema, async (args: any) => {
            const mem = await this.handleReadMemory(args);
            return { content: [{ type: "text", text: JSON.stringify(mem, null, 2) }] };
        });

        server.tool("write_memory", writeMemoryDescription, writeMemoryInputSchema, async (args: any) => {
            const result = await this.handleWriteMemory(args);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });

        server.tool("explain_fault", explainFaultDescription, explainFaultInputSchema, async () => {
            const result = await this.handleExplainFault();
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        });

        return server;
    }

    get isRunning(): boolean {
        return this._isRunning;
    }

    setPort(port: number): void {
        this.port = port || 4711;

        // Update port in configuration file if available
        if (this.portConfigPath && typeof port === 'number') {
            try {
                const fs = require('fs');
                fs.writeFileSync(this.portConfigPath, JSON.stringify({ port }));
            } catch (err) {
                console.error('Failed to update port configuration file:', err);
                // We'll still use the new port even if saving to file fails
            }
        }
    }

    getPort(): number {
        return this.port;
    }

    async forceStopExistingServer(): Promise<void> {
        try {
            // Send a request to the shutdown endpoint of any existing server
            await new Promise<void>((resolve, reject) => {
                const req = http.request({
                    hostname: 'localhost',
                    port: this.port,
                    path: '/shutdown',
                    method: 'POST',
                    timeout: 3000 // 3 second timeout
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode === 200) {
                            // Give the server a moment to shut down
                            setTimeout(resolve, 500);
                        } else {
                            reject(new Error(`Unexpected status: ${res.statusCode}`));
                        }
                    });
                });

                req.on('error', (err: NodeJS.ErrnoException) => {
                    // If we can't connect, there's no server running or it's not ours
                    if (err.code === 'ECONNREFUSED') {
                        resolve(); // No server running, so nothing to stop
                    } else {
                        reject(err);
                    }
                });

                req.on('timeout', () => {
                    req.destroy();
                    reject(new Error('Request timed out'));
                });

                req.end();
            });
        } catch (err) {
            console.error('Error requesting server shutdown:', err);
            throw new Error('Failed to stop existing server');
        }
    }

    async start(): Promise<void> {
        if (this.server) {
            throw new Error('Server is already running');
        }

        this.server = http.createServer(async (req, res) => {
            // Handle CORS
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');
            res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

            if (req.method === 'OPTIONS') {
                res.writeHead(204).end();
                return;
            }

            // Shutdown endpoint - allows another instance to request shutdown of this server
            if (req.method === 'POST' && req.url === '/shutdown') {
                res.writeHead(200).end('Server shutting down');
                this.stop().catch(err => {
                    res.writeHead(500).end(`Error shutting down: ${err.message}`);
                });
                return;
            }

            // Legacy TCP-style endpoint
            if (req.method === 'POST' && req.url === '/tcp') {
                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const request = JSON.parse(body);
                        let response: any;

                        if (request.type === 'listTools') {
                            response = { tools };
                        } else if (request.type === 'callTool') {
                            response = await this.handleCommand(request);
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, data: response }));
                    } catch (error) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({
                            success: false,
                            error: error instanceof Error ? error.message : 'Unknown error'
                        }));
                    }
                });
                return;
            }

            // Streamable HTTP endpoint (Claude Code's preferred transport).
            if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
                await this.handleStreamableHttp(req, res);
                return;
            }

            // SSE endpoint (legacy)
            if (req.method === 'GET' && req.url === '/sse') {
                const transport = new SSEServerTransport('/messages', res);
                this.activeTransports[transport.sessionId] = transport;
                await this.mcpServer.connect(transport);
                res.on('close', () => {
                    delete this.activeTransports[transport.sessionId];
                });
                return;
            }

            // Message endpoint for SSE
            if (req.method === 'POST' && req.url?.startsWith('/messages')) {
                const url = new URL(req.url, 'http://localhost');
                const sessionId = url.searchParams.get('sessionId');
                if (!sessionId || !this.activeTransports[sessionId]) {
                    res.writeHead(404).end('Session not found');
                    return;
                }
                await this.activeTransports[sessionId].handlePostMessage(req, res);
                return;
            }

            res.writeHead(404).end();
        });

        return new Promise((resolve, reject) => {
            this.server!.listen(this.port, () => {
                this._isRunning = true;
                this.emit('started');
                resolve();
            }).on('error', reject);
        });
    }

    /**
     * Streamable HTTP transport (MCP spec 2025-03-26), Claude Code's preferred
     * channel. Stateful: the client's initialize POST (no session id) creates a
     * transport whose generated id is returned in the mcp-session-id header;
     * subsequent POST/GET/DELETE carry that id and route to the same transport.
     */
    private async handleStreamableHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        let transport = sessionId ? this.streamableTransports[sessionId] : undefined;

        if (!transport) {
            if (req.method !== 'POST') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0',
                    error: { code: -32000, message: 'Missing or unknown mcp-session-id' },
                    id: null,
                }));
                return;
            }
            // New session from the client's initialize request.
            const newTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid: string) => {
                    this.streamableTransports[sid] = newTransport;
                },
            });
            // A fresh server per session (see createMcpServer) — one server cannot
            // route responses for multiple concurrent transports.
            const sessionServer = this.createMcpServer();
            await sessionServer.connect(newTransport);
            // connect() OVERWRITES transport.onclose with the SDK's own handler, so
            // wire our map cleanup AFTER connect and chain to the SDK's — otherwise
            // the session entry (and its server) leaks on every disconnect.
            const protocolOnClose = newTransport.onclose;
            newTransport.onclose = () => {
                protocolOnClose?.();
                if (newTransport.sessionId) {
                    delete this.streamableTransports[newTransport.sessionId];
                }
            };
            transport = newTransport;
        }

        await transport.handleRequest(req, res);
    }

    // Helper method to handle tool calls
    private async handleCommand(request: ToolRequest): Promise<any> {
        switch (request.tool) {
            case 'listFiles':
                return await this.handleListFiles(request.arguments);
            case 'getFileContent':
                return await this.handleGetFile(request.arguments);
            case 'debug':
                return await this.handleDebug(request.arguments);
            case 'get_debug_state':
                return await this.handleGetDebugState();
            case 'gdb_exec':
                return await this.handleGdbExec(request.arguments);
            case 'read_special_reg':
                return await this.handleReadSpecialReg(request.arguments);
            case 'set_watchpoint':
                return await this.handleSetWatchpoint(request.arguments);
            case 'list_threads':
                return await this.handleListThreads();
            case 'select_thread':
                return await this.handleSelectThread(request.arguments);
            case 'get_stack':
                return await this.handleGetStack(request.arguments);
            case 'get_registers':
                return await this.handleGetRegisters(request.arguments);
            case 'get_variables':
                return await this.handleGetVariables(request.arguments);
            case 'read_memory':
                return await this.handleReadMemory(request.arguments);
            case 'write_memory':
                return await this.handleWriteMemory(request.arguments);
            case 'explain_fault':
                return await this.handleExplainFault();
            default:
                throw new Error(`Unknown tool: ${request.tool}`);
        }
    }

    private async handleLaunch(payload: {
        program: string,
        args?: string[]
    }): Promise<string> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            throw new Error('No workspace folder found');
        }

        // Try to get launch configurations
        const launchConfig = vscode.workspace.getConfiguration('launch', workspaceFolder.uri);
        const configurations = launchConfig.get<any[]>('configurations');

        if (!configurations || configurations.length === 0) {
            throw new Error('No debug configurations found in launch.json');
        }

        // Get the first configuration and update it with the current file
        const config = { ...configurations[0] };

        // Replace ${file} with actual file path if it exists in the configuration
        Object.keys(config).forEach(key => {
            if (typeof config[key] === 'string') {
                config[key] = config[key].replace('${file}', payload.program);
            }
        });

        // Replace ${workspaceFolder} in environment variables if they exist
        if (config.env) {
            Object.keys(config.env).forEach(key => {
                if (typeof config.env[key] === 'string') {
                    config.env[key] = config.env[key].replace(
                        '${workspaceFolder}',
                        workspaceFolder.uri.fsPath
                    );
                }
            });
        }

        // Check if we're already debugging
        let session = vscode.debug.activeDebugSession;
        if (!session) {
            // Start debugging using the configured launch configuration
            await vscode.debug.startDebugging(workspaceFolder, config);

            // Wait for session to be available
            session = await this.waitForDebugSession();
        }

        // Check if we're at a breakpoint
        try {
            // Resolve the stopped thread from session state (never hardcode/assume
            // threads[0]). Right after launch the target may not be stopped yet, or
            // the RTOS scheduler may not have started, so tolerate "no thread".
            const threadId = await this.tracker.resolveActiveThreadId(session);
            if (threadId === undefined) {
                return 'Debug session started';
            }

            const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
            if (stack.stackFrames && stack.stackFrames.length > 0) {
                const topFrame = stack.stackFrames[0];
                const currentBreakpoints = vscode.debug.breakpoints.filter(bp => {
                    if (bp instanceof vscode.SourceBreakpoint) {
                        return bp.location.uri.toString() === topFrame.source.path &&
                            bp.location.range.start.line === (topFrame.line - 1);
                    }
                    return false;
                });

                if (currentBreakpoints.length > 0) {
                    return `Debug session started - Stopped at breakpoint on line ${topFrame.line}`;
                }
            }
            return 'Debug session started';
        } catch (err) {
            console.error('Error checking breakpoint status:', err);
            return 'Debug session started';
        }
    }

    private waitForDebugSession(): Promise<vscode.DebugSession> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for debug session'));
            }, 5000);

            const checkSession = () => {
                const session = vscode.debug.activeDebugSession;
                if (session) {
                    clearTimeout(timeout);
                    resolve(session);
                } else {
                    setTimeout(checkSession, 100);
                }
            };

            checkSession();
        });
    }

    private async handleListFiles(payload: {
        includePatterns?: string[],
        excludePatterns?: string[]
    }): Promise<string[]> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folders found');
        }

        const includePatterns = payload.includePatterns || ['**/*'];
        const excludePatterns = payload.excludePatterns || ['**/node_modules/**', '**/.git/**'];

        const files: string[] = [];
        for (const folder of workspaceFolders) {
            const relativePattern = new vscode.RelativePattern(folder, `{${includePatterns.join(',')}}`);
            const foundFiles = await vscode.workspace.findFiles(relativePattern, `{${excludePatterns.join(',')}}`);
            files.push(...foundFiles.map(file => file.fsPath));
        }

        return files;
    }

    private async handleGetFile(payload: { path: string }): Promise<string> {
        const doc = await vscode.workspace.openTextDocument(payload.path);
        const lines = doc.getText().split('\n');
        return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
    }

    /**
     * Assemble a snapshot of the shared debug session for Claude to re-sync after
     * the human may have acted: live status/location/threads/breakpoints from VS
     * Code + the DAP session, plus the tracker's recent-action log.
     */
    private async handleGetDebugState(): Promise<any> {
        const breakpoints = this.describeBreakpoints();
        const recentActions = this.tracker.getRecentActions();

        const session = vscode.debug.activeDebugSession;
        if (!session) {
            return { status: 'no-session', session: null, breakpoints, recentActions };
        }

        const state = this.tracker.getState(session.id);
        const isStopped = !!state?.isStopped;

        const result: any = {
            status: isStopped ? 'stopped' : 'running',
            session: { id: session.id, type: session.type, name: session.name },
            reason: state?.reason,
            allThreadsStopped: state?.allThreadsStopped,
            stoppedThread: null,
            location: null,
            threads: [],
            breakpoints,
            recentActions,
        };

        // Live thread list (only meaningful while stopped; tolerate failure).
        try {
            const resp = await session.customRequest('threads');
            const threads = (resp?.threads ?? []).map((t: any) => ({ id: t.id, name: t.name }));
            result.threads = threads;
            if (state?.stoppedThreadId !== undefined) {
                result.stoppedThread =
                    threads.find((t: any) => t.id === state.stoppedThreadId) ??
                    { id: state.stoppedThreadId, name: undefined };
            }
        } catch {
            // not stopped / adapter can't list threads while running
        }

        // Live current source location of the stopped thread's top frame.
        if (isStopped) {
            const threadId = state?.stoppedThreadId ?? (await this.tracker.resolveActiveThreadId(session));
            if (threadId !== undefined) {
                try {
                    const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
                    const top = stack?.stackFrames?.[0];
                    if (top) {
                        result.location = {
                            file: top.source?.path,
                            line: top.line,
                            function: top.name,
                        };
                    }
                } catch {
                    // ignore — location is best-effort
                }
            }
        }

        return result;
    }

    private describeBreakpoints(): any[] {
        return vscode.debug.breakpoints.map((bp) => {
            if (bp instanceof vscode.SourceBreakpoint) {
                return {
                    type: 'source',
                    file: bp.location.uri.fsPath,
                    line: bp.location.range.start.line + 1,
                    enabled: bp.enabled,
                    condition: bp.condition,
                    hitCondition: bp.hitCondition,
                };
            }
            if (bp instanceof vscode.FunctionBreakpoint) {
                return { type: 'function', functionName: bp.functionName, enabled: bp.enabled, condition: bp.condition };
            }
            return { type: 'other', enabled: bp.enabled };
        });
    }

    /**
     * Resolve a {session, threadId, frameId} for a (possibly explicit/selected)
     * target thread. When no thread is specified, defers to the full resolver
     * (which also honors the human's focused frame); otherwise stackTraces the
     * chosen thread and takes its top frame.
     */
    private async resolveFrameForThread(explicitThreadId?: number): Promise<{ session: vscode.DebugSession; threadId: number; frameId: number }> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        if (explicitThreadId === undefined && this.tracker.getSelectedThreadId() === undefined) {
            return this.tracker.resolveActiveFrame();
        }
        const threadId = await this.tracker.resolveTargetThreadId(session, explicitThreadId);
        if (threadId === undefined) {
            throw new Error('Could not determine the target thread (specify threadId or select_thread)');
        }
        const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
        const top = stack?.stackFrames?.[0];
        if (!top) {
            throw new Error(`No stack frames available for thread ${threadId}`);
        }
        return { session, threadId, frameId: top.id };
    }

    /** Run a raw GDB CLI command and return the captured console/stderr output. */
    private async handleGdbExec(payload: { command: string }): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        const command = payload?.command;
        if (!command || !command.trim()) {
            throw new Error('command is required');
        }

        let rejectionMessage = '';
        const { console: out, stderr } = await this.tracker.captureConsoleOutput(async () => {
            // Mark self right before the send (NOT before the queue wait) so the repl
            // evaluate is attributed to claude even if this capture queued behind
            // others. Output arrives as console OutputEvents before the response.
            this.tracker.markSelfActivity();
            try {
                await session.customRequest('evaluate', { expression: command, context: 'repl' });
            } catch (err: any) {
                // A failing command usually emits its error on the console/stderr stream
                // (captured below); keep the rejection message in case it does not.
                rejectionMessage = err instanceof Error ? err.message : String(err);
            }
        });

        const parts = [out, stderr].filter((s) => s && s.trim());
        if (parts.length === 0 && rejectionMessage) {
            parts.push(rejectionMessage);
        }
        return parts.join('\n').trimEnd() || '(no output)';
    }

    /** Read ARM Cortex-M special/system registers (frame-pinned, hex). */
    private async handleReadSpecialReg(payload: { name?: string; threadId?: number }): Promise<any> {
        const { session, threadId, frameId } = await this.resolveFrameForThread(payload?.threadId);
        const state = this.tracker.getState(session.id);
        // The CPU's hardware registers reflect the running context = the stopped thread.
        // Treat the target as "current" only when it IS that thread (conservative: if
        // the stopped thread is unknown, assume non-current to avoid mislabeling).
        const isCurrent = state?.stoppedThreadId !== undefined && threadId === state.stoppedThreadId;

        const names = payload?.name
            ? [payload.name.replace(/^\$/, '')]
            : SPECIAL_REGS;

        const registers: Record<string, string | null> = {};
        for (const name of names) {
            // Don't report the running thread's global registers under a non-current
            // thread's name — that is a silent wrong value.
            if (!isCurrent && GLOBAL_ONLY_REGS.has(name)) {
                registers[name] = null;
                continue;
            }
            try {
                const response = await session.customRequest('evaluate', {
                    expression: `$${name},x`,
                    frameId,
                    context: 'watch',
                });
                const raw: string = (response?.result ?? '').trim();
                // null = not present on this target (GDB returns '<error>'/'<...>' or the
                // literal 'void' for an unknown convenience register, e.g. $psplim on M7),
                // or (for global regs above) not meaningful for a non-current thread.
                registers[name] = !raw || raw === 'void' || raw.startsWith('<') ? null : raw;
            } catch {
                registers[name] = null;
            }
        }

        const result: any = { threadId, currentThread: isCurrent, registers };
        if (!isCurrent) {
            result.note = 'Non-current thread: CPU-global registers (msp/psp/control/primask/basepri/faultmask/msplim/psplim) are null because a single hardware instance reflects only the running thread. sp is the per-thread stack pointer (reconstructed from the saved frame); lr/pc/xpsr are also per-thread but depend on the gdb-server\'s RTOS unwind fidelity.';
        }
        return result;
    }

    /** Set a hardware data watchpoint via GDB (watch/rwatch/awatch). */
    private async handleSetWatchpoint(payload: { expression?: string; expr?: string; kind?: 'write' | 'read' | 'access' }): Promise<string> {
        const expression = payload?.expression ?? payload?.expr;
        if (!expression || !expression.trim()) {
            throw new Error('expression is required');
        }
        const kind = payload.kind ?? 'write';
        const verb = kind === 'read' ? 'rwatch' : kind === 'access' ? 'awatch' : 'watch';

        const out = await this.handleGdbExec({ command: `${verb} ${expression}` });
        // GDB confirms success with e.g. "Hardware watchpoint 3: <expr>",
        // "Hardware read watchpoint 3: ...", "Hardware access (read/write) watchpoint 3: ...".
        // Check for that FIRST so a watched symbol whose name contains "error"/"invalid"
        // (e.g. g_error_flag) is not mis-reported as a failure.
        const succeeded = /watchpoint\s+\d+:/i.test(out);
        const failed = !succeeded && /no symbol .* in current context|cannot|can not|free dwt|no hardware|too many|expression cannot/i.test(out);
        if (failed) {
            return `Watchpoint may have failed (Cortex-M has ~4 DWT comparators): ${out}`;
        }
        return `Set ${kind} watchpoint on ${expression}\n${out}`;
    }

    /** List all threads with their top frame, and which is stopped/selected. */
    private async handleListThreads(): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        const state = this.tracker.getState(session.id);
        const selected = this.tracker.getSelectedThreadId();
        const resp = await session.customRequest('threads');
        const threads: Array<{ id: number; name: string }> = resp?.threads ?? [];

        const result: any[] = [];
        for (const t of threads) {
            const entry: any = {
                id: t.id,
                name: t.name,
                stopped: t.id === state?.stoppedThreadId,
                selected: t.id === selected,
            };
            try {
                const stack = await session.customRequest('stackTrace', { threadId: t.id, startFrame: 0, levels: 1 });
                const top = stack?.stackFrames?.[0];
                if (top) {
                    entry.topFrame = { file: top.source?.path, line: top.line, function: top.name };
                }
            } catch {
                // per-thread stack may be unavailable; leave topFrame absent
            }
            result.push(entry);
        }
        return result;
    }

    /** Select a thread that inspection tools default to (until the next resume). */
    private async handleSelectThread(payload: { threadId: number }): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        if (typeof payload?.threadId !== 'number') {
            throw new Error('threadId (number) is required');
        }
        const resp = await session.customRequest('threads');
        const threads: Array<{ id: number; name: string }> = resp?.threads ?? [];
        const match = threads.find((t) => t.id === payload.threadId);
        if (!match) {
            throw new Error(`No thread with id ${payload.threadId}. Use list_threads to see valid ids.`);
        }
        this.tracker.selectThread(payload.threadId);
        return `Selected thread ${payload.threadId} (${match.name}). Inspection tools default to it until the next resume.`;
    }

    /** Get the call stack of a thread (defaults to the selected/stopped thread). */
    private async handleGetStack(payload: { threadId?: number; levels?: number }): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        const threadId = await this.tracker.resolveTargetThreadId(session, payload?.threadId);
        if (threadId === undefined) {
            throw new Error('Could not determine the target thread (specify threadId or select_thread)');
        }
        const levels = payload?.levels ?? 20;
        const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels });
        const frames = (stack?.stackFrames ?? []).map((f: any) => ({
            id: f.id,
            name: f.name,
            file: f.source?.path,
            line: f.line,
        }));
        return { threadId, frames };
    }

    /** Read the CPU core registers via the 'Registers' scope (frame-pinned). */
    private async handleGetRegisters(payload: { threadId?: number }): Promise<any> {
        const { session, threadId, frameId } = await this.resolveFrameForThread(payload?.threadId);
        const scopesResp = await session.customRequest('scopes', { frameId });
        const regScope = (scopesResp?.scopes ?? []).find((s: any) => s.name === 'Registers');
        if (!regScope) {
            return { threadId, registers: [], note: 'No Registers scope (target not stopped at a cortex-debug frame?)' };
        }
        const varsResp = await session.customRequest('variables', { variablesReference: regScope.variablesReference });
        const registers = (varsResp?.variables ?? []).map((v: any) => ({ name: v.name, value: v.value }));
        return { threadId, registers };
    }

    /** Read in-scope variables (locals/globals/statics), grouped by scope. */
    private async handleGetVariables(payload: { threadId?: number; scope?: string }): Promise<any> {
        const { session, threadId, frameId } = await this.resolveFrameForThread(payload?.threadId);
        const scopesResp = await session.customRequest('scopes', { frameId });
        const scopes = scopesResp?.scopes ?? [];

        const result: any = { threadId, scopes: {} };
        for (const scope of scopes) {
            if (scope.name === 'Registers') {
                continue; // use get_registers for those
            }
            if (payload?.scope && scope.name !== payload.scope) {
                continue;
            }
            const varsResp = await session.customRequest('variables', { variablesReference: scope.variablesReference });
            result.scopes[scope.name] = (varsResp?.variables ?? []).map((v: any) => ({
                name: v.name,
                value: v.value,
                type: v.type,
                variablesReference: v.variablesReference,
            }));
        }
        return result;
    }

    /** Read target memory; returns bytes as hex. */
    private async handleReadMemory(payload: { address: string | number; count?: number; offset?: number }): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        if (payload?.address === undefined || payload.address === '') {
            throw new Error('address is required');
        }
        const memoryReference = String(payload.address);
        const count = payload.count ?? 64;
        const resp = await session.customRequest('readMemory', {
            memoryReference,
            offset: payload.offset ?? 0,
            count,
        });
        const data = resp?.data ? Buffer.from(resp.data, 'base64') : Buffer.alloc(0);
        const hex = (data.toString('hex').match(/../g) ?? []).join(' ');
        return {
            address: resp?.address ?? memoryReference,
            bytes: data.length,
            unreadableBytes: resp?.unreadableBytes,
            hex,
        };
    }

    /** Write target memory from hex bytes. DANGEROUS — mutates live state. */
    private async handleWriteMemory(payload: { address: string | number; data: string }): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        if (payload?.address === undefined || payload.address === '') {
            throw new Error('address is required');
        }
        if (!payload?.data) {
            throw new Error('data (hex bytes) is required');
        }
        const memoryReference = String(payload.address);
        const hex = payload.data.replace(/0x/gi, '').replace(/\s+/g, '');
        if (hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
            throw new Error('data must be an even-length hex string, e.g. "deadbeef"');
        }
        const buf = Buffer.from(hex, 'hex');
        const resp = await session.customRequest('writeMemory', {
            memoryReference,
            data: buf.toString('base64'),
        });
        return { address: memoryReference, bytesWritten: resp?.bytesWritten ?? buf.length };
    }

    /** Read a little-endian u32 from an absolute address (frame-independent). */
    private async readU32(session: vscode.DebugSession, addr: number): Promise<number> {
        const resp = await session.customRequest('readMemory', {
            memoryReference: '0x' + (addr >>> 0).toString(16),
            offset: 0,
            count: 4,
        });
        const data = resp?.data ? Buffer.from(resp.data, 'base64') : Buffer.alloc(0);
        if (data.length < 4) {
            throw new Error(`Could not read 4 bytes at 0x${(addr >>> 0).toString(16)}`);
        }
        return data.readUInt32LE(0);
    }

    /** Map of core/system register name -> numeric value, from the Registers scope. */
    private async readRegisterMap(session: vscode.DebugSession, frameId: number): Promise<Record<string, number>> {
        const scopesResp = await session.customRequest('scopes', { frameId });
        const regScope = (scopesResp?.scopes ?? []).find((s: any) => s.name === 'Registers');
        const map: Record<string, number> = {};
        if (!regScope) {
            return map;
        }
        const varsResp = await session.customRequest('variables', { variablesReference: regScope.variablesReference });
        for (const v of varsResp?.variables ?? []) {
            const raw = String(v.value ?? '').trim();
            const n = parseInt(raw, raw.toLowerCase().startsWith('0x') ? 16 : 10);
            if (!Number.isNaN(n)) {
                map[v.name.toLowerCase()] = n >>> 0;
            }
        }
        return map;
    }

    /**
     * Decode the current ARM Cortex-M fault and recover the pre-fault context.
     * Core-aware: ARMv7-M (M3/M4/M7) and ARMv8-M Mainline (M33/M55/M85) decode
     * CFSR/HFSR (+ STKOF and SecureFault on v8-M); ARMv6-M (M0/M0+) and ARMv8-M
     * Baseline (M23) are HardFault-only (no fault-status registers) so the verdict
     * comes from ICSR.VECTACTIVE + the stacked PC.
     */
    private async handleExplainFault(): Promise<any> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }

        // Detect the core (CPUID PartNo bits[15:4]).
        const cpuid = await this.readU32(session, 0xE000ED00);
        const partno = (cpuid >> 4) & 0xfff;
        const core = CORTEX_CORES[partno] ?? {
            name: `unknown core (CPUID PartNo 0x${partno.toString(16)})`,
            // Architecture field bits[19:16]: 0xF = v7-M/v8-M (has CFSR), 0xC = v6-M.
            configurableFaults: ((cpuid >> 16) & 0xf) === 0xf,
            v8m: false,
        };

        // Current exception (ICSR.VECTACTIVE bits[8:0]).
        const icsr = await this.readU32(session, 0xE000ED04);
        const vectActive = icsr & 0x1ff;
        // Exception 7 is SecureFault only on ARMv8-M with Security; reserved elsewhere.
        const namedException = (vectActive === 7 && !core.v8m) ? undefined : FAULT_EXCEPTIONS[vectActive];
        const currentException = namedException
            ?? (vectActive === 0 ? 'Thread mode' : `exception ${vectActive}`);
        const inFaultHandler = vectActive >= 3 && vectActive <= 7;

        const flags: string[] = [];
        const add = (cond: number, name: string) => { if (cond) { flags.push(name); } };

        // Configurable-fault status block (v7-M / v8-M Mainline only).
        let cfsr = 0, hfsr = 0, dfsr = 0, shcsr = 0;
        let mmarValid = false, bfarValid = false;
        let mmfar: number | undefined, bfar: number | undefined;
        if (core.configurableFaults) {
            cfsr = await this.readU32(session, 0xE000ED28);
            hfsr = await this.readU32(session, 0xE000ED2C);
            dfsr = await this.readU32(session, 0xE000ED30);
            shcsr = await this.readU32(session, 0xE000ED24);
            const mmfsr = cfsr & 0xff;
            const bfsr = (cfsr >> 8) & 0xff;
            const ufsr = (cfsr >> 16) & 0xffff;
            add(mmfsr & 0x01, 'MMFSR.IACCVIOL (instruction access violation)');
            add(mmfsr & 0x02, 'MMFSR.DACCVIOL (data access violation)');
            add(mmfsr & 0x08, 'MMFSR.MUNSTKERR (MemManage unstacking on exception return)');
            add(mmfsr & 0x10, 'MMFSR.MSTKERR (MemManage stacking on exception entry)');
            add(mmfsr & 0x20, 'MMFSR.MLSPERR (MemManage during lazy FP state save)');
            add(bfsr & 0x01, 'BFSR.IBUSERR (instruction bus error)');
            add(bfsr & 0x02, 'BFSR.PRECISERR (precise data bus error)');
            add(bfsr & 0x04, 'BFSR.IMPRECISERR (imprecise data bus error)');
            add(bfsr & 0x08, 'BFSR.UNSTKERR (bus fault on unstacking)');
            add(bfsr & 0x10, 'BFSR.STKERR (bus fault on stacking)');
            add(bfsr & 0x20, 'BFSR.LSPERR (bus fault during lazy FP state save)');
            add(ufsr & 0x0001, 'UFSR.UNDEFINSTR (undefined instruction)');
            add(ufsr & 0x0002, 'UFSR.INVSTATE (invalid EPSR/Thumb state)');
            add(ufsr & 0x0004, 'UFSR.INVPC (invalid PC load via EXC_RETURN)');
            add(ufsr & 0x0008, 'UFSR.NOCP (no coprocessor / FPU not enabled)');
            if (core.v8m) {
                add(ufsr & 0x0010, 'UFSR.STKOF (stack overflow — ARMv8-M; check MSPLIM/PSPLIM)');
            }
            add(ufsr & 0x0100, 'UFSR.UNALIGNED (unaligned access)');
            add(ufsr & 0x0200, 'UFSR.DIVBYZERO (divide by zero)');
            add(hfsr & 0x00000002, 'HFSR.VECTTBL (vector table read fault)');
            add(hfsr & 0x40000000, 'HFSR.FORCED (escalated configurable fault — see CFSR bits)');
            add(hfsr & 0x80000000, 'HFSR.DEBUGEVT (debug event)');
            mmarValid = !!(mmfsr & 0x80);
            bfarValid = !!(bfsr & 0x80);
            mmfar = mmarValid ? await this.readU32(session, 0xE000ED34) : undefined;
            bfar = bfarValid ? await this.readU32(session, 0xE000ED38) : undefined;
        }

        // SecureFault (ARMv8-M with the Security Extension). SFSR reads as 0 from a
        // Non-secure context / without the Main Extension, so only decode if set.
        let sfsr = 0, sfarValid = false;
        let sfar: number | undefined;
        if (core.v8m) {
            sfsr = await this.readU32(session, 0xE000EDE4).catch(() => 0);
            if (sfsr) {
                add(sfsr & 0x01, 'SFSR.INVEP (invalid entry point)');
                add(sfsr & 0x02, 'SFSR.INVIS (invalid integrity signature)');
                add(sfsr & 0x04, 'SFSR.INVER (invalid exception return)');
                add(sfsr & 0x08, 'SFSR.AUVIOL (attribution unit violation)');
                add(sfsr & 0x10, 'SFSR.INVTRAN (invalid transition)');
                add(sfsr & 0x20, 'SFSR.LSPERR (lazy FP preservation error)');
                add(sfsr & 0x80, 'SFSR.LSERR (lazy state error)');
                sfarValid = !!(sfsr & 0x40);
                sfar = sfarValid ? await this.readU32(session, 0xE000EDE8).catch(() => undefined) : undefined;
            }
        }

        const faultActive = inFaultHandler || cfsr !== 0 || hfsr !== 0 || sfsr !== 0;
        if (!faultActive) {
            const result: any = {
                fault: false,
                core: core.name,
                currentException,
                vectActive,
                summary: core.configurableFaults
                    ? `No active fault on ${core.name}: CFSR/HFSR are 0 and not in a fault handler — a "stopped: exception" here is benign (debug/step event or ISR entry).`
                    : `No active fault on ${core.name}: not in a fault handler (VECTACTIVE=${vectActive}). This core is HardFault-only (no fault-status registers).`,
            };
            if (core.configurableFaults) {
                Object.assign(result, { cfsr: hex32(cfsr), hfsr: hex32(hfsr), dfsr: hex32(dfsr), shcsr: hex32(shcsr) });
            }
            return result;
        }

        const ctx = await this.recoverStackedContext(session, core.v8m);

        let summary: string;
        if (!core.configurableFaults) {
            summary = `${currentException} on ${core.name} (HardFault-only architecture — no fault-status registers; diagnose from the faulting PC).`;
        } else {
            summary = `${inFaultHandler ? currentException : 'Fault'} on ${core.name}: ${flags.join('; ') || 'no decoded sub-bits set'}.`;
        }
        if (mmarValid) { summary += ` MMFAR=${hex32(mmfar!)}.`; }
        if (bfarValid) { summary += ` BFAR=${hex32(bfar!)}.`; }
        if (sfarValid) { summary += ` SFAR=${hex32(sfar!)}.`; }
        if (ctx.faultingPc) { summary += ` Faulting PC=${ctx.faultingPc}${ctx.sourceLine ? ' — ' + ctx.sourceLine : ''}.`; }
        if (core.configurableFaults && ((cfsr >> 8) & 0x04)) {
            summary += ' NOTE: imprecise bus fault — the faulting PC is approximate (write buffer not yet drained).';
        }

        const result: any = {
            fault: true,
            core: core.name,
            currentException,
            summary,
            flags,
            faultingContext: ctx,
        };
        if (core.configurableFaults) {
            Object.assign(result, {
                cfsr: hex32(cfsr), hfsr: hex32(hfsr), dfsr: hex32(dfsr), shcsr: hex32(shcsr),
                mmfar: { valid: mmarValid, address: mmfar !== undefined ? hex32(mmfar) : null },
                bfar: { valid: bfarValid, address: bfar !== undefined ? hex32(bfar) : null },
            });
        }
        if (sfsr) {
            result.sfsr = hex32(sfsr);
            result.sfar = { valid: sfarValid, address: sfar !== undefined ? hex32(sfar) : null };
        }
        return result;
    }

    /**
     * Recover the pre-fault context from the stacked exception frame. Uses the
     * stopped thread's TOP (handler) frame so $lr is the live EXC_RETURN. Frame
     * layout (R0,R1,R2,R3,R12,LR,PC,xPSR) is identical across ARMv6/7/8-M. On
     * ARMv8-M with TrustZone, EXC_RETURN bit6 (S) selects the secure stack bank.
     */
    private async recoverStackedContext(session: vscode.DebugSession, v8m: boolean): Promise<any> {
        const ctx: any = {};
        try {
            const threadId = await this.tracker.resolveActiveThreadId(session);
            const stack = threadId !== undefined
                ? await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 })
                : undefined;
            const topFrameId = stack?.stackFrames?.[0]?.id;
            if (topFrameId === undefined) {
                ctx.note = 'No stopped frame available.';
                return ctx;
            }
            const regs = await this.readRegisterMap(session, topFrameId);
            const lr = regs['lr'];
            if (lr === undefined || (lr >>> 24) !== 0xff) {
                ctx.note = '$lr is not an EXC_RETURN — not stopped in the fault handler? Pre-fault context unavailable.';
                return ctx;
            }
            const useProcessStack = !!(lr & 0x4);  // EXC_RETURN bit 2 (SPSEL)
            const basicFrame = !!(lr & 0x10);      // bit 4 (FType): 1 = basic (no FP), 0 = extended
            const secure = v8m && !!(lr & 0x40);   // bit 6 (S): frame on the Secure stack
            let sp: number | undefined;
            if (secure) {
                sp = useProcessStack ? (regs['psp_s'] ?? regs['psp']) : (regs['msp_s'] ?? regs['msp']);
            } else {
                sp = useProcessStack ? regs['psp'] : regs['msp'];
            }
            ctx.excReturn = hex32(lr);
            ctx.stack = (useProcessStack ? 'PSP' : 'MSP') + (secure ? '_S' : '');
            ctx.fpFrame = !basicFrame;
            if (sp === undefined) {
                ctx.note = `Could not read ${ctx.stack} to locate the stacked frame.`;
                return ctx;
            }
            const resp = await session.customRequest('readMemory', { memoryReference: hex32(sp), offset: 0, count: 32 });
            const f = resp?.data ? Buffer.from(resp.data, 'base64') : Buffer.alloc(0);
            if (f.length < 32) {
                ctx.note = 'Could not read the stacked exception frame.';
                return ctx;
            }
            const stackedPc = f.readUInt32LE(24);
            ctx.r0 = hex32(f.readUInt32LE(0));
            ctx.r1 = hex32(f.readUInt32LE(4));
            ctx.r2 = hex32(f.readUInt32LE(8));
            ctx.r3 = hex32(f.readUInt32LE(12));
            ctx.r12 = hex32(f.readUInt32LE(16));
            ctx.faultingLr = hex32(f.readUInt32LE(20));
            ctx.faultingPc = hex32(stackedPc);
            ctx.xpsr = hex32(f.readUInt32LE(28));
            try {
                const info = await this.handleGdbExec({ command: `info line *${hex32(stackedPc)}` });
                ctx.sourceLine = info.split('\n')[0];
            } catch {
                // best-effort source line
            }
        } catch (err: any) {
            ctx.note = `Could not recover pre-fault context: ${err instanceof Error ? err.message : String(err)}`;
        }
        return ctx;
    }

    /**
     * Drive flow control via the native VS Code command so the human watches the
     * highlighted line move, exactly as if they had clicked the toolbar (raw
     * customRequest stepping would not "follow" the editor the same way). The
     * command acts on the focused thread, which VS Code auto-focuses to the stopped
     * thread on each stop. Arms a stop-waiter first, then reports the new location.
     */
    private async runFlowCommand(command: string, verb: string): Promise<string> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }

        const stopped = this.tracker.waitForStop();
        this.tracker.markSelfActivity();
        await vscode.commands.executeCommand(command);
        const didStop = await stopped;
        if (!didStop) {
            if (!vscode.debug.activeDebugSession) {
                return `${verb}: target exited / session ended`;
            }
            return `${verb} issued, but no stop within timeout — target may still be running`;
        }

        // Report where execution landed, on the now-stopped thread. The reason is
        // surfaced so that if an unrelated stop won the race (e.g. a human pause or
        // another breakpoint), it is visible rather than silently mislabeled.
        const state = this.tracker.getState(session.id);
        const threadId = state?.stoppedThreadId ?? (await this.tracker.resolveActiveThreadId(session));
        const reason = state?.reason ? ` [${state.reason}]` : '';
        if (threadId !== undefined) {
            try {
                const stack = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 1 });
                const top = stack?.stackFrames?.[0];
                if (top) {
                    return `${verb} → ${top.source?.path ?? '?'}:${top.line} (${top.name})${reason}`;
                }
            } catch {
                // best-effort location
            }
        }
        return `${verb} complete${reason}`;
    }

    private async handleDebug(payload: { steps: DebugStep[] }): Promise<string[]> {
        const results: string[] = [];

        for (const step of payload.steps) {
            switch (step.type) {
                case 'setBreakpoint': {
                    if (!step.line) {
                        throw new Error('Line number required');
                    }
                    if (!step.file) {
                        throw new Error('File path required');
                    }

                    // Open the file and make it active
                    const document = await vscode.workspace.openTextDocument(step.file);
                    const editor = await vscode.window.showTextDocument(document);

                    const bp = new vscode.SourceBreakpoint(
                        new vscode.Location(
                            editor.document.uri,
                            new vscode.Position(step.line - 1, 0)
                        ),
                        true,
                        step.condition,
                    );
                    this.tracker.markSelfBreakpoints([bp]);
                    await vscode.debug.addBreakpoints([bp]);
                    results.push(`Set breakpoint at line ${step.line}`);
                    break;
                }

                case 'removeBreakpoint': {
                    if (!step.line) {
                        throw new Error('Line number required');
                    }
                    const bps = vscode.debug.breakpoints.filter(bp => {
                        if (bp instanceof vscode.SourceBreakpoint) {
                            return bp.location.range.start.line === step.line! - 1;
                        }
                        return false;
                    });
                    this.tracker.markSelfBreakpoints(bps);
                    await vscode.debug.removeBreakpoints(bps);
                    results.push(`Removed breakpoint at line ${step.line}`);
                    break;
                }

                case 'continue': {
                    const session = vscode.debug.activeDebugSession;
                    if (!session) {
                        throw new Error('No active debug session');
                    }

                    // Continue the thread that is actually stopped (resolved from the
                    // `stopped` event), not threads[0]. On an all-stop Cortex-M target
                    // this resumes the core; allThreadsContinued typically comes back true.
                    const threadId = await this.tracker.resolveActiveThreadId(session);
                    if (threadId === undefined) {
                        throw new Error('No threads available to continue');
                    }

                    this.tracker.markSelfActivity();
                    await session.customRequest('continue', { threadId });
                    results.push('Continued execution');
                    break;
                }

                case 'stepOver': {
                    results.push(await this.runFlowCommand('workbench.action.debug.stepOver', 'Stepped over'));
                    break;
                }

                case 'stepInto': {
                    results.push(await this.runFlowCommand('workbench.action.debug.stepInto', 'Stepped into'));
                    break;
                }

                case 'stepOut': {
                    results.push(await this.runFlowCommand('workbench.action.debug.stepOut', 'Stepped out'));
                    break;
                }

                case 'pause': {
                    // Pausing an already-stopped target is a no-op that emits no
                    // `stopped` event — short-circuit so we don't wait for a stop
                    // that never comes.
                    const session = vscode.debug.activeDebugSession;
                    if (session && this.tracker.getState(session.id)?.isStopped) {
                        results.push('Already paused');
                        break;
                    }
                    results.push(await this.runFlowCommand('workbench.action.debug.pause', 'Paused'));
                    break;
                }

                case 'evaluate': {
                    // Resolve the correct stopped thread + frame from session state.
                    // This replaces the old hardcoded `threadId: 1`, which broke under
                    // multi-thread (RTOS) targets where the stopped thread is rarely id 1.
                    let session: vscode.DebugSession;
                    let frameId: number;
                    try {
                        ({ session, frameId } = await this.tracker.resolveActiveFrame());
                    } catch (err: any) {
                        results.push(`ERROR: Could not resolve a stopped frame for "${step.expression}": ${err instanceof Error ? err.message : String(err)}`);
                        break;
                    }

                    try {
                        // Use 'watch' context, NOT 'repl'. cortex-debug's repl path runs
                        // the input as `interpreter-exec console`, emits the value to the
                        // Debug Console as an OutputEvent, and returns a valueless serialized
                        // node in response.result (the "relay bug") — and it ignores frameId.
                        // The 'watch' path evaluates the expression via a var-object, returns
                        // the value in response.result, and honors frameId (frame-pinned to
                        // the resolved RTOS thread/frame). It is also the portable DAP context
                        // (debugpy etc.). Trade-off: GDB CLI verbs ('p/x', 'info registers',
                        // 'x/...', 'monitor ...') are NOT valid here — those move to the
                        // Phase 4 gdb_exec tool (repl + OutputEvent capture). Use bare
                        // expressions; for hex, append a ',x' format suffix.
                        const response = await session.customRequest('evaluate', {
                            expression: step.expression,
                            frameId: frameId,
                            context: 'watch'
                        });

                        results.push(`Evaluated "${step.expression}": ${response.result}`);
                    } catch (err: any) {
                        let errorMessage = '';
                        let stackTrace = '';

                        if (err instanceof Error) {
                            errorMessage = err.message;
                            if (err.stack) {
                                stackTrace = `\nStack: ${err.stack}`;
                            }
                        } else {
                            errorMessage = String(err);
                        }
                        results.push(`ERROR: Evaluation failed for "${step.expression}": ${errorMessage}${stackTrace}`);
                    }
                    break;
                }

                case 'launch': {
                    if (!step.file) {
                        throw new Error('File path required for launch');
                    }
                    await this.handleLaunch({ program: step.file });
                    break;
                }
            }
        }

        return results;
    }

    stop(): Promise<void> {
        return new Promise((resolve) => {
            if (!this.server) {
                this._isRunning = false;
                this.emit('stopped');
                resolve();
                return;
            }

            Object.values(this.activeTransports).forEach(transport => {
                transport.close();
            });
            this.activeTransports = {};

            Object.values(this.streamableTransports).forEach(transport => {
                transport.close();
            });
            this.streamableTransports = {};

            this.server.close(() => {
                this.server = null;
                this._isRunning = false;
                this.emit('stopped');
                resolve();
            });
        });
    }
}
