'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPT_SOURCE = fs.readFileSync(path.join(ROOT, 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(source, name) {
  const re = new RegExp(`^[\\t ]*(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const match = re.exec(source);
  if (!match) throw new Error(`Could not find function ${name}`);
  const functionStart = match.index;
  const bodyStart = source.indexOf('{', functionStart);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(functionStart, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function makeHelper() {
  let now = 0;
  const logs = [];
  let invokeCount = 0;
  let invokeImpl = () => Promise.resolve({ ok: true });
  const helper = (reason, options) => {
    if (typeof window === 'undefined' || !window.electronAPI?.snapshotLeveldbToBackup) return;
    const tag = String(options?.tag || 'BAK');
    const backupEnqueuedAt = now;
    const invoke = (delayMs) => {
      const start = () => {
        const backupStart = now;
        window.electronAPI.snapshotLeveldbToBackup().then(result => {
          invokeCount += 1;
          if (options?.onSuccess) options.onSuccess({ enqueuedAt: backupEnqueuedAt, startedAt: backupStart, result });
        }, error => {
          logs.push('[' + tag + '][BAK-ERROR] reason=' + String(reason || 'unknown') + ' err=' + String(error?.message || error));
        });
      };
      if (delayMs > 0) setTimeout(start, delayMs);
      else setTimeout(start, 0);
    };
    try { invoke(options?.delayMs || 0); }
    catch (e) { logs.push('[' + tag + '][BAK-ERROR] reason=' + String(reason || 'unknown') + ' err=' + String(e?.message || e)); }
  };
  const window = {
    electronAPI: { snapshotLeveldbToBackup: () => invokeImpl() },
  };
  return { helper, window, logs, setNow: ms => { now = ms; }, getInvokeCount: () => invokeCount, setInvokeImpl: fn => { invokeImpl = fn; } };
}

function tick(ms = 5) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('queue helper does not block the caller even when the backup promise is delayed', async () => {
  const h = makeHelper();
  let resolveBackup;
  h.setInvokeImpl(() => new Promise(resolve => { resolveBackup = resolve; }));
  const start = Date.now();
  h.helper('settings', { tag: 'SETTINGS' });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, 'helper must not block on the backup completion');
  await tick();
  assert.ok(resolveBackup, 'backup should have been scheduled after the macrotask turn');
  resolveBackup({ ok: true });
  await tick();
  assert.equal(h.getInvokeCount(), 1);
});

test('queue helper enqueues exactly one background backup per call', async () => {
  const h = makeHelper();
  h.helper('craft', { tag: 'CRAFT' });
  h.helper('craft', { tag: 'CRAFT' });
  h.helper('craft', { tag: 'CRAFT' });
  await tick();
  await tick();
  assert.equal(h.getInvokeCount(), 3);
});

test('queue helper catches and logs background backup failures without rethrowing', async () => {
  const h = makeHelper();
  h.setInvokeImpl(() => Promise.reject(new Error('copy failed')));
  h.helper('craft-fail', { tag: 'CRAFT' });
  await tick();
  await tick();
  assert.ok(h.logs.some(line => line.includes('[CRAFT][BAK-ERROR]') && line.includes('copy failed')));
});

test('queue helper is a no-op when electronAPI is missing', () => {
  const h = makeHelper();
  assert.doesNotThrow(() => h.helper('reason'));
});

test('all four save paths must use the non-blocking queue helper and never await the snapshot', () => {
  // saveGlobalSettings, saveFleetConfig, saveCraftConfig must each enqueue (not await) the snapshot.
  for (const tag of ["queueLeveldbSafetyBackup(reason, { tag: 'SETTINGS'",
                     "queueLeveldbSafetyBackup('fleet-'",
                     "queueLeveldbSafetyBackup('craft-'"]) {
    assert.ok(USERSCRIPT_SOURCE.includes(tag), `userscript must call ${tag}`);
  }
  assert.ok(/queueLeveldbSafetyBackup\('config-modal-save'/.test(USERSCRIPT_SOURCE), 'config-modal save must use the helper');
  // The only legitimate await of window.electronAPI.snapshotLeveldbToBackup is in runSlyaPeriodicBackup.
  assert.match(USERSCRIPT_SOURCE, /await\s+window\.electronAPI\.snapshotLeveldbToBackup/);
  const start = USERSCRIPT_SOURCE.indexOf('async function runSlyaPeriodicBackup(');
  assert.notEqual(start, -1, 'runSlyaPeriodicBackup must exist');
  const before = USERSCRIPT_SOURCE.slice(0, start);
  assert.ok(!/await\s+window\.electronAPI\.snapshotLeveldbToBackup\b/.test(before), 'no code before runSlyaPeriodicBackup may await the snapshot');
  const after = USERSCRIPT_SOURCE.slice(start);
  const blockStart = after.indexOf('{');
  let depth = 0, blockEnd = -1;
  for (let i = blockStart; i < after.length; i += 1) {
    if (after[i] === '{') depth += 1;
    if (after[i] === '}') depth -= 1;
    if (depth === 0) { blockEnd = i; break; }
  }
  const afterBody = after.slice(0, blockEnd + 1);
  const afterTail = after.slice(blockEnd + 1);
  assert.ok(!/await\s+window\.electronAPI\.snapshotLeveldbToBackup\b/.test(afterTail), 'no code after runSlyaPeriodicBackup may await the snapshot');
  // The periodic backup body itself may await the snapshot once.
  assert.equal((afterBody.match(/await\s+window\.electronAPI\.snapshotLeveldbToBackup\b/g) || []).length, 1, 'periodic backup body must await the snapshot exactly once');
});

test('queue helper is mirrored into the Electron userscript copy', () => {
  const electronSource = fs.readFileSync(path.join(ROOT, 'electron-app', 'app', 'SLY_Assistant.user.js'), 'utf8');
  assert.match(electronSource, /function queueLeveldbSafetyBackup\(/);
  for (const callSite of ["queueLeveldbSafetyBackup(reason, { tag: 'SETTINGS'",
                          "queueLeveldbSafetyBackup('fleet-'",
                          "queueLeveldbSafetyBackup('craft-'",
                          "queueLeveldbSafetyBackup('config-modal-save'"]) {
    assert.ok(electronSource.includes(callSite), `electron userscript missing ${callSite}`);
  }
});
