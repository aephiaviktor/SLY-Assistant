'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'SLY_Assistant.user.js'), 'utf8');

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, startMarker);
  assert.notEqual(end, -1, endMarker);
  return source.slice(start, end);
}

test('Scan movement telemetry records the start immediately and the completion after exit', () => {
  const movement = between('async function handleMovement', 'async function handleMining');
  assert.match(movement, /completePendingScanningMovementTransaction\(userFleets\[i\]\)/);
  assert.match(movement, /savePendingScanningMovementTransaction/);
  assert.match(movement, /sendToInflux\(`movement,\$\{movementTags\} \$\{movementFields\}`\)/);
  assert.match(movement, /completePendingScanningMovementTransaction/);
  assert.match(movement, /const movementCompletionTxResult = await execExitSubwarp/);
  assert.match(movement, /const movementCompletionTxResult = await execExitWarp/);
  assert.match(movement, /assignment === 'Scan'/);
});

test('scanning movement state is durable and only clears after successful telemetry emission', () => {
  assert.match(source, /slya:scanning-pending-movement:/);
  assert.match(source, /const sent = await sendToInflux\(line\);\s*if\(!sent\) return false;\s*await clearPendingScanningMovementTransaction/s);
  assert.match(source, /type=\$\{optimizationInfluxString\(`\$\{pending\.type\}_exit`\)\},burnedFuel=0,moveTime=0,moveDist=0/);
  assert.match(source, /txCount=\$\{Math\.round\(completionCount\)\}i/);
});

test('failed completion writes retain durable state and a retry emits only the exit transaction', async () => {
  const helperRegion = between('function getPendingScanningMovementTransactionKey', 'function appendInfluxFieldsToLines');
  const values = new Map();
  const lines = [];
  let writeSucceeds = false;
  const context = {
    getPubkeyString: String,
    getSlyaSuccessfulTxCount: (tx) => !tx || tx?.meta?.err ? 0 : 1,
    getSlyaTxFeeLamports: (tx) => Number(tx?.meta?.fee || 0),
    optimizationInfluxString: (value) => JSON.stringify(String(value)),
    sendToInflux: async (line) => { lines.push(line); return writeSucceeds; },
    GM: {
      setValue: async (key, value) => values.set(key, value),
      getValue: async (key, fallback) => values.has(key) ? values.get(key) : fallback,
      deleteValue: async (key) => values.delete(key),
    },
  };
  vm.runInNewContext(`${helperRegion}\nthis.helpers={savePendingScanningMovementTransaction,completePendingScanningMovementTransaction};`, context);
  const fleet = { publicKey: 'scan-fleet' };
  await context.helpers.savePendingScanningMovementTransaction(fleet, {
    movementTags: 'fleet=Scanner,assignment=Scan', type: 'subwarp', burnedFuel: 10, moveTime: 20, moveDist: 2,
    txResult: { meta: { fee: 5001, err: null } },
  });
  assert.equal(await context.helpers.completePendingScanningMovementTransaction(fleet, { meta: { fee: 5002, err: null } }), false);
  assert.equal(values.size, 1);
  writeSucceeds = true;
  assert.equal(await context.helpers.completePendingScanningMovementTransaction(fleet), true);
  assert.equal(values.size, 0);
  assert.match(lines.at(-1), /type="subwarp_exit",burnedFuel=0,moveTime=0,moveDist=0,txCostSol=0\.000005002,txFeeLamports=5002i,txCount=1i/);
});

test('scan points expose explicit successful transaction counts', () => {
  const scan = between('async function handleScanCore', 'async function handleMining');
  assert.match(scan, /buildSlyaTxCostInfluxFields\(scanResult\)/);
});
