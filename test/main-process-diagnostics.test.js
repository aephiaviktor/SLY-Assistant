'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'electron-app', 'main.js');
const SOURCE = fs.readFileSync(MAIN_PATH, 'utf8');

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist`);
  const asyncStart = source.lastIndexOf('async ', functionStart);
  const start = asyncStart !== -1 && source.slice(asyncStart + 6, functionStart) === '' ? asyncStart : functionStart;
  const bodyStart = source.indexOf('{', functionStart);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadFunctions() {
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    extractFunction(SOURCE, 'createMainProcessDiagnostics'),
    extractFunction(SOURCE, 'runMainProcessDiagnosticOperation'),
    'this.createMainProcessDiagnostics = createMainProcessDiagnostics;',
    'this.runMainProcessDiagnosticOperation = runMainProcessDiagnosticOperation;',
  ].join('\n'), context);
  return context;
}

function makeHarness({ enabled = true, hrtimeValues = [] } = {}) {
  const writes = [];
  const mkdirCalls = [];
  const timers = [];
  const errors = [];
  let nowMs = 1_000_000;
  let hrtimeIndex = 0;
  const fakeProcess = {
    pid: 4321,
    hrtime: {
      bigint() {
        const value = hrtimeValues[hrtimeIndex] ?? BigInt(hrtimeIndex) * 1_000_000n;
        hrtimeIndex += 1;
        return value;
      },
    },
    cpuUsage() {
      return { user: 120_000, system: 30_000 };
    },
  };
  const fakePerformance = {
    eventLoopUtilization(previous) {
      if (!previous) return { active: 10, idle: 90, utilization: 0.1 };
      return { active: 20, idle: 180, utilization: 0.1 };
    },
  };
  const options = {
    enabled,
    appRoot: '/app',
    outputPath: '/app/analysis/main-process-diagnostics.jsonl',
    appName: 'SLYA - MUD',
    instanceName: 'MUD',
    intervalMs: 300_000,
    fs: {
      mkdirSync(target, opts) { mkdirCalls.push({ target, opts }); },
      appendFileSync(target, text, encoding) { writes.push({ target, text, encoding }); },
    },
    path: { dirname: value => value.slice(0, value.lastIndexOf('/')) },
    os: { cpus: () => [{}, {}, {}, {}] },
    performance: fakePerformance,
    process: fakeProcess,
    crypto: { randomUUID: () => 'diagnostic-session' },
    now: () => nowMs,
    isoNow: () => new Date(nowMs).toISOString(),
    setInterval(callback, intervalMs) {
      const timer = {
        callback,
        intervalMs,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      timers.push(timer);
      return timer;
    },
    logError(error) { errors.push(error); },
  };
  return {
    options,
    writes,
    mkdirCalls,
    timers,
    errors,
    advance(ms) { nowMs += ms; },
  };
}

function parseRecords(writes) {
  return writes.flatMap(entry => entry.text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

test('diagnostics disabled creates no file, directory, or timer and operations are no-ops', () => {
  const { createMainProcessDiagnostics } = loadFunctions();
  const harness = makeHarness({ enabled: false });
  const diagnostics = createMainProcessDiagnostics(harness.options);
  assert.equal(diagnostics.increment('ironforgeRequests'), undefined);
  assert.equal(diagnostics.begin(), null);
  assert.equal(diagnostics.finish('walletSign', null, true, { messageBytes: 12 }), undefined);
  assert.equal(diagnostics.start(), null);
  assert.equal(harness.mkdirCalls.length, 0);
  assert.equal(harness.writes.length, 0);
  assert.equal(harness.timers.length, 0);
});

test('counters accumulate and reports reset interval counters', () => {
  const { createMainProcessDiagnostics } = loadFunctions();
  const harness = makeHarness();
  const diagnostics = createMainProcessDiagnostics(harness.options);
  diagnostics.start();
  diagnostics.increment('ironforgeRequests');
  diagnostics.increment('ironforgeRequests', 2);
  harness.advance(300_000);
  diagnostics.report();
  diagnostics.report();
  const intervals = parseRecords(harness.writes).filter(record => record.type === 'interval');
  assert.equal(intervals[0].counters.ironforgeRequests, 3);
  assert.deepEqual(intervals[1].counters, {});
});

test('timed operations retain calls, successes, failures, total, maximum, and numeric extras', () => {
  const { createMainProcessDiagnostics } = loadFunctions();
  const harness = makeHarness({ hrtimeValues: [0n, 5_000_000n, 10_000_000n, 17_000_000n] });
  const diagnostics = createMainProcessDiagnostics(harness.options);
  diagnostics.start();
  diagnostics.finish('walletSign', diagnostics.begin(), true, { messageBytes: 12 });
  diagnostics.finish('walletSign', diagnostics.begin(), false, { messageBytes: 4 });
  harness.advance(300_000);
  diagnostics.report();
  const counter = parseRecords(harness.writes).find(record => record.type === 'interval').counters.walletSign;
  assert.equal(counter.calls, 2);
  assert.equal(counter.successes, 1);
  assert.equal(counter.failures, 1);
  assert.equal(counter.totalMs, 12);
  assert.equal(counter.maxMs, 7);
  assert.equal(counter.messageBytes, 16);
});

test('reports include finite non-negative process CPU and event-loop fields', () => {
  const { createMainProcessDiagnostics } = loadFunctions();
  const harness = makeHarness();
  const diagnostics = createMainProcessDiagnostics(harness.options);
  diagnostics.start();
  harness.advance(300_000);
  diagnostics.report();
  const report = parseRecords(harness.writes).find(record => record.type === 'interval');
  assert.equal(report.wallMs, 300_000);
  assert.equal(report.logicalCpuCount, 4);
  for (const value of Object.values(report.processCpu)) assert.ok(Number.isFinite(value) && value >= 0);
  for (const value of Object.values(report.eventLoop)) assert.ok(Number.isFinite(value) && value >= 0);
});

test('reports exclude supplied secrets, transaction data, signatures, headers, URLs, and RPC payloads', () => {
  const { createMainProcessDiagnostics } = loadFunctions();
  const harness = makeHarness();
  const diagnostics = createMainProcessDiagnostics(harness.options);
  diagnostics.start();
  const sensitiveValues = {
    secret: 'SECRET_KEY_MATERIAL',
    transaction: 'TRANSACTION_BYTES',
    signature: 'SIGNATURE_VALUE',
    headers: 'AUTHORIZATION_HEADER',
    url: 'https://rpc.example/private/path',
    payload: 'RPC_PAYLOAD_CONTENT',
  };
  diagnostics.finish('walletSign', diagnostics.begin(), true, { messageBytes: 12, ...sensitiveValues });
  harness.advance(300_000);
  diagnostics.report();
  const output = harness.writes.map(entry => entry.text).join('');
  for (const value of Object.values(sensitiveValues)) assert.equal(output.includes(value), false);
});

test('the five-minute interval timer is unrefd', () => {
  const { createMainProcessDiagnostics } = loadFunctions();
  const harness = makeHarness();
  const diagnostics = createMainProcessDiagnostics(harness.options);
  diagnostics.start();
  assert.equal(harness.timers.length, 1);
  assert.equal(harness.timers[0].intervalMs, 300_000);
  assert.equal(harness.timers[0].unrefCalled, true);
});

test('diagnostic IPC wrapper preserves successful results and thrown errors', async () => {
  const { runMainProcessDiagnosticOperation } = loadFunctions();
  const calls = [];
  const diagnostics = {
    begin: () => 10n,
    finish: (...args) => calls.push(args),
  };
  const result = { ok: true, bytes: 42 };
  assert.strictEqual(
    await runMainProcessDiagnosticOperation(diagnostics, 'writeSlyaStateBackup', () => result, value => ({ bytes: value.bytes })),
    result,
  );
  assert.equal(calls[0][2], true);
  assert.deepEqual(calls[0][3], { bytes: 42 });

  const returnedFailure = { ok: false, error: 'existing result' };
  assert.strictEqual(
    await runMainProcessDiagnosticOperation(diagnostics, 'snapshotLeveldbToBackup', () => returnedFailure),
    returnedFailure,
  );
  assert.equal(calls[1][2], false);

  const existingError = new Error('existing thrown error');
  await assert.rejects(
    runMainProcessDiagnosticOperation(diagnostics, 'auditLeveldb', () => { throw existingError; }),
    error => error === existingError,
  );
  assert.equal(calls[2][2], false);
});

test('main-process instrumentation is confined to approved paths and starts after IPC registration', () => {
  assert.match(SOURCE, /instanceConfig\.mainProcessDiagnostics === true/);
  assert.match(SOURCE, /onBeforeSendHeaders[\s\S]*?increment\(['"]ironforgeRequests['"]\)[\s\S]*?details\.requestHeaders\['Origin'\]/);
  assert.match(SOURCE, /walletSecret:sign[\s\S]*?begin\(\)[\s\S]*?messageBytes/);
  assert.match(SOURCE, /appendUpgradeAutomationLogFile[\s\S]*?appendUpgradeLogIpc/);
  for (const name of ['snapshotLeveldbToBackup', 'writeSlyaStateBackup', 'readSlyaStateBackup', 'restoreLeveldbFromBackup', 'auditLeveldb']) {
    assert.match(SOURCE, new RegExp(`ipcMain\\.handle\\('${name}'[\\s\\S]*?['\"]${name}['\"]`));
  }
  const lastHandler = SOURCE.lastIndexOf("ipcMain.handle('auditLeveldb'");
  const startCall = SOURCE.lastIndexOf('mainProcessDiagnostics.start()');
  assert.ok(startCall > lastHandler, 'diagnostics must start after IPC handlers are registered');
});
