'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extract(name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, name);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === 'async ' ? functionStart - 6 : functionStart;
  const body = source.indexOf('{', source.indexOf(')', functionStart));
  let depth = 0, quote = '', escaped = false;
  for (let i = body; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function load() {
  const context = vm.createContext({
    BigInt, Math, Number, String, JSON, Array, Object, Uint8Array, ArrayBuffer, TextEncoder,
    crypto: webcrypto, userProfileAcct: { toString: () => 'profile-1' },
    getUpgradeAutomationInfluxFactionTag: () => 'UST',
    getSlyaInfluxInstanceTag: () => 'USTUR1',
    influxEscape: (value) => String(value).replaceAll(' ', '\\ '),
    optimizationInfluxString: (value) => JSON.stringify(String(value ?? '')),
  });
  vm.runInContext(`
    ${extract('canonicalizeCargoTelemetryEvidencePayload')}
    ${extract('sha256CargoTelemetryText')}
    ${extract('getCargoTelemetryProgramIdentity')}
    ${extract('normalizeSlyaAccountingExact')}
    ${extract('normalizeSlyaAccountingEntries')}
    ${extract('normalizeSlyaAccountingMoney')}
    ${extract('deriveSlyaAccountingTokenDeltas')}
    ${extract('getSlyaInfluxPrecision')}
    ${extract('formatSlyaInfluxTimestamp')}
    ${extract('selectSlyaAccountingEvidenceCandidates')}
    ${extract('getSlyaAccountingEvidenceType')}
    ${extract('buildConfirmedSlyaAccountingEvidence')}
    ${extract('buildSlyaAccountingEvidenceLine')}
    function resolveConfirmedCargoOuterInstructionIndex() { return 0; }
    const outbox = new Map();
    const slyaCostSourceCounters = { deduplicated: 0 };
    let missing = 0;
    async function loadSlyaCostSourceOutbox() { return outbox; }
    async function persistSlyaCostSourceOutbox() {}
    function countSlyaCostSourceMissing() { missing += 1; }
    ${extract('applyConfirmedSlyaAccountingEvidence')}
    this.api = { buildConfirmedSlyaAccountingEvidence, buildSlyaAccountingEvidenceLine, selectSlyaAccountingEvidenceCandidates, applyConfirmedSlyaAccountingEvidence, outbox, counters: slyaCostSourceCounters, missing: () => missing };
  `, context);
  return context.api;
}

function tx() {
  const data = new Uint8Array([7, 8, 9]);
  return {
    slyaTxHash: 'confirmed-signature', slot: 123, blockTime: 1785830000,
    slyaTxFeeLamports: 5000, transaction: { message: {
      staticAccountKeys: [{ toString: () => 'SAGE_PROGRAM' }],
      compiledInstructions: [{ programIdIndex: 0, data }],
    } },
  };
}

test('confirmed evidence has immutable identity, exact quantities, lineage and canonical hash', async () => {
  const api = load();
  const wrapper = { instruction: { programId: { toString: () => 'SAGE_PROGRAM' }, data: new Uint8Array([7, 8, 9]) }, slyaAccountingEvidence: {
    evidenceType: 'crafting', inputs: [{ asset: 'Ore', quantity: '000' }], outputs: [{ asset: 'Plate', quantity: '2.500' }],
    directFees: '1.25', transactionCosts: null, lineage: { craftingProcess: 'process-1' },
  } };
  // Atomic source quantities are required to be canonical decimal strings.
  const rejected = await api.buildConfirmedSlyaAccountingEvidence({ wrapper, txResult: tx(), fleet: { label: 'Fleet', publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: 0 });
  assert.equal(rejected, null);
  wrapper.slyaAccountingEvidence.inputs[0].quantity = '0';
  const evidence = await api.buildConfirmedSlyaAccountingEvidence({ wrapper, txResult: tx(), fleet: { label: 'Fleet', publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: 0 });
  assert.equal(evidence.eventId, 'slya-accounting:v1:crafting:confirmed-signature:0');
  assert.equal(evidence.signature, 'confirmed-signature');
  assert.equal(evidence.slot, 123);
  assert.equal(evidence.transactionCosts.solLamports, '5000');
  assert.match(evidence.payloadHash, /^[0-9a-f]{64}$/);
  assert.match(api.buildSlyaAccountingEvidenceLine(evidence), /^slya_accounting_evidence_v1,/);
  assert.match(api.buildSlyaAccountingEvidenceLine(evidence), /programId=/);
  const replay = await api.buildConfirmedSlyaAccountingEvidence({ wrapper, txResult: tx(), fleet: { label: 'Fleet', publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(replay)), JSON.parse(JSON.stringify(evidence)));
  const unboundWrapper = { ...wrapper, slyaAccountingEvidence: { ...wrapper.slyaAccountingEvidence, inputs: [], outputs: [] } };
  const unbound = await api.buildConfirmedSlyaAccountingEvidence({ wrapper: unboundWrapper, txResult: tx(), fleet: { publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(unbound.inputs)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(unbound.outputs)), []);
  const changed = { ...wrapper, slyaAccountingEvidence: { ...wrapper.slyaAccountingEvidence, lineage: { craftingProcess: 'process-2' } } };
  const conflict = await api.buildConfirmedSlyaAccountingEvidence({ wrapper: changed, txResult: tx(), fleet: { label: 'Fleet', publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: 0 });
  assert.equal(conflict.eventId, evidence.eventId);
  assert.notEqual(conflict.payloadHash, evidence.payloadHash);
});

test('multi-wrapper unannotated transactions emit no generic token-delta evidence', () => {
  const api = load();
  const wrappers = [{ instruction: { programId: { toString: () => 'SAGE_PROGRAM' }, data: new Uint8Array([7, 8, 9]) } }];
  assert.deepEqual(JSON.parse(JSON.stringify(api.selectSlyaAccountingEvidenceCandidates(wrappers, 'mining'))), []);
});

test('apply skips unannotated aggregate evidence without mutating the outbox', async () => {
  const api = load();
  const wrappers = [{ instruction: { programId: { toString: () => 'SAGE_PROGRAM' }, data: new Uint8Array([7, 8, 9]) } }];
  assert.equal(await api.applyConfirmedSlyaAccountingEvidence(wrappers, { publicKey: { toString: () => 'fleet-1' } }, tx(), 'MINING'), 0);
  assert.equal(api.outbox.size, 0);
});

test('missing confirmed coordinates or authoritative scope fail closed', async () => {
  const api = load();
  const wrapper = { slyaAccountingEvidence: { evidenceType: 'mining', inputs: [], outputs: [], directFees: '0', transactionCosts: null, lineage: {} } };
  assert.equal(await api.buildConfirmedSlyaAccountingEvidence({ wrapper, txResult: tx(), fleet: { publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: -1 }), null);
  assert.equal(await api.buildConfirmedSlyaAccountingEvidence({ wrapper, txResult: { ...tx(), slot: -1 }, fleet: { publicKey: { toString: () => 'fleet-1' } }, outerInstructionIndex: 0 }), null);
});
