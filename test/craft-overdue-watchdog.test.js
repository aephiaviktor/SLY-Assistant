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

function loadDecision() {
  const context = vm.createContext({ Number });
  vm.runInContext(`${extractFunction('getCraftWatchdogAction')}; this.result = getCraftWatchdogAction;`, context);
  return context.result;
}

test('craft watchdog ignores healthy, idle, and not-yet-overdue slots', () => {
  const decide = loadDecision();
  const now = 1_000_000;

  assert.equal(decide({ expectedEndAt: now - 120_001, pollStartedAt: now - 30_000, pollCompletedAt: now - 40_000, recoveryAttempts: 0 }, { craftingId: 7 }, now), 'none');
  assert.equal(decide({ expectedEndAt: now - 120_001, pollStartedAt: now - 300_000, pollCompletedAt: now - 400_000, recoveryAttempts: 0 }, { craftingId: 0 }, now), 'clear');
  assert.equal(decide({ expectedEndAt: now - 119_999, pollStartedAt: now - 300_000, pollCompletedAt: now - 400_000, recoveryAttempts: 0 }, { craftingId: 7 }, now), 'none');
});

test('craft watchdog reconciles a stalled overdue slot before requesting reload', () => {
  const decide = loadDecision();
  const now = 1_000_000;
  const stalled = { expectedEndAt: now - 120_001, pollStartedAt: now - 300_000, pollCompletedAt: now - 400_000, recoveryAttempts: 0 };

  assert.equal(decide(stalled, { craftingId: 7 }, now), 'reconcile');
  assert.equal(decide({ ...stalled, recoveryAttempts: 1 }, { craftingId: 7 }, now), 'reload');
});

test('craft watchdog is independent, two-minute, generation-safe, and reload-guarded', () => {
  assert.match(source, /CRAFT_WATCHDOG_INTERVAL_MS\s*=\s*2\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /setTimeout\(craftOverdueWatchdog, CRAFT_WATCHDOG_INTERVAL_MS\)/);
  assert.match(source, /craftPollGeneration/);
  assert.match(source, /craftTransactionInFlightCount\s*===\s*0/);
  assert.match(source, /CRAFT_WATCHDOG_RELOAD_COOLDOWN_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /GM\.setValue\(CRAFT_WATCHDOG_LAST_RELOAD_KEY, now\)/);
});
