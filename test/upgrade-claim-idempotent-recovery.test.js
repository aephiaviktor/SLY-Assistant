'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extract(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0) ?? -1;
  assert.notEqual(start, -1, `missing production function ${name}`);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0, quote = '', escaped = false;
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

function recoveryApi() {
  const context = vm.createContext({ Map, Promise, Date, JSON, Math, Number, Object, String });
  const names = ['buildUpgradeClaimAttemptIdentity', 'buildUpgradeClaimRecoveryKey', 'normalizeUpgradeClaimRecoveryState', 'decideUpgradeClaimRecoveryAction', 'runIdempotentUpgradeClaimRecovery'];
  vm.runInContext(`const upgradeClaimRecoveryInFlight=new Map();\n${names.map(extract).join('\n')}\nthis.api={${names.join(',')}};`, context);
  return context.api;
}

const identity = Object.freeze({ faction: 'USTUR', instance: 'USTUR2', profile: 'profile', craftingProcess: 'process', craftingId: 42 });
const key = 'USTUR:USTUR2:profile:process:42';

function harness(overrides = {}) {
  let state = overrides.initialState || null;
  let sends = 0, verifies = 0, authoritativeReads = 0, completions = 0, telemetryFinalizations = 0;
  const operations = {
    loadState: async () => state,
    saveState: async next => { state = JSON.parse(JSON.stringify(next)); },
    readAuthoritativeState: async () => { authoritativeReads += 1; return overrides.authoritativeState || 'pending'; },
    verifySignature: async signature => { verifies += 1; return overrides.signatureStatus?.[signature] || 'pending'; },
    send: async () => { sends += 1; return overrides.sendResult || { status: 'sent', signature: `sig-${sends}` }; },
    finalizeCompletion: async () => { completions += 1; },
    finalizeTelemetry: async () => { telemetryFinalizations += 1; },
  };
  return { operations, state: () => state, counts: () => ({ sends, verifies, authoritativeReads, completions, telemetryFinalizations }) };
}

test('concurrent scheduler and fallback triggers coalesce to one send', async () => {
  const api = recoveryApi();
  const h = harness();
  await Promise.all([
    api.runIdempotentUpgradeClaimRecovery({ ...identity, triggeringPath: 'scheduler' }, h.operations),
    api.runIdempotentUpgradeClaimRecovery({ ...identity, triggeringPath: 'fallback' }, h.operations),
  ]);
  assert.equal(h.counts().sends, 1);
});

test('timeout followed by delayed confirmation verifies and never resends', async () => {
  const api = recoveryApi();
  const h = harness({
    initialState: { ...identity, recoveryKey: key, attemptNumber: 1, state: 'sent', transactionSignature: 'late-sig' },
    signatureStatus: { 'late-sig': 'confirmed' },
  });
  const result = await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  assert.equal(result.state, 'completed');
  assert.deepEqual(h.counts(), { sends: 0, verifies: 1, authoritativeReads: 0, completions: 1, telemetryFinalizations: 1 });
});

test('restart after sent resumes bounded verification before considering send', async () => {
  const api = recoveryApi();
  const persisted = JSON.stringify({ ...identity, recoveryKey: key, attemptNumber: 1, state: 'sent', transactionSignature: 'pending-sig' });
  const h = harness({ initialState: JSON.parse(persisted), signatureStatus: { 'pending-sig': 'pending' } });
  const result = await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  assert.equal(result.state, 'sent');
  assert.equal(h.counts().verifies, 1);
  assert.equal(h.counts().sends, 0);
});

test('conclusively absent or expired transaction permits exactly one retry', async () => {
  const api = recoveryApi();
  for (const terminal of ['absent', 'expired']) {
    const h = harness({ initialState: { ...identity, recoveryKey: key, attemptNumber: 1, state: 'sent', transactionSignature: `${terminal}-sig` }, signatureStatus: { [`${terminal}-sig`]: terminal } });
    const result = await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
    assert.equal(result.attemptNumber, 2);
    assert.equal(h.counts().sends, 1);
  }
});

test('authoritative already-completed process finalizes locally without sending', async () => {
  const api = recoveryApi();
  const h = harness({ authoritativeState: 'completed' });
  const result = await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  assert.equal(result.state, 'completed');
  assert.equal(h.counts().sends, 0);
  assert.equal(h.counts().completions, 1);
});

test('permanent instruction failure is terminal and does not loop', async () => {
  const api = recoveryApi();
  const h = harness({ initialState: { ...identity, recoveryKey: key, attemptNumber: 1, state: 'failed_permanent', errorClassification: 'instruction_error' } });
  const first = await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  const second = await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  assert.equal(first.state, 'failed_permanent');
  assert.equal(second.state, 'failed_permanent');
  assert.equal(h.counts().sends, 0);
});

test('recovery keys isolate otherwise identical crafting identities by faction and instance', () => {
  const api = recoveryApi();
  assert.equal(api.buildUpgradeClaimRecoveryKey(identity), key);
  assert.notEqual(api.buildUpgradeClaimRecoveryKey({ ...identity, faction: 'MUD' }), key);
  assert.notEqual(api.buildUpgradeClaimRecoveryKey({ ...identity, instance: 'USTUR1' }), key);
});

test('completion and telemetry finalization are each emitted exactly once', async () => {
  const api = recoveryApi();
  const h = harness({ authoritativeState: 'completed' });
  await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  await api.runIdempotentUpgradeClaimRecovery(identity, h.operations);
  assert.equal(h.counts().completions, 1);
  assert.equal(h.counts().telemetryFinalizations, 1);
});

test('production wiring remains bounded and both userscripts stay byte-identical', () => {
  assert.match(source, /runIdempotentUpgradeClaimRecovery/);
  assert.match(source, /execCompleteUpgrade[\s\S]*runIdempotentUpgradeClaimRecovery/);
  assert.doesNotMatch(source, /setInterval\([^\n]*UpgradeClaimRecovery|setTimeout\([^\n]*UpgradeClaimRecovery/);
  const electron = fs.readFileSync(path.join(__dirname, '..', 'electron-app/app/SLY_Assistant.user.js'), 'utf8');
  assert.equal(electron, source);
});
