'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing production function ${name}`);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0, quote = '', escaped = false;
  for (let index = body; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if ('"\'`'.includes(char)) { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

function api() {
  const names = [
    'canonicalizeUpgradeOptimizerDecisionValue',
    'hashUpgradeOptimizerDecisionText',
    'normalizeUpgradeOptimizerDecisionCandidate',
    'buildUpgradeOptimizerDecisionEvidence',
    'buildUpgradeOptimizerDecisionEvidenceBatch',
    'attachUpgradeOptimizerDecisionEvidenceToScheduleRows',
    'buildUpgradeOptimizerDecisionEventLines',
  ];
  const context = vm.createContext({ Date, JSON, Math, Number, Object, String, Array, Map,
    influxEscape: String, influxFieldString: value => JSON.stringify(String(value ?? '')),
    formatSlyaInfluxTimestamp: value => BigInt(value) * 1000000n,
  });
  vm.runInContext(`${names.map(extract).join('\n')}\nthis.api={${names.join(',')}};`, context);
  return context.api;
}

const base = Object.freeze({
  faction: 'ONI', instance: 'ONI', profile: 'profile-public-key', applicationVersion: '0.7.35-268',
  optimizerVersion: 'O2', policyVersion: 'slya.lp.optimizer-policy.v1', schemaVersion: 1,
  decidedAtMs: 1787650000000, inputSnapshotId: 'snapshot-2026-08-25T09:26Z',
  expectedAdditionalLp: 1234, expectedTotalLp: 5678, expectedLpSourceTimestampMs: 1787649940000,
  expectedLpProvenance: 'influx:lp_expected', expectedLpStatus: 'fresh_complete',
  installedLp: 1000, neutralTargetLp: 4000, requestedTargetLp: 5000, optimizerTargetLp: 4800,
  candidates: [
    { component: 'Framework', upgrade: 'Framework Upgrade', eligible: true, lpGain: 68, costAtlas: 0.004,
      atlasPerLp: 0.0000588235, secondsPerUnit: 12, crewRequired: 10, score: 1.2, rank: 2,
      selected: false, rejectionReasons: ['ranked_lower'], priceAtlas: 0.004, priceSource: 'pricingATL.priceATL', priceTimestampMs: 1787649900000 },
    { component: 'Electronics', upgrade: 'Electronics Upgrade', eligible: true, lpGain: 92, costAtlas: 0.005,
      atlasPerLp: 0.0000543478, secondsPerUnit: 14, crewRequired: 20, score: 1.4, rank: 1,
      selected: true, tieBreakReason: 'higher_net_atlas_per_second', rejectionReasons: [], priceAtlas: 0.005,
      priceSource: 'pricingATL.priceATL', priceTimestampMs: 1787649900000 },
  ],
});

test('selected decision is stable, complete, and includes explicit no-upgrade alternative', () => {
  const result = api().buildUpgradeOptimizerDecisionEvidence(base);
  assert.match(result.decisionId, /^lp-decision:v1:/);
  assert.equal(result.selectedCandidateId, result.candidates.find(row => row.selected).candidateId);
  assert.equal(result.candidates.filter(row => row.selected).length, 1);
  assert.equal(result.candidates.at(-1).component, '__NO_UPGRADE__');
  assert.equal(result.candidates.at(-1).selected, false);
  assert.equal(result.candidates.at(-1).rejectionReasons[0], 'upgrade_candidate_selected');
  assert.equal(result.expectedLp.ageMs, 60000);
  assert.equal(result.expectedLp.status, 'fresh_complete');
});

test('same decision-time inputs deduplicate across restart and candidate order', () => {
  const decisionApi = api();
  const first = decisionApi.buildUpgradeOptimizerDecisionEvidence(base);
  const reordered = decisionApi.buildUpgradeOptimizerDecisionEvidence({ ...base, candidates: [...base.candidates].reverse() });
  const restored = JSON.parse(JSON.stringify(first));
  assert.equal(reordered.decisionId, first.decisionId);
  assert.equal(restored.decisionId, first.decisionId);
  assert.deepEqual(reordered.candidates.map(row => row.candidateId).sort(), first.candidates.map(row => row.candidateId).sort());
});

test('no-upgrade and unavailable inputs are explicit rather than silently zero', () => {
  const result = api().buildUpgradeOptimizerDecisionEvidence({
    ...base,
    expectedAdditionalLp: null,
    expectedTotalLp: null,
    expectedLpSourceTimestampMs: null,
    expectedLpStatus: 'NOT_OBSERVED',
    candidates: base.candidates.map(row => ({ ...row, selected: false, eligible: false, rejectionReasons: ['input_unavailable'] })),
    noUpgradeReason: 'optimizer_inputs_unavailable',
  });
  assert.equal(result.expectedLp.additionalLp, null);
  assert.equal(result.expectedLp.totalLp, null);
  assert.equal(result.expectedLp.ageMs, null);
  assert.equal(result.selectedCandidateId, result.candidates.at(-1).candidateId);
  assert.equal(result.candidates.at(-1).selected, true);
  assert.equal(result.candidates.at(-1).selectionReason, 'optimizer_inputs_unavailable');
});

test('actual optimizer summary creates one decision per selected job with the complete universe', () => {
  const decisionApi = api();
  const summary = {
    optimizerVersion: 'O2', expectedLpByEod: 1234, expectedTotalLpByEod: 5678,
    expectedLpByEodSnapshotTime: '2026-08-25T09:25:40.000Z', installedToday: 1000,
    neutralLpTarget: 4000, requestedLpTargetOpt: 5000, achievableLpTargetOpt: 4800,
    neutralComponentPlan: [
      { name: 'Framework', displayName: 'Framework', phantomUpgradeEligible: true, finalCrew: 10, lpPerUnit: 68, secondsPerUnit: 12, optimizer2GmPrice: 0.004, optimizer2NetAtlasPerSecond: 1.2 },
      { name: 'Electronics', displayName: 'Electronics', phantomUpgradeEligible: true, finalCrew: 20, lpPerUnit: 92, secondsPerUnit: 14, optimizer2GmPrice: 0.005, optimizer2NetAtlasPerSecond: 1.4 },
      { name: 'Field Stabilizer', displayName: 'Field Stabilizer', phantomUpgradeEligible: false, finalCrew: 0, lpPerUnit: 100, secondsPerUnit: 16, optimizer2GmPrice: null, optimizer2NetAtlasPerSecond: null, specialRiskBlocked: true },
    ],
  };
  const decisions = decisionApi.buildUpgradeOptimizerDecisionEvidenceBatch(summary, {
    faction: 'ONI', instance: 'ONI', profile: 'profile', applicationVersion: '0.7.35-268',
    decidedAtMs: Date.parse('2026-08-25T09:26:40.000Z'), inputSnapshotId: 'cycle', priceTimestampMs: Date.parse('2026-08-25T09:26:00.000Z'),
  });
  assert.equal(decisions.length, 2);
  assert.deepEqual(decisions.map(item => item.candidates.length), [4, 4]);
  assert.deepEqual(decisions.map(item => item.candidates.find(row => row.selected).component).sort(), ['Electronics', 'Framework']);
  assert.equal(decisions[0].candidates.find(row => row.component === 'Field Stabilizer').rejectionReasons[0], 'special_risk_blocked');
  const rows = decisionApi.attachUpgradeOptimizerDecisionEvidenceToScheduleRows(summary, [
    { component: 'Framework' }, { component: 'Electronics' }, { component: 'Field Stabilizer' },
  ], { faction: 'ONI', instance: 'ONI', profile: 'profile', applicationVersion: '0.7.35-268', decidedAtMs: Date.parse('2026-08-25T09:26:40.000Z'), inputSnapshotId: 'cycle' });
  assert.match(rows[0].decisionId, /^lp-decision:v1:/);
  assert.match(rows[1].candidateId, /^lp-candidate:v1:/);
  assert.equal(rows[2].decisionId, '');
});

test('decision and candidates serialize as joinable append-only Influx events', () => {
  const decisionApi = api();
  const result = decisionApi.buildUpgradeOptimizerDecisionEvidence(base);
  const lines = decisionApi.buildUpgradeOptimizerDecisionEventLines(result);
  assert.equal(lines.length, result.candidates.length + 1);
  assert.match(lines[0], /^lp_optimizer_decision_v1,/);
  assert.match(lines[0], new RegExp(`decisionId=${result.decisionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(lines.filter(line => line.startsWith('lp_optimizer_candidate_v1,')).length, result.candidates.length);
  for (const line of lines.slice(1)) assert.match(line, /decisionId=lp-decision:v1:/);
});

test('production wiring reuses the durable outbox and adds no acquisition cadence', () => {
  assert.match(source, /const decisions = buildUpgradeOptimizerDecisionEvidenceBatch\(summary \|\| \{\}, evidenceContext\)/);
  assert.match(source, /for \(const decision of decisions\) await queueUpgradeOptimizerDecisionEvidence\(decision\)/);
  assert.match(source, /attachUpgradeOptimizerDecisionEvidenceToScheduleRows\(summary \|\| \{\}, capture\.rows, evidenceContext\)/);
  assert.match(source, /SLYA_COST_SOURCE_OUTBOX_KEY/);
  assert.match(source, /decisionId/);
  assert.doesNotMatch(source, /setInterval\([^\n]*lp_optimizer_decision_v1|setTimeout\([^\n]*lp_optimizer_decision_v1|fetch\([^\n]*lp_optimizer_decision_v1/);
});

test('decision lineage survives scheduler row, craft slot, job cache, claim and completion', () => {
  assert.match(source, /lpAutomationDecisionId: String\(row\?\.decisionId \|\| ''\)/);
  assert.match(source, /lpAutomationCandidateId: String\(row\?\.candidateId \|\| ''\)/);
  assert.match(source, /decisionId: String\(userCraft\.lpAutomationDecisionId \|\| ''\)/);
  assert.match(source, /candidateId: String\(userCraft\.lpAutomationCandidateId \|\| ''\)/);
  assert.match(source, /decisionId: String\(upgradeTelemetryJob\?\.decisionId \|\| userCraft\?\.lpAutomationDecisionId \|\| ''\)/);
  assert.match(source, /optimizerDecisionId=\$\{influxFieldString\(job\.decisionId \|\| ''\)\}/);
  assert.match(source, /optimizerCandidateId=\$\{influxFieldString\(job\.candidateId \|\| ''\)\}/);
});
