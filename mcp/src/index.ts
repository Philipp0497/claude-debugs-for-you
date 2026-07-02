import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Thin stdio -> HTTP proxy. It owns NO tool definitions: both the tool list
 * and every call are forwarded to the extension's /tcp endpoint, so the
 * extension's tool registry is the single source of truth. The extension must
 * be running (status-bar ✓) — that was already true for calls; now tools/list
 * needs it too.
 */

// Product flavors that may host the extension, in preference order.
const VSCODE_FLAVORS = ['Code', 'Code - Insiders', 'VSCodium', 'Code - OSS'];

function candidateStoragePaths(): string[] {
    const homeDir = os.homedir();
    return VSCODE_FLAVORS.map((flavor) => {
        let userDir: string;
        if (process.platform === 'darwin') {
            userDir = path.join(homeDir, 'Library', 'Application Support', flavor, 'User');
        } else if (process.platform === 'win32') {
            userDir = path.join(homeDir, 'AppData', 'Roaming', flavor, 'User');
        } else {
            // Linux and others
            userDir = path.join(homeDir, '.config', flavor, 'User');
        }
        return path.join(userDir, 'globalStorage', 'jasonmcghee.claude-debugs-for-you');
    });
}

// Port resolution: env override, then the first flavor's port-config.json, then default.
function getPortFromConfig(): number {
    const envPort = Number(process.env.CLAUDE_DEBUGS_PORT);
    if (Number.isInteger(envPort) && envPort > 0) {
        return envPort;
    }
    for (const storagePath of candidateStoragePaths()) {
        try {
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

server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Forward to the extension so this proxy never drifts from its registry.
    const response = await makeRequest({ type: 'listTools' });
    return { tools: response.tools };
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
