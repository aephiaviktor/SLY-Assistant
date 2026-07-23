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
  influxFieldString: value => `"${String(value)}"`
};
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('buildUpgradeAutomationSlyaPerfFields')}
  this.buildFields = buildUpgradeAutomationSlyaPerfFields;
`, context);

assert.equal(
  context.buildFields({
    today: 100,
    expectedLpByEod: 40,
    expectedTotalLpByEod: 140,
    expectedLpByEodAgeMs: 12_400
  }, {
    installedToday: 25,
    installedYesterday: 80
  }, '2026-07-23T19:00:00Z'),
  'lp_today=100i,expected_additional_lp_eod=40i,expected_total_lp_eod=140i,installed_lp_today=25i,installed_lp_yesterday=80i,expected_additional_snapshot_age_seconds=12i,snapshot_for_hour="2026-07-23T19:00:00Z"',
  'hourly performance point includes all fresh forecast and installation fields'
);

const missingForecast = context.buildFields({
  today: 100,
  expectedLpByEod: null,
  expectedTotalLpByEod: null,
  expectedLpByEodAgeMs: null
}, {
  installedToday: 25,
  installedYesterday: null
}, '2026-07-23T19:00:00Z');
assert.equal(
  missingForecast,
  'lp_today=100i,installed_lp_today=25i,snapshot_for_hour="2026-07-23T19:00:00Z"',
  'unavailable values are omitted instead of being written as misleading zeroes'
);
assert.doesNotMatch(missingForecast, /expected_|installed_lp_yesterday/, 'missing optional metrics do not enter the point');
assert.match(source, /`slya_perf,faction=\$\{influxEscape\(lpAutoFactionTag\)\},instance=\$\{influxEscape\(lpAutoInstanceTag\)\}`/, 'slya_perf is tagged by faction and instance');

console.log('slya_perf tests passed');
