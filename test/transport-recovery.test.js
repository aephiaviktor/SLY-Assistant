'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readFunctionSource(source, name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `${name} must exist in SLY_Assistant.user.js`);

  const start = match.index;
  if (name === 'handleTransport') {
    const nextFunction = source.indexOf('function getTransportPlusLegs(', start);
    assert.ok(nextFunction > start);
    return source.slice(start, nextFunction);
  }
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let end = bodyStart; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}' && --depth === 0) return source.slice(start, end + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadFunctions(names, globals, sourcePath = 'SLY_Assistant.user.js') {
  const source = fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8');
  const context = vm.createContext(globals);
  vm.runInContext(names.map(name => readFunctionSource(source, name)).join('\n'), context);
  return context;
}

function loadFunction(name, sourcePath) {
  const context = loadFunctions([name], { globalSettings: { transportKeep1: false } }, sourcePath);
  return { fn: context[name], context };
}

test('transport recovery requires every configured resource to be fully loaded', () => {
  const { fn } = loadFunction('hasLoadedTransportCargoForManifest');
  const ammo = 'ammo';
  const food = 'food';
  const returnManifest = [
    { res: ammo, amt: 220000 },
    { res: food, amt: 230000 },
  ];

  const nostromoCargo = {
    [ammo]: 54116,
    [food]: 0,
  };

  assert.equal(fn(returnManifest, nostromoCargo), false);
});

test('Electron transport recovery also rejects Nostromo partial cargo', () => {
  const { fn } = loadFunction('hasLoadedTransportCargoForManifest', path.join('electron-app', 'app', 'SLY_Assistant.user.js'));
  const manifest = [
    { res: 'ammo', amt: 220000 },
    { res: 'food', amt: 230000 },
  ];

  assert.equal(fn(manifest, { ammo: 54116, food: 0 }), false);
});

test('partial useful manifest cargo prevents a false no-cargo error', () => {
  const { fn } = loadFunction('hasUsefulTransportCargoForManifest');
  const manifest = [
    { res: 'food', amt: 50000 },
    { res: 'field-stabilizer', amt: 120000 },
  ];

  assert.equal(fn(manifest, { food: 30000 }), true);
});

test('keep-one residue is not useful departing cargo', () => {
  const { fn, context } = loadFunction('hasUsefulTransportCargoForManifest');
  context.globalSettings.transportKeep1 = true;

  assert.equal(fn([{ res: 'food', amt: 50000 }], { food: 1 }), false);
});

test('transport recovery accepts a fully loaded manifest', () => {
  const { fn } = loadFunction('hasLoadedTransportCargoForManifest');
  const manifest = [
    { res: 'ammo', amt: 220000 },
    { res: 'food', amt: 230000 },
  ];

  assert.equal(fn(manifest, { ammo: 220000, food: 230000 }), true);
});

test('transport recovery ignores empty manifest entries', () => {
  const { fn } = loadFunction('hasLoadedTransportCargoForManifest');
  const manifest = [
    { res: '', amt: 0 },
    { res: 'ammo', amt: 100 },
    { res: 'food', amt: 0 },
  ];

  assert.equal(fn(manifest, { ammo: 100 }), true);
});

function transportResumeFixture(savedDeparture = {}) {
  let saved = { subwarpPref: 4, moveType: 'automated', ...savedDeparture };
  const fleet = { publicKey: 'fleet', starbaseCoord: '0,0', destCoord: '6,0', moveTarget: saved.moveTarget || '' };
  const observed = { cargo: {}, forecasts: [], moves: [], fuelModes: [] };
  const context = loadFunctions([
    'handleTransport', 'resumeLoadedTransportDeparture', 'recoverTransportMovement', 'prepareTransportDepartureFuel',
    'persistFleetTransportRouteState', 'getLegacyAutomatedRouteLegs', 'getTransportCoordKey',
    'transportSubwarpPrefToMoveType', 'transportMoveTypeToSubwarpPref', 'resolveWarpSmartTravelMode',
    'hasLoadedTransportCargoForManifest', 'hasTransportManifest', 'cloneTransportManifest',
    'applyTransportTotalRemaining', 'CoordsEqual', 'CoordsValid', 'ConvertCoords', 'calculateMovementDistance',
  ], {
    userFleets: [fleet],
    GM: { getValue: async () => JSON.stringify(saved) },
    saveFleetConfig: async (_key, config) => { saved = { ...config }; },
    getTransportRecoveryCargoAmounts: async () => observed.cargo,
    getLegacyTransportTotalContext: () => ({}),
    getLegacyTransportManifestEntry: (_data, prefix) => ({
      transportResource1: { res: 'food', amt: 50_000 },
      transportSBResource1: { res: 'electronics', amt: 40_000, cargoTotal: true },
    })[prefix] || {},
    resolveAutomatedTravelMode: async (_fleet, manifest, forecast) => {
      observed.forecasts.push(forecast);
      return manifest[0].cargoTotal ? 'warp' : 'subwarp';
    },
    getFleetFuelData: async fleet => {
      observed.fuelModes.push(fleet.moveType);
      return { fuelNeeded: 10, amount: 20, capacity: 100 };
    },
    checkCargo: async (currentManifest, destinationManifest) => ({ currentManifest, destinationManifest }),
    handleMovement: async (_i, _distance, x, y) => {
      observed.moves.push({ mode: fleet.moveType, target: [Number(x), Number(y)], saved: { ...saved } });
    },
    sageGameAcct: { account: { mints: { fuel: 'fuel' } } },
    globalSettings: {},
    maybeFinalizeFleetTelemetryCostCycle: () => {},
    getFleetTelemetryHomeStarbaseName: () => '',
    markTransportRequiredFuelAmounts: () => {},
    logTransportCrewDecision: () => {},
    clearTransportLoadRetry: () => {},
    cLog: () => {},
    FleetTimeStamp: () => '',
  });
  return {
    observed,
    operateAt: coords => context.handleTransport(0, 'Idle', coords),
  };
}

test('Automated Transport saves Subwarp before departure, resumes it, then replans the next leg', async () => {
  const trip = transportResumeFixture();
  await trip.operateAt([0, 0]);
  const selected = trip.observed.moves[0].saved;
  assert.equal(selected.moveTarget, '6,0');
  assert.equal(selected.transportEffectiveMoveType, 'subwarp');
  assert.equal(selected.moveType, 'automated');
  assert.equal(selected.subwarpPref, 4);

  const resumed = transportResumeFixture(selected);
  await resumed.operateAt([0, 0]);
  await resumed.operateAt([3, 0]);
  assert.deepEqual(resumed.observed.forecasts, []);
  assert.deepEqual(resumed.observed.moves.map(move => move.mode), ['subwarp', 'subwarp']);

  await resumed.operateAt([6, 0]);
  assert.equal(resumed.observed.forecasts.length, 1);
  assert.equal(resumed.observed.forecasts[0].currentLegIndex, 1);
  assert.deepEqual(resumed.observed.moves[2].target, [0, 0]);
  assert.equal(resumed.observed.moves[2].saved.transportEffectiveMoveType, 'warp');
});

test('Automated Transport rechecks loaded cargo from an older save without changing the configured mode', async () => {
  const resumed = transportResumeFixture();
  resumed.observed.cargo = { food: 50_000 };
  await resumed.operateAt([0, 0]);

  assert.equal(resumed.observed.forecasts.length, 1);
  assert.deepEqual(resumed.observed.fuelModes, ['subwarp']);
  const [{ mode, saved }] = resumed.observed.moves;
  assert.equal(mode, 'subwarp');
  assert.equal(saved.moveType, 'automated');
  assert.equal(saved.subwarpPref, 4);
});

test('Automated Transport recomputes the correct saved leg without an effective mode', async () => {
  const resumed = transportResumeFixture({ moveTarget: '0,0' });
  await resumed.operateAt([3, 0]);

  assert.equal(resumed.observed.forecasts.length, 1);
  assert.equal(resumed.observed.forecasts[0].currentLegIndex, 1);
  assert.deepEqual(resumed.observed.moves[0].target, [0, 0]);
  assert.equal(resumed.observed.moves[0].saved.transportEffectiveMoveType, 'warp');
  assert.equal(resumed.observed.moves[0].saved.moveType, 'automated');
});
