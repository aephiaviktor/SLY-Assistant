'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readSource(sourcePath = path.join('SLY_Assistant.user.js')) {
  return fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8');
}

function readFunctionSource(name, sourcePath = path.join('SLY_Assistant.user.js')) {
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
  return source.slice(start, end + 1);
}

function loadFunction(name, sourcePath = path.join('SLY_Assistant.user.js')) {
  const context = vm.createContext({});
  vm.runInContext(`${name === "simulateTransportRequiredLoad" ? readFunctionSource("getTransportRequiredLoadWait", sourcePath) + "\n" + readFunctionSource("isTransportPriorityFull", sourcePath) : ""}\n${readFunctionSource(name, sourcePath)}; this.result = ${name};`, context);
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

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { entryIndex: 0, res: 'food', missing: 800, resources: ['food'] });
});

test('multiple checked cargo entries are OR alternatives and report every waiting resource', () => {
  const getTransportRequiredLoadWait = loadFunction('getTransportRequiredLoadWait');
  const manifest = [
    { res: 'electronics', amt: 30000, cargoTotal: true },
    { res: 'framework', amt: 60000, cargoTotal: true },
  ];

  assert.deepEqual(JSON.parse(JSON.stringify(getTransportRequiredLoadWait(
    manifest,
    { electronics: 0, framework: 0 },
    50715,
    { electronics: 2, framework: 1 },
  ))), { entryIndex: 0, res: 'electronics', missing: 30000, resources: ['electronics', 'framework'] });

  assert.equal(getTransportRequiredLoadWait(
    manifest,
    { electronics: 30000, framework: 0 },
    10000,
    { electronics: 2, framework: 1 },
  ), null, 'one satisfied checked alternative must release the whole OR gate');
});

test('capacity-limited higher-priority cargo makes the hold priority-full despite rounding residue', () => {
  const isTransportPriorityFull = loadFunction('isTransportPriorityFull');
  assert.equal(isTransportPriorityFull(30000, 25357, 25357, 2, 1), true);
  assert.equal(isTransportPriorityFull(30000, 25357, 20000, 2, 10715), false);
});

test('read-only retry simulation waits on partial stock and proceeds only when the route can depart', () => {
  const simulateTransportRequiredLoad = loadFunction('simulateTransportRequiredLoad');
  const manifest = [
    { res: 'survey', amt: 10000, cargoTotal: false },
    { res: 'electronics', amt: 30000, cargoTotal: true },
    { res: 'framework', amt: 60000, cargoTotal: true },
  ];
  const cargoSizes = { survey: 1, electronics: 2, framework: 1 };

  const unavailable = simulateTransportRequiredLoad(manifest, {}, 50715, cargoSizes, { electronics: 0, framework: 0 });
  assert.equal(unavailable.ready, false);
  assert.deepEqual(JSON.parse(JSON.stringify(unavailable.waitingResources)), ['electronics', 'framework']);
  assert.equal(unavailable.plannedAmount, 0);

  const partial = simulateTransportRequiredLoad(manifest, {}, 50715, cargoSizes, { electronics: 10000, framework: 0 });
  assert.equal(partial.ready, false, 'partial stock must not trigger a paid retry that still ends waiting');
  assert.equal(partial.plannedAmount, 10000);

  const sufficient = simulateTransportRequiredLoad(manifest, {}, 50715, cargoSizes, { electronics: 30000, framework: 0 });
  assert.equal(sufficient.ready, true);
  assert.equal(sufficient.priorityFull, true);
  assert.equal(sufficient.projectedCargoAmounts.electronics, 25357);
  assert.equal(sufficient.cargoSpace, 1);
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

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { entryIndex: 0, res: 'ammo', missing: 300, resources: ['ammo'] });
});

test('required-load retry is one minute and uses the concise activity text', () => {
  const source = readSource();
  assert.match(source, /const TRANSPORT_LOAD_RETRY_DELAY_MS = 60000;/);
  assert.match(source, /updateFleetState\(fleet, `Waiting for \$\{resourceName\}`, true\);/);
  assert.doesNotMatch(source, /Waiting for \$\{resourceName\}.*retrying/i);
});

test('required-load retry has an independent recurring per-fleet wake timer and cancels it when cleared', () => {
  const source = readSource();
  assert.match(source, /const transportLoadRetryTimers = new Map\(\);/);
  assert.match(source, /function armTransportLoadRetryTimer\(fleet, retryAt\)/);
  assert.match(source, /function ensureTransportLoadRetryTimer\(fleet\)/);
  assert.match(source, /setTimeout\(async \(\) =>[\s\S]*?startFleet\(fleetIndex, false, 'transport-load-retry'\)/);
  assert.match(source, /scheduleTransportLoadRetry[\s\S]*?armTransportLoadRetryTimer\(fleet, fleet\.transportLoadRetryAt\)/);
  assert.match(source, /clearTransportLoadRetry[\s\S]*?clearTransportLoadRetryTimer\(fleet\)/);
  assert.match(source, /finally \{[\s\S]*?ensureTransportLoadRetryTimer\(fleet\)/);
});

test('fleet operation single-flight prevents overlapping wake and normal-loop work', () => {
  const source = readSource();
  assert.match(source, /const fleetOperationInFlight = new Set\(\);/);
  assert.match(source, /async function startFleet\(i, scheduleNext = true, trigger = 'loop'\)/);
  assert.match(source, /if\(fleetOperationInFlight\.has\(fleetKey\)\)/);
  assert.match(source, /fleetOperationInFlight\.add\(fleetKey\)/);
  assert.match(source, /fleetOperationInFlight\.delete\(fleetKey\)/);
  assert.match(source, /phase: 'retry-wake-blocked'/);
  assert.match(source, /phase: 'retry-wake-dispatched'/);
});

test('independent retry timer dispatches once and defers safely while fleet work is in flight', async () => {
  let now = 1000;
  let nextTimerId = 0;
  const scheduled = [];
  const cleared = [];
  const diagnostics = [];
  const starts = [];
  const fleet = { label: 'CF-05|06', publicKey: { toString: () => 'fleet-pk' } };
  const context = vm.createContext({
    Date: { now: () => now },
    userFleets: [fleet],
    enableAssistant: true,
    transportLoadRetryTimers: new Map(),
    fleetOperationInFlight: new Set(),
    setTimeout(callback, delay) {
      const timer = { id: ++nextTimerId, callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) { cleared.push(timer.id); },
    recordTransportLoadDiagnostic(_fleet, patch) { diagnostics.push(patch); },
    async startFleet(...args) { starts.push(args); },
  });
  vm.runInContext([
    readFunctionSource('getTransportFleetRuntimeKey'),
    readFunctionSource('clearTransportLoadRetryTimer'),
    readFunctionSource('armTransportLoadRetryTimer'),
    'this.arm = armTransportLoadRetryTimer;',
  ].join('\n'), context);

  assert.equal(context.arm(fleet, now + 60000), true);
  assert.equal(scheduled[0].delay, 60000);
  assert.equal(context.arm(fleet, now + 60000), true);
  assert.deepEqual(cleared, [1]);
  now += 60000;
  await scheduled.at(-1).callback();
  assert.deepEqual(starts, [[0, false, 'transport-load-retry']]);
  assert.equal(diagnostics.at(-1).phase, 'retry-wake-dispatched');

  starts.length = 0;
  context.fleetOperationInFlight.add('fleet-pk');
  assert.equal(context.arm(fleet, now + 60000), true);
  now += 60000;
  await scheduled.at(-1).callback();
  assert.deepEqual(starts, []);
  assert.equal(diagnostics.at(-1).phase, 'retry-wake-blocked');
  assert.equal(scheduled.at(-1).delay, 5000);
});

test('retry lifecycle re-arms every 60 seconds while the same required-load wait remains', () => {
  let now = 1000;
  const scheduled = [];
  const diagnostics = [];
  const fleet = {
    label: 'CF-05|06',
    state: 'Waiting for Copper Ore',
    transportLoadRetryAt: 0,
    transportLoadRetryResource: 'Copper Ore',
    publicKey: { toString: () => 'fleet-pk' },
  };
  const context = vm.createContext({
    Date: { now: () => now },
    userFleets: [fleet],
    enableAssistant: true,
    TRANSPORT_LOAD_RETRY_DELAY_MS: 60000,
    transportLoadRetryTimers: new Map(),
    fleetOperationInFlight: new Set(),
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout() {},
    recordTransportLoadDiagnostic(_fleet, patch) { diagnostics.push(patch); },
    async startFleet() {},
  });
  vm.runInContext([
    readFunctionSource('getTransportFleetRuntimeKey'),
    readFunctionSource('clearTransportLoadRetryTimer'),
    readFunctionSource('armTransportLoadRetryTimer'),
    readFunctionSource('ensureTransportLoadRetryTimer'),
    'this.ensure = ensureTransportLoadRetryTimer;',
  ].join('\n'), context);

  assert.equal(context.ensure(fleet), true);
  assert.equal(scheduled.at(-1).delay, 60000);
  assert.equal(fleet.transportLoadRetryAt, 61000);
  assert.equal(diagnostics.at(-1).phase, 'retry-rearmed');

  assert.equal(context.ensure(fleet), false, 'an already armed wait must not duplicate its timer');
  assert.equal(scheduled.length, 1);

  fleet.state = 'Idle';
  fleet.transportLoadRetryAt = 0;
  context.transportLoadRetryTimers.clear();
  now += 60000;
  assert.equal(context.ensure(fleet), false, 'a resolved wait must not re-arm');
  assert.equal(scheduled.length, 1);
});

test('transport diagnostics expose every required-load threshold', () => {
  const buildTransportRequiredLoadThresholds = loadFunction('buildTransportRequiredLoadThresholds');
  const result = buildTransportRequiredLoadThresholds(
    [
      { res: 'copper', amt: 100000, cargoTotal: true },
      { res: 'food', amt: 2000, cargoTotal: false },
      { res: 'ammo', amt: 1000, cargoTotal: true },
    ],
    { copper: 17522, food: 250, ammo: 700 },
    82478,
    { copper: 1, food: 1, ammo: 1 },
    { ammo: 500 },
  );

  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { entryIndex: 0, res: 'copper', required: 100000, aboard: 17522, missing: 82478, requiredLoad: true, cargoSize: 1, cargoSpace: 82478, dedicatedFree: 0, compatibleFree: 82478, thresholdMet: false, departureBlocked: true },
    { entryIndex: 1, res: 'food', required: 2000, aboard: 250, missing: 1750, requiredLoad: false, cargoSize: 1, cargoSpace: 82478, dedicatedFree: 0, compatibleFree: 82478, thresholdMet: false, departureBlocked: false },
    { entryIndex: 2, res: 'ammo', required: 1000, aboard: 700, missing: 300, requiredLoad: true, cargoSize: 1, cargoSpace: 82478, dedicatedFree: 500, compatibleFree: 82978, thresholdMet: false, departureBlocked: true },
  ]);
});

test('LP Automation panel no longer renders the temporary Transport Load Debugger', () => {
  for (const sourcePath of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = readSource(sourcePath);
    assert.doesNotMatch(source, /Transport Load Debugger/);
    assert.doesNotMatch(source, /buildTransportLoadDebugRowsHtml/);
    assert.doesNotMatch(source, /lp-auto-transport-debug/);
    assert.doesNotMatch(source, /transportLoadDiagnosticRenderTimer/);
  }
});

test('fuel and ammo loading account for the amount actually available', () => {
  const source = readSource();
  assert.match(source, /const actualFuelAdded = Math\.max\(0, Number\(execResp && execResp\.amount \|\| 0\)\);/);
  assert.match(source, /amountLoaded = Math\.max\(0, Number\(resp && resp\.amount \|\| 0\)\);/);
});

test('starbase cargo discovery keeps every matching token account in the same cargo pod', () => {
  const collectStarbaseCargoSources = loadFunction('collectStarbaseCargoSources');
  const result = collectStarbaseCargoSources('pod-a', {
    value: [
      {
        pubkey: 'copper-small',
        account: { data: { parsed: { info: { mint: 'copper', tokenAmount: { uiAmount: 17522 } } } } },
      },
      {
        pubkey: 'carbon',
        account: { data: { parsed: { info: { mint: 'carbon', tokenAmount: { uiAmount: 1 } } } } },
      },
      {
        pubkey: 'copper-large',
        account: { data: { parsed: { info: { mint: 'copper', tokenAmount: { uiAmount: 79000 } } } } },
      },
    ],
  }, 'copper');

  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { cargoPod: 'pod-a', token: 'copper-small', amount: 17522 },
    { cargoPod: 'pod-a', token: 'copper-large', amount: 79000 },
  ]);
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

test('resource checkbox explains required-load alternatives and has custom background in both source copies', () => {
  for (const sourcePath of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = readSource(sourcePath);
    assert.match(source, /transportResourceTotal\.title = 'Require this resource as a departure alternative\.';/);
    assert.match(source, /styleTransportRequiredLoadCheckbox\(transportResourceTotal\);/);
    assert.match(source, /transportResourceCrewTotal\.title = 'Treat this crew amount as a total to dispatch, not per roundtrip\.';/);
  }
});

for (const assignment of ['Transport', 'Supply Chain']) {
  for (const scenario of [
    { name: 'due Copper retry uses chain Idle', expected: ['Idle'] },
    { name: 'cooldown does not dispatch', retryAt: 3000, expected: [] },
    { name: 'stopped fleet does not dispatch', state: 'STOPPED', expected: [] },
    { name: 'error fleet does not dispatch', state: 'ERROR: transaction failed', expected: [] },
    { name: 'in-progress resupply is not bypassed', resupplying: true, expected: [] },
    { name: 'non-Idle chain state is not fabricated as Idle', chainState: 'StarbaseLoadingBay', expected: ['Waiting for Copper Ore'] },
    { name: 'non-retry dispatch is unchanged', retryAt: 0, state: 'Idle', expected: ['Idle'] },
  ]) {
  test(`${assignment}: ${scenario.name}`, async () => {
    const fleet = { publicKey: { toString: () => 'fleet' }, label: 'CF-05|06', state: 'Waiting for Copper Ore', transportLoadRetryAt: 1000, transportLoadRetryResource: 'Copper Ore', iterCnt: 3 };
    if(scenario.retryAt !== undefined) fleet.transportLoadRetryAt = scenario.retryAt;
    if(scenario.state) fleet.state = scenario.state;
    fleet.resupplying = !!scenario.resupplying;
    const calls = [];
    const errors = [];
    const context = vm.createContext({
      userFleets: [fleet], Date: { now: () => 2000 }, globalErrorTracker: { errorCount: 0 },
      GM: { getValue: async () => JSON.stringify({ assignment }) },
      getTransportLoadRetry: f => f.transportLoadRetryAt ? { retryAt: f.transportLoadRetryAt, resource: f.transportLoadRetryResource } : null,
      openTransportLoadRetryGate: f => { f.transportLoadRetryAt = 0; },
      recordTransportLoadDiagnostic() {}, getTransportUnloadRetry: () => null,
      getAccountInfo: async () => ({}), updateFleetMiscStats() {}, getFleetState: () => [scenario.chainState || 'Idle', [1, 2]],
      updateFleetState: (f, state) => { f.state = state; },
      cLog() {}, FleetTimeStamp: () => '', logError: e => errors.push(e),
      handleTransport: async (_i, state) => calls.push(state),
      handleSupplyChain: async (_i, state) => calls.push(state),
    });
    vm.runInContext(`async ${readFunctionSource('operateFleet')}; this.run = operateFleet;`, context);
    await context.run(0);
    assert.deepEqual(errors, []);
    assert.deepEqual(calls, scenario.expected);
  });
  }
}

test('timer diagnostics cannot make old balances or thresholds look newly observed', () => {
  let now = 1000;
  const rows = new Map();
  const fleet = { label: 'CF-05|06', state: 'Waiting for Copper Ore' };
  const context = vm.createContext({ Date: { now: () => now }, transportLoadDiagnostics: rows, document: { querySelector: () => null } });
  vm.runInContext(`${readFunctionSource('recordTransportLoadDiagnostic')}; this.record = recordTransportLoadDiagnostic;`, context);
  context.record(fleet, { starbaseTotal: 65683, thresholds: [{ aboard: 65683 }] });
  now = 2000;
  context.record(fleet, { phase: 'retry-gate', gate: 'cooldown' });
  assert.equal(rows.get(fleet.label).updatedAt, 2000);
  assert.equal(rows.get(fleet.label).balancesObservedAt, 1000);
  assert.equal(rows.get(fleet.label).thresholdsObservedAt, 1000);
  now = 3000;
  context.record(fleet, { starbaseTotal: 158883 });
  assert.equal(rows.get(fleet.label).balancesObservedAt, 3000);
  assert.equal(rows.get(fleet.label).thresholdsObservedAt, 1000);
});

test('retry handlers run a read-only required-load preflight before transport transactions', () => {
  const source = readSource();
  const preflightSource = readFunctionSource('preflightTransportRequiredLoadRetry');
  assert.doesNotMatch(preflightSource, /execDock|execUndock|txSliceAndSend|depositCargoToFleet/);
  assert.match(source, /handleTransport[\s\S]*?preflightTransportRequiredLoadRetry[\s\S]*?execDock/);
  assert.match(source, /handleTransportStop[\s\S]*?preflightTransportRequiredLoadRetry[\s\S]*?execDock/);
  assert.match(source, /const hasRequiredLoadRetry = !!String\(userFleets\[i\]\.transportLoadRetryResource \|\| ''\);/);
  assert.match(source, /const resumedRequiredLoadWait = configuredMoveType == 'warp-smart' && hasRequiredLoadRetry;/);
});

test('CF-05|06 fresh Copper balances permit topping up and departing at full capacity', () => {
  const plan = loadFunction('planStarbaseCargoLoads')([{ cargoPod: 'starbase-not-fleet', token: 'copper-source', amount: 158883 }], 20639, true, 0);
  assert.equal(plan.amount, 20639);
  const wait = loadFunction('getTransportRequiredLoadWait')([{ res: 'copper', amt: 87000, cargoTotal: true }], { copper: 65683 + plan.amount }, 0, { copper: 1 }, {});
  assert.equal(wait, null);
});
