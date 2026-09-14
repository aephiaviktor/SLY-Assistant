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
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = body; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if ('"\'`'.includes(char)) {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

function loadRamp() {
  const context = vm.createContext({ Date, Math, Number });
  vm.runInContext(`${extractFunction('computeUpgradeAutomationTargetRamp')}\nthis.fn = computeUpgradeAutomationTargetRamp;`, context);
  return context.fn;
}

test('2.0 accelerated target curve has the agreed early-biased checkpoints', () => {
  const ramp = loadRamp();

  assert.equal(ramp(new Date('2026-09-14T06:00:00Z'), 6), 0);
  assert.ok(Math.abs(ramp(new Date('2026-09-14T10:31:00Z'), 6) - 0.44129565496301904) < 1e-12);
  assert.ok(Math.abs(ramp(new Date('2026-09-14T12:00:00Z'), 6) - 0.6208969925678929) < 1e-12);
  assert.equal(ramp(new Date('2026-09-14T23:00:00Z'), 6), 1);
});

test('target curve remains bounded outside the configured phase', () => {
  const ramp = loadRamp();

  assert.equal(ramp(new Date('2026-09-14T03:00:00Z'), 6), 0);
  assert.equal(ramp(new Date('2026-09-14T23:59:59Z'), 6), 1);
});

test('overall aggressiveness uses the same accelerated target authority', () => {
  const context = vm.createContext({
    Date,
    Math,
    Number,
    globalSettings: {
      upgradeAutomationAggressivenessStartHour: 6,
      upgradeAutomationRelMultiplier: 1,
      upgradeAutomationAbsAggrMultiplier: 1,
    },
    clamp: (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value)),
    computeAbsoluteAggressivenessAdjustment: () => 0.6,
  });
  vm.runInContext(
    `${extractFunction('computeUpgradeAutomationTargetRamp')}\n${extractFunction('computeAggressivenessFromControl')}\nthis.fn = computeAggressivenessFromControl;`,
    context,
  );

  const result = context.fn(
    { errNow: 0.2 },
    0,
    null,
    new Date('2026-09-14T10:31:00Z'),
    23_000_000_000,
  );

  assert.ok(Math.abs(result.timeWeight - 0.44129565496301904) < 1e-12);
  assert.ok(Math.abs(result.aggr - 1.0882591309926038) < 1e-12);
});

test('packaged userscript stays byte-identical to the canonical userscript', () => {
  const packaged = fs.readFileSync(path.join(root, 'electron-app', 'app', 'SLY_Assistant.user.js'), 'utf8');
  assert.equal(packaged, source);
});
