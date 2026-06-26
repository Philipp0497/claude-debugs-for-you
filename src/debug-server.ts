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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
];
export class DebugServer extends EventEmitter implements DebugServerEvents {
    private server: net.Server | null = null;
    private port: number = 4711;
    private portConfigPath: string | null = null;
    private activeTransports: Record<string, SSEServerTransport> = {};
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
        this.mcpServer = new McpServer({
            name: "Debug Server",
            version: "1.0.0",
        });

        // Setup MCP tools to use our existing handlers
        this.mcpServer.tool("listFiles", listFilesDescription, listFilesInputSchema, async (args: any) => {
            const files = await this.handleListFiles(args);
            return { content: [{ type: "text", text: JSON.stringify(files) }] };
        });

        this.mcpServer.tool("getFileContent", getFileContentDescription, getFileContentInputSchema, async (args: any) => {
            const content = await this.handleGetFile(args);
            return { content: [{ type: "text", text: content }] };
        });

        this.mcpServer.tool("debug", debugDescription, debugInputSchema, async (args: any) => {
            const results = await this.handleDebug(args);
            return { content: [{ type: "text", text: results.join('\n') }] };
        });

        this.mcpServer.tool("get_debug_state", getDebugStateDescription, getDebugStateInputSchema, async () => {
            const state = await this.handleGetDebugState();
            return { content: [{ type: "text", text: JSON.stringify(state, null, 2) }] };
        });

        this.mcpServer.tool("gdb_exec", gdbExecDescription, gdbExecInputSchema, async (args: any) => {
            const out = await this.handleGdbExec(args);
            return { content: [{ type: "text", text: out }] };
        });

        this.mcpServer.tool("read_special_reg", readSpecialRegDescription, readSpecialRegInputSchema, async (args: any) => {
            const regs = await this.handleReadSpecialReg(args);
            return { content: [{ type: "text", text: JSON.stringify(regs, null, 2) }] };
        });

        this.mcpServer.tool("set_watchpoint", setWatchpointDescription, setWatchpointInputSchema, async (args: any) => {
            const result = await this.handleSetWatchpoint(args);
            return { content: [{ type: "text", text: result }] };
        });

        this.mcpServer.tool("list_threads", listThreadsDescription, listThreadsInputSchema, async () => {
            const threads = await this.handleListThreads();
            return { content: [{ type: "text", text: JSON.stringify(threads, null, 2) }] };
        });

        this.mcpServer.tool("select_thread", selectThreadDescription, selectThreadInputSchema, async (args: any) => {
            const result = await this.handleSelectThread(args);
            return { content: [{ type: "text", text: result }] };
        });

        this.mcpServer.tool("get_stack", getStackDescription, getStackInputSchema, async (args: any) => {
            const stack = await this.handleGetStack(args);
            return { content: [{ type: "text", text: JSON.stringify(stack, null, 2) }] };
        });
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
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', '*');

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

            // SSE endpoint
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

            this.server.close(() => {
                this.server = null;
                this._isRunning = false;
                this.emit('stopped');
                resolve();
            });
        });
    }
}
