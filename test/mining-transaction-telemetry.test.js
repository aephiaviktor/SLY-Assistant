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

test('confirmed Mine support transactions are staged once per signature before the next mining start', () => {
  const confirmedTx = between('function txSignAndSend', 'async function execScan');
  assert.match(confirmedTx, /recordConfirmedMiningSupportTransaction\(fleet, opName, txResult\)/);
  assert.match(source, /\['LOAD', 'UNLOAD', 'RESUPPLY', 'DOCK', 'UNDOCK'\]/);
  assert.match(source, /fleetParsedData\?\.assignment !== 'Mine'/);
});

test('completed mining telemetry includes start and stop fees and explicit transaction count', () => {
  const stopMining = between('async function execStopMining', 'async function execStartCrafting');
  assert.match(stopMining, /loadPendingMiningTransaction/);
  assert.match(stopMining, /buildMiningTxCostInfluxFields/);
  assert.match(stopMining, /if\(sent\) await clearPendingMiningTransaction/);
  assert.match(source, /txCount=\$\{Math\.round\(transactionCount\)\}i/);
});

test('pending start telemetry is only counted for a successful transaction and is overwritten per new cycle', () => {
  const helperRegion = between('function getSlyaTxFeeLamports', 'function appendInfluxFieldsToLines');
  assert.match(helperRegion, /function getSlyaSuccessfulTxCount/);
  assert.match(helperRegion, /meta\?\.err/);
  assert.match(helperRegion, /startedAt/);
  assert.match(helperRegion, /GM\.deleteValue/);
});

test('mining transaction helper combines staged resupply, start, and stop without counting failed sends', async () => {
  const helperRegion = between('function getSlyaSuccessfulTxCount', 'function appendInfluxFieldsToLines');
  const values = new Map();
  const context = {
    globalSettings: { influxURL: 'https://influx.invalid/write' },
    getPubkeyString: (value) => String(value?.toString?.() || value || ''),
    getSlyaTxFeeLamports: (result) => Number(result?.slyaTxFeeLamports ?? result?.meta?.fee ?? 0),
    GM: {
      setValue: async (key, value) => values.set(key, value),
      getValue: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      deleteValue: async (key) => values.delete(key),
    },
  };
  vm.runInNewContext(`${helperRegion}\nthis.helpers = { getSlyaSuccessfulTxCount, stagePendingMiningTransaction, recordConfirmedMiningSupportTransaction, savePendingMiningTransaction, loadPendingMiningTransaction, clearPendingMiningTransaction, buildMiningTxCostInfluxFields };`, context);
  const fleet = { publicKey: 'fleet-account', label: 'Mining Fleet' };
  values.set('fleet-account', JSON.stringify({ assignment: 'Mine' }));
  await context.helpers.recordConfirmedMiningSupportTransaction(fleet, 'UNLOAD', { slyaTxFeeLamports: 6000, slyaTxSliceCount: 1, meta: { err: null } });
  await context.helpers.recordConfirmedMiningSupportTransaction(fleet, 'RESUPPLY', { slyaTxFeeLamports: 8000, slyaTxSliceCount: 1, meta: { err: null } });
  await context.helpers.recordConfirmedMiningSupportTransaction(fleet, 'SCAN', { meta: { fee: 9000, err: null } });
  await context.helpers.recordConfirmedMiningSupportTransaction(fleet, 'LOAD', { meta: { fee: 9999, err: { InstructionError: [0, 'x'] } } });
  const pending = await context.helpers.savePendingMiningTransaction(fleet, { meta: { fee: 5000, err: null } }, 'resource-account');
  assert.equal(pending.transactionCount, 3);
  assert.equal(pending.txFeeLamports, 19000);
  assert.deepEqual(await context.helpers.loadPendingMiningTransaction(fleet, 'other-resource'), null);
  const loaded = await context.helpers.loadPendingMiningTransaction(fleet, 'resource-account');
  assert.equal(loaded.txFeeLamports, 19000);
  assert.equal(context.helpers.buildMiningTxCostInfluxFields(loaded, { meta: { fee: 7000, err: null } }), ',txCostSol=0.000026,txFeeLamports=26000i,txCount=4i');
  assert.equal(context.helpers.getSlyaSuccessfulTxCount({ meta: { fee: 7000, err: { InstructionError: [0, 'x'] } } }), 0);
  await context.helpers.clearPendingMiningTransaction(fleet);
  assert.deepEqual(await context.helpers.loadPendingMiningTransaction(fleet, 'resource-account'), null);
});

test('standalone and Electron userscript copies remain byte-identical', () => {
  assert.equal(fs.readFileSync(electronCopyPath, 'utf8'), source);
});

test('feature does not change userscript version metadata', () => {
  assert.match(source, /^\/\/ @version\s+0\.7\.35$/m);
  assert.match(source, /^\/\/ @aephia-version\s+0\.7\.35-282$/m);
});
