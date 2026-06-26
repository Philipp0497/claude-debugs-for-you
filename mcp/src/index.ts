import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Try to read port from config file, fallback to default
function getPortFromConfig(): number {
    try {
        // Determine the global storage path based on platform
        let storagePath: string;
        const homeDir = os.homedir();
        
        if (process.platform === 'darwin') {
            storagePath = path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
        } else if (process.platform === 'win32') {
            storagePath = path.join(homeDir, 'AppData', 'Roaming', 'Code', 'User', 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
        } else {
            // Linux and others
            storagePath = path.join(homeDir, '.config', 'Code', 'User', 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
        }
        
        const configPath = path.join(storagePath, 'port-config.json');
        
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (config && typeof config.port === 'number') {
                return config.port;
            }
        }
    } catch (error) {
        console.error('Error reading port config:', error);
    }
    
    return 4711; // Default port
}

async function makeRequest(payload: any): Promise<any> {
    const port = getPortFromConfig();
    
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(payload);
        
        const req = http.request({
            hostname: 'localhost',
            port,
            path: '/tcp',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data)
            }
        }, res => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const response = JSON.parse(body);
                    if (!response.success) {
                        reject(new Error(response.error || 'Unknown error'));
                    } else {
                        resolve(response.data);
                    }
                } catch (err) {
                    reject(err);
                }
            });
        });

        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

const server = new Server(
    {
        name: "mcp-debug-server",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
        },
    }
);


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

const explainFaultDescription = `Decode the current ARM Cortex-M fault on the SHARED session. Auto-detects
the core via CPUID. On ARMv7-M (M3/M4/M7) and ARMv8-M Mainline (M33/M55/M85): decodes CFSR/HFSR/MMFAR/BFAR
(+ UFSR.STKOF stack-overflow and SecureFault SFSR/SFAR on v8-M) into plain English. On ARMv6-M (M0/M0+)
and ARMv8-M Baseline (M23): HardFault-only — verdict from ICSR.VECTACTIVE + the stacked PC. Always recovers
the PRE-FAULT context (faulting PC/LR/xPSR + R0-R3/R12) from the stacked exception frame via EXC_RETURN,
with the source line. Returns {fault:false} for a benign 'exception' stop. Call while stopped in the handler.`;

const startSessionDescription = `Launch the debug session on the SHARED setup from a launch.json
configuration (works with launch OR attach configs). REFUSES if a session is already active — use
restart_session to relaunch. After launch the target typically halts at entry/main; the result reports
whether it stopped. 'config' defaults to the first launch.json configuration. This is a VISIBLE action.`;

const restartSessionDescription = `(Re)launch the debug session on the SHARED setup: stops any active
session, then starts the named (or first) launch.json configuration. Use this to recover the session
yourself after a destructive test (a forced fault, a reflash) instead of asking the human to reload VS
Code. Reports whether the target halted at entry. 'config' defaults to the first launch.json configuration.`;

// Zod schemas for the tools
const listFilesInputSchema = {
    type: "object",
    properties: {
        includePatterns: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns to include (e.g. ['**/*.js'])"
        },
        excludePatterns: {
            type: "array",
            items: { type: "string" },
            description: "Glob patterns to exclude (e.g. ['node_modules/**'])"
        }
    }
};

const getFileContentInputSchema = {
    type: "object",
    properties: {
        path: {
            type: "string",
            description: "Path to the file. IT MUST BE AN ABSOLUTE PATH AND MATCH THE OUTPUT OF listFiles"
        }
    },
    required: ["path"]
};

const debugStepSchema = {
    type: "array",
    items: {
        type: "object",
        properties: {
            type: {
                type: "string",
                enum: ["setBreakpoint", "removeBreakpoint", "continue", "evaluate", "launch", "stepOver", "stepInto", "stepOut", "pause"],
                description: ""
            },
            file: { type: "string", description: "File path. Required for setBreakpoint and launch; ignored by flow-control/evaluate steps." },
            line: { type: "number" },
            expression: {
                description: "A bare expression to evaluate in the resolved stopped frame (e.g. a variable name, '&symbol', '$pc', '$sp'). NOT a debugger CLI command: 'p/x ...', 'info registers', 'x/...', 'monitor ...' are not supported here. For hex output append a ',x' format suffix (e.g. 'value,x').",
                type: "string"
            },
            condition: {
                description: "If needed, a breakpoint condition may be specified to only stop on a breakpoint for some given condition.",
                type: "string"
            },
        },
        required: ["type"]
    }
};

const debugInputSchema = {
    type: "object",
    properties: {
        steps: debugStepSchema
    },
    required: ["steps"]
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
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "gdb_exec",
        description: gdbExecDescription,
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Raw GDB CLI command, e.g. 'info registers', 'x/16xw $sp', 'bt', 'monitor reset halt'." }
            },
            required: ["command"]
        },
    },
    {
        name: "read_special_reg",
        description: readSpecialRegDescription,
        inputSchema: {
            type: "object",
            properties: {
                name: { type: "string", description: "Register name without '$' (e.g. 'msp', 'psp', 'psplim', 'control'). Omit to read the standard set." },
                threadId: { type: "number", description: "Thread to read from; defaults to the selected/stopped thread." }
            }
        },
    },
    {
        name: "set_watchpoint",
        description: setWatchpointDescription,
        inputSchema: {
            type: "object",
            properties: {
                expression: { type: "string", description: "Expression or address to watch, e.g. 'g_counter' or '*(uint32_t*)0x20000010'." },
                expr: { type: "string", description: "Alias for 'expression'." },
                kind: { type: "string", enum: ["write", "read", "access"], description: "write (default), read, or access (both)." }
            }
        },
    },
    {
        name: "list_threads",
        description: listThreadsDescription,
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "select_thread",
        description: selectThreadDescription,
        inputSchema: {
            type: "object",
            properties: {
                threadId: { type: "number", description: "Thread id from list_threads." }
            },
            required: ["threadId"]
        },
    },
    {
        name: "get_stack",
        description: getStackDescription,
        inputSchema: {
            type: "object",
            properties: {
                threadId: { type: "number", description: "Thread to get the stack for; defaults to the selected/stopped thread." },
                levels: { type: "number", description: "Max number of frames (default 20)." }
            }
        },
    },
    {
        name: "get_registers",
        description: getRegistersDescription,
        inputSchema: {
            type: "object",
            properties: {
                threadId: { type: "number", description: "Thread to read from; defaults to the selected/stopped thread." }
            }
        },
    },
    {
        name: "get_variables",
        description: getVariablesDescription,
        inputSchema: {
            type: "object",
            properties: {
                threadId: { type: "number", description: "Thread to read from; defaults to the selected/stopped thread." },
                scope: { type: "string", description: "Only return this scope (e.g. 'Local'). Omit for all non-register scopes." }
            }
        },
    },
    {
        name: "read_memory",
        description: readMemoryDescription,
        inputSchema: {
            type: "object",
            properties: {
                address: { type: "string", description: "Address as a hex string or decimal, e.g. '0x20000000'." },
                count: { type: "number", description: "Number of bytes to read (default 64)." },
                offset: { type: "number", description: "Byte offset from address (default 0)." }
            },
            required: ["address"]
        },
    },
    {
        name: "write_memory",
        description: writeMemoryDescription,
        inputSchema: {
            type: "object",
            properties: {
                address: { type: "string", description: "Address as a hex string or decimal, e.g. '0x20000000'." },
                data: { type: "string", description: "Hex bytes to write, e.g. 'deadbeef' or 'de ad be ef'." }
            },
            required: ["address", "data"]
        },
    },
    {
        name: "explain_fault",
        description: explainFaultDescription,
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "start_session",
        description: startSessionDescription,
        inputSchema: {
            type: "object",
            properties: {
                config: { type: "string", description: "launch.json configuration name (launch or attach); defaults to the first." }
            }
        },
    },
    {
        name: "restart_session",
        description: restartSessionDescription,
        inputSchema: {
            type: "object",
            properties: {
                config: { type: "string", description: "launch.json configuration name (launch or attach); defaults to the first." }
            }
        },
    },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const response = await makeRequest({
        type: 'callTool',
        tool: request.params.name,
        arguments: request.params.arguments
    });

    let text: string;
    if (Array.isArray(response) && response.every((x) => typeof x === "string")) {
        // String arrays (debug step results, listFiles) join as lines.
        text = response.join("\n");
    } else if (typeof response === "string") {
        text = response;
    } else {
        // Structured tool results (get_debug_state, list_threads, get_stack,
        // read_special_reg) come back as objects/arrays-of-objects.
        text = JSON.stringify(response, null, 2);
    }

    return {
        content: [{
            type: "text",
            text
        }]
    };
});

function sleep(ms: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

async function main() {
    try {
        const transport = new StdioServerTransport();
        await server.connect(transport);
        console.error("MCP Debug Server running");
        return true;
    } catch (error) {
        console.error("Error starting server:", error);
        return false;
    }
}

// Only try up to 10 times
const MAX_RETRIES = 10;

// Wait 500ms before each subsequent check
const TIMEOUT = 500;

// Wait 500ms before first check
const INITIAL_DELAY = 500;

(async function() {
    await sleep(INITIAL_DELAY);

    for (let i = 0; i < MAX_RETRIES; i++) {
        const success = await main();
        if (success) {
            break;
        }
        await sleep(TIMEOUT);
    }
})();

