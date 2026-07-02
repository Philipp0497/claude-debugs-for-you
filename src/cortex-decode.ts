/**
 * Pure ARM Cortex-M / ThreadX decode logic: no vscode, no DAP, no I/O.
 * Everything here is unit-testable off-target (see src/unit-tests/) — this is
 * where the hardware-verified knowledge lives, so regressions are caught by
 * `npm run test:unit` instead of on the bench.
 */

export function hex32(n: number): string {
    return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

export interface CoreCaps {
    name: string;
    /** Has the CFSR/HFSR/MMFAR/BFAR block (ARMv7-M and ARMv8-M Mainline). */
    configurableFaults: boolean;
    /** ARMv8-M (adds UFSR.STKOF + SecureFault SFSR/SFAR). */
    v8m: boolean;
}

// CPUID PartNo (bits[15:4]) -> core capabilities. NOTE: Cortex-M23 is v8-M but
// HardFault-only, so capability is keyed per-part, NOT off v8m.
export const CORTEX_CORES: Record<number, CoreCaps> = {
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

/**
 * Resolve core capabilities from the raw CPUID value. Unknown parts fall back
 * to the Architecture field (bits[19:16]: 0xF = v7-M/v8-M has CFSR, 0xC = v6-M).
 */
export function coreFromCpuid(cpuid: number): CoreCaps {
    const partno = (cpuid >> 4) & 0xfff;
    return CORTEX_CORES[partno] ?? {
        name: `unknown core (CPUID PartNo 0x${partno.toString(16)})`,
        configurableFaults: ((cpuid >> 16) & 0xf) === 0xf,
        v8m: false,
    };
}

/** ICSR.VECTACTIVE exception numbers that are CPU faults. */
export const FAULT_EXCEPTIONS: Record<number, string> = {
    3: 'HardFault',
    4: 'MemManage',
    5: 'BusFault',
    6: 'UsageFault',
    7: 'SecureFault',
};

export interface FaultFlagDecode {
    flags: string[];
    mmarValid: boolean;
    bfarValid: boolean;
    sfarValid: boolean;
}

/**
 * Decode the CFSR/HFSR (v7-M / v8-M Mainline) and SFSR (v8-M Security) bits
 * into human-readable flags. Cores without configurable faults contribute no
 * CFSR/HFSR flags; SFSR is decoded only when non-zero (it reads as 0 from a
 * Non-secure context / without the Main Extension).
 */
export function decodeFaultFlags(
    core: Pick<CoreCaps, 'configurableFaults' | 'v8m'>,
    cfsr: number,
    hfsr: number,
    sfsr: number,
): FaultFlagDecode {
    const flags: string[] = [];
    const add = (cond: number, name: string) => { if (cond) { flags.push(name); } };
    let mmarValid = false, bfarValid = false, sfarValid = false;

    if (core.configurableFaults) {
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
        mmarValid = !!(cfsr & 0x80);
        bfarValid = !!((cfsr >> 8) & 0x80);
    }

    if (core.v8m && sfsr) {
        add(sfsr & 0x01, 'SFSR.INVEP (invalid entry point)');
        add(sfsr & 0x02, 'SFSR.INVIS (invalid integrity signature)');
        add(sfsr & 0x04, 'SFSR.INVER (invalid exception return)');
        add(sfsr & 0x08, 'SFSR.AUVIOL (attribution unit violation)');
        add(sfsr & 0x10, 'SFSR.INVTRAN (invalid transition)');
        add(sfsr & 0x20, 'SFSR.LSPERR (lazy FP preservation error)');
        add(sfsr & 0x80, 'SFSR.LSERR (lazy state error)');
        sfarValid = !!(sfsr & 0x40);
    }

    return { flags, mmarValid, bfarValid, sfarValid };
}

export interface ExcReturnDecode {
    /** EXC_RETURN bit 2 (SPSEL): frame is on the process stack. */
    useProcessStack: boolean;
    /** Bit 4 (FType): 1 = basic (no FP) frame, 0 = extended. */
    basicFrame: boolean;
    /** Bit 6 (S, ARMv8-M with TrustZone): frame on the Secure stack bank. */
    secure: boolean;
}

/** Decode an EXC_RETURN value; undefined if `lr` is not one (top byte != 0xFF). */
export function decodeExcReturn(lr: number, v8m: boolean): ExcReturnDecode | undefined {
    if ((lr >>> 24) !== 0xff) {
        return undefined;
    }
    return {
        useProcessStack: !!(lr & 0x4),
        basicFrame: !!(lr & 0x10),
        secure: v8m && !!(lr & 0x40),
    };
}

export interface StackedFrame {
    r0: number; r1: number; r2: number; r3: number; r12: number;
    lr: number; pc: number; xpsr: number;
}

/**
 * Decode the 8-word stacked exception frame (R0,R1,R2,R3,R12,LR,PC,xPSR — the
 * layout is identical across ARMv6/7/8-M). Undefined if fewer than 32 bytes.
 */
export function decodeStackedFrame(frame: Buffer): StackedFrame | undefined {
    if (frame.length < 32) {
        return undefined;
    }
    return {
        r0: frame.readUInt32LE(0),
        r1: frame.readUInt32LE(4),
        r2: frame.readUInt32LE(8),
        r3: frame.readUInt32LE(12),
        r12: frame.readUInt32LE(16),
        lr: frame.readUInt32LE(20),
        pc: frame.readUInt32LE(24),
        xpsr: frame.readUInt32LE(28),
    };
}

/**
 * Offset of the saved PC inside a ThreadX Cortex-M (GCC port) TCB saved
 * context, given the frame's first word. That word must be an EXC_RETURN
 * (else: unknown port layout); non-FP frames (bit4 set) put the PC at +60,
 * FP frames at +124.
 */
export function savedPcOffsetFromExcReturn(firstWord: number): number | undefined {
    if ((firstWord >>> 24) !== 0xff) {
        return undefined;
    }
    return (firstWord & 0x10) ? 60 : 124;
}

// ThreadX tx_thread_state values (Azure RTOS / Eclipse ThreadX, tx_api.h).
export const TX_STATE_NAMES = [
    'READY', 'COMPLETED', 'TERMINATED', 'SUSPENDED', 'SLEEP', 'QUEUE_SUSP',
    'SEMAPHORE_SUSP', 'EVENT_FLAG', 'BLOCK_MEMORY', 'BYTE_MEMORY', 'IO_DRIVER',
    'FILE', 'TCP_IP', 'MUTEX_SUSP', 'PRIORITY_CHANGE',
];

// Default ThreadX stack fill word (filled at create unless TX_DISABLE_STACK_FILLING).
export const TX_STACK_FILL = 0xefefefef;

/**
 * Scan a stack region image for the ThreadX fill pattern and report peak usage
 * from the low end. `size` is the declared stack size in bytes (the buffer may
 * be shorter if the read was truncated).
 */
export function scanStackHighWater(data: Buffer, size: number): any {
    const words = Math.floor(data.length / 4);
    if (words === 0) {
        return { note: 'could not read stack memory' };
    }
    let firstNonFill = -1;
    let fillCount = 0;
    for (let i = 0; i < words; i++) {
        if (data.readUInt32LE(i * 4) === TX_STACK_FILL) {
            fillCount++;
        } else if (firstNonFill < 0) {
            firstNonFill = i;
        }
    }
    if (fillCount === 0) {
        return { note: 'no 0xEFEFEFEF fill found — stack filling disabled (TX_DISABLE_STACK_FILLING) or stack fully consumed; high-water unavailable' };
    }
    if (firstNonFill < 0) {
        firstNonFill = words; // entire stack still filled (never used)
    }
    const freeBytes = firstNonFill * 4;
    const peakUsedBytes = size - freeBytes;
    const peakPct = Math.round((peakUsedBytes / size) * 1000) / 10;
    return { peakUsedBytes, freeBytes, peakPct, overflowRisk: freeBytes <= 64 };
}
