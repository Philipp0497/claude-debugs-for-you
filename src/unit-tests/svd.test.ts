import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseSvd } from '../svd';

// Synthetic CMSIS-SVD covering everything the minimal parser claims to handle:
// derivedFrom (with a FORWARD reference), the three field bit-range encodings,
// register override-by-name, groupName, and reset values. Shapes match the
// STM32F746.svd constructs read_peripheral was validated against on hardware.
const FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>TESTDEV</name>
  <size>32</size>
  <peripherals>
    <peripheral derivedFrom="UART2">
      <name>UART1</name>
      <baseAddress>0x40001000</baseAddress>
      <registers>
        <register>
          <name>SR</name>
          <addressOffset>0x0</addressOffset>
          <resetValue>0xC0</resetValue>
          <fields>
            <field>
              <name>TXE</name>
              <bitOffset>7</bitOffset>
              <bitWidth>1</bitWidth>
            </field>
          </fields>
        </register>
      </registers>
    </peripheral>
    <peripheral>
      <name>UART2</name>
      <groupName>UART</groupName>
      <description>Universal  asynchronous
        receiver transmitter</description>
      <baseAddress>0x40002000</baseAddress>
      <registers>
        <register>
          <name>SR</name>
          <addressOffset>0x0</addressOffset>
          <fields>
            <field>
              <name>RXNE</name>
              <bitRange>[5:5]</bitRange>
            </field>
          </fields>
        </register>
        <register>
          <name>DR</name>
          <addressOffset>0x4</addressOffset>
          <fields>
            <field>
              <name>DATA</name>
              <lsb>0</lsb>
              <msb>8</msb>
            </field>
          </fields>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

test('parseSvd: peripherals, base addresses, group names', () => {
    const model = parseSvd(FIXTURE);
    assert.equal(model.peripherals.length, 2);
    const uart2 = model.peripherals.find((p) => p.name === 'UART2')!;
    assert.equal(uart2.baseAddress, 0x40002000);
    assert.equal(uart2.groupName, 'UART');
    // Descriptions are whitespace-normalized.
    assert.equal(uart2.description, 'Universal asynchronous receiver transmitter');
});

test('parseSvd: all three field bit-range encodings normalize to offset/width', () => {
    const uart2 = parseSvd(FIXTURE).peripherals.find((p) => p.name === 'UART2')!;
    const rxne = uart2.registers.find((r) => r.name === 'SR')!.fields[0];
    assert.deepEqual([rxne.bitOffset, rxne.bitWidth], [5, 1]);   // bitRange [5:5]
    const data = uart2.registers.find((r) => r.name === 'DR')!.fields[0];
    assert.deepEqual([data.bitOffset, data.bitWidth], [0, 9]);   // lsb/msb 0..8
});

test('parseSvd: derivedFrom resolves a forward reference and inherits registers', () => {
    const uart1 = parseSvd(FIXTURE).peripherals.find((p) => p.name === 'UART1')!;
    assert.equal(uart1.baseAddress, 0x40001000);
    // DR is inherited from UART2; SR is overridden by name.
    const names = uart1.registers.map((r) => r.name).sort();
    assert.deepEqual(names, ['DR', 'SR']);
});

test('parseSvd: an own register overrides the inherited one by name', () => {
    const uart1 = parseSvd(FIXTURE).peripherals.find((p) => p.name === 'UART1')!;
    const sr = uart1.registers.find((r) => r.name === 'SR')!;
    assert.equal(sr.resetValue, 0xC0);
    assert.equal(sr.fields.length, 1);
    assert.equal(sr.fields[0].name, 'TXE');            // own field, not RXNE
    assert.deepEqual([sr.fields[0].bitOffset, sr.fields[0].bitWidth], [7, 1]); // bitOffset/bitWidth encoding
});

test('parseSvd: register size defaults to the device size', () => {
    const uart2 = parseSvd(FIXTURE).peripherals.find((p) => p.name === 'UART2')!;
    assert.equal(uart2.registers.find((r) => r.name === 'DR')!.size, 32);
});

test('parseSvd: overriding a register does not mutate the base peripheral', () => {
    const model = parseSvd(FIXTURE);
    const uart2sr = model.peripherals.find((p) => p.name === 'UART2')!.registers.find((r) => r.name === 'SR')!;
    assert.equal(uart2sr.fields[0].name, 'RXNE');
    assert.equal(uart2sr.resetValue, undefined);
});
