'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const userscriptPath = path.join(root, 'SLY_Assistant.user.js');
const electronCopyPath = path.join(root, 'electron-app', 'app', 'SLY_Assistant.user.js');
const source = fs.readFileSync(userscriptPath, 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, startMarker);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}

test('successful mining start fee is persisted for the eventual completed mining point', () => {
  const startMining = between('async function execStartMining', 'async function execStopMining');
  assert.match(startMining, /savePendingMiningTransaction/);
  assert.match(source, /GM\.setValue\(getPendingMiningTransactionKey\(fleet\)/);
});

test('completed mining telemetry includes start and stop fees and explicit transaction count', () => {
  const stopMining = between('async function execStopMining', 'async function execStartCrafting');
  assert.match(stopMining, /loadPendingMiningTransaction/);
  assert.match(stopMining, /buildMiningTxCostInfluxFields/);
  assert.match(stopMining, /clearPendingMiningTransaction/);
  assert.match(source, /txCount=\$\{Math\.round\(transactionCount\)\}i/);
});

test('pending start telemetry is only counted for a successful transaction and is overwritten per new cycle', () => {
  const helperRegion = between('function getSlyaTxFeeLamports', 'function appendInfluxFieldsToLines');
  assert.match(helperRegion, /function getSlyaSuccessfulTxCount/);
  assert.match(helperRegion, /meta\?\.err/);
  assert.match(helperRegion, /startedAt/);
  assert.match(helperRegion, /GM\.deleteValue/);
});

test('mining transaction helper adds successful start and stop fees without counting failed sends', async () => {
  const helperRegion = between('function getSlyaSuccessfulTxCount', 'function appendInfluxFieldsToLines');
  const values = new Map();
  const context = {
    getPubkeyString: (value) => String(value?.toString?.() || value || ''),
    getSlyaTxFeeLamports: (result) => Number(result?.slyaTxFeeLamports ?? result?.meta?.fee ?? 0),
    GM: {
      setValue: async (key, value) => values.set(key, value),
      getValue: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      deleteValue: async (key) => values.delete(key),
    },
  };
  vm.runInNewContext(`${helperRegion}\nthis.helpers = { getSlyaSuccessfulTxCount, savePendingMiningTransaction, loadPendingMiningTransaction, clearPendingMiningTransaction, buildMiningTxCostInfluxFields };`, context);
  const fleet = { publicKey: 'fleet-account', label: 'Mining Fleet' };
  const pending = await context.helpers.savePendingMiningTransaction(fleet, { meta: { fee: 5000, err: null } }, 'resource-account');
  assert.equal(pending.transactionCount, 1);
  assert.deepEqual(await context.helpers.loadPendingMiningTransaction(fleet, 'other-resource'), null);
  const loaded = await context.helpers.loadPendingMiningTransaction(fleet, 'resource-account');
  assert.equal(loaded.txFeeLamports, 5000);
  assert.equal(context.helpers.buildMiningTxCostInfluxFields(loaded, { meta: { fee: 7000, err: null } }), ',txCostSol=0.000012,txFeeLamports=12000i,txCount=2i');
  assert.equal(context.helpers.getSlyaSuccessfulTxCount({ meta: { fee: 7000, err: { InstructionError: [0, 'x'] } } }), 0);
  await context.helpers.clearPendingMiningTransaction(fleet);
  assert.deepEqual(await context.helpers.loadPendingMiningTransaction(fleet, 'resource-account'), null);
});

test('standalone and Electron userscript copies remain byte-identical', () => {
  assert.equal(fs.readFileSync(electronCopyPath, 'utf8'), source);
});

test('feature does not change userscript version metadata', () => {
  assert.match(source, /^\/\/ @version\s+0\.7\.35$/m);
  assert.match(source, /^\/\/ @aephia-version\s+0\.7\.35-276$/m);
});
