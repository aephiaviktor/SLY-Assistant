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
  ${extractFunction('updateUpgradeAutomationLpPerProfileWatchCohort')}
  ${extractFunction('computeUpgradeAutomationLpProcessEodProjection')}
  ${extractFunction('formatUpgradeAutomationLpProcessDebugLines')}
  ${extractFunction('buildUpgradeAutomationLpPerProfileTransactionQueue')}
  ${extractFunction('extractUpgradeAutomationLpPerProfileRedemptions')}
  this.buildPlan = buildUpgradeAutomationLpPerProfileRpcPlan;
  this.mergeState = mergeUpgradeAutomationLpPerProfileSignatureState;
  this.updateCohort = updateUpgradeAutomationLpPerProfileWatchCohort;
  this.projectEod = computeUpgradeAutomationLpProcessEodProjection;
  this.formatDebug = formatUpgradeAutomationLpProcessDebugLines;
  this.buildQueue = buildUpgradeAutomationLpPerProfileTransactionQueue;
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

const now = 1_725_000_000;
const cohort = context.updateCohort({ profiles: {
  'profile-old': { firstSeenAt: now - 500, expiresAt: now + 100, cursor: 'old-cursor', pending: [] },
  'profile-expired': { firstSeenAt: now - 90000, expiresAt: now - 1, cursor: 'gone', pending: [] }
}}, [
  { profile: 'profile-new', active: true, expectedCompletionsByEod: 3 },
  { profile: 'profile-later', active: true, expectedCompletionsByEod: 0 }
], now);
assert.deepEqual(Object.keys(cohort.profiles).sort(), ['profile-new', 'profile-old'], 'cohort adds only EoD profiles, retains watched profiles through grace, and removes expired profiles');
assert.equal(cohort.profiles['profile-new'].firstSeenAt, now, 'new profile backfill starts when it enters the cohort');
assert.equal(cohort.profiles['profile-old'].cursor, 'old-cursor', 'restart cursor survives cohort refresh');
assert.equal(cohort.profiles['profile-new'].expiresAt, (Math.floor(now / 86400) + 1) * 86400 + 7200, 'watched profile remains through EoD plus two-hour grace');

assert.deepEqual(JSON.parse(JSON.stringify(context.projectEod(100, 200, 150, 750, 60, 3))), {
  durationSeconds: 100,
  inFlightCompletionsByEod: 1,
  expectedCompletionsByEod: 6,
  inFlightLpByEod: 60,
  expectedLpByEod: 360,
  repeatLpByEod: 300,
  inFlightQuantityByEod: 3,
  expectedQuantityByEod: 18
}, 'EoD projection includes every complete same-duration automation repeat');
assert.equal(context.projectEod(100, 800, 150, 750, 60, 3).expectedCompletionsByEod, 0, 'a process ending after EoD contributes no completed LP');
assert.equal(context.projectEod(200, 200, 150, 750, 60, 3).expectedCompletionsByEod, 1, 'invalid duration retains the conservative in-flight completion without extrapolation');
assert.equal(context.projectEod(100, 750, 150, 750, 60, 3).expectedCompletionsByEod, 1, 'a process ending exactly at EoD counts once');

const debugLines = context.formatDebug('MUD', [{
  profile: 'profile-123456789', craftingProcess: 'process-123456789', component: 'Framework',
  quantity: 3, lp: 60000000, startTime: 100, endTime: 200, durationSeconds: 100,
  remainingSeconds: 50, expectedCompletionsByEod: 6, expectedLpByEod: 360000000
}], new Date('2026-07-23T05:00:00Z'));
assert.match(debugLines, /MUD LP process diagnosis @ 2026-07-23T05:00:00\.000Z/);
assert.match(debugLines, /profile-123456789 \| Framework \| process-123456789 \| qty=3 \| lp=60,000,000 \| start=100 \| end=200 \| duration=100s \| remaining=50s \| completions=6 \| expectedLP=360,000,000/);

const historyRunner = extractFunction('runUpgradeAutomationLpPerProfileRedemptionHistory');
assert.match(historyRunner, /getSignaturesForAddress\(new solanaWeb3\.PublicKey\(profile\)/, 'history queries watched profile addresses directly');
assert.doesNotMatch(historyRunner, /starbaseKeys|getSignaturesForAddress\(starbase/, 'history no longer scans the high-volume starbase address');
assert.match(historyRunner, /buildUpgradeAutomationLpPerProfileTransactionQueue\(state\.profiles, 250\)/, 'transaction inspection has one global per-cycle cap');
assert.match(historyRunner, /offset \+= 8/, 'transaction RPCs use bounded concurrency');
assert.match(historyRunner, /\[HISTORY-DIAG\]/, 'history cycle logs categorized rejection counters');
assert.match(source, /lp_redemption_total,[^`]*totalLp=/, 'authoritative cumulative LP total is recorded for hourly deltas');
assert.match(source, /_field == "expectedLpByEod"/, 'LP panel reads the expected automation-repeat projection');
assert.match(source, />Expected LP by EOD</, 'panel labels the projection as Expected LP by EOD');
assert.match(source, /lpByEod=.*quantityByEod=/, 'conservative in-flight EoD fields remain in telemetry');

const queue = context.buildQueue({
  alpha: { pending: [{ signature: 'a1' }, { signature: 'a2' }] },
  beta: { pending: [{ signature: 'b1' }, { signature: 'b2' }] }
}, 3);
assert.deepEqual(JSON.parse(JSON.stringify(queue)), [
  { profile: 'alpha', item: { signature: 'a1' } },
  { profile: 'beta', item: { signature: 'b1' } },
  { profile: 'alpha', item: { signature: 'a2' } }
], 'transaction queue is globally capped and round-robins watched profiles');

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
