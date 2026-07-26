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
assert.match(lowBufferHtml, /align="right">25<\/td><td align="right" style="color:#ff8080">0\.25<\/td>/,
  'positive Phantom inventory stays white while its low Buffer Days value is red');
assert.doesNotMatch(lowBufferHtml, /<span style="color:#ff8080">Framework/, 'a low-buffer component name stays white');
assert.doesNotMatch(lowBufferHtml, /Framework \(blocked\)/, 'a low positive Phantom buffer is not labelled blocked');

const zeroInventoryHtml = context.renderRows({}, { Framework: 100 }, { Framework: 0 }, { Framework: 1000 }, {});
assert.match(zeroInventoryHtml, /Framework \(blocked\)/, 'zero Phantom inventory is visibly blocked');
assert.doesNotMatch(zeroInventoryHtml, /<span style="color:#ff8080">Framework/, 'a blocked component name stays white');
assert.match(zeroInventoryHtml, /align="right" style="color:#ff8080">0<\/td>/, 'zero inventory remains a red numeric warning');

const neutralPlan = extractFunction('computeUpgradeAutomationNeutralPlan');
assert.match(neutralPlan, /const phantomInventoryBlocked = inventoryPhantom <= 0;/,
  'zero Phantom inventory has an explicit optimizer block');
assert.match(neutralPlan, /const phantomUpgradeEligible = !phantomInventoryBlocked;/,
  'positive Phantom inventory remains optimizer-eligible regardless of buffer days');
assert.doesNotMatch(neutralPlan, /phantomUpgradeEligible = inventoryPhantom > 0 && !phantomBlocked/,
  'the 0.5 Phantom buffer threshold must not block optimizer allocation');

vm.runInContext(`
  ${extractFunction('getUpgradeAutomationCappedStartAmount')}
  this.capStartAmount = getUpgradeAutomationCappedStartAmount;
`, context);
assert.equal(context.capStartAmount(100, 25), 25, 'scheduler uses all available inventory when it is below the planned amount');
assert.equal(context.capStartAmount(100, 0), 0, 'scheduler does not start with zero inventory');
assert.equal(context.capStartAmount(100, 150), 100, 'scheduler does not exceed its planned amount');

const freshInventoryReader = extractFunction('getUpgradeAutomationFreshInventoryForStart');
assert.match(freshInventoryReader, /getStarbaseFromCoords\(/, 'JIT inventory uses the standalone starbase lookup');
assert.match(freshInventoryReader, /getStarbasePlayer\(/, 'JIT inventory uses the standalone starbase-player lookup');
assert.match(freshInventoryReader, /getStarbasePlayerCargoHolds\(/, 'JIT inventory uses the standalone cargo lookup');
assert.doesNotMatch(freshInventoryReader, /getStarbaseData|getStarbasePlayerData|getCargoHoldsTokenAccounts/,
  'JIT inventory does not reference APIs absent from standalone SLYA');

const inventoryContext = {
  cargoItems: [{ name: 'Framework', token: 'framework-mint' }],
  allRes: undefined
};
vm.createContext(inventoryContext);
vm.runInContext(`
  ${extractFunction('extractInventoryFromCargo')}
  this.extractInventory = extractInventoryFromCargo;
`, inventoryContext);
const extractedInventory = inventoryContext.extractInventory([{
  cargoHoldTokens: [{ mint: 'framework-mint', amount: 17 }]
}]);
assert.equal(extractedInventory.Framework, 17, 'standalone nested cargo holds are mapped through cargoItems without allRes');

console.log('phantom inventory safety tests passed');
