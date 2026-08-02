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

const context = {
  Math, Number, Object, String, Set, Map, Array, BigInt,
  influxEscape: val => val.replaceAll('\\', '\\\\').replaceAll(' ', '\\ ').replaceAll(',', '\\,').replaceAll('=', '\\=')
};
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('buildUpgradeAutomationLpPerProfileRpcPlan')}
  ${extractFunction('mergeUpgradeAutomationLpPerProfileSignatureState')}
  ${extractFunction('updateUpgradeAutomationLpPerProfileWatchCohort')}
  ${extractFunction('computeUpgradeAutomationSageEodSeconds')}
  ${extractFunction('medianUpgradeAutomationRestartDelay')}
  ${extractFunction('collectUpgradeAutomationRestartGaps')}
  ${extractFunction('estimateUpgradeAutomationRestartDelay')}
  ${extractFunction('applyUpgradeAutomationRestartDelays')}
  ${extractFunction('computeUpgradeAutomationLpProcessEodProjection')}
  ${extractFunction('summarizeUpgradeAutomationUninstalledLp')}
  ${extractFunction('buildUpgradeAutomationLpPerProfileTransactionQueue')}
  ${extractFunction('extractUpgradeAutomationLpPerProfileRedemptions')}
  ${extractFunction('formatUpgradeAutomationLpProcessHistoryInfluxLine')}
  this.buildPlan = buildUpgradeAutomationLpPerProfileRpcPlan;
  this.mergeState = mergeUpgradeAutomationLpPerProfileSignatureState;
  this.updateCohort = updateUpgradeAutomationLpPerProfileWatchCohort;
  this.sageEod = computeUpgradeAutomationSageEodSeconds;
  this.estimateRestartDelay = estimateUpgradeAutomationRestartDelay;
  this.applyRestartDelays = applyUpgradeAutomationRestartDelays;
  this.projectEod = computeUpgradeAutomationLpProcessEodProjection;
  this.summarizeUninstalled = summarizeUpgradeAutomationUninstalledLp;
  this.buildQueue = buildUpgradeAutomationLpPerProfileTransactionQueue;
  this.extractRedemptions = extractUpgradeAutomationLpPerProfileRedemptions;
  this.formatProcessHistory = formatUpgradeAutomationLpProcessHistoryInfluxLine;
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

const repeatHistory = [
  { profile: 'profile-1', process: 'p1', starbase: '0,-24', component: 'Framework', recipeKey: 'recipe-1', startTime: 100, endTime: 200 },
  { profile: 'profile-1', process: 'p2', starbase: '0,-24', component: 'Framework', recipeKey: 'recipe-1', startTime: 250, endTime: 350 },
  { profile: 'profile-1', process: 'p3', starbase: '0,-24', component: 'Framework', recipeKey: 'recipe-1', startTime: 420, endTime: 520 },
  { profile: 'profile-1', process: 'p4', starbase: '0,-24', component: 'Framework', recipeKey: 'recipe-1', startTime: 900, endTime: 1_000 }
];
const currentRepeatJob = { profile: 'profile-1', starbase: '0,-24', component: 'Framework', recipeKey: 'recipe-1', startTime: 1_100 };
assert.deepEqual(JSON.parse(JSON.stringify(context.estimateRestartDelay(currentRepeatJob, repeatHistory, 1_100))), {
  restartDelaySeconds: 70, restartDelaySource: 'player_component', restartGapSamples: 3, evidenceWindowDays: 7
}, 'the player/component restart delay uses the median observed gap and ignores the large outlier');
assert.deepEqual(JSON.parse(JSON.stringify(context.estimateRestartDelay({ ...currentRepeatJob, profile: 'profile-new' }, repeatHistory, 1_100))), {
  restartDelaySeconds: 70, restartDelaySource: 'component_fallback', restartGapSamples: 3, evidenceWindowDays: 7
}, 'a component median is used when that player has insufficient restart history');
assert.deepEqual(JSON.parse(JSON.stringify(context.estimateRestartDelay({ ...currentRepeatJob, profile: 'profile-new', component: 'Power Source', recipeKey: 'recipe-2' }, repeatHistory, 1_100))), {
  restartDelaySeconds: 70, restartDelaySource: 'global_fallback', restartGapSamples: 3, evidenceWindowDays: 7
}, 'the global median is used when player and component history are unavailable');
assert.equal(context.estimateRestartDelay(currentRepeatJob, [], 1_100).restartDelaySeconds, 300, 'a 300-second conservative delay is used when no restart history exists');

assert.deepEqual(JSON.parse(JSON.stringify(context.projectEod(100, 200, 150, 750, 60, 3, 50))), {
  durationSeconds: 100, overdueSeconds: 0, restartDelaySeconds: 50, remainingRestartDelaySeconds: 50,
  staleUninstalled: false, pendingInstallation: false, inFlightCompletionsByEod: 1, expectedCompletionsByEod: 4,
  inFlightLpByEod: 60, expectedLpByEod: 240, repeatLpByEod: 180,
  inFlightQuantityByEod: 3, expectedQuantityByEod: 12
}, 'active projections include the median restart delay between every completion');
assert.equal(context.projectEod(100, 200, 250, 750, 60, 3, 100).remainingRestartDelaySeconds, 50, 'pending jobs subtract time already overdue from their restart delay');
assert.equal(context.projectEod(100, 200, 350, 750, 60, 3, 100).remainingRestartDelaySeconds, 0, 'pending jobs beyond their typical delay are assumed to restart immediately');
assert.equal(context.projectEod(100, 200, 86_601, 90_000, 60, 3, 100).expectedCompletionsByEod, 0, 'uninstalled LP older than 24 hours is excluded from Expected Additional LP by EOD');
assert.equal(context.projectEod(100, 200, 86_600, 90_000, 60, 3, 100).expectedCompletionsByEod, 18, 'uninstalled LP exactly 24 hours old remains eligible for cadence-based repeats');
assert.equal(
  context.sageEod(1_782_771_962, new Date('2026-07-23T07:50:00Z')),
  1_782_830_162,
  'SAGE EoD preserves the real seconds remaining until UTC midnight without mixing clock epochs'
);
assert.equal(
  context.projectEod(1_782_768_956, 1_782_772_508, 1_782_771_962, context.sageEod(1_782_771_962, new Date('2026-07-23T07:50:00Z')), 701_389, 2_119, 300).expectedCompletionsByEod,
  15,
  'a 59-minute MUD job includes its restart delay without mixing clock epochs'
);

const uninstalled = context.summarizeUninstalled([
  { lp: 60, pendingInstallation: true, overdueSeconds: 50 },
  { lp: 40, pendingInstallation: true, overdueSeconds: 500 },
  { lp: 30, pendingInstallation: true, overdueSeconds: 90_000 },
  { lp: 999, pendingInstallation: false, overdueSeconds: 0 }
]);
assert.deepEqual(JSON.parse(JSON.stringify(uninstalled)), {
  under24hLp: 100,
  over24hLp: 30,
  oldestOver24hAgeSeconds: 90_000
}, 'faction diagnostics split all uninstalled LP only by the 24-hour EoD cutoff');

const historyRunner = extractFunction('runUpgradeAutomationLpPerProfileRedemptionHistory');
assert.match(historyRunner, /getSignaturesForAddress\(new solanaWeb3\.PublicKey\(profile\)/, 'history queries watched profile addresses directly');
assert.doesNotMatch(historyRunner, /starbaseKeys|getSignaturesForAddress\(starbase/, 'history no longer scans the high-volume starbase address');
assert.match(historyRunner, /buildUpgradeAutomationLpPerProfileTransactionQueue\(state\.profiles, 250\)/, 'transaction inspection has one global per-cycle cap');
assert.match(historyRunner, /offset \+= 8/, 'transaction RPCs use bounded concurrency');
assert.match(historyRunner, /\[HISTORY-DIAG\]/, 'history cycle logs categorized rejection counters');
assert.match(source, /lp_redemption_total,[^`]*totalLp=/, 'authoritative cumulative LP total is recorded for hourly deltas');
assert.match(source, /_field == "expectedLpByEod"/, 'LP panel reads the expected automation-repeat projection');
assert.match(source, />Expected Additional LP by EOD</, 'panel labels the active-process projection as additional LP');
assert.match(source, />Expected Total LP by EOD</, 'panel shows LP Today plus expected additional LP');
assert.doesNotMatch(source, />Projected LP Today</, 'historical projected LP is removed from the panel');
assert.match(source, /lpByEod=.*quantityByEod=/, 'conservative in-flight EoD fields remain in telemetry');

const processHistory = context.formatProcessHistory([{
  profile: 'profile-1', craftingProcess: 'process-1', starbase: '0,-24',
  component: 'Framework', recipe: 'Upgrade Framework', recipeKey: 'recipe-1',
  quantity: 42, lp: 1260, lpPerUnit: 30,
  startTime: 1_000, endTime: 1_600, durationSeconds: 600,
  remainingSeconds: 100, pendingInstallation: false, restartDelaySeconds: 70, restartDelaySource: 'player_component', restartGapSamples: 3
}], 'MUD', new Date('2026-07-27T07:00:00Z'), 'MUD1');
assert.match(processHistory, /^lp_upgrade_process_history,/, 'individual active jobs use a separate diagnostic measurement');
assert.match(processHistory, /profile=profile-1/, 'process history retains the player profile');
assert.match(processHistory, /process=process-1/, 'process history retains the process identity');
assert.match(processHistory, /starbase=0\\\,-24/, 'process history retains the starbase');
assert.match(processHistory, /component=Framework/, 'process history retains the component');
assert.match(processHistory, /recipeKey=recipe-1/, 'process history retains the recipe identity');
assert.match(processHistory, /quantity=42i/, 'process history retains job quantity');
assert.match(processHistory, /startTime=1000i,endTime=1600i,durationSeconds=600i/, 'process history retains exact cadence timestamps');
assert.match(processHistory, /restartDelaySeconds=70i,restartGapSamples=3i/, 'process history exposes the observed restart cadence');
assert.match(processHistory, /restartDelaySource=player_component/, 'process history exposes the restart-delay evidence source');
assert.match(source, /fetchUpgradeAutomationRestartHistory\(faction, now\)/, 'the hourly cycle loads the rolling seven-day process evidence before projection');
assert.match(source, /applyUpgradeAutomationRestartDelays\(allProcesses, restartHistory\)/, 'the hourly cycle applies component-level repeat eligibility before aggregation');
assert.match(source, /sendUpgradeAutomationLpProcessHistoryToInflux\(allProcesses, faction, now\)/, 'the hourly cycle emits individual process history without changing projections');
const expectedLpReader = extractFunction('fetchUpgradeAutomationExpectedLpByEod');
assert.doesNotMatch(expectedLpReader, /range\(start: -2h, stop:/, 'the expected-LP read includes the just-written snapshot at the cycle timestamp');

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
