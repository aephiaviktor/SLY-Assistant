'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const signatureEnd = source.indexOf(') {', start);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  let quote = '';
  let escaped = false;
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

function loadFunction(name) {
  const context = vm.createContext({ Date, String, Number, Set });
  vm.runInContext(`${extractFunction(name)}; this.result = ${name};`, context);
  return context.result;
}

test('an overdue 00:58 LP clock at 07:00 is stale, not tomorrow night', () => {
  const parse = loadFunction('parseUpgradeAutomationLiveFinishAtUtc');
  assert.equal(parse('Upgrading [00:58]', new Date('2026-07-29T05:00:00Z')), '');
});

test('a near-midnight 00:58 LP clock is allowed to resolve to the coming night', () => {
  const parse = loadFunction('parseUpgradeAutomationLiveFinishAtUtc');
  assert.equal(parse('Upgrading [00:58]', new Date('2026-07-28T20:00:00Z')), '2026-07-28T22:58:00.000Z');
});

test('runtime reconciliation evicts only a pre-existing managed crafting id absent on-chain', () => {
  const shouldClear = loadFunction('shouldClearMissingUpgradeAutomationProcess');
  const onChainIds = new Set(['222']);

  assert.equal(shouldClear({ craftingId: 111, lpAutomationManaged: true }, { craftingId: 111 }, onChainIds), true);
  assert.equal(shouldClear({ craftingId: 222, lpAutomationManaged: true }, { craftingId: 222 }, onChainIds), false);
  assert.equal(shouldClear({ craftingId: 0, lpAutomationManaged: true }, { craftingId: 0 }, onChainIds), false);
  assert.equal(shouldClear({ craftingId: 111, lpAutomationManaged: false }, { craftingId: 111 }, onChainIds), false);
  assert.equal(shouldClear({ craftingId: 333, lpAutomationManaged: true }, { craftingId: 111 }, onChainIds), false);
});
