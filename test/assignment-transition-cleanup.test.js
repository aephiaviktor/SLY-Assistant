'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function readSource(sourcePath = 'SLY_Assistant.user.js') {
  return fs.readFileSync(path.join(root, sourcePath), 'utf8');
}

function readFunctionSource(name, sourcePath = 'SLY_Assistant.user.js') {
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

function loadPlanner(sourcePath = 'SLY_Assistant.user.js') {
  const context = vm.createContext({});
  vm.runInContext(`${readFunctionSource('getAssignmentTransitionCleanupPlan', sourcePath)}; this.plan = getAssignmentTransitionCleanupPlan;`, context);
  return context.plan;
}

test('assignment change with cargo at home unloads before the new assignment', () => {
  const plan = loadPlanner();
  assert.deepEqual(JSON.parse(JSON.stringify(plan(true, 'Idle', [0, 0], [0, 0], [
    { mint: 'electronics', amount: 25357 },
  ]))), { action: 'dock-unload', cargo: [{ mint: 'electronics', amount: 25357 }] });
});

test('assignment change with an empty cargo hold completes without docking', () => {
  const plan = loadPlanner();
  assert.deepEqual(JSON.parse(JSON.stringify(plan(true, 'Idle', [0, 0], [0, 0], []))), { action: 'complete', cargo: [] });
});

test('assignment change away from home returns before starting the new assignment', () => {
  const plan = loadPlanner();
  assert.deepEqual(JSON.parse(JSON.stringify(plan(true, 'Idle', [5, 6], [0, 0], [
    { mint: 'electronics', amount: 10 },
  ]))), { action: 'move-home', cargo: [{ mint: 'electronics', amount: 10 }] });
});

test('active mining stops before assignment cleanup returns home', () => {
  const plan = loadPlanner();
  assert.deepEqual(JSON.parse(JSON.stringify(plan(true, 'MineAsteroid', [], [0, 0], []))), { action: 'stop-mining', cargo: [] });
});

test('dedicated fuel and ammo stores are not part of assignment cleanup cargo', () => {
  const plan = loadPlanner();
  assert.deepEqual(JSON.parse(JSON.stringify(plan(true, 'StarbaseLoadingBay', [], [0, 0], [
    { mint: 'food', amount: 5 },
    { mint: 'empty', amount: 0 },
  ]))), { action: 'unload-docked', cargo: [{ mint: 'food', amount: 5 }] });
});

test('Automated movement reconciles cleanup and fuel fallback with the displayed plan', async () => {
  const source = readSource();
  const movement = source.slice(source.indexOf('\tasync function handleMovement('), source.indexOf('\tasync function saveScanEnd('));
  const functions = [
    'getAssignmentTransitionCleanupPlan', 'clearAutomatedTravelPlan', 'getTransportCoordKey',
    'compressAutomatedTravelPlan', 'getAutomatedTravelPlanDisplay',
  ].map(name => readFunctionSource(name)).join('\n');
  const cleanup = 'async ' + readFunctionSource('handleAssignmentTransitionCleanup');
  const submitted = new Error('movement submission reached');
  for (const [cleanupPending, fuel, expectedMode, expectedSuffix, requestedMode = 'warp', savedMode] of [
    [true, 30_000, 'warp', ''],
    [true, 10_000, 'subwarp', ''],
    [false, 10_000, 'subwarp', ' | -'],
    [false, 30_000, 'warp', ' | 48w', 'automated'],
    [false, 30_000, 'subwarp', ' | 48w', 'automated', 'subwarp'],
  ]) {
    const config = { assignment: 'Supply Chain', assignmentCleanupPending: cleanupPending, starbase: '0,-39', moveType: 'automated',
      moveTarget: '0,-39', transportEffectiveMoveType: savedMode };
    const fleet = {
      label: 'CF-CSS|Phantom', publicKey: 'fleet', cargoHold: 'hold', fuelTank: 'tank', exitSubwarpWillBurnFuel: 0,
      starbaseCoord: config.starbase, moveType: cleanupPending ? 'automated' : requestedMode,
      automatedTravelPlan: Array(48).fill('warp'), automatedTravelMoveType: 'warp',
      automatedDeparture: { destination: '0,-39', mode: savedMode || 'warp' },
    };
    let departure;
    const submit = mode => async (_fleet, x, y) => {
      departure = { mode, x: Number(x), y: Number(y) };
      throw submitted;
    };
    const { handleAssignmentTransitionCleanup, handleMovement, getAutomatedTravelPlanDisplay } = vm.runInNewContext(
      functions + '\n' + cleanup + '\n' + movement + '\n({handleAssignmentTransitionCleanup, handleMovement, getAutomatedTravelPlanDisplay})',
      {
        userFleets: [fleet],
        clearTransportLoadRetry() {},
        clearTransportUnloadRetry() {},
        ConvertCoords: value => value.split(',').map(Number),
        calculateMovementDistance: (from, to) => Math.hypot(from[0] - to[0], from[1] - to[1]),
        updateFleetState() {},
        completePendingScanningMovementTransaction: async () => {},
        getAccountInfo: async () => ({ data: [] }),
        getFleetState: () => ['Idle', [0, -29]],
        calcWarpFuelReq: () => 20_147,
        calculateSubwarpFuelBurn: () => 5_536,
        cLog() {},
        logAutomatedSubwarpDecision() {},
        writeAutomatedTravelDiagnostic() {},
        FleetTimeStamp: () => '',
        tokenProgramPK: 'token',
        solanaReadConnection: {
          getParsedTokenAccountsByOwner: async account => ({ value: account === 'tank' ? [
            { account: { data: { parsed: { info: { mint: 'fuel', tokenAmount: { uiAmount: fuel } } } } } },
          ] : [] }),
        },
        sageGameAcct: { account: { mints: { fuel: 'fuel' } } },
        globalSettings: { subwarpShortDist: false },
        sageProgram: { coder: { accounts: { decode: () => ({ warpCooldownExpiresAt: { toNumber: () => 0 } }) } } },
        GM: { getValue: async () => JSON.stringify(config) },
        wait: async () => {},
        WARP_COOLDOWN_RETRY_BUFFER_MS: 0,
        calculateWarpTime: () => 100,
        calculateSubwarpTime: () => 2_632,
        calculateScanningMovementOpportunityCost: () => ({}),
        reserveFleetTelemetryMovementEvent: async () => {},
        execWarp: submit('warp'),
        execSubwarp: submit('subwarp'),
      },
    );
    const movementResult = cleanupPending
      ? handleAssignmentTransitionCleanup(0, config, 'Idle', [0, -29])
      : handleMovement(0, 10, 0, -39);
    await assert.rejects(movementResult, error => error === submitted);
    assert.deepEqual(departure, { mode: expectedMode, x: 0, y: -39 });
    assert.equal(getAutomatedTravelPlanDisplay(fleet).suffix, expectedSuffix);
    assert.equal(fleet.automatedDeparture?.mode, cleanupPending ? undefined : expectedMode);
  }
});

test('assignment cleanup is persisted on config change and gates assignment dispatch', () => {
  const source = readSource();
  assert.match(source, /const assignmentChanged = previousAssignment && fleetAssignment && previousAssignment !== fleetAssignment;/);
  assert.match(source, /assignmentCleanupPending: assignmentChanged || !!fleetParsedData?.assignmentCleanupPending/);
  assert.match(source, /fleetParsedData\.assignmentCleanupPending && await handleAssignmentTransitionCleanup\(i, fleetParsedData, fleetState, fleetCoords, fleetMining, extra\)/);
  assert.match(source, /fleetState === 'StarbaseLoadingBay' && fleetStateExtra\?\.starbase/);
  assert.match(source, /clearTransportLoadRetry\(userFleets\[userFleetIndex\]\)/);
  assert.match(source, /clearTransportUnloadRetry\(userFleets\[userFleetIndex\]\)/);
});

test('canonical and Electron userscripts contain identical assignment cleanup behavior', () => {
  assert.equal(readSource(), readSource(path.join('electron-app', 'app', 'SLY_Assistant.user.js')));
});
