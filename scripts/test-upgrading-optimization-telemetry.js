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
  Math,
  Number,
  String,
  Array,
  Object,
  UPGRADE_AUTOMATION_COMPONENT_LP: { Framework: 300, Electronics: 120, SDU: 1325 },
  influxEscape: value => String(value).replaceAll(' ', '\\ '),
  influxFieldString: value => `"${String(value)}"`,
  getUpgradeAutomationInfluxFactionTag: () => 'MUD',
  getSlyaInfluxInstanceTag: () => 'MUD-1',
};
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('getUpgradeAutomationComponentLpPerUnit')}
  ${extractFunction('computeUpgradeAutomationInstalledLp')}
  ${extractFunction('buildUpgradeAutomationUpgradingOptimizationLines')}
  this.componentLp = getUpgradeAutomationComponentLpPerUnit;
  this.installedLp = computeUpgradeAutomationInstalledLp;
  this.buildLines = buildUpgradeAutomationUpgradingOptimizationLines;
`, context);

assert.equal(context.componentLp('Survey Data Unit'), 1325, 'the display name resolves to the canonical SDU LP value');
assert.equal(context.installedLp({ Framework: 2, 'Survey Data Unit': 3 }), 4_575, 'player installed LP includes SDU');

const lines = context.buildLines(
  new Date('2026-07-25T11:50:00Z'),
  {
    today: 1_000,
    expectedLpByEod: 400,
    expectedTotalLpByEod: 1_400,
    aggrRelative: 1.1,
    aggrAbsolute: 0.8,
    aggressiveness: 0.88,
  },
  {
    installedToday: 960,
    effectiveCrewTotal: 840,
    neutralLpTargetFullDay: 2_000,
    requestedLpTargetFullDay: 2_500,
    achievableLpTargetFullDay: 2_300,
    neutralComponentPlan: [
      { displayName: 'Framework', installedToday: 2 },
      { displayName: 'Electronics', installedToday: 3 },
    ],
  },
  {
    under24hLp: 120,
    over24hLp: 30,
    oldestOver24hAgeSeconds: 100_000,
  }
);

assert.equal(lines.length, 3, 'one aggregate and one row per component are emitted');
assert.match(lines[0], /^optimization_upgrading,faction=MUD,instance=MUD-1 /);
assert.match(lines[0], /player_lp_installed_today=960i/, 'player installed LP equals the sum of all component LP, not the legacy SDU-excluding total');
assert.match(lines[0], /faction_lp_installed_today=1000i/);
assert.match(lines[0], /expected_additional_lp_eod=400i/);
assert.match(lines[0], /expected_total_lp_eod=1400i/);
assert.match(lines[0], /uninstalled_under_24h_lp=120i/);
assert.match(lines[0], /uninstalled_over_24h_lp=30i/);
assert.match(lines[0], /oldest_uninstalled_over_24h_age_seconds=100000i/);
assert.match(lines[0], /phantom_crew=840i/);
assert.match(lines[0], /neutral_lp_target=2000i/);
assert.match(lines[0], /requested_lp_target=2500i/);
assert.match(lines[0], /optimizer_lp_target=2300i/);
assert.match(lines[0], /aggressiveness_rel=1\.1/);
assert.match(lines[0], /aggressiveness_abs=0\.8/);
assert.match(lines[0], /aggressiveness=0\.88/);
assert.match(lines[1], /^optimization_upgrading_component,faction=MUD,instance=MUD-1,component=Framework /);
assert.match(lines[1], /installed_today=2i/);
assert.match(lines[1], /installed_lp_today=600i/);
assert.match(lines[2], /component=Electronics/);
assert.match(lines[2], /installed_lp_today=360i/);
assert.ok(lines.every(line => line.endsWith(` ${new Date('2026-07-25T11:50:00Z').getTime()}`)), 'all rows share one millisecond timestamp');

const simulation = source.slice(
  source.indexOf('async function runUpgradeAutomationSimulation('),
  source.indexOf('const __slyaUpgradeAutomationApi =')
);
assert.match(simulation, /fetchUpgradeAutomationExpectedLpByEod\(now\)/, 'the simulation loads the fresh EOD forecast');
assert.match(simulation, /computeAggressivenessFromControl\(control, cumErr, influxTarget, now, expectedTotalLpByEod\)/, 'simulation aggressiveness consumes Expected Total LP');
assert.match(simulation, /expectedLpByEod: expectedLpByEod\.value/, 'the simulation exposes Expected Additional LP to the snapshot producer');
assert.match(simulation, /aggrRelative: ag\.aggrRel/, 'the simulation exposes relative aggressiveness');
assert.match(simulation, /aggrAbsolute: ag\.aggrAbs/, 'the simulation exposes absolute aggressiveness');

const snapshotRunner = extractFunction('runUpgradeAutomationSnapshot');
assert.ok(snapshotRunner.indexOf('await runUpgradeAutomationLpPerProfileCycle(now)') < snapshotRunner.indexOf('await runUpgradeAutomationSimulation(instanceId, inventory, now)'), 'process telemetry refreshes before the optimizer consumes Expected Total LP');
assert.match(snapshotRunner, /expectedLpByEod: res\.expectedLpByEod/, 'the emitted aggregate preserves Expected Additional LP from the simulation');
assert.match(snapshotRunner, /aggrRelative: Number\(res\.aggrRelative/, 'the emitted aggregate preserves relative aggressiveness');
assert.match(snapshotRunner, /aggrAbsolute: Number\(res\.aggrAbsolute/, 'the emitted aggregate preserves absolute aggressiveness');

const emitter = extractFunction('emitUpgradeAutomationInfluxSnapshot');
assert.match(emitter, /buildUpgradeAutomationUpgradingOptimizationLines\(now, summary, executionSummary, upgradeAutomationUninstalledLp\)/, 'hourly automation snapshot builds upgrading optimization telemetry');
assert.match(emitter, /sendToInflux\(optimizationLine, 'optimization'\)/, 'upgrading optimization telemetry targets the dedicated bucket');

console.log('upgrading optimization telemetry tests passed');
