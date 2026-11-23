'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

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
  forecast: { inventory: { phantom: { electronics: 1_360_000 } } },
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
      const db = new Database(databasePath);
      try {
        const records = db.all(`
          SELECT instance_name, fleet, recorded_at, event_type, move_type,
                 json_extract(payload, '$.forecast.inventory.phantom.electronics') AS electronics
          FROM automated_travel_diagnostics WHERE run_id = ? ORDER BY id
        `, [payload.runId]);
        assert.deepEqual(records, ['forecast', 'movement_selected'].map((event_type, index) => ({
          instance_name: 'MUD', fleet: payload.fleet, recorded_at: payload.timestamp,
          event_type, move_type: index ? 'subwarp' : 'warp', electronics: 1_360_000,
        })));
        assert.deepEqual(db.all('PRAGMA index_list(automated_travel_diagnostics)').map(row => row.name).sort(),
          ['fleet_history', 'forecast_history']);
      } finally {
        db.close();
      }
    });
  });
}

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
