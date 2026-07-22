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
  Math, Number, Object, String, Set, Map, Array,
  getSlyaInfluxInstanceTag: () => 'MUD',
  influxEscape: value => String(value).replace(/ /g, '\\ ')
};
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('reconcileUpgradeAutomationLpPerProfileHistory')}
  ${extractFunction('aggregateUpgradeAutomationLpPerProfile')}
  ${extractFunction('formatUpgradeAutomationLpPerProfileCompletedInfluxLine')}
  this.reconcile = reconcileUpgradeAutomationLpPerProfileHistory;
  this.aggregate = aggregateUpgradeAutomationLpPerProfile;
  this.formatCompleted = formatUpgradeAutomationLpPerProfileCompletedInfluxLine;
`, context);

const prior = [
  { profile: 'profile-a', craftingProcess: 'process-1', component: 'Framework', quantity: 10, lp: 680, lpPerUnit: 68, endTime: 1_000 },
  { profile: 'profile-b', craftingProcess: 'process-2', component: 'Power Source', quantity: 2, lp: 196, lpPerUnit: 98, endTime: 2_000 },
  { profile: 'profile-c', craftingProcess: 'process-3', component: 'Electromagnet', quantity: 3, lp: 399, lpPerUnit: 133, endTime: 3_000 }
];
const current = [
  prior[1],
  { profile: 'profile-d', craftingProcess: 'process-4', component: 'Framework', quantity: 4, lp: 272, lpPerUnit: 68, endTime: 4_000 }
];

const result = context.reconcile(prior, current, 2_500);
assert.deepEqual(JSON.parse(JSON.stringify(result.completed)), [
  { profile: 'profile-a', craftingProcess: 'process-1', component: 'Framework', quantity: 10, lp: 680, lpPerUnit: 68, endTime: 1_000, completedAt: 2_500 }
], 'a disappeared process is recorded only after its scheduled end time');
assert.deepEqual(result.pending.map(row => row.craftingProcess).sort(), ['process-2', 'process-3', 'process-4'], 'visible jobs and not-yet-due missing jobs remain pending');

const duplicateCurrent = context.reconcile(prior, [prior[1], prior[1]], 2_500);
assert.equal(duplicateCurrent.pending.filter(row => row.craftingProcess === 'process-2').length, 1, 'current process IDs are deduplicated');

const aggregate = context.aggregate([
  { ...prior[0], active: false, completesByEod: false },
  { ...prior[1], active: true, completesByEod: true }
]);
assert.equal(aggregate['profile-a'], undefined, 'finished but unredeemed processes are excluded from the active snapshot');
assert.equal(aggregate['profile-b']['Power Source'].lpByEod, 196, 'active processes still populate Guaranteed LP by EOD');

const line = context.formatCompleted(result.completed, 'MUD');
assert.match(line, /source=redeemed/);
assert.match(line, /process=process-1/);
assert.match(line, /lp=680,quantity=10i,lpPerUnit=68i,scheduledEndTime=1000i 2500000$/, 'completion time is written in milliseconds for the configured Influx precision');
console.log('lp-per-profile history tests passed');
