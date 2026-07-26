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
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${name} body must exist`);
  let depth = 0, quote = '', escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = {};
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('getUpgradeAutomationComponentValue')}
  ${extractFunction('getUpgradeAutomationEffectiveDrain')}
  ${extractFunction('formatUpgradeAutomationInfluxRows')}
  this.renderRows = formatUpgradeAutomationInfluxRows;
`, context);

const lowBufferHtml = context.renderRows({}, { Framework: 100 }, { Framework: 25 }, { Framework: 1000 }, {});
assert.match(lowBufferHtml, /Framework/);
assert.match(lowBufferHtml, /color:#ff8080/, 'a Phantom buffer below 0.5 remains a red warning');
assert.doesNotMatch(lowBufferHtml, /\(blocked\)/, 'a low Phantom buffer is no longer labelled blocked');

const neutralPlan = extractFunction('computeUpgradeAutomationNeutralPlan');
assert.match(neutralPlan, /const phantomUpgradeEligible = inventoryPhantom > 0;/,
  'positive Phantom inventory remains optimizer-eligible regardless of buffer days');
assert.doesNotMatch(neutralPlan, /phantomUpgradeEligible = inventoryPhantom > 0 && !phantomBlocked/,
  'the 0.5 Phantom buffer threshold must not block optimizer allocation');

console.log('phantom buffer warning tests passed');
