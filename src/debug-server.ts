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
    type: 'setBreakpoint' | 'removeBreakpoint' | 'continue' | 'evaluate' | 'launch';
    file: string;
    line?: number;
    expression?: string;
    condition?: string;
}

interface ToolRequest {
    type: 'listTools' | 'callTool';
    tool?: string;
    arguments?: any;
}

const debugDescription = `Execute a debug plan with breakpoints, launch, continues, and expression 
evaluation. ONLY SET BREAKPOINTS BEFORE LAUNCHING OR WHILE PAUSED. Be careful to keep track of where 
you are, if paused on a breakpoint. Make sure to find and get the contents of any requested files. 
Only use continue when ready to move to the next breakpoint. Launch will bring you to the first 
breakpoint. DO NOT USE CONTINUE TO GET TO THE FIRST BREAKPOINT.`;

const listFilesDescription = "List all files in the workspace. Use this to find any requested files.";

const getFileContentDescription = `Get file content with line numbers - you likely need to list files
to understand what files are available. Be careful to use absolute paths.`;

const getDebugStateDescription = `Get the current state of the SHARED debug session: running/stopped, stop
reason, the active stopped thread, current source location, all threads, all breakpoints, and a log of
recent actions (each tagged human or claude). The session is SHARED with a human who may step, set
breakpoints, or change focus at any time — call this after any pause in your activity to re-sync before
acting on a stale picture.`;

// Zod schemas for the tools
const getDebugStateInputSchema = {};

const listFilesInputSchema = {
    includePatterns: z.array(z.string()).describe("Glob patterns to include (e.g. ['**/*.js'])").optional(),
    excludePatterns: z.array(z.string()).describe("Glob patterns to exclude (e.g. ['node_modules/**'])").optional(),
};

const getFileContentInputSchema = {
    path: z.string().describe("Path to the file. IT MUST BE AN ABSOLUTE PATH AND MATCH THE OUTPUT OF listFiles"),
};

const debugStepSchema = z.object({
    type: z.enum(["setBreakpoint", "removeBreakpoint", "continue", "evaluate", "launch"]).describe(""),
    file: z.string(),
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
                    await this.handleLaunch({ program: step.file });
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
