'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.resolve(__dirname, '..', 'electron-app', 'main.js'), 'utf8');

function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < SOURCE.length; index += 1) {
    if (SOURCE[index] === '{') depth += 1;
    if (SOURCE[index] === '}') depth -= 1;
    if (depth === 0) return SOURCE.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadCoordinator() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunction('createLeveldbSnapshotCoordinator')}\nthis.createLeveldbSnapshotCoordinator = createLeveldbSnapshotCoordinator;`, context);
  return context.createLeveldbSnapshotCoordinator;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makeHarness({ controlled = false } = {}) {
  const createCoordinator = loadCoordinator();
  const counters = {};
  const timers = [];
  const snapshots = [];
  let now = 0;
  let active = 0;
  let maxActive = 0;
  const performSnapshot = () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const call = controlled ? deferred() : { promise: Promise.resolve({ ok: true, run: snapshots.length + 1 }) };
    snapshots.push({ at: now, call });
    return call.promise.finally(() => { active -= 1; });
  };
  const coordinator = createCoordinator({
    minIntervalMs: 30_000,
    now: () => now,
    diagnostics: { increment(name) { counters[name] = (counters[name] || 0) + 1; } },
    performSnapshot,
    setTimeout(callback, delay) {
      const timer = { callback, at: now + delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
  });
  async function flush() { await Promise.resolve(); await Promise.resolve(); }
  async function advance(ms) {
    now += ms;
    for (;;) {
      const index = timers.findIndex(timer => timer.at <= now && !timer.fired);
      if (index === -1) break;
      timers[index].fired = true;
      timers[index].callback();
      await flush();
    }
  }
  return { coordinator, counters, timers, snapshots, get maxActive() { return maxActive; }, advance, flush };
}

test('first request runs immediately and cooldown burst creates one unrefd trailing snapshot', async () => {
  const h = makeHarness();
  const first = h.coordinator.request();
  await h.flush();
  assert.equal(h.snapshots.length, 1);
  await first;
  const burst = Array.from({ length: 100 }, () => h.coordinator.request());
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].unrefCalled, true);
  await h.advance(29_999);
  assert.equal(h.snapshots.length, 1);
  await h.advance(1);
  assert.equal(h.snapshots.length, 2);
  await Promise.all(burst);
  assert.equal(h.counters.snapshotLeveldbRequests, 101);
  assert.equal(h.counters.snapshotLeveldbCoalesced, 100);
  assert.equal(h.counters.snapshotLeveldbTrailingRuns, 1);
});

test('requests during an active snapshot never overlap and retain one trailing run', async () => {
  const h = makeHarness({ controlled: true });
  const first = h.coordinator.request();
  await h.flush();
  const trailing = [h.coordinator.request(), h.coordinator.request(), h.coordinator.request()];
  assert.equal(h.snapshots.length, 1);
  h.snapshots[0].call.resolve({ ok: true, run: 1 });
  await first;
  await h.advance(30_000);
  assert.equal(h.snapshots.length, 2);
  assert.equal(h.maxActive, 1);
  h.snapshots[1].call.resolve({ ok: true, run: 2 });
  await Promise.all(trailing);
});

test('continuous requests start physical snapshots no more than once per 30 seconds', async () => {
  const h = makeHarness();
  await h.coordinator.request();
  for (let elapsed = 1_000; elapsed <= 90_000; elapsed += 1_000) {
    h.coordinator.request();
    await h.advance(1_000);
  }
  assert.deepEqual(h.snapshots.map(snapshot => snapshot.at), [0, 30_000, 60_000, 90_000]);
});

test('activity arriving during cooldown is captured by the eventual trailing snapshot', async () => {
  const h = makeHarness();
  await h.coordinator.request();
  const trailing = h.coordinator.request();
  await h.advance(20_000);
  h.coordinator.request();
  assert.equal(h.snapshots.length, 1);
  await h.advance(10_000);
  assert.equal((await trailing).run, 2);
  assert.equal(h.snapshots.length, 2);
});

test('a rejected physical snapshot does not wedge later automatic requests', async () => {
  const h = makeHarness({ controlled: true });
  const failed = h.coordinator.request();
  await h.flush();
  h.snapshots[0].call.reject(new Error('copy failed'));
  await assert.rejects(failed, /copy failed/);
  await h.advance(30_000);
  const next = h.coordinator.request();
  await h.flush();
  assert.equal(h.snapshots.length, 2);
  h.snapshots[1].call.resolve({ ok: true });
  assert.deepEqual(await next, { ok: true });
});

test('returned failures and thrown exceptions preserve their existing contracts', async () => {
  const failure = { ok: false, error: 'existing failure' };
  const createCoordinator = loadCoordinator();
  const diagnostics = { increment() {} };
  const returnedFailure = createCoordinator({
    minIntervalMs: 30_000, now: () => 0, setTimeout: () => assert.fail('unexpected timer'), diagnostics,
    performSnapshot: () => failure,
  });
  assert.strictEqual(await returnedFailure.request(), failure);

  const existingError = new Error('existing exception');
  const thrownError = createCoordinator({
    minIntervalMs: 30_000, now: () => 0, setTimeout: () => assert.fail('unexpected timer'), diagnostics,
    performSnapshot: () => { throw existingError; },
  });
  await assert.rejects(thrownError.request(), error => error === existingError);
});

test('immediate manual requests bypass cooldown but remain serialized', async () => {
  const h = makeHarness({ controlled: true });
  const automatic = h.coordinator.request();
  await h.flush();
  h.snapshots[0].call.resolve({ ok: true });
  await automatic;
  const manual = h.coordinator.request({ immediate: true });
  await h.flush();
  assert.equal(h.snapshots.length, 2);
  assert.equal(h.snapshots[1].at, 0);
  h.snapshots[1].call.resolve({ ok: true, manual: true });
  assert.equal((await manual).manual, true);
  assert.equal(h.maxActive, 1);
});

test('source keeps diagnostics opt-in, times only physical copies, and leaves restore and JSON handlers separate', () => {
  assert.match(SOURCE, /const LEVELDB_SNAPSHOT_MIN_INTERVAL_MS = 30 \* 1000/);
  assert.match(SOURCE, /instanceConfig\.mainProcessDiagnostics === true/);
  assert.match(SOURCE, /performSnapshot: \(\) => runMainProcessDiagnosticOperation\(mainProcessDiagnostics, 'snapshotLeveldbToBackup', performLeveldbSnapshotNow\)/);
  assert.match(SOURCE, /ipcMain\.handle\('snapshotLeveldbToBackup'[\s\S]*?requestLeveldbSnapshot\(\)/);
  assert.match(SOURCE, /ipcMain\.handle\('writeSlyaStateBackup'[\s\S]*?writeSlyaStateBackup\(payload\)/);
  assert.match(SOURCE, /ipcMain\.handle\('restoreLeveldbFromBackup'[\s\S]*?restoreLeveldbFromBackup\(\)/);
});
