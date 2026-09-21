'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readSource(sourcePath = path.join('SLY_Assistant.user.js')) {
  return fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8');
}

function loadFunction(name, sourcePath = path.join('SLY_Assistant.user.js')) {
  const source = readSource(sourcePath);
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in ${sourcePath}`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let end = bodyStart;
  for (; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }

  const context = vm.createContext({});
  vm.runInContext(`${source.slice(start, end + 1)}; this.result = ${name};`, context);
  return context.result;
}

test('checked cargo remains a per-trip amount while checked crew remains a route total', () => {
  const applyTransportTotalRemaining = loadFunction('applyTransportTotalRemaining');
  const [entry] = applyTransportTotalRemaining([{
    res: 'food',
    amt: 2000,
    cargoTotal: true,
    cargoDispatched: 750,
    crew: 20,
    crewTotal: true,
    crewDispatched: 5,
  }]);

  assert.equal(entry.amt, 2000);
  assert.equal(entry.crew, 15);
});

test('required cargo waits when the requested amount is missing and compatible room remains', () => {
  const getTransportRequiredLoadWait = loadFunction('getTransportRequiredLoadWait');
  const result = getTransportRequiredLoadWait(
    [{ res: 'food', amt: 2000, cargoTotal: true }],
    { food: 1200 },
    1000,
    { food: 1 },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { entryIndex: 0, res: 'food', missing: 800 });
});

test('required cargo may depart below the requested amount when no compatible room remains', () => {
  const getTransportRequiredLoadWait = loadFunction('getTransportRequiredLoadWait');
  const result = getTransportRequiredLoadWait(
    [{ res: 'food', amt: 2000, cargoTotal: true }],
    { food: 1200 },
    0,
    { food: 1 },
  );

  assert.equal(result, null);
});

test('unchecked cargo never blocks departure', () => {
  const getTransportRequiredLoadWait = loadFunction('getTransportRequiredLoadWait');
  const result = getTransportRequiredLoadWait(
    [{ res: 'food', amt: 2000, cargoTotal: false }],
    { food: 0 },
    5000,
    { food: 1 },
  );

  assert.equal(result, null);
});

test('dedicated ammo room keeps a checked ammo load waiting even when cargo is full', () => {
  const getTransportRequiredLoadWait = loadFunction('getTransportRequiredLoadWait');
  const result = getTransportRequiredLoadWait(
    [{ res: 'ammo', amt: 1000, cargoTotal: true }],
    { ammo: 700 },
    0,
    { ammo: 1 },
    { ammo: 500 },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { entryIndex: 0, res: 'ammo', missing: 300 });
});

test('required-load retry is one minute and uses the concise activity text', () => {
  const source = readSource();
  assert.match(source, /const TRANSPORT_LOAD_RETRY_DELAY_MS = 60000;/);
  assert.match(source, /updateFleetState\(fleet, `Waiting for \$\{resourceName\}`, true\);/);
  assert.doesNotMatch(source, /Waiting for \$\{resourceName\}.*retrying/i);
});

test('fuel and ammo loading account for the amount actually available', () => {
  const source = readSource();
  assert.match(source, /const actualFuelAdded = Math\.max\(0, Number\(execResp && execResp\.amount \|\| 0\)\);/);
  assert.match(source, /amountLoaded = Math\.max\(0, Number\(resp && resp\.amount \|\| 0\)\);/);
});

test('required transport load can satisfy the remaining amount across multiple starbase cargo pods', () => {
  const planStarbaseCargoLoads = loadFunction('planStarbaseCargoLoads');
  const result = planStarbaseCargoLoads([
    { cargoPod: 'pod-a', token: 'token-a', amount: 25000 },
    { cargoPod: 'pod-b', token: 'token-b', amount: 50000 },
  ], 41958, false, 0);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    requested: 41958,
    amount: 41958,
    remaining: 0,
    loads: [{ cargoPod: 'pod-b', token: 'token-b', amount: 41958 }],
  });
});

test('required transport load combines split cargo pods and preserves one token in each source', () => {
  const planStarbaseCargoLoads = loadFunction('planStarbaseCargoLoads');
  const result = planStarbaseCargoLoads([
    { cargoPod: 'pod-a', token: 'token-a', amount: 25000 },
    { cargoPod: 'pod-b', token: 'token-b', amount: 20000 },
  ], 41958, true, 0);

  assert.equal(result.amount, 41958);
  assert.equal(result.remaining, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(result.loads)), [
    { cargoPod: 'pod-a', token: 'token-a', amount: 24999 },
    { cargoPod: 'pod-b', token: 'token-b', amount: 16959 },
  ]);
});

test('transport loading opts into multi-pod source loading and collects every planned transaction', () => {
  const source = readSource();
  assert.match(source, /execCargoFromStarbaseToFleet\([\s\S]*?resMax,[\s\S]*?true\s*\)/);
  assert.match(source, /transactions\.push\(\.\.\.\(resp\.transactions \|\| \[\]\)\)/);
});

test('resource checkbox uses a light-brown background while unchecked and checked', () => {
  const styleTransportRequiredLoadCheckbox = loadFunction('styleTransportRequiredLoadCheckbox');
  let refresh = null;
  const checkbox = {
    checked: false,
    style: {},
    addEventListener(eventName, listener) {
      assert.equal(eventName, 'change');
      refresh = listener;
    },
  };

  styleTransportRequiredLoadCheckbox(checkbox);
  assert.equal(checkbox.style.appearance, 'none');
  assert.equal(checkbox.style.backgroundColor, '#c8a77a');
  assert.equal(checkbox.style.backgroundImage, 'none');

  checkbox.checked = true;
  refresh();
  assert.equal(checkbox.style.backgroundColor, '#c8a77a');
  assert.match(checkbox.style.backgroundImage, /^url\("data:image\/svg\+xml,/);
});

test('resource checkbox has required-load tooltip and custom background in both source copies', () => {
  for (const sourcePath of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = readSource(sourcePath);
    assert.match(source, /transportResourceTotal\.title = 'Require amount before departure\.';/);
    assert.match(source, /styleTransportRequiredLoadCheckbox\(transportResourceTotal\);/);
    assert.match(source, /transportResourceCrewTotal\.title = 'Treat this crew amount as a total to dispatch, not per roundtrip\.';/);
  }
});
