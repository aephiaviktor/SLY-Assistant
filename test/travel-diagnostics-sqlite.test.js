'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');

const appRoot = path.resolve(__dirname, '..', 'electron-app');
const vendor = path.join(appRoot, 'vendor', 'node-sqlite3-wasm-0.8.61');
const bindingPath = path.join(vendor, 'node-sqlite3-wasm.js');
const { Database } = require(bindingPath);
const main = fs.readFileSync(path.join(appRoot, 'main.js'), 'utf8');
const diagnostics = main.slice(main.indexOf('const TRAVEL_SQLITE_VENDOR_DIR'), main.indexOf('function createMainProcessDiagnostics('));
const payload = {
  schema: 'slya.automated-travel.v1',
  timestamp: '2026-11-23T10:10:18.542Z',
  type: 'forecast',
  fleet: 'CF-05|06',
  runId: '1795428618542:test-fleet',
  moveType: 'warp',
  decisionSource: 'shared_forecast',
  forecast: { estimated: true, inventory: { phantom: { electronics: 1_360_000 } } },
};

function loadDiagnostics(overrides = {}) {
  return vm.runInNewContext(diagnostics + '\n({getTravelSqliteBinding, createTravelDiagnosticsWriter})', {
    fs, path, crypto, Buffer, AbortSignal, fetch, require, APP_ROOT: appRoot, ...overrides,
  });
}

async function withTemporaryDirectory(operation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'slya-travel-sqlite-'));
  try {
    return await operation(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const driver of ['bundled', 'built-in']) {
  test(`the ${driver} driver persists indexed travel records across restarts`, async t => {
    if (driver === 'built-in') {
      try { require('node:sqlite'); }
      catch (error) {
        if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
        return t.skip('This Node runtime predates built-in SQLite');
      }
    }
    await withTemporaryDirectory(async directory => {
      const databasePath = path.join(directory, 'data', 'automated-travel.sqlite');
      const { createTravelDiagnosticsWriter } = loadDiagnostics();
      const options = { databasePath, instance: 'MUD', resolveBinding: async () => driver === 'bundled' ? bindingPath : null };
      fs.mkdirSync(path.dirname(databasePath));
      const legacy = { ...payload, runId: 'legacy-run', forecast: { events: Array(10_000).fill({ mode: 'warp' }) } };
      const oldDb = new Database(databasePath);
      try {
        oldDb.exec(`CREATE TABLE automated_travel_diagnostics (
          id INTEGER PRIMARY KEY, instance_name TEXT NOT NULL, fleet TEXT NOT NULL,
          recorded_at TEXT NOT NULL, run_id TEXT, event_type TEXT NOT NULL,
          move_type TEXT, payload TEXT NOT NULL CHECK (json_valid(payload)))`);
        oldDb.run('INSERT INTO automated_travel_diagnostics VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
          ['MUD', legacy.fleet, legacy.timestamp, legacy.runId, legacy.type, legacy.moveType, JSON.stringify(legacy)]);
      } finally {
        oldDb.close();
      }
      const legacyBytes = fs.statSync(databasePath).size;
      const first = createTravelDiagnosticsWriter(options);
      try {
        assert.equal((await first.write(JSON.stringify(payload))).ok, true);
        assert.equal((await first.write('invalid JSON')).ok, false);
      } finally {
        assert.equal((await first.close()).ok, true);
      }
      const second = createTravelDiagnosticsWriter(options);
      try {
        const movement = { ...payload, type: 'movement_selected', moveType: 'subwarp' };
        assert.equal((await second.write(JSON.stringify(movement))).ok, true);
      } finally {
        assert.equal((await second.close()).ok, true);
      }
      assert.equal(fs.readFileSync(databasePath).subarray(0, 16).toString(), 'SQLite format 3\0');
      assert.ok(fs.statSync(databasePath).size < legacyBytes / 2);
      const db = new Database(databasePath);
      try {
        const records = db.all(`
          SELECT instance_name, fleet, recorded_at, event_type, move_type,
                 json_extract(payload, '$.decisionSource') AS decision_source, payload, forecast_gzip
          FROM automated_travel_diagnostics WHERE run_id = ? ORDER BY id
        `, [payload.runId]);
        assert.deepEqual(records.map(({ payload, forecast_gzip, ...record }) => record), ['forecast', 'movement_selected'].map((event_type, index) => ({
          instance_name: 'MUD', fleet: payload.fleet, recorded_at: payload.timestamp,
          event_type, move_type: index ? 'subwarp' : 'warp', decision_source: 'shared_forecast',
        })));
        const summary = JSON.parse(records[0].payload);
        assert.deepEqual(summary.forecast, { estimated: true });
        assert.deepEqual(JSON.parse(gunzipSync(records[0].forecast_gzip)), payload.forecast);
        assert.equal(records[1].forecast_gzip, null);
        const migrated = db.get('SELECT id, payload, forecast_gzip FROM automated_travel_diagnostics WHERE run_id = ?', [legacy.runId]);
        assert.equal(migrated.id, 1);
        assert.deepEqual({ ...JSON.parse(migrated.payload), forecast: JSON.parse(gunzipSync(migrated.forecast_gzip)) }, legacy);
        assert.deepEqual(db.all('PRAGMA index_list(automated_travel_diagnostics)').map(row => row.name).sort(),
          ['fleet_history', 'forecast_history']);
      } finally {
        db.close();
      }
    });
  });
}

test('diagnostic retention evicts the oldest records and reclaims disk space', () => withTemporaryDirectory(async directory => {
  const { createTravelDiagnosticsWriter } = loadDiagnostics();
  const databasePath = path.join(directory, 'automated-travel.sqlite');
  const maxStorageBytes = 128 * 1024;
  const writer = createTravelDiagnosticsWriter({ databasePath, instance: 'MUD', maxStorageBytes, resolveBinding: async () => bindingPath });
  const records = Array.from({ length: 12 }, (_, index) => ({ ...payload, runId: `${index}`, forecast: {
    inventory: crypto.randomBytes(16 * 1024).toString('base64'),
  } }));
  try {
    for (const record of records) {
      const result = await writer.write(JSON.stringify(record));
      assert.equal(result.ok, true, result.error);
      assert.ok(fs.statSync(databasePath).size <= maxStorageBytes);
    }
  } finally {
    assert.equal((await writer.close()).ok, true);
  }
  const db = new Database(databasePath);
  try {
    const retained = db.all('SELECT run_id, forecast_gzip FROM automated_travel_diagnostics ORDER BY id');
    assert.ok(retained.length >= 2 && retained.length < records.length);
    assert.deepEqual(retained.map(record => record.run_id), records.slice(-retained.length).map(record => record.runId));
    assert.deepEqual(JSON.parse(gunzipSync(retained.at(-1).forecast_gzip)), records.at(-1).forecast);
    assert.equal(db.get('PRAGMA quick_check').quick_check, 'ok');
  } finally {
    db.close();
  }
}));

test('older app updates fetch and verify pinned SQLite assets only when needed', () => withTemporaryDirectory(async installation => {
  const downloads = [];
  let serveWrongBytes = true;
  const { getTravelSqliteBinding } = loadDiagnostics({
    APP_ROOT: installation,
    AEP_UPDATE_BASE_URL: 'https://updates.example.test',
    require(name) {
      assert.equal(name, 'node:sqlite');
      throw Object.assign(new Error('missing'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
    },
    async fetch(url) {
      downloads.push(url);
      const bytes = serveWrongBytes ? Buffer.from('incorrect') : fs.readFileSync(path.join(vendor, path.basename(url)));
      return { ok: true, arrayBuffer: async () => bytes };
    },
  });
  await assert.rejects(getTravelSqliteBinding(), /checksum does not match/);
  serveWrongBytes = false;
  const installed = await getTravelSqliteBinding();
  assert.equal(installed, path.join(installation, path.relative(appRoot, bindingPath)));
  assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(bindingPath));
  assert.equal(downloads.length, 4);
  assert.equal(await getTravelSqliteBinding(), installed);
  assert.equal(downloads.length, 4);
}));
