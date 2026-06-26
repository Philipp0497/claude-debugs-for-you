import { XMLParser } from 'fast-xml-parser';

/**
 * Minimal CMSIS-SVD model: peripherals -> registers -> fields, with peripheral
 * `derivedFrom` resolution (two-pass, forward refs allowed) and the three field
 * bit-range encodings normalized to {bitOffset,bitWidth}. dim arrays and register
 * clusters are NOT expanded (the STM32F7 SVD uses neither); a register that uses
 * them is kept as-is. Numbers are parsed manually (the SVD mixes 0x/0X and decimal).
 */
export interface SvdField {
    name: string;
    bitOffset: number;
    bitWidth: number;
    description?: string;
}

export interface SvdRegister {
    name: string;
    addressOffset: number;
    size: number; // bits
    access?: string;
    resetValue?: number;
    description?: string;
    fields: SvdField[];
}

export interface SvdPeripheral {
    name: string;
    baseAddress: number;
    groupName?: string;
    description?: string;
    registers: SvdRegister[];
}

export interface SvdModel {
    peripherals: SvdPeripheral[];
}

function num(v: any): number | undefined {
    if (v === undefined || v === null) {
        return undefined;
    }
    const s = String(v).trim();
    if (!s) {
        return undefined;
    }
    const n = parseInt(s, /^0x/i.test(s) ? 16 : 10);
    return Number.isNaN(n) ? undefined : n;
}

function arr(x: any): any[] {
    return x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];
}

function clean(s: any): string | undefined {
    return s ? String(s).replace(/\s+/g, ' ').trim() : undefined;
}

function parseField(f: any, defaultWidth: number): SvdField {
    let bitOffset: number | undefined;
    let bitWidth: number | undefined;
    if (f.bitOffset !== undefined && f.bitWidth !== undefined) {
        bitOffset = num(f.bitOffset);
        bitWidth = num(f.bitWidth);
    } else if (f.bitRange !== undefined) {
        const m = String(f.bitRange).match(/\[\s*(\d+)\s*:\s*(\d+)\s*\]/);
        if (m) {
            const msb = parseInt(m[1], 10);
            const lsb = parseInt(m[2], 10);
            bitOffset = lsb;
            bitWidth = msb - lsb + 1;
        }
    } else if (f.lsb !== undefined && f.msb !== undefined) {
        const lsb = num(f.lsb);
        const msb = num(f.msb);
        if (lsb !== undefined && msb !== undefined) {
            bitOffset = lsb;
            bitWidth = msb - lsb + 1;
        }
    }
    return {
        name: String(f.name),
        bitOffset: bitOffset ?? 0,
        bitWidth: bitWidth ?? defaultWidth,
        description: clean(f.description),
    };
}

function parseRegister(r: any, peripheralSize: number): SvdRegister {
    const size = num(r.size) ?? peripheralSize;
    return {
        name: String(r.name),
        addressOffset: num(r.addressOffset) ?? 0,
        size,
        access: r.access ? String(r.access) : undefined,
        resetValue: num(r.resetValue),
        description: clean(r.description),
        fields: arr(r.fields?.field).map((f) => parseField(f, size)),
    };
}

export function parseSvd(xml: string): SvdModel {
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        parseTagValue: false,
        trimValues: true,
        isArray: (name) => ['peripheral', 'register', 'field', 'cluster', 'enumeratedValue', 'interrupt', 'addressBlock'].includes(name),
    });
    const doc = parser.parse(xml);
    const device = doc?.device ?? {};
    const deviceSize = num(device.size) ?? num(device.width) ?? 32;

    const rawPeripherals = arr(device.peripherals?.peripheral);
    const rawByName = new Map<string, any>();
    for (const p of rawPeripherals) {
        rawByName.set(String(p.name), p);
    }

    const resolved = new Map<string, SvdPeripheral>();
    const resolving = new Set<string>();

    const resolve = (name: string): SvdPeripheral | undefined => {
        const cached = resolved.get(name);
        if (cached) {
            return cached;
        }
        const raw = rawByName.get(name);
        if (!raw || resolving.has(name)) {
            return undefined; // missing or a derivedFrom cycle
        }
        resolving.add(name);

        const peripheralSize = num(raw.size) ?? deviceSize;
        let registers: SvdRegister[] = [];

        const derivedFrom = raw['@_derivedFrom'];
        if (derivedFrom) {
            const base = resolve(String(derivedFrom));
            if (base) {
                // Inherit the base's registers (deep-ish copy so overrides don't mutate it).
                registers = base.registers.map((reg) => ({ ...reg, fields: reg.fields.slice() }));
            }
        }

        const ownRegisters = arr(raw.registers?.register).map((r) => parseRegister(r, peripheralSize));
        if (ownRegisters.length) {
            const byName = new Map(registers.map((reg) => [reg.name, reg]));
            for (const reg of ownRegisters) {
                byName.set(reg.name, reg); // own overrides inherited by name
            }
            registers = [...byName.values()];
        }

        const peripheral: SvdPeripheral = {
            name: String(raw.name),
            baseAddress: num(raw.baseAddress) ?? 0,
            groupName: raw.groupName ? String(raw.groupName) : undefined,
            description: clean(raw.description),
            registers,
        };
        resolving.delete(name);
        resolved.set(name, peripheral);
        return peripheral;
    };

    for (const p of rawPeripherals) {
        resolve(String(p.name));
    }
    return { peripherals: [...resolved.values()] };
}
