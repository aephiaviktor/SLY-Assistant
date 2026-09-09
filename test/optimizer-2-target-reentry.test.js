'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
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

function loadApi() {
  const context = vm.createContext({ Math, Number, String, Array, Object });
  vm.runInContext(`${extractFunction('applyUpgradeAutomationOptimizer2TargetReentry')}\nthis.fn=applyUpgradeAutomationOptimizer2TargetReentry;`, context);
  return context.fn;
}

function loadPlanApi() {
  const context = vm.createContext({
    Date, Math, Number, String, Array, Object, Map,
    UPGRADE_AUTOMATION_MIN_JOB_CREW: 10,
    UPGRADE_AUTOMATION_OPTIMIZER2_TARGET_REENTRY_MAX_CREW_RATIO: 0.15,
    UPGRADE_AUTOMATION_OPTIMIZER2_TARGET_REENTRY_MIN_PROFIT_GAIN_RATIO: 0.10,
    globalSettings: { upgradeAutomationAggressivenessStartHour: 6 },
    getUpgradeAutomationPlanningHorizon: () => ({ planningHours: 6 }),
    getUpgradeAutomationPerformanceComponentName: component => component,
    projectUpgradeAutomationFinalRow: (candidate, crew) => ({
      finalUpgradingHour: Math.floor(crew * 3600 / candidate.secondsPerUnit),
      finalUpgradingDay: Math.floor(crew * 21600 / candidate.secondsPerUnit),
      finalBufferDays: crew > 0 ? candidate.inventoryGlobal / crew : Infinity,
    }),
  });
  vm.runInContext(`${extractFunction('applyUpgradeAutomationOptimizer2TargetReentry')}\n${extractFunction('computeUpgradeAutomationNetAtlasPlan')}\nthis.fn=computeUpgradeAutomationNetAtlasPlan;`, context);
  return context.fn;
}

function row(name, crew, netProfitPerDay, overrides = {}) {
  return {
    name,
    displayName: name,
    crew,
    optimizer2Crew: crew,
    optimizer2NetAtlasPerSecond: netProfitPerDay / 86400,
    phantomUpgradeEligible: true,
    inventoryPhantom: 1_000_000,
    inventoryGlobal: 1_000_000,
    neutralPhaseBlocked: false,
    targetPhaseBlocked: false,
    ...overrides,
  };
}

const legal = (_row, crew) => ({ legal: crew === 0 || crew >= 10 });

test('seeds a profitable neutral-blocked component with one minimum useful crew block', () => {
  const rows = [
    row('Framework', 732, 12.8),
    row('Electronics', 211, 15.5),
    row('Electromagnet', 57, 6.4),
    row('Field Stabilizer', 0, 8.1, { neutralPhaseBlocked: true }),
    row('Survey Data Unit', 0, 4.8, { neutralPhaseBlocked: true }),
  ];

  const result = loadApi()(rows, legal, { minCrew: 10, maxCrewRatio: 0.15, minProfitGainRatio: 0.10 });

  assert.equal(result.transferredCrew, 10);
  assert.equal(result.transfers.length, 1);
  assert.equal(result.transfers[0].from, 'Electromagnet');
  assert.equal(result.transfers[0].to, 'Field Stabilizer');
  assert.equal(rows.find(item => item.name === 'Electromagnet').optimizer2Crew, 47);
  assert.equal(rows.find(item => item.name === 'Field Stabilizer').optimizer2Crew, 10);
  assert.equal(rows.find(item => item.name === 'Survey Data Unit').optimizer2Crew, 0);
  assert.ok(result.transfers[0].profitGainRatio > 0.26 && result.transfers[0].profitGainRatio < 0.27);
  assert.equal(rows.reduce((sum, item) => sum + item.optimizer2Crew, 0), 1000);
});

test('does not seed when the profit improvement is below the threshold', () => {
  const rows = [
    row('Electromagnet', 100, 6.5),
    row('Field Stabilizer', 0, 7.0, { neutralPhaseBlocked: true }),
  ];
  const result = loadApi()(rows, legal, { minCrew: 10, maxCrewRatio: 0.15, minProfitGainRatio: 0.10 });
  assert.equal(result.transferredCrew, 0);
  assert.equal(rows[0].optimizer2Crew, 100);
  assert.equal(rows[1].optimizer2Crew, 0);
});

test('does not violate the rebalance cap or minimum-job legality', () => {
  const rows = [
    row('Electromagnet', 50, 6.4),
    row('Field Stabilizer', 0, 8.1, { neutralPhaseBlocked: true }),
  ];
  const result = loadApi()(rows, legal, { minCrew: 10, maxCrewRatio: 0.15, minProfitGainRatio: 0.10 });
  assert.equal(result.maxCrew, 7);
  assert.equal(result.transferredCrew, 0);
});

test('respects the shared special-risk crew cap', () => {
  const rows = [
    row('Electromagnet', 100, 6.4),
    row('Field Stabilizer', 0, 8.1, { neutralPhaseBlocked: true, specialRiskControlled: true, specialRiskMaxCrew: 5 }),
  ];
  const result = loadApi()(rows, legal, { minCrew: 10, maxCrewRatio: 0.15, minProfitGainRatio: 0.10 });
  assert.equal(result.transferredCrew, 0);
  assert.equal(rows[1].optimizer2Crew, 0);
});

test('integrated Target plan removes the zero-start penalty without changing Neutral', () => {
  const rows = [
    row('Framework', 732, 12.8, { secondsPerUnit: 86400, lpPerUnit: 1 }),
    row('Electronics', 211, 15.5, { secondsPerUnit: 86400, lpPerUnit: 1 }),
    row('Electromagnet', 57, 6.4, { secondsPerUnit: 86400, lpPerUnit: 1 }),
    row('Field Stabilizer', 0, 8.1, { secondsPerUnit: 86400, lpPerUnit: 1, neutralPhaseBlocked: true }),
    row('Survey Data Unit', 0, 4.8, { secondsPerUnit: 86400, lpPerUnit: 1, neutralPhaseBlocked: true }),
  ];
  const metrics = rows.map(candidate => ({
    component: candidate.name,
    priceGm: 100 - candidate.optimizer2NetAtlasPerSecond * 86400,
  }));
  const plan = loadPlanApi();

  const neutral = plan(rows, metrics, 1, 100, new Date('2026-09-09T06:00:00Z'));
  assert.equal(neutral.targetMultiplier, 0);
  assert.equal(neutral.targetReentryTransferredCrew, 0);
  assert.equal(neutral.rows.find(item => item.name === 'Field Stabilizer').optimizer2Crew, 0);

  const target = plan(rows, metrics, 1, 100, new Date('2026-09-09T14:30:00Z'));
  assert.ok(target.targetMultiplier > 0);
  assert.equal(target.targetReentryTransferredCrew, 10);
  assert.ok(target.rows.find(item => item.name === 'Field Stabilizer').optimizer2Crew >= 10);
  assert.equal(target.rows.find(item => item.name === 'Survey Data Unit').optimizer2Crew, 0);
  assert.equal(target.rows.reduce((sum, item) => sum + item.optimizer2Crew, 0), 1000);
});

test('production applies re-entry only after Target starts and exposes its reason', () => {
  assert.match(source, /targetMultiplier > 0[\s\S]{0,300}applyUpgradeAutomationOptimizer2TargetReentry/);
  assert.match(source, /optimizer2TargetReentryReason/);
  assert.match(source, /Target re-entry:/);
  const packaged = fs.readFileSync(path.join(root, 'electron-app', 'app', 'SLY_Assistant.user.js'), 'utf8');
  assert.equal(packaged, source);
});
