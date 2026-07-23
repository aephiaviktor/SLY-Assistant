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

const context = { Math, Number };
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('computeUpgradeAutomationRequestedLpTargetFullDay')}
  this.computeRequested = computeUpgradeAutomationRequestedLpTargetFullDay;
`, context);

const rows = [
  { neutralUpgradingHour: 100, targetBaselineUpgradingHour: 150, lpPerUnit: 10 },
  { neutralUpgradingHour: 20, targetBaselineUpgradingHour: 30, lpPerUnit: 100 }
];
assert.equal(
  context.computeRequested(5000, rows, 1, 2, 4),
  5000 + (100 * 10 + 20 * 100) * 2 + (150 * 10 + 30 * 100) * 4,
  'Aggr 1 includes the all-component target baseline during target-phase hours'
);
assert.equal(
  context.computeRequested(5000, rows, 1.2, 2, 4),
  5000 + (100 * 10 + 20 * 100) * 2 + (150 * 10 + 30 * 100) * 1.2 * 4,
  'aggressiveness applies only to the target-phase baseline'
);
assert.equal(
  context.computeRequested(5000, rows, 1.2, 6, 0),
  5000 + (100 * 10 + 20 * 100) * 6,
  'neutral phase remains special-free and is not multiplied by aggressiveness'
);
assert.equal(
  context.computeRequested(5000, [{ ...rows[0], targetPhaseBlocked: true }, rows[1]], 1.2, 2, 4),
  5000 + (100 * 10 + 20 * 100) * 2 + (100 * 10 + 20 * 100) * 1.2 * 4,
  'a fully blocked target phase falls back to the executable neutral baseline'
);

console.log('requested LP target tests passed');
