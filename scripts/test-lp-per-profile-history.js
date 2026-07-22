#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = { Math, Number, Object, String, Set, Map, Array, BigInt };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('buildUpgradeAutomationLpPerProfileRpcPlan')}
  ${extractFunction('mergeUpgradeAutomationLpPerProfileSignatureState')}
  ${extractFunction('extractUpgradeAutomationLpPerProfileRedemptions')}
  this.buildPlan = buildUpgradeAutomationLpPerProfileRpcPlan;
  this.mergeState = mergeUpgradeAutomationLpPerProfileSignatureState;
  this.extractRedemptions = extractUpgradeAutomationLpPerProfileRedemptions;
`, context);

assert.deepEqual(JSON.parse(JSON.stringify(context.buildPlan(['recipe-a', 'recipe-b', 'recipe-a']))), [
  [{ memcmp: { offset: 49, bytes: 'recipe-a' } }],
  [{ memcmp: { offset: 49, bytes: 'recipe-b' } }]
], 'active RPC plan filters crafting processes server-side by recipe at the documented offset');

const merged = context.mergeState(
  { cursor: 'sig-old', pending: [{ signature: 'sig-pending', blockTime: 100 }] },
  [
    { signature: 'sig-new', blockTime: 300, err: null },
    { signature: 'sig-pending', blockTime: 100, err: null },
    { signature: 'sig-failed', blockTime: 200, err: { InstructionError: [0, 'x'] } }
  ]
);
assert.equal(merged.cursor, 'sig-new');
assert.deepEqual(merged.pending.map(row => row.signature), ['sig-pending', 'sig-new'], 'pending signatures survive restart, deduplicate, and exclude failed transactions');

const tx = {
  blockTime: 1_725_000_000,
  meta: {
    err: null,
    preTokenBalances: [{ accountIndex: 12, uiTokenAmount: { amount: '1500' } }],
    postTokenBalances: [{ accountIndex: 12, uiTokenAmount: { amount: '500' } }],
    loadedAddresses: { writable: [], readonly: [] }
  },
  transaction: {
    message: {
      accountKeys: Array.from({ length: 29 }, (_, i) => `key-${i}`),
      instructions: [
        { programIdIndex: 28, accounts: Array.from({ length: 28 }, (_, i) => i), data: 'submit-data' },
        { programIdIndex: 28, accounts: Array.from({ length: 28 }, (_, i) => i), data: 'close-data' }
      ]
    }
  }
};
tx.transaction.message.accountKeys[28] = 'sage-program';
const rows = context.extractRedemptions(tx, 'sig-1', (data, programId) => data === 'submit-data' && programId === 'sage-program');
assert.deepEqual(JSON.parse(JSON.stringify(rows)), [{
  signature: 'sig-1', instructionIndex: 0, blockTime: 1_725_000_000,
  starbase: 'key-1', profile: 'key-16', craftingProcess: 'key-4',
  resourceRecipe: 'key-8', quantity: 1000
}], 'only successful submitStarbaseUpgradeResource instructions produce rows, using token delta and block time');

const versionedRows = context.extractRedemptions({
  ...tx,
  transaction: { message: { staticAccountKeys: tx.transaction.message.accountKeys, compiledInstructions: tx.transaction.message.instructions } }
}, 'sig-v0', (data, programId) => data === 'submit-data' && programId === 'sage-program');
assert.equal(versionedRows.length, 1, 'versioned transactions use staticAccountKeys and compiledInstructions');

assert.deepEqual(JSON.parse(JSON.stringify(context.extractRedemptions({ ...tx, meta: { ...tx.meta, err: { failed: true } } }, 'sig-2', () => true))), [], 'failed transactions never produce redemption rows');
console.log('lp-per-profile history tests passed');
