'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extract(name) {
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
    if ('"\'`'.includes(char)) { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

function ledgerApi() {
  const context = vm.createContext({
    Date,
    JSON,
    Math,
    Number,
    Object,
    String,
    influxEscape: String,
    optimizationInfluxString: value => JSON.stringify(String(value ?? '')),
    formatSlyaInfluxTimestamp: value => BigInt(value) * 1000000n,
  });
  const names = [
    'buildUpgradeClaimAttemptIdentity',
    'normalizeUpgradeClaimAttemptLedger',
    'applyUpgradeClaimAttemptTransition',
    'buildUpgradeClaimAttemptEventLine',
  ];
  vm.runInContext(`${names.map(extract).join('\n')}\nthis.api={${names.join(',')}};`, context);
  return context.api;
}

const base = Object.freeze({
  faction: 'USTUR',
  instance: 'USTUR2',
  profile: 'profile-public-key',
  applicationVersion: '0.7.35-265',
  craftingId: 8181,
  craftingProcess: 'crafting-process-public-key',
  completionTelemetryId: 'USTUR:USTUR2:8181',
  detectedAtMs: 1787570000000,
  queuedAtMs: 1787570000100,
  triggeringPath: 'craft_poll_completion',
});

function begin(api) {
  const identity = api.buildUpgradeClaimAttemptIdentity(base);
  assert.equal(identity, 'USTUR:USTUR2:profile-public-key:crafting-process-public-key:8181');
  return api.applyUpgradeClaimAttemptTransition(null, { ...base, type: 'queued', attemptIdentity: identity });
}

test('normal claim completion produces one joinable authoritative attempt', () => {
  const api = ledgerApi();
  let ledger = begin(api);
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_started', atMs: 1787570000200 });
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_result', atMs: 1787570000300, transactionSignature: 'normal-signature' });
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'confirmed', atMs: 1787570000900 });
  assert.equal(ledger.attemptNumber, 1);
  assert.equal(ledger.authoritativeFinalState, 'confirmed');
  assert.equal(ledger.transactionSignature, 'normal-signature');
  assert.equal(ledger.confirmedAtMs, 1787570000900);
  assert.equal(ledger.completionTelemetryId, base.completionTelemetryId);
  assert.match(api.buildUpgradeClaimAttemptEventLine(ledger), /^upgrade_claim_attempt_v1,/);
});

test('blockheight timeout records classification, retry reason, and next retry without finalizing the job', () => {
  const api = ledgerApi();
  let ledger = begin(api);
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_started', atMs: 1787570000200 });
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, {
    type: 'retry_scheduled',
    atMs: 1787570030000,
    errorClassification: 'blockheight_timeout',
    retryReason: 'TransactionExpiredBlockheightExceededError',
    nextScheduledRetryAtMs: 1787570030000,
  });
  assert.equal(ledger.authoritativeFinalState, 'retry_scheduled');
  assert.equal(ledger.errorClassification, 'blockheight_timeout');
  assert.equal(ledger.nextScheduledRetryAtMs, 1787570030000);
});

test('retry increments only the attempt number while preserving restart-stable job identity', () => {
  const api = ledgerApi();
  let ledger = begin(api);
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'retry_scheduled', atMs: 1787570030000, retryReason: 'blockheight_timeout', nextScheduledRetryAtMs: 1787570030000 });
  const persisted = JSON.parse(JSON.stringify(ledger));
  ledger = api.normalizeUpgradeClaimAttemptLedger(persisted);
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_started', atMs: 1787570030000 });
  assert.equal(ledger.attemptIdentity, api.buildUpgradeClaimAttemptIdentity(base));
  assert.equal(ledger.attemptNumber, 2);
  assert.equal(ledger.sendStartedAtMs, 1787570030000);
});

test('delayed confirmation links back to the original send and becomes authoritative', () => {
  const api = ledgerApi();
  let ledger = begin(api);
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_started', atMs: 1787570000200 });
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_result', atMs: 1787570000300, transactionSignature: 'delayed-signature' });
  const restored = api.normalizeUpgradeClaimAttemptLedger(JSON.parse(JSON.stringify(ledger)));
  ledger = api.applyUpgradeClaimAttemptTransition(restored, { type: 'confirmed', atMs: 1787570120000 });
  assert.equal(ledger.transactionSignature, 'delayed-signature');
  assert.equal(ledger.authoritativeFinalState, 'confirmed');
  assert.equal(ledger.finalResultAtMs, 1787570120000);
});

test('terminal transaction failure is classified and never represented as confirmation', () => {
  const api = ledgerApi();
  let ledger = begin(api);
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, { type: 'send_started', atMs: 1787570000200 });
  ledger = api.applyUpgradeClaimAttemptTransition(ledger, {
    type: 'failed',
    atMs: 1787570000800,
    transactionSignature: 'failed-signature',
    errorClassification: 'instruction_error',
    error: 'custom program error: 6001',
  });
  assert.equal(ledger.authoritativeFinalState, 'failed');
  assert.equal(ledger.errorClassification, 'instruction_error');
  assert.equal(ledger.confirmedAtMs, 0);
  assert.equal(ledger.finalResultAtMs, 1787570000800);
});

test('production wiring uses the existing durable outbox and adds no timer or acquisition path', () => {
  assert.match(source, /upgrade_claim_attempt_v1/);
  assert.match(source, /queueUpgradeClaimAttemptEvent/);
  assert.match(source, /composeSlyaScheduledInfluxBody/);
  assert.match(source, /execCompleteUpgrade[\s\S]*completionTelemetryId/);
  assert.doesNotMatch(source, /setInterval\([^\n]*upgrade_claim_attempt_v1|setTimeout\([^\n]*upgrade_claim_attempt_v1|fetch\([^\n]*upgrade_claim_attempt_v1/);
});
