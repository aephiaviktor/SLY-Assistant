#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const bodyStart = source.indexOf('{', functionStart);
  let depth = 0, quote = '', escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const names = [
  'getCargoTelemetryInstructionBytes', 'getCargoTelemetryProgramIdentity',
  'resolveConfirmedCargoOuterInstructionIndex', 'decodeConfirmedCargoWithdrawRawAmount',
  'formatCargoTelemetryDecimalAmount', 'canonicalizeCargoTelemetryEvidencePayload',
  'sha256CargoTelemetryText', 'buildConfirmedCargoDeliveryEvidence'
];
const context = { Uint8Array, ArrayBuffer, BigInt, String, Number, TextEncoder, crypto: webcrypto };
vm.createContext(context);
vm.runInContext(`${names.map(extractFunction).join('\n')}\n${names.map(n => `this.${n}=${n};`).join('\n')}`, context);

function withdrawData(raw, discriminator = 7) {
  const out = new Uint8Array(18);
  out.fill(discriminator, 0, 8);
  let n = BigInt(raw);
  for (let i = 0; i < 8; i++) { out[8 + i] = Number(n & 255n); n >>= 8n; }
  return out;
}
function key(value) { return { toString: () => value }; }
function txResult(instructions) {
  return {
    slyaTxHash: '5igConfirmed', slot: 987654321, blockTime: 1787547600,
    transaction: { message: { staticAccountKeys: [key('ComputeBudget111'), key('SAGE_PROGRAM')], compiledInstructions: instructions } }
  };
}
function ix(programIdIndex, data) { return { programIdIndex, data }; }

(async () => {
  const bulkData = withdrawData('12345678901234567890');
  const confirmed = txResult([ix(0, new Uint8Array([1, 2, 3])), ix(1, bulkData)]);
  const wrapper = { instruction: { programId: key('SAGE_PROGRAM'), data: bulkData }, sourcePosition: 0 };
  assert.equal(context.resolveConfirmedCargoOuterInstructionIndex(confirmed, wrapper, new Set()), 1, 'compute prefix must remain part of actual coordinate');
  assert.equal(context.decodeConfirmedCargoWithdrawRawAmount(confirmed, 1), '12345678901234567890');
  assert.equal(context.formatCargoTelemetryDecimalAmount('12345678901234567890', 18), '12.34567890123456789');
  assert.equal(context.formatCargoTelemetryDecimalAmount('1', 18), '0.000000000000000001');

  const base = {
    txResult: confirmed, wrapper, outerInstructionIndex: 1, mint: 'MintA', mintDecimals: 18,
    fleetAccount: 'FleetPk', fleetLabel: 'Cargo One', factionProfile: 'USTUR', route: 'MRZ-1->MRZ-2',
    cycleId: 'cycle-1', allocationId: 'cycle-1:5igConfirmed:1'
  };
  const evidence = await context.buildConfirmedCargoDeliveryEvidence(base);
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.movementType, 'unload');
  assert.equal(evidence.rawAmount, '12345678901234567890');
  assert.equal(evidence.decimalAmount, '12.34567890123456789');
  assert.equal(evidence.outerInstructionIndex, 1);
  assert.ok(evidence.eventId.includes('5igConfirmed:1:unload'));
  assert.match(evidence.payloadHash, /^[0-9a-f]{64}$/);

  const replay = await context.buildConfirmedCargoDeliveryEvidence(base);
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(evidence)), 'replay must be deterministic');
  const changed = await context.buildConfirmedCargoDeliveryEvidence({ ...base, route: 'MRZ-1->MRZ-9' });
  assert.equal(changed.eventId, evidence.eventId, 'mutable payload must not change source identity');
  assert.notEqual(changed.payloadHash, evidence.payloadHash, 'changed payload must be conflict-detectable');

  const oneData = withdrawData('1', 9);
  const multi = txResult([ix(0, new Uint8Array([4])), ix(1, bulkData), ix(1, oneData)]);
  const used = new Set();
  const first = context.resolveConfirmedCargoOuterInstructionIndex(multi, wrapper, used); used.add(first);
  const secondWrapper = { instruction: { programId: key('SAGE_PROGRAM'), data: oneData }, sourcePosition: 1 };
  const second = context.resolveConfirmedCargoOuterInstructionIndex(multi, secondWrapper, used);
  assert.deepEqual([first, second], [1, 2]);
  const one = await context.buildConfirmedCargoDeliveryEvidence({ ...base, txResult: multi, wrapper: secondWrapper, outerInstructionIndex: second, mintDecimals: 0, allocationId: 'cycle-1:5igConfirmed:2' });
  assert.equal(one.rawAmount, '1');
  assert.equal(one.decimalAmount, '1');
  assert.notEqual(one.eventId, evidence.eventId);

  // Two byte-identical unloads are correlated in retained wrapper/source order. The
  // used-coordinate set prevents either operation from silently selecting the first match.
  const duplicateTx = txResult([ix(0, new Uint8Array([8])), ix(1, bulkData), ix(1, bulkData)]);
  const duplicateWrappers = [
    { instruction: { programId: key('SAGE_PROGRAM'), data: bulkData }, sourcePosition: 0 },
    { instruction: { programId: key('SAGE_PROGRAM'), data: bulkData }, sourcePosition: 1 },
  ];
  const duplicateUsed = new Set();
  const duplicateEvidence = [];
  for (const duplicateWrapper of duplicateWrappers) {
    const coordinate = context.resolveConfirmedCargoOuterInstructionIndex(duplicateTx, duplicateWrapper, duplicateUsed);
    assert.notEqual(coordinate, -1, `source position ${duplicateWrapper.sourcePosition} must resolve uniquely`);
    assert.equal(duplicateUsed.has(coordinate), false, 'a confirmed coordinate must never be silently reused');
    duplicateUsed.add(coordinate);
    duplicateEvidence.push(await context.buildConfirmedCargoDeliveryEvidence({
      ...base, txResult: duplicateTx, wrapper: duplicateWrapper, outerInstructionIndex: coordinate,
      allocationId: `cycle-1:5igConfirmed:${coordinate}`
    }));
  }
  assert.deepEqual(duplicateEvidence.map(item => item.outerInstructionIndex), [1, 2]);
  assert.equal(new Set(duplicateEvidence.map(item => item.eventId)).size, 2, 'byte-identical unloads must retain distinct source identities');
  assert.equal(context.resolveConfirmedCargoOuterInstructionIndex(duplicateTx, duplicateWrappers[1], duplicateUsed), -1, 'exhausted/ambiguous correspondence must fail closed');

  assert.equal(context.resolveConfirmedCargoOuterInstructionIndex(txResult([]), wrapper, new Set()), -1, 'a balance without a confirmed unload has no evidence coordinate');

  const apply = extractFunction('applyConfirmedCargoTelemetry');
  assert.match(apply, /txResult/);
  assert.match(apply, /sourcePosition/);
  assert.match(apply, /resolveConfirmedCargoOuterInstructionIndex/);
  assert.doesNotMatch(apply, /getTransaction|getParsedTokenAccounts|fetch\(/, 'evidence handoff must not add RPC work');

  const finalize = extractFunction('maybeFinalizeFleetTelemetryCostCycle');
  assert.match(finalize, /deliveryEvidenceSchemaVersion/);
  assert.match(finalize, /deliveryEvidencePayloadHash/);
  assert.match(finalize, /amount=\$\{Number\(item\.amount \|\| 0\)\},cargoVolume=/, 'legacy fields remain intact');

  console.log('cargo delivery evidence tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
