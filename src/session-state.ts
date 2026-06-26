import * as vscode from 'vscode';

/**
 * Live, single-source-of-truth model of "where the debug session is".
 *
 * The session is SHARED: a human drives via the VS Code UI and an MCP client
 * (Claude) drives via tools on the very same `vscode.debug.activeDebugSession`.
 * The human may step, set breakpoints, or change the focused frame between any
 * two MCP tool calls, so every read must reconcile against the latest state
 * captured here rather than against a hardcoded thread/frame.
 *
 * Phase 1 deliberately keeps this minimal: it tracks only what is needed to
 * resolve the correct stopped thread + top frame for inspection. Phase 2 will
 * extend the tracker with human-action observation (`onWillReceiveMessage`), a
 * ring buffer of recent actions, and a `get_debug_state` tool.
 */
export interface SessionState {
    /** `DebugSession.id` */
    sessionId: string;
    /** `DebugSession.type`, e.g. 'cortex-debug' */
    sessionType: string;
    /** True between a `stopped` event and the next `continued`/`terminated`. */
    isStopped: boolean;
    /**
     * Thread id from the last `stopped` event body. Authoritative for "which
     * thread is stopped". May be undefined if the adapter omitted it (the DAP
     * `threadId` field on `stopped` is optional). Under an RTOS (ThreadX) this
     * is a TCB-pointer id, NOT a 1..N index — never assume 1.
     */
    stoppedThreadId?: number;
    /** `reason` from the last `stopped` event (open string, e.g. 'breakpoint'). */
    reason?: string;
    /** `allThreadsStopped` from the last `stopped` event. */
    allThreadsStopped?: boolean;
    /** Within-stop cache of the last resolved top frame id (invalidated on each stop). */
    selectedFrameId?: number;
}

/** A fully resolved inspection target for the current stop. */
export interface ResolvedFrame {
    session: vscode.DebugSession;
    threadId: number;
    frameId: number;
}

/**
 * The debug type(s) the tracker attaches to. '*' matches every debug adapter,
 * which keeps the fix generic (it also fixes multi-thread targets for other
 * adapters). Phase 2 will make this configurable.
 */
const TRACKED_DEBUG_TYPE = '*';

export class SessionStateTracker {
    private readonly states = new Map<string, SessionState>();

    /**
     * Register the DebugAdapterTracker factory and session-lifecycle listeners.
     * Must be called from the extension host (it has `context`). The factory is
     * created once per session and observes the raw DAP traffic read-only.
     */
    register(context: vscode.ExtensionContext): void {
        context.subscriptions.push(
            vscode.debug.registerDebugAdapterTrackerFactory(TRACKED_DEBUG_TYPE, {
                createDebugAdapterTracker: (session) => {
                    this.ensure(session);
                    return {
                        onDidSendMessage: (message: any) => this.onDidSendMessage(session, message),
                    };
                },
            }),
            vscode.debug.onDidStartDebugSession((session) => {
                this.ensure(session);
            }),
            vscode.debug.onDidTerminateDebugSession((session) => {
                this.states.delete(session.id);
            }),
        );
    }

    /** Read the tracked state for a session (used by future get_debug_state). */
    getState(sessionId: string): SessionState | undefined {
        return this.states.get(sessionId);
    }

    private ensure(session: vscode.DebugSession): SessionState {
        let state = this.states.get(session.id);
        if (!state) {
            state = {
                sessionId: session.id,
                sessionType: session.type,
                isStopped: false,
            };
            this.states.set(session.id, state);
        }
        return state;
    }

    /**
     * Update state from adapter -> editor DAP messages. Phase 1 only needs the
     * `stopped`/`continued`/`terminated` events to know the active stopped thread.
     */
    private onDidSendMessage(session: vscode.DebugSession, message: any): void {
        if (!message || message.type !== 'event') {
            return;
        }
        const state = this.ensure(session);
        const body = message.body ?? {};

        switch (message.event) {
            case 'stopped': {
                state.isStopped = true;
                // threadId is optional on `stopped`; keep the previous value if omitted.
                if (typeof body.threadId === 'number') {
                    state.stoppedThreadId = body.threadId;
                }
                state.reason = body.reason;
                state.allThreadsStopped = !!body.allThreadsStopped;
                // Frame ids are reissued on every stop — drop any cached value.
                state.selectedFrameId = undefined;
                break;
            }
            case 'continued': {
                // allThreadsContinued omitted or true => every thread resumed.
                const allContinued = body.allThreadsContinued !== false;
                if (allContinued || body.threadId === state.stoppedThreadId) {
                    this.markRunning(state);
                }
                break;
            }
            case 'terminated':
            case 'exited': {
                this.markRunning(state);
                break;
            }
        }
    }

    private markRunning(state: SessionState): void {
        state.isStopped = false;
        state.stoppedThreadId = undefined;
        state.reason = undefined;
        state.allThreadsStopped = undefined;
        state.selectedFrameId = undefined;
    }

    /**
     * Resolve the active stopped thread + top/selected frame for inspection
     * (scopes / variables / evaluate). Ordered fallback; never hardcodes a thread
     * and never silently guesses on a multi-thread target.
     *
     *   1. Authoritative: the stopped thread captured from the DAP `stopped` event.
     *   2. UI hint: `vscode.debug.activeStackItem` for THIS session — but only while
     *      the session is not known to have resumed (a focused frame from a previous
     *      stop is stale), and only when the focused frame is on the authoritative
     *      stopped thread (a hint pointing at another thread is stale). A focused
     *      DebugStackFrame yields an exact frame; a DebugThread contributes its threadId.
     *   3. Last resort: query threads — take the single thread if unambiguous, else
     *      refuse (no recent stop / no focus on a multi-thread target). Never `threadId: 1`.
     *   4. stackTrace the resolved thread and take the top frame.
     */
    async resolveActiveFrame(): Promise<ResolvedFrame> {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
            throw new Error('No active debug session');
        }
        const state = this.states.get(session.id);

        // (1) Authoritative stopped thread.
        let threadId: number | undefined = state?.isStopped ? state.stoppedThreadId : undefined;

        // (2) UI focus hint. Consult it only if the tracker does NOT know the
        //     session has resumed — a focused frame left over from a previous stop
        //     is stale (frame ids are reissued each stop). `state?.isStopped !== false`
        //     also allows the hint when there is no tracked state yet.
        if (state?.isStopped !== false) {
            const item = vscode.debug.activeStackItem;
            if (item && item.session.id === session.id) {
                if (item instanceof vscode.DebugStackFrame && typeof item.frameId === 'number') {
                    // Honor an explicitly focused frame, but only when it is on the
                    // authoritative stopped thread (or no thread is known yet). A hint
                    // pointing at a different thread is stale (e.g. resumed in A, just
                    // re-stopped in B before VS Code re-pointed the focus) — fall
                    // through and stackTrace the real stopped thread instead.
                    if (threadId === undefined || item.threadId === threadId) {
                        if (state) {
                            state.selectedFrameId = item.frameId;
                        }
                        return { session, threadId: item.threadId, frameId: item.frameId };
                    }
                } else if (item instanceof vscode.DebugThread && threadId === undefined) {
                    threadId = item.threadId;
                }
            }
        }

        // (3) Last resort: query threads. Refuse to GUESS on a multi-thread target —
        //     threads[0] is frequently the idle thread under an RTOS, which would
        //     silently inspect the wrong thread (exactly the bug this module removes).
        //     Only an unambiguous single thread is safe to pick.
        if (threadId === undefined) {
            const resp = await session.customRequest('threads');
            const threads: Array<{ id: number; name: string }> = resp?.threads ?? [];
            if (threads.length === 0) {
                throw new Error('No threads available (target not stopped, or RTOS scheduler not started)');
            }
            if (threads.length > 1) {
                throw new Error(
                    'Cannot determine the stopped thread: no recent stop is tracked and no frame is focused. ' +
                    'Stop at a breakpoint (or focus a frame/thread in the Call Stack) and retry.'
                );
            }
            threadId = threads[0].id;
        }

        // (4) Top frame of the resolved thread.
        const stack = await session.customRequest('stackTrace', {
            threadId,
            startFrame: 0,
            levels: 1,
        });
        const top = stack?.stackFrames?.[0];
        if (!top) {
            throw new Error(`No stack frames available for thread ${threadId}`);
        }
        if (state) {
            state.selectedFrameId = top.id;
        }
        return { session, threadId, frameId: top.id };
    }

    /**
     * Resolve only the thread to act on (flow control such as `continue`), using
     * the same precedence as resolveActiveFrame but without a stackTrace. Returns
     * undefined only if no thread can be determined at all.
     */
    async resolveActiveThreadId(session: vscode.DebugSession): Promise<number | undefined> {
        const state = this.states.get(session.id);
        let threadId: number | undefined = state?.isStopped ? state.stoppedThreadId : undefined;

        if (threadId === undefined) {
            const item = vscode.debug.activeStackItem;
            if (item && item.session.id === session.id) {
                threadId = item.threadId;
            }
        }
        if (threadId === undefined) {
            const resp = await session.customRequest('threads');
            threadId = resp?.threads?.[0]?.id;
        }
        return threadId;
    }
}
