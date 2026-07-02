import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    hex32, coreFromCpuid, decodeFaultFlags, decodeExcReturn, decodeStackedFrame,
    savedPcOffsetFromExcReturn, scanStackHighWater, TX_STACK_FILL,
} from '../cortex-decode';

// These pin the behavior confirmed on real hardware (Nucleo-F746ZG, 2026-06):
// a regression here means explain_fault / inspect_tcb / thread_stack_usage
// would silently decode garbage on the bench.

test('hex32 formats 32-bit values, including negative JS numbers', () => {
    assert.equal(hex32(0), '0x00000000');
    assert.equal(hex32(0xE000ED00), '0xe000ed00');
    assert.equal(hex32(-1), '0xffffffff');
});

test('coreFromCpuid resolves known PartNos', () => {
    // STM32F746 (Cortex-M7 r1p0) CPUID.
    const m7 = coreFromCpuid(0x411FC271);
    assert.equal(m7.name, 'Cortex-M7');
    assert.equal(m7.configurableFaults, true);
    assert.equal(m7.v8m, false);

    const m0plus = coreFromCpuid(0x410CC601);
    assert.equal(m0plus.name, 'Cortex-M0+');
    assert.equal(m0plus.configurableFaults, false);

    const m33 = coreFromCpuid(0x410FD214);
    assert.equal(m33.name, 'Cortex-M33');
    assert.equal(m33.v8m, true);

    // M23 is v8-M but HardFault-only.
    const m23 = coreFromCpuid(0x410FD200);
    assert.equal(m23.name, 'Cortex-M23');
    assert.equal(m23.configurableFaults, false);
    assert.equal(m23.v8m, true);
});

test('coreFromCpuid falls back to the Architecture field for unknown parts', () => {
    // Architecture 0xF (v7-M/v8-M) => configurable faults assumed present.
    const unknownV7 = coreFromCpuid(0x410F0000 | (0xabc << 4));
    assert.match(unknownV7.name, /unknown core/);
    assert.equal(unknownV7.configurableFaults, true);
    // Architecture 0xC (v6-M) => HardFault-only.
    const unknownV6 = coreFromCpuid(0x410C0000 | (0xabc << 4));
    assert.equal(unknownV6.configurableFaults, false);
});

const M7 = { configurableFaults: true, v8m: false };
const M33 = { configurableFaults: true, v8m: true };
const M0P = { configurableFaults: false, v8m: false };

test('decodeFaultFlags: MemManage with valid MMFAR', () => {
    // DACCVIOL | MMARVALID
    const d = decodeFaultFlags(M7, 0x82, 0, 0);
    assert.ok(d.flags.some((f) => f.includes('DACCVIOL')));
    assert.equal(d.mmarValid, true);
    assert.equal(d.bfarValid, false);
});

test('decodeFaultFlags: precise bus fault with valid BFAR + escalation', () => {
    // BFSR: PRECISERR | BFARVALID, HFSR: FORCED
    const d = decodeFaultFlags(M7, 0x82 << 8, 0x40000000, 0);
    assert.ok(d.flags.some((f) => f.includes('PRECISERR')));
    assert.ok(d.flags.some((f) => f.includes('FORCED')));
    assert.equal(d.bfarValid, true);
    assert.equal(d.mmarValid, false);
});

test('decodeFaultFlags: UFSR.STKOF only decodes on ARMv8-M', () => {
    const stkof = 0x0010 << 16;
    assert.ok(decodeFaultFlags(M33, stkof, 0, 0).flags.some((f) => f.includes('STKOF')));
    assert.ok(!decodeFaultFlags(M7, stkof, 0, 0).flags.some((f) => f.includes('STKOF')));
});

test('decodeFaultFlags: HardFault-only cores contribute no CFSR/HFSR flags', () => {
    const d = decodeFaultFlags(M0P, 0xffffffff, 0xffffffff, 0);
    assert.deepEqual(d.flags, []);
    assert.equal(d.mmarValid, false);
});

test('decodeFaultFlags: SFSR decodes only on v8-M and only when set', () => {
    // AUVIOL | SFARVALID
    const d = decodeFaultFlags(M33, 0, 0, 0x48);
    assert.ok(d.flags.some((f) => f.includes('AUVIOL')));
    assert.equal(d.sfarValid, true);
    assert.equal(decodeFaultFlags(M7, 0, 0, 0x48).sfarValid, false);
    assert.equal(decodeFaultFlags(M33, 0, 0, 0).sfarValid, false);
});

test('decodeExcReturn: thread mode / process stack / basic frame', () => {
    const d = decodeExcReturn(0xFFFFFFFD, false)!;
    assert.equal(d.useProcessStack, true);
    assert.equal(d.basicFrame, true);
    assert.equal(d.secure, false);
});

test('decodeExcReturn: handler on main stack with FP (extended) frame', () => {
    const d = decodeExcReturn(0xFFFFFFE9, false)!;
    assert.equal(d.useProcessStack, false);
    assert.equal(d.basicFrame, false);
});

test('decodeExcReturn: bit6 selects the Secure bank only on v8-M', () => {
    assert.equal(decodeExcReturn(0xFFFFFFFD, true)!.secure, true);
    assert.equal(decodeExcReturn(0xFFFFFFFD, false)!.secure, false);
    assert.equal(decodeExcReturn(0xFFFFFFB8, true)!.secure, false);
});

test('decodeExcReturn: a code address is not an EXC_RETURN', () => {
    assert.equal(decodeExcReturn(0x08001234, false), undefined);
});

test('decodeStackedFrame: R0,R1,R2,R3,R12,LR,PC,xPSR layout', () => {
    const buf = Buffer.alloc(32);
    const words = [0x11111111, 0x22222222, 0x33333333, 0x44444444, 0xCCCCCCCC, 0x080012AB, 0x08004567, 0x21000000];
    words.forEach((w, i) => buf.writeUInt32LE(w, i * 4));
    const f = decodeStackedFrame(buf)!;
    assert.equal(f.r0, 0x11111111);
    assert.equal(f.r3, 0x44444444);
    assert.equal(f.r12, 0xCCCCCCCC);
    assert.equal(f.lr, 0x080012AB);
    assert.equal(f.pc, 0x08004567);
    assert.equal(f.xpsr, 0x21000000);
});

test('decodeStackedFrame: short read yields undefined', () => {
    assert.equal(decodeStackedFrame(Buffer.alloc(31)), undefined);
});

test('savedPcOffsetFromExcReturn: ThreadX GCC-port saved-context PC offsets', () => {
    assert.equal(savedPcOffsetFromExcReturn(0xFFFFFFFD), 60);   // non-FP frame
    assert.equal(savedPcOffsetFromExcReturn(0xFFFFFFE9), 124);  // FP frame
    assert.equal(savedPcOffsetFromExcReturn(0x20001000), undefined); // not EXC_RETURN
});

function stack(sizeWords: number, usedWords: number): Buffer {
    const buf = Buffer.alloc(sizeWords * 4);
    for (let i = 0; i < sizeWords; i++) {
        // ThreadX stacks grow DOWN: the used region is at the high end.
        buf.writeUInt32LE(i < sizeWords - usedWords ? TX_STACK_FILL : 0x12345678, i * 4);
    }
    return buf;
}

test('scanStackHighWater: never-used stack reports zero peak', () => {
    const r = scanStackHighWater(stack(256, 0), 1024);
    assert.equal(r.peakUsedBytes, 0);
    assert.equal(r.freeBytes, 1024);
    assert.equal(r.peakPct, 0);
    assert.equal(r.overflowRisk, false);
});

test('scanStackHighWater: half-used stack', () => {
    const r = scanStackHighWater(stack(256, 128), 1024);
    assert.equal(r.peakUsedBytes, 512);
    assert.equal(r.freeBytes, 512);
    assert.equal(r.peakPct, 50);
});

test('scanStackHighWater: nearly-full stack flags overflow risk', () => {
    const r = scanStackHighWater(stack(256, 240), 1024);
    assert.equal(r.freeBytes, 64);
    assert.equal(r.overflowRisk, true);
});

test('scanStackHighWater: no fill pattern => high-water unavailable', () => {
    const r = scanStackHighWater(stack(256, 256), 1024);
    assert.match(r.note, /high-water unavailable/);
});

test('scanStackHighWater: unreadable stack => note', () => {
    const r = scanStackHighWater(Buffer.alloc(0), 1024);
    assert.match(r.note, /could not read/);
});
