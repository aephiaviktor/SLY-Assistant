'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function readFunctionSource(name, sourcePath = 'SLY_Assistant.user.js') {
  const source = fs.readFileSync(path.join(ROOT, sourcePath), 'utf8');
  const functionStart = source.indexOf(`function ${name}(`);
  assert.notEqual(functionStart, -1, `${name} must exist in ${sourcePath}`);
  const asyncStart = source.lastIndexOf('async ', functionStart);
  const start = asyncStart >= 0 && source.slice(asyncStart, functionStart) === 'async ' ? asyncStart : functionStart;
  const signatureEnd = source.indexOf(') {', functionStart);
  assert.notEqual(signatureEnd, -1, `missing function body for ${name}`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let end = bodyStart; end < source.length; end += 1) {
    if (source[end] === '{') depth += 1;
    if (source[end] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, end + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadFunctions(names, globals = {}) {
  const dependencies = [];
  if (names.includes('buildAutomatedTravelForecast') || names.includes('buildStarbaseInventoryForecast')) {
    dependencies.push('getAutomatedLoadedManifest', 'getAutomatedCssStockSelector', 'explainSharedAutomatedSubwarp',
      'compressAutomatedTravelPlan', 'getAutomatedCraftIngredientsByLocation',
      'prepareInventoryForecast', 'prepareInventoryForecastFleets');
    if (!globals.planSharedAutomatedTravel) dependencies.push(...sharedPlannerFunctions);
  }
  if (names.includes('collectSharedAutomatedFleets')) dependencies.push('getAutomatedCraftIngredientsByLocation');
  if (names.includes('collectAutomatedEstimatedCraftingProductionEvents')) dependencies.push('readAutomatedCraftConfigs');
  if ([...names, ...dependencies].some(name => ['readAutomatedRouteInventory', 'collectAutomatedCraftingProductionEvents',
    'collectAutomatedEstimatedCraftingProductionEvents', 'getAutomatedCraftIngredientsByLocation'].includes(name))) {
    dependencies.push('getInventoryForecastRequirements');
  }
  if (names.includes('collectAutomatedEstimatedCraftingProductionEvents') || names.includes('collectSharedAutomatedFleets')
      || dependencies.includes('getAutomatedCraftIngredientsByLocation')) dependencies.push('getAutomatedCraftIngredientMints');
  if (names.includes('simulateInventoryForecast') || names.includes('planSharedAutomatedTravel') || dependencies.includes('planSharedAutomatedTravel')) {
    dependencies.push('getAutomatedPickupShortfall', 'advanceAutomatedTravelProduction', 'estimateAutomatedCraftChain',
      'getAutomatedArrivalManifest', 'projectAutomatedIngredientCargo', 'simulateInventoryForecast');
  }
  if (names.includes('resolveAutomatedTravelMode')) dependencies.push('getTransportCoordKey', 'logAutomatedSubwarpDecision');
  names = [...new Set([...names, ...dependencies])];
  const context = vm.createContext({
    automatedTravelForecastQueue: Promise.resolve(),
    collectSharedAutomatedFleets: async () => [],
    readAutomatedCraftConfigs: async () => [],
    getAccountInfo: async () => null,
    getSharedAutomatedRoute: (_fleet, legs) => legs,
    ...globals,
  });
  vm.runInContext(`${names.map(name => readFunctionSource(name)).join('\n')}; this.out = { ${names.join(', ')} };`, context);
  return context.out;
}

function makeTwoLegRoute({ warpMs = 10, subwarpMs = 30, amount = 10 } = {}) {
  return [
    { source: 'A', destination: 'B', warpMs, subwarpMs, manifest: [{ res: 'ore', amt: amount, cargoTotal: true }] },
    { source: 'B', destination: 'A', warpMs, subwarpMs, manifest: [] },
  ];
}

const sharedPlannerFunctions = [
  'planSharedAutomatedTravel', 'cloneAutomatedInventory', 'applyAutomatedProductionEvents',
  'getAutomatedRequiredManifest', 'canWithdrawAutomatedManifest', 'adjustAutomatedInventoryForManifest',
  'compressAutomatedTravelPlan',
];

function loadSingleFleetPlanner() {
  const { planSharedAutomatedTravel, explainSharedAutomatedSubwarp } = loadFunctions([
    ...sharedPlannerFunctions, 'explainSharedAutomatedSubwarp',
  ]);
  return ({ legs, inventory, productionEvents = [], nowMs = 0, currentLegIndex = 0, currentLoadedManifest,
    currentLegLoaded = true, warpReadyMs, horizonLegs, beamWidth }) => {
    const participants = [{
      fleet: { label: 'fleet' }, legs, legIndex: currentLegIndex, atMs: nowMs, modes: [], warpReadyMs,
      cargo: currentLegLoaded ? currentLoadedManifest ?? legs[currentLegIndex].manifest : null,
    }];
    const plans = planSharedAutomatedTravel(participants, inventory, productionEvents, nowMs, horizonLegs, beamWidth);
    return { ...plans[0], firstSubwarp: explainSharedAutomatedSubwarp(participants, plans, 0, inventory, productionEvents, nowMs, horizonLegs) };
  };
}

function makeSharedFleet(legs, overrides = {}) {
  return { legs, legIndex: 1, atMs: 0, modes: [], cargo: [], ...overrides };
}

test('a base without transport has current and projected stock through the selected time', async () => {
  const { buildStarbaseInventoryForecast } = loadFunctions([
    'buildStarbaseInventoryForecast', 'getTransportCoordKey', 'readAutomatedRouteInventory', 'getAutomatedCraftOutputAmount',
    'collectAutomatedCraftingProductionEvents', 'collectAutomatedEstimatedCraftingProductionEvents',
  ], {
    validTargets: [{ x: 0, y: 0 }, { x: 1, y: 0 }],
    Date: { now: () => 0 },
    userProfileAcct: 'profile',
    getStarbaseFromCoords: async (x, y) => ({ publicKey: [x, y].join(','), account: { level: 5 } }),
    getStarbasePlayer: async (_profile, base) => ({ publicKey: { toBase58: () => base } }),
    getStarbasePlayerCargoHolds: async () => [{ cargoHoldTokens: [{ mint: 'ore', amount: 20 }] }],
    getStarbaseTime: async () => ({ starbaseTime: 0, resRemaining: 1 }),
    ConvertCoords: key => key.split(',').map(Number),
    sageProgram: { account: { craftingInstance: { all: async ([filter]) =>
      [{ publicKey: { toBase58: () => filter.memcmp.bytes } }] } } },
    craftingProgram: { account: { craftingProcess: { all: async ([filter]) => filter.memcmp.bytes === '0,0' ?
      [{ publicKey: { toBase58: () => 'live-process' },
        account: { recipe: 'polymer-recipe', quantity: 5, status: 2, endTime: 60 } }] : [] } } },
    maybeBnToNumber: value => Number(value),
    craftRecipes: [{ name: 'Polymer', publicKey: 'polymer-recipe', input: [{ mint: 'ore', amount: 3 }],
      output: { mint: 'polymer', amount: 2 }, duration: 10 }],
    globalSettings: { craftingJobs: 1 },
    GM: { getValue: async () => ({ label: 'craft-1', coordinates: '1,0', item: 'Polymer', amount: 4, crew: 1 }) },
    collectAutomatedMiningProductionEvents: async () => [],
  });
  const profile = await buildStarbaseInventoryForecast();
  assert.deepEqual(Object.keys(profile.starbases), ['0,0', '1,0']);
  assert.equal(profile.starbases['0,0'].current.ore, 20);
  assert.equal(profile.starbases['0,0'].projected.polymer, 10);
  assert.equal(profile.starbases['1,0'].current.ore, 20);
  assert.equal(profile.starbases['1,0'].projected.ore, 8);
  assert.equal(profile.starbases['1,0'].projected.polymer, 8);
  const early = await buildStarbaseInventoryForecast(' 1, 0 ', 0.01);
  assert.deepEqual(Object.keys(early.starbases), ['1,0']);
  assert.equal(early.starbases['1,0'].projected.ore, 8);
  assert.equal(early.starbases['1,0'].projected.polymer, undefined);
  assert.equal(early.productionEvents.length, 0);
});

test('a scoped inventory forecast follows an optional pickup at another base across its unload time', async () => {
  const fleet = { publicKey: { toString: () => 'feeder' }, label: 'Feeder', cargoCapacity: 10 };
  const feeder = makeSharedFleet([{ source: '1,0', destination: '0,0', trackAllCargo: true, fixedMode: 'subwarp',
    warpMs: 1000, subwarpMs: 36000, manifest: [{ res: 'polymer', amt: 3 }] },
    { source: '0,0', destination: '1,0', manifest: [], fixedMode: 'subwarp', warpMs: 1000, subwarpMs: 36000 }],
  { fleet, legIndex: 0, cargo: null });
  const scopes = [];
  const { buildStarbaseInventoryForecast } = loadFunctions(['buildStarbaseInventoryForecast', 'getTransportCoordKey'], {
    Date: { now: () => 0 },
    collectSharedAutomatedFleets: async (_fleet, _legs, _now, _configs, locations) => {
      scopes.push(Array.from(locations));
      return [feeder];
    },
    readAutomatedRouteInventory: async () => ({ '0,0': { polymer: 0 }, '1,0': { polymer: 3 } }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
  });
  const early = await buildStarbaseInventoryForecast(['0,0'], 0.005);
  const later = await buildStarbaseInventoryForecast(['0,0'], 0.01);
  assert.deepEqual(scopes, [['0,0'], ['0,0']]);
  assert.deepEqual(Object.keys(later.starbases), ['0,0']);
  assert.equal(early.starbases['0,0'].projected.polymer, 0);
  assert.equal(later.starbases['0,0'].projected.polymer, 3);
  assert.equal(later.starbases['0,0'].current.polymer, 0);
});

test('a single Supply Chain uses the shared forecast across three stops and honors its saved leg modes', async () => {
  const { getTransportPlusLegs, buildAutomatedTravelForecast } = loadFunctions([
    'getTransportPlusLegs', 'buildAutomatedTravelForecast', 'getSharedAutomatedRoute', 'getTransportFuelPolicy',
    'planTransportCargoUnload',
  ], {
    getTransportPlusTargets: () => ['B', 'C'],
    getTransportPlusRouteContexts: () => [],
    getTransportPlusRoutes: config => config.transportPlusRoutes,
    cloneTransportManifest: manifest => manifest.map(entry => ({ ...entry })),
    getAutomatedRouteLeg: (_fleet, leg) => ({
      source: leg.sourceCoord, destination: leg.destCoord, manifest: leg.destinationManifest,
      configuredMode: leg.moveType, roundTrip: leg.roundTrip, warpMs: 10, subwarpMs: 30,
    }),
    ConvertCoords: value => value,
    calcWarpFuelReq: () => 10,
    calculateSubwarpFuelBurn: () => 5,
    calculateMovementDistance: () => 1,
    readAutomatedRouteInventory: async () => ({ A: { polymer: 1000 }, B: { electronics: 10 } }),
    collectAutomatedCraftingProductionEvents: async () => [
      { id: 'craft-at-B', atMs: 75, location: 'B', res: 'electronics', amount: 10 },
    ],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    Date: { now: () => 0 },
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
  });
  const config = { transportPlusRoutes: [
    { moveType: 'automated', manifest: [{ res: 'polymer', amt: 10, cargoTotal: true }] },
    { moveType: 'automated', manifest: [{ res: 'electronics', amt: 10, cargoTotal: true }] },
    { moveType: 'subwarp', manifest: [] },
  ] };
  const legacy = getTransportPlusLegs(config, 'A', 'B');
  assert.deepEqual(Array.from(legacy, leg => leg.moveType), ['automated', 'automated', 'subwarp']);
  const fleet = { label: 'Supply Chain', fuelCapacity: 100 };
  const cargo = [{ mint: 'polymer', amount: 10 }];
  const legacyPlan = await buildAutomatedTravelForecast(fleet, legacy, 0, cargo);
  assert.deepEqual(Array.from(legacyPlan.modes.slice(0, 6)), ['warp', 'warp', 'subwarp', 'subwarp', 'warp', 'subwarp']);
  const route = getTransportPlusLegs({ ...config, transportPlusAutomated: true }, 'A', 'B');
  assert.deepEqual(Array.from(route, leg => leg.moveType), ['automated', 'automated', 'automated']);
  const allAutomated = await buildAutomatedTravelForecast(fleet, route, 0, cargo);
  assert.deepEqual(Array.from(allAutomated.modes.slice(0, 6)), ['warp', 'warp', 'subwarp', 'subwarp', 'warp', 'warp']);
  assert.equal(config.transportPlusRoutes[2].moveType, 'subwarp');
  const fuelLimited = await buildAutomatedTravelForecast({ ...fleet, fuelCapacity: 11 }, route, 0, cargo);
  assert.equal(fuelLimited.modes[0], 'subwarp');
});

test('Supply Chain resumes a saved Automated Warp at an intermediate waypoint after restart', async () => {
  const fleet = { publicKey: 'fleet' };
  const legs = [{ sourceCoord: '0,0', destCoord: '6,0', routeIndex: 0, moveType: 'automated' },
    { sourceCoord: '6,0', destCoord: '0,0', routeIndex: 1, moveType: 'automated' }];
  const { handleSupplyChain } = loadFunctions(['handleSupplyChain', 'getTransportPlusRouteIndex'], {
    userFleets: [fleet],
    GM: { getValue: async () => JSON.stringify({
      moveTarget: '6,0', transportPlusRouteIndex: 0, transportEffectiveMoveType: 'warp',
    }) },
    getTransportPlusLegs: () => legs,
    ConvertCoords: value => value.split(',').map(Number),
    CoordsEqual: (a, b) => a[0] === b[0] && a[1] === b[1],
    calculateMovementDistance: () => 3,
    handleMovement: async (_i, distance) => {
      assert.equal(distance, 3);
      assert.equal(fleet.moveType, 'warp');
    },
  });
  await handleSupplyChain(0, 'Idle', [3, 0]);
  assert.equal(fleet.transportPlusRouteIndex, 0);
});

test('shared CSS forecast spends stock once across both fleets and gives each up to 48 legs', async () => {
  const legs = makeTwoLegRoute().map((leg, index) => ({
    ...leg,
    source: index ? '1,0' : '0,0',
    destination: index ? '0,0' : '1,0',
    configuredMode: 'automated',
  }));
  const fleetA = { publicKey: 'a', cargoCapacity: 10 };
  const fleetB = { publicKey: 'b', cargoCapacity: 10 };
  let stock = 600;
  let inventoryReads = 0;
  const { buildAutomatedTravelForecast } = loadFunctions([
    ...sharedPlannerFunctions, 'buildAutomatedTravelForecast', 'getAutomatedCssTravelMode', 'planTransportCargoUnload',
  ], {
    Date: { now: () => 0 },
    collectSharedAutomatedFleets: async fleet => [makeSharedFleet(legs, { fleet: fleet === fleetA ? fleetB : fleetA })],
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getSharedAutomatedRoute: (_fleet, route) => route,
    getAccountInfo: async () => null,
    getStarbaseNameFromCoords: x => x === 0 ? 'ONI-1' : 'ONI-Phantom',
    readAutomatedRouteInventory: async route => {
      inventoryReads++;
      assert.equal(route.length, 4);
      return { '0,0': { ore: stock } };
    },
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
  });
  const full = await buildAutomatedTravelForecast(fleetA, legs, 1);
  assert.equal(full.summary, '48w');
  assert.equal(full.sharedPlans[0].modes.length, 48);
  assert.ok(full.sharedPlans[0].modes.every(mode => mode === 'warp'));

  stock = 120;
  const limited = await buildAutomatedTravelForecast(fleetA, legs, 1);
  const other = await buildAutomatedTravelForecast(fleetB, legs, 1);
  const pickups = modes => Math.floor(modes.length / 2);
  assert.equal(pickups(limited.modes) + pickups(limited.sharedPlans[0].modes), 12);
  assert.ok(limited.modes.includes('subwarp'));
  assert.ok(limited.sharedPlans[0].modes.includes('subwarp'));
  assert.deepEqual(Array.from(limited.modes), Array.from(other.sharedPlans[0].modes));
  assert.deepEqual(Array.from(other.modes), Array.from(limited.sharedPlans[0].modes));
  assert.equal(inventoryReads, 3);
});

test('two fleets stagger their returns to use separate production batches', () => {
  const { planSharedAutomatedTravel } = loadFunctions(sharedPlannerFunctions);
  const legs = makeTwoLegRoute();
  const fleets = [makeSharedFleet(legs), makeSharedFleet(legs)];
  const firstBatch = { id: 'mine:1', location: 'A', res: 'ore', amount: 10, atMs: 5 };
  const laterBatch = { id: 'craft:1', location: 'A', res: 'ore', amount: 10, atMs: 25 };
  const oneBatch = planSharedAutomatedTravel(fleets, {}, [firstBatch, firstBatch], 0, 2);
  assert.equal(oneBatch.reduce((total, plan) => total + (plan.completedLegs === 2), 0), 1);
  const plans = planSharedAutomatedTravel(fleets, {}, [firstBatch, laterBatch], 0, 2);
  assert.deepEqual(Array.from(plans, plan => plan.summary).sort(), ['1sw1w', '2w']);
});

test('a shared Subwarp reports the fleet and pickup that would go short if it Warped', () => {
  const { planSharedAutomatedTravel, explainSharedAutomatedSubwarp } = loadFunctions([
    ...sharedPlannerFunctions, 'explainSharedAutomatedSubwarp',
  ]);
  const legs = makeTwoLegRoute();
  const fleets = ['first', 'second'].map(label => makeSharedFleet(legs, { fleet: { label } }));
  const events = [
    { id: 'mine', location: 'A', res: 'ore', amount: 10, atMs: 5 },
    { id: 'craft', location: 'A', res: 'ore', amount: 10, atMs: 25 },
  ];
  const plans = planSharedAutomatedTravel(fleets, {}, events, 0);
  const index = plans.findIndex(plan => plan.firstSubwarp);
  assert.ok(index >= 0);
  const decision = explainSharedAutomatedSubwarp(fleets, plans, index, {}, events, 0);
  assert.equal(decision.leg, 1);
  assert.equal(decision.shortfall.fleetLabel, 'second');
  assert.equal(decision.shortfall.location, 'A');
  assert.equal(decision.shortfall.atMs, 10);
  assert.equal(decision.shortfall.requirements[0].available, 0);
  assert.equal(decision.shortfall.requirements[0].required, 10);
  assert.equal(decision.shortfall.replenishment.atMs, 25);
});

test('an in-flight fleet credits only its observed cargo and only at its arrival', () => {
  const { planSharedAutomatedTravel, explainSharedAutomatedSubwarp } = loadFunctions([
    ...sharedPlannerFunctions, 'explainSharedAutomatedSubwarp',
  ]);
  const deliveryLegs = makeTwoLegRoute();
  const consumerLegs = [...deliveryLegs].reverse().map((leg, index) => ({
    ...leg,
    manifest: index ? [] : [{ res: 'ore', amt: 10, cargoTotal: true }],
  }));
  const consumer = makeSharedFleet(consumerLegs, { fleet: { label: 'consumer' } });
  const delivery = makeSharedFleet(deliveryLegs, {
    fleet: { label: 'delivery' },
    legIndex: 0, atMs: 20, modes: ['warp'], arriving: true, cargo: [{ res: 'ore', amt: 10, cargoTotal: true }],
  });
  const plans = planSharedAutomatedTravel([consumer, delivery], {}, [], 0, 2);
  assert.equal(plans[0].summary, '1sw1w');
  const decision = explainSharedAutomatedSubwarp([consumer, delivery], plans, 0, {}, [], 0);
  assert.equal(decision.shortfall.replenishment.atMs, 20);
  assert.equal(decision.shortfall.replenishment.source, 'fleet delivery');
  delivery.cargo[0].amt = 9;
  const short = planSharedAutomatedTravel([consumer, delivery], {}, [], 0, 2);
  assert.equal(short[0].completedLegs, 1);
});

test('shared fleet collection uses active routes and preserves an in-flight subwarp ETA', async () => {
  const fleet = { publicKey: 'requester', assignment: 'Transport' };
  const peer = { publicKey: 'peer', assignment: 'Transport', state: 'Move', cargoHold: 'peer-cargo' };
  const stopped = { publicKey: 'stopped', assignment: 'Transport', state: 'STOPPED' };
  const differentMint = { publicKey: 'different', assignment: 'Transport', state: 'Move' };
  const makeRoute = mint => [{
    source: '0,0', destination: '1,0', manifest: [{ res: mint, amt: 10, cargoTotal: true }],
  }];
  const reads = [];
  const { collectSharedAutomatedFleets } = loadFunctions([
    'collectSharedAutomatedFleets', 'getAutomatedPeerStart', 'getAutomatedLoadedManifest',
    'getAutomatedRequiredManifest', 'getTransportCoordKey', 'getTransportPlusRouteIndex', 'planTransportCargoUnload',
  ], {
    userFleets: [fleet, peer, stopped, differentMint],
    GM: { getValue: async key => JSON.stringify({ assignment: 'Transport', key, moveTarget: '0,0' }) },
    getAutomatedPeerRoute: (_fleet, config) => makeRoute(config.key === 'different' ? 'food' : 'ore'),
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAccountInfo: async (_label, _reason, key) => {
      reads.push(key);
      return { data: [] };
    },
    getFleetState: () => ['MoveSubwarp', { fromSector: [0, 0], toSector: [1, 0], arrivalTime: 30 }],
    maybeBnToNumber: Number,
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
    sageProgram: { coder: { accounts: { decode: () => ({ warpCooldownExpiresAt: 31 }) } } },
    tokenProgramPK: 'tokens',
    solanaReadConnection: {
      getParsedTokenAccountsByOwner: async owner => {
        assert.equal(owner, 'peer-cargo');
        return { value: [{ account: { data: { parsed: { info: { mint: 'ore', tokenAmount: { uiAmount: 4 } } } } } }] };
      },
    },
  });
  const participants = await collectSharedAutomatedFleets(fleet, makeRoute('ore'), 10_000);
  assert.deepEqual(reads, ['peer']);
  assert.equal(participants.length, 1);
  assert.equal(participants[0].fleet, peer);
  assert.equal(participants[0].arriving, true);
  assert.equal(participants[0].atMs, 30_000);
  assert.equal(participants[0].warpReadyMs, 31_000);
  assert.equal(participants[0].modes[0], 'subwarp');
  assert.equal(participants[0].cargo[0].amt, 4);
});

test('a fleet that delivers directly to a checked pickup joins the shared forecast', async () => {
  const fleet = { publicKey: 'consumer', assignment: 'Supply Chain' };
  const feeder = { publicKey: 'feeder', assignment: 'Transport' };
  const manifest = [{ res: 'ore', amt: 10, cargoTotal: true }];
  const { collectSharedAutomatedFleets } = loadFunctions(['collectSharedAutomatedFleets', 'getAutomatedRequiredManifest'], {
    userFleets: [fleet, feeder],
    GM: { getValue: async () => JSON.stringify({ assignment: 'Transport' }) },
    getAutomatedPeerRoute: () => [{ source: 'A', destination: 'B', manifest }],
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedPeerStart: async peer => ({ fleet: peer }),
  });
  const peers = await collectSharedAutomatedFleets(fleet, [{ source: 'B', destination: 'C', manifest }], 0);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].fleet, feeder);
});

test('selecting a starbase also includes upstream optional fixed-mode cargo routes', async () => {
  const makeFleet = (key, starbase, dest, resource) => ({
    key, publicKey: key, assignment: 'Transport', starbase, dest, resource,
  });
  const fleets = [makeFleet('feeder', '1,0', '0,0', 'polymer'),
    makeFleet('upstream', '2,0', '1,0', 'polymer'), makeFleet('unrelated', '3,0', '4,0', 'polymer')];
  const { collectSharedAutomatedFleets } = loadFunctions(['collectSharedAutomatedFleets', 'getAutomatedRequiredManifest'], {
    userFleets: fleets,
    GM: { getValue: async key => JSON.stringify(fleets.find(fleet => fleet.key === key)) },
    getAutomatedPeerRoute: (_fleet, config) => [{ source: config.starbase, destination: config.dest,
      configuredMode: 'subwarp', manifest: [{ res: config.resource, amt: 10 }] }],
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedPeerStart: async (fleet, _config, legs) => ({ fleet, legs }),
  });
  const peers = await collectSharedAutomatedFleets(null, [], 0, [], new Set(['0,0']));
  assert.deepEqual(Array.from(peers, peer => peer.fleet.key), ['feeder', 'upstream']);
  assert.ok(peers.every(peer => peer.legs[0].trackAllCargo && peer.legs[0].configuredMode === 'subwarp'));
});

test('CSS Automated fallback uses only the configured required asset and only at CSS', () => {
  const { getAutomatedCssTravelMode } = loadFunctions(['getAutomatedCssTravelMode']);
  const base = {
    sourceStarbaseName: 'MUD-1',
    inventory: { electronics: 1000, polymer: 9_999_999 },
    requiredAsset: { res: 'electronics' },
    cargoCapacity: 100,
  };
  assert.equal(getAutomatedCssTravelMode(base), 'warp');
  assert.equal(getAutomatedCssTravelMode({ ...base, inventory: { electronics: 999 }, cargoCapacity: 100 }), 'subwarp');
  assert.equal(getAutomatedCssTravelMode({ ...base, sourceStarbaseName: 'MUD-2', inventory: { electronics: 0 } }), null);
  assert.equal(getAutomatedCssTravelMode({ ...base, requiredAsset: { res: 'polymer' }, inventory: { electronics: 999, polymer: 999 } }), 'subwarp');
});

test('a multi-stop route keeps the CSS stock threshold from choosing modes for unrelated stops', () => {
  const { getAutomatedCssStockSelector } = loadFunctions(['getAutomatedCssStockSelector'], {
    getStarbaseNameFromCoords: () => 'ONI-1',
  });
  assert.equal(getAutomatedCssStockSelector({}, [{}, {}, {}]), undefined);
});

test('CSS Automated fallback projects up to 48 stock-funded legs from either direction', async () => {
  const capacity = 201_428;
  const legs = makeTwoLegRoute({ amount: capacity });
  let stock = 16_754_612;
  const { buildAutomatedTravelForecast } = loadFunctions([
    'buildAutomatedTravelForecast', 'getAutomatedCssTravelMode',
    'cloneAutomatedInventory', 'applyAutomatedProductionEvents', 'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest', 'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan', 'planTransportCargoUnload',
  ], {
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getStarbaseNameFromCoords: (_x, y) => y === -39 ? 'MUD-1' : 'MUD-PHANTOM',
    readAutomatedRouteInventory: async () => ({ '0,-39': { ore: stock }, '0,-24': {} }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
  });

  legs[0] = { ...legs[0], source: '0,-39', destination: '0,-24' };
  legs[1] = { ...legs[1], source: '0,-24', destination: '0,-39' };
  const fleet = { cargoCapacity: capacity };
  const loadedCargo = [{ mint: 'ore', amount: capacity }];
  for (const [legIndex, cargo] of [[0, loadedCargo], [1, []]]) {
    const plan = await buildAutomatedTravelForecast(fleet, legs, legIndex, cargo);
    assert.equal(plan.summary, '48w');
    assert.equal(plan.completedLegs, 48);
    assert.equal(plan.estimated, false);
  }

  stock = 10 * capacity;
  const limited = await buildAutomatedTravelForecast(fleet, legs, 0, loadedCargo);
  assert.equal(limited.summary, '2w20sw');
  assert.equal(limited.completedLegs, 22);
  assert.equal(limited.reason, 'inventory_horizon');
});

test('Automated planner warps while stock covers future pickups, then subwarps to bridge production', () => {
  const planSingleFleet = loadSingleFleetPlanner();
  const plan = planSingleFleet({
    nowMs: 0,
    legs: makeTwoLegRoute(),
    currentLegIndex: 0,
    currentLegLoaded: true,
    inventory: { A: { ore: 20 }, B: {} },
    productionEvents: [{ atMs: 95, location: 'A', res: 'ore', amount: 80 }],
    horizonLegs: 12,
  });

  assert.equal(plan.modes[0], 'warp');
  assert.ok(plan.modes.includes('subwarp'), 'forecast must slow down before stock would be exhausted');
  assert.equal(plan.modes.length, 12);
  assert.match(plan.summary, /^\d+w(?:\d+sw)+/);
});

test('Automated reserves Electronics for the minimum Subwarp legs needed to reach the craft', () => {
  const planSingleFleet = loadSingleFleetPlanner();
  const pickupAmount = 39_687;
  const route = makeTwoLegRoute({ amount: pickupAmount, warpMs: 22_361, subwarpMs: 333_742 });
  route[0].manifest[0].res = 'electronics';
  const input = {
    legs: route,
    currentLegIndex: 1,
    currentLoadedManifest: [],
    horizonLegs: 48,
    productionEvents: [{ atMs: 9_913_000, location: 'A', res: 'electronics', amount: 1_700_000 }],
  };

  for (const [stock, summary] of [[794_419, '12w29sw7w'], [16 * pickupAmount + 679, '3w30sw15w']]) {
    for (const beamWidth of [8, 96]) {
      const plan = planSingleFleet({ ...input, beamWidth, inventory: { A: { electronics: stock }, B: {} } });
      assert.equal(plan.reason, 'forecast_complete');
      assert.equal(plan.completedLegs, 48);
      assert.equal(plan.summary, summary);
    }
  }
});

test('Automated planner recalculates back to warp when a confirmed unload raises stock', () => {
  const planSingleFleet = loadSingleFleetPlanner();
  const input = {
    nowMs: 0,
    legs: makeTwoLegRoute(),
    currentLegIndex: 0,
    currentLegLoaded: true,
    inventory: { A: { ore: 0 }, B: {} },
    productionEvents: [{ atMs: 25, location: 'A', res: 'ore', amount: 10 }],
    horizonLegs: 4,
  };
  const constrained = planSingleFleet(input);
  const replenished = planSingleFleet({ ...input, inventory: { A: { ore: 100 }, B: {} } });
  assert.ok(constrained.modes.includes('subwarp'), 'forecast must contain a slowing leg while stock is constrained');
  assert.equal(replenished.modes[0], 'warp');
  assert.equal(replenished.modes.includes('subwarp'), false, 'fresh confirmed stock must permit the forecast to return to all Warp');
});

test('Automated planner preserves checked cargo OR alternatives', () => {
  const { canWithdrawAutomatedManifest } = loadFunctions([
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
  ]);
  const manifest = [
    { res: 'copper', amt: 10, cargoTotal: true },
    { res: 'iron', amt: 10, cargoTotal: true },
  ];
  assert.equal(canWithdrawAutomatedManifest({ A: { copper: 10, iron: 0 } }, 'A', manifest), true);
  assert.equal(canWithdrawAutomatedManifest({ A: { copper: 0, iron: 10 } }, 'A', manifest), true);
  assert.equal(canWithdrawAutomatedManifest({ A: { copper: 9, iron: 9 } }, 'A', manifest), false);
});

test('Automated forecast suffix distinguishes estimates and shows a dash when no plan is available', () => {
  const { compressAutomatedTravelPlan, getAutomatedTravelPlanSuffix, getAssistStatusRowModel } = loadFunctions([
    'compressAutomatedTravelPlan',
    'getAutomatedTravelPlanSuffix',
    'getAssistStatusRowModel',
  ]);
  assert.equal(compressAutomatedTravelPlan(['warp', 'warp', 'subwarp', 'subwarp', 'subwarp', 'warp']), '2w3sw1w');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: ['warp', 'warp', 'subwarp'] }), ' | 2w1sw');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: ['warp', 'warp', 'subwarp'], automatedTravelPlanEstimated: true }), ' | ~2w1sw');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: [], automatedTravelPlanPending: true }), ' | -');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: [] }), '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(getAssistStatusRowModel({ publicKey: 'fleet', label: 'Hauler', state: 'Warp [28,21] 14:32', automatedTravelPlan: ['warp', 'warp', 'subwarp'] }, []))),
    { section: 'fleet', cells: ['Hauler', 'Warp [28,21] 14:32 | 2w1sw'] },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(getAssistStatusRowModel({ publicKey: 'fleet', label: 'Eagle Fleet', state: 'Warp C/D [16:00]', automatedTravelPlan: [], automatedTravelPlanPending: true }, []))),
    { section: 'fleet', cells: ['Eagle Fleet', 'Warp C/D [16:00] | -'] },
  );
});

test('visible crafting events credit recipe output per process quantity', () => {
  const { getAutomatedCraftOutputAmount } = loadFunctions(['getAutomatedCraftOutputAmount']);
  const process = { account: { quantity: { toNumber: () => 25 } } };
  const recipe = { output: { amount: 4 } };
  assert.equal(getAutomatedCraftOutputAmount(process, recipe), 100);
});

test('visible direct craft collector publishes the multiplied token output', async () => {
  const recipe = {
    publicKey: { toString: () => 'electronics-recipe' },
    output: { mint: { toString: () => 'electronics' }, amount: 4 },
  };
  const process = {
    publicKey: { toBase58: () => 'process-1' },
    account: {
      recipe: { toString: () => 'electronics-recipe' },
      status: 1,
      quantity: { toNumber: () => 25 },
      endTime: { toNumber: () => 100 },
    },
  };
  const { collectAutomatedCraftingProductionEvents } = loadFunctions([
    'getAutomatedCraftOutputAmount',
    'collectAutomatedCraftingProductionEvents',
  ], {
    getAutomatedRequiredManifest: manifest => manifest,
    ConvertCoords: value => value,
    getStarbaseFromCoords: async () => ({ publicKey: 'starbase', account: { level: 5 } }),
    getStarbasePlayer: async () => ({ publicKey: { toBase58: () => 'player' } }),
    getStarbaseTime: async () => ({ starbaseTime: 0, resRemaining: 1 }),
    sageProgram: { account: { craftingInstance: { all: async () => [{ publicKey: { toBase58: () => 'instance' } }] } } },
    craftingProgram: { account: { craftingProcess: { all: async () => [process] } } },
    craftRecipes: [recipe],
    maybeBnToNumber: value => Number(value),
    userProfileAcct: 'profile',
    Date,
    Math,
    Set,
  });

  const events = await collectAutomatedCraftingProductionEvents([{ source: 'A', manifest: [{ res: 'electronics', amount: 10 }] }], 0);
  assert.equal(events[0].amount, 100);
  assert.equal(events[0].source, 'craft');
});

test('craft-chain ETA uses recipe quantities, output amounts, crew, inventory, and sequential dependencies', () => {
  const { estimateAutomatedCraftChain } = loadFunctions(['estimateAutomatedCraftChain']);
  const recipes = [
    { name: 'Polymer', duration: 60, input: [{ mint: 'ore', amount: 2 }], output: { mint: 'polymer', amount: 2 } },
    { name: 'Electronics', duration: 100, input: [{ mint: 'polymer', amount: 3 }], output: { mint: 'electronics', amount: 1 } },
  ];
  const result = estimateAutomatedCraftChain({
    targetRecipe: recipes[1],
    targetRuns: 2,
    crew: 10,
    inventory: { ore: 100, polymer: 2 },
    recipes,
    speedMultiplier: 1,
  });

  // Two Electronics runs need six Polymer. Two are in stock, so one two-Polymer
  // recipe run is not enough and two Polymer runs are required: 2*60/10 + 2*100/10.
  assert.equal(result.durationSeconds, 32);
  assert.equal(result.outputAmount, 2);
  assert.equal(result.stages, 2);
});

test('estimated craft collector combines active intermediate remaining time with the configured chain', async () => {
  const recipes = [
    { name: 'Polymer', publicKey: { toString: () => 'polymer-recipe' }, duration: 60, input: [{ mint: 'ore', amount: 2 }], output: { mint: { toString: () => 'polymer' }, amount: 2 } },
    { name: 'Electronics', publicKey: { toString: () => 'electronics-recipe' }, duration: 100, input: [{ mint: { toString: () => 'polymer' }, amount: 3 }], output: { mint: { toString: () => 'electronics' }, amount: 1 } },
  ];
  const activeProcess = {
    account: {
      craftingId: { toNumber: () => 7 },
      recipe: { toString: () => 'polymer-recipe' },
      quantity: { toNumber: () => 2 },
      endTime: { toNumber: () => 100 },
    },
  };
  const { collectAutomatedEstimatedCraftingProductionEvents } = loadFunctions([
    'getAutomatedCraftOutputAmount',
    'estimateAutomatedCraftChain',
    'collectAutomatedEstimatedCraftingProductionEvents',
  ], {
    getAutomatedRequiredManifest: manifest => manifest,
    globalSettings: { craftingJobs: 1 },
    GM: { getValue: async () => JSON.stringify({ label: 'craft2', item: 'Electronics', coordinates: 'A', amount: 2, crew: 10, craftingId: 7 }) },
    ConvertCoords: value => value,
    getTransportCoordKey: value => String(value),
    getStarbaseFromCoords: async () => ({ publicKey: 'starbase', account: { level: 5 } }),
    getStarbasePlayer: async () => ({ publicKey: { toBase58: () => 'player' } }),
    getStarbaseTime: async () => ({ starbaseTime: 0, resRemaining: 1 }),
    sageProgram: { account: { craftingInstance: { all: async () => [{ publicKey: { toBase58: () => 'instance' } }] } } },
    craftingProgram: { account: { craftingProcess: { all: async () => [activeProcess] } } },
    craftRecipes: recipes,
    userProfileAcct: 'profile',
    Date,
    Math,
    Map,
    Set,
  });

  const events = await collectAutomatedEstimatedCraftingProductionEvents(
    [{ source: 'A', manifest: [{ res: 'electronics', amount: 10 }] }],
    { A: { ore: 100 } },
    0,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'craft-estimate');
  assert.equal(events[0].amount, 2);
  assert.equal(events[0].atMs, 306000);

  const [withFeeder] = await collectAutomatedEstimatedCraftingProductionEvents(
    [{ source: 'A', manifest: [{ res: 'electronics', amount: 10 }] },
      { source: 'B', destination: 'A', manifest: [{ res: 'polymer', amt: 2 }] }],
    { A: {} },
    0,
  );
  assert.equal(withFeeder.atMs, Infinity);
  assert.equal(withFeeder.job.readyAtMs, 160_000);
  assert.equal(withFeeder.job.pendingOutput.res, 'polymer');
  assert.equal(withFeeder.job.pendingOutput.amount, 4);
});

test('the planner uses delivered Polymer while preserving an active Hydrocarbon stage', () => {
  const { planSharedAutomatedTravel } = loadFunctions(sharedPlannerFunctions);
  const hydrocarbon = { name: 'Hydrocarbon', duration: 900, input: [{ mint: 'ore', amount: 1 }], output: { mint: 'hydrocarbon', amount: 1 } };
  const polymer = { name: 'Polymer', duration: 600, input: [{ mint: 'hydrocarbon', amount: 1 }], output: { mint: 'polymer', amount: 1 } };
  const electronics = { name: 'Electronics', duration: 120, input: [{ mint: 'polymer', amount: 1 }], output: { mint: 'electronics', amount: 1 } };
  const events = [{ id: 'electronics-job', location: 'B', res: 'electronics', atMs: 930_000, amount: 1,
    job: { targetRecipe: electronics, recipes: [hydrocarbon, polymer, electronics], targetRuns: 1, crew: 1,
      readyAtMs: 90_000, pendingOutput: { res: 'hydrocarbon', amount: 1, final: false } } }];
  const electronicCargo = [{ res: 'electronics', amt: 1, cargoTotal: true }];
  const route = [{ source: 'B', destination: 'C', manifest: electronicCargo, warpMs: 1000, subwarpMs: 2000 },
    { source: 'C', destination: 'B', manifest: [], warpMs: 200_000, subwarpMs: 300_000 }];
  const cargo = [{ res: 'polymer', amt: 1, cargoTotal: true }];
  const feederRoute = [{ source: 'A', destination: 'B', manifest: cargo, warpMs: 10, subwarpMs: 20 },
    { source: 'B', destination: 'A', manifest: [], fixedMode: 'warp', warpMs: 10, subwarpMs: 20 }];
  const forecast = (arrivalMs, delivery = cargo, production = events, destination = 'B') => planSharedAutomatedTravel([
    makeSharedFleet(route),
    makeSharedFleet([{ ...feederRoute[0], destination }, feederRoute[1]],
      { legIndex: 0, arriving: true, atMs: arrivalMs, modes: ['warp'], cargo: delivery }),
  ], {}, production, 0, 2)[0];
  const early = forecast(30_000);
  assert.equal(early.summary, '1sw1w');
  assert.equal(early.craftOutputs[0].atMs, 270_000);
  assert.equal(forecast(150_000).completedLegs, 1, 'Polymer arriving at 150s cannot fund a 300s pickup after the 180s craft');
  assert.equal(forecast(30_000, []).completedLegs, 1, 'cargo that did not unload cannot fund the craft');
  assert.equal(forecast(30_000, cargo, events, 'D').completedLegs, 1);
  const waiting = [{ ...events[0], job: { ...events[0].job, readyAtMs: 0, pendingOutput: null } }];
  assert.equal(forecast(10_000, cargo, waiting).craftOutputs[0].atMs, 190_000);
  assert.equal(forecast(10_000, cargo, waiting).summary, '2w', 'incoming Polymer bypasses both unstarted prerequisites');
});

test('a future optional ingredient pickup is capacity-limited and does not become a departure requirement', async () => {
  const { projectAutomatedIngredientCargo, getAutomatedArrivalManifest, canWithdrawAutomatedManifest,
    getAutomatedLoadedManifest } = loadFunctions([
    'projectAutomatedIngredientCargo', 'getAutomatedArrivalManifest', 'canWithdrawAutomatedManifest', 'getAutomatedRequiredManifest',
    'getAutomatedLoadedManifest', 'planTransportCargoUnload',
  ], { globalSettings: { transportKeep1: true }, sageGameAcct: { account: { mints: { ammo: 'ammo' } } } });
  const leg = {
    source: 'A', destination: 'B',
    manifest: [{ res: 'ore', amt: 3, cargoTotal: true }, { res: 'food', amt: 2 }, { res: 'polymer', amt: 10 }],
    craftIngredients: new Set(['polymer']),
    cargoSizes: { ore: 1, food: 1, polymer: 2 },
    keepOne: true,
  };
  const stock = { ore: 3, food: 2, polymer: 9 };
  const loaded = projectAutomatedIngredientCargo({ cargoCapacity: 11 }, leg, stock, leg.manifest.slice(0, 1));
  assert.equal(loaded[1].amt, 3);
  assert.equal(getAutomatedArrivalManifest(loaded)[1].amt, 2);
  assert.equal(canWithdrawAutomatedManifest({ A: { ore: 3 } }, 'A', leg.manifest), true);
  const onboard = await getAutomatedLoadedManifest({}, leg, [{ mint: 'polymer', amount: 4 }, { mint: 'food', amount: 5 }],
    leg.craftIngredients);
  assert.deepEqual(Array.from(onboard, entry => ({...entry})), [{ res: 'polymer', amt: 3, cargoTotal: true }]);
});

test('an optional Polymer feeder joins a forecast for Electronics at its destination', async () => {
  const requester = { publicKey: 'electronics', assignment: 'Transport' };
  const feeder = { publicKey: 'polymer', assignment: 'Transport' };
  const config = { item: 'Electronics', coordinates: 'B' };
  const suppliedAt = [];
  const cargo = [{ res: 'polymer', amt: 10 }];
  const { collectSharedAutomatedFleets } = loadFunctions(['collectSharedAutomatedFleets', 'getAutomatedRequiredManifest'], {
    getTransportCoordKey: value => value,
    craftRecipes: [{ name: 'Electronics', input: [{ mint: 'polymer', amount: 1 }], output: { mint: 'electronics', amount: 1 } }],
    userFleets: [requester, feeder],
    GM: { getValue: async () => JSON.stringify({ assignment: 'Transport' }) },
    getAutomatedPeerRoute: () => [{ source: 'A', destination: 'B', manifest: cargo }],
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedPeerStart: async (fleet, _config, _route, _now, ingredients) => {
      suppliedAt.push(ingredients.get('B').has('polymer'));
      return { fleet };
    },
  });
  const peers = await collectSharedAutomatedFleets(requester, [{ source: 'B', destination: 'C',
    manifest: [{ res: 'electronics', amt: 1, cargoTotal: true }] }], 0, [config]);
  assert.equal(peers[0].fleet, feeder);
  assert.deepEqual(suppliedAt, [true]);
});

test('Automated keeps Warp through a missing mining ETA only when stock covers the full forecast', async () => {
  const capacity = 91_081;
  let copperStock = 66_169_918;
  const legs = [
    { source: '11,-16', destination: '2,-23', warpMs: 357_000, subwarpMs: 3_564_000, manifest: [{ res: 'copper', amt: capacity, cargoTotal: true }] },
    { source: '2,-23', destination: '11,-16', warpMs: 357_000, subwarpMs: 3_564_000, manifest: [{ res: 'food', amt: 3_500 }] },
  ];
  const { buildAutomatedTravelForecast, resolveAutomatedTravelMode } = loadFunctions([
    'buildAutomatedTravelForecast', 'getAutomatedCssTravelMode',
    'cloneAutomatedInventory', 'applyAutomatedProductionEvents', 'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest', 'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan', 'planTransportCargoUnload',
    'calculateAutomatedTravelMode', 'resolveAutomatedTravelMode',
  ], {
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getStarbaseNameFromCoords: x => x === 11 ? 'MRZ-6' : 'MRZ-5',
    readAutomatedRouteInventory: async () => ({ '11,-16': { copper: copperStock }, '2,-23': { food: 23_030_464 } }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo', fuel: 'fuel' } } },
    solanaReadConnection: { getParsedTokenAccountsByOwner: async () => ({ value: [
      { account: { data: { parsed: { info: { mint: 'food', tokenAmount: { uiAmount: 3_500 } } } } } },
    ] }) },
    tokenProgramPK: 'token-program',
    cargoItems: [{ token: 'food', size: 1 }],
    cLog: () => {},
    FleetTimeStamp: () => '',
    updateAssistStatus: () => {},
    Date,
  });

  const fleet = { cargoCapacity: capacity, cargoHold: 'hold' };
  const loaded = [{ mint: 'food', amount: 3_500 }];
  const context = { legs, currentLegIndex: 1 };
  for (const stock of [copperStock, 24 * capacity]) {
    copperStock = stock;
    const plan = await buildAutomatedTravelForecast(fleet, legs, 1, loaded);
    assert.equal(plan.summary, '48w');
    assert.equal(plan.completedLegs, 48);
    assert.equal(plan.estimated, false);
    assert.deepEqual(Array.from(plan.productionEvents), []);
    assert.equal(await resolveAutomatedTravelMode(fleet, legs[1].manifest, context), 'warp');
    assert.equal(fleet.automatedTravelPlan.length, 48);
  }

  copperStock = 24 * capacity - 1;
  const plan = await buildAutomatedTravelForecast(fleet, legs, 1, loaded);
  assert.deepEqual(Array.from(plan.modes), []);
  assert.equal(plan.reason, 'awaiting_final_output');
  assert.deepEqual(Array.from(plan.productionEvents), []);
  assert.equal(await resolveAutomatedTravelMode(fleet, legs[1].manifest, context), 'subwarp');
});

test('estimated final-craft ETA puts the Subwarp bridge after stock-funded Warp legs', async () => {
  const route = makeTwoLegRoute({ warpMs: 10, subwarpMs: 30, amount: 10 });
  let eta = 95;
  let batch = 300;
  const { buildAutomatedTravelForecast } = loadFunctions([
    'cloneAutomatedInventory',
    'applyAutomatedProductionEvents',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'buildAutomatedTravelForecast',
    'planTransportCargoUnload',
  ], {
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    readAutomatedRouteInventory: async () => ({ A: { ore: 20 }, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [{ id: 'estimate:craft2', atMs: eta, location: 'A', res: 'ore', amount: batch, source: 'craft-estimate' }],
    Date: { now: () => 0 },
  });

  const plan = await buildAutomatedTravelForecast({}, route, 0, [{ mint: 'ore', amount: 10 }]);

  assert.equal(plan.estimated, true);
  assert.equal(plan.modes.length, 48);
  assert.equal(plan.summary, '4w2sw42w');

  eta = 60;
  const stocked = await buildAutomatedTravelForecast({}, route, 0, [{ mint: 'ore', amount: 10 }]);
  assert.equal(stocked.summary, '48w');

  batch = 10;
  const shortfall = await buildAutomatedTravelForecast({}, route, 0, [{ mint: 'ore', amount: 10 }]);
  assert.equal(shortfall.summary, '8w');
  assert.equal(shortfall.reason, 'inventory_horizon');
});

test('estimated production keeps 48w for the observed MUD and ONI stock examples', async () => {
  const { buildAutomatedTravelForecast } = loadFunctions([
    ...sharedPlannerFunctions, 'buildAutomatedTravelForecast', 'planTransportCargoUnload',
  ], {
    Date: { now: () => 0 },
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    readAutomatedRouteInventory: async ([leg]) => ({ A: { ore: leg.stock } }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async ([leg]) => [
      { id: 'estimate', atMs: leg.eta, location: 'A', res: 'ore', amount: 1_000_000, source: 'craft-estimate' },
    ],
  });
  for (const example of [
    { stock: 1_694_201, amount: 39_687, warpMs: 22_361, subwarpMs: 333_742, eta: 34 * 60_000 },
    { stock: 10_854_322, amount: 50_017, warpMs: 67_083, subwarpMs: 1_427_278, eta: 120 * 60_000 },
    { stock: 230, amount: 10, warpMs: 10, subwarpMs: 30, eta: 495 },
  ]) {
    const route = makeTwoLegRoute(example);
    Object.assign(route[0], { stock: example.stock, eta: example.eta });
    const plan = await buildAutomatedTravelForecast({}, route, 0, [{ mint: 'ore', amount: example.amount }]);
    assert.equal(plan.summary, example.stock === 230 ? '47w1sw' : '48w');
    assert.equal(plan.completedLegs, 48);
    assert.equal(plan.estimated, true);
  }
});

test('the last safe Warp depends on the next pickup and the remaining warp cooldown', () => {
  const planSingleFleet = loadSingleFleetPlanner();
  const input = { legs: makeTwoLegRoute(), inventory: { A: { ore: 0 } }, currentLegLoaded: true, horizonLegs: 4 };
  const forecast = (atMs, extra = {}) => planSingleFleet({
    ...input, ...extra, productionEvents: [{ id: 'craft', res: 'ore', amount: 100, location: 'A', atMs }],
  });
  assert.equal(forecast(20).summary, '4w');
  const later = forecast(35);
  assert.equal(later.summary, '1w1sw2w');
  assert.equal(later.firstSubwarp.leg, 2);
  assert.equal(later.firstSubwarp.shortfall.atMs, 20);
  assert.equal(later.firstSubwarp.shortfall.replenishment.atMs, 35);
  assert.equal(forecast(50).summary, '2sw2w');
  assert.equal(forecast(70).summary, '2sw');
  assert.equal(forecast(35, { warpReadyMs: 15 }).summary, '4w');
});

test('Subwarp logs the decision leg, required stock, and the relevant replenishment ETA', () => {
  const logs = [];
  const { logAutomatedSubwarpDecision, getAutomatedPickupShortfall } = loadFunctions([
    'logAutomatedSubwarpDecision', 'getAutomatedPickupShortfall', 'getAutomatedRequiredManifest',
  ], {
    FleetTimeStamp: label => label,
    cargoItems: [{ token: 'ore', name: 'Copper Ore' }],
    cLog: (_level, message) => logs.push(message),
  });
  const events = [
    { id: 'irrelevant', res: 'ore', amount: 100, location: 'B', atMs: 25 },
    { id: 'mine', res: 'ore', amount: 3, location: 'A', atMs: 30 },
    { id: 'mine', res: 'ore', amount: 3, location: 'A', atMs: 35 },
    { id: 'craft', res: 'ore', amount: 4, location: 'A', atMs: 50, source: 'craft-estimate' },
  ];
  const shortfall = getAutomatedPickupShortfall({ A: { ore: 3 } }, makeTwoLegRoute()[0], 20, events);
  logAutomatedSubwarpDecision({ label: 'Phantom' }, { leg: 48, shortfall });
  assert.match(logs[0], /Phantom Automated Subwarp leg 48.*pickup A.*Copper Ore 3\/10.*replenishment ETA 1970-01-01T00:00:00\.050Z \(craft-estimate\)/);
});

test('Automated forecast starts when a direct final-output event is visible', async () => {
  const { buildAutomatedTravelForecast } = loadFunctions(['buildAutomatedTravelForecast', 'planTransportCargoUnload'], {
    globalSettings: {},
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedRequiredManifest: manifest => manifest.filter(entry => entry.cargoTotal),
    readAutomatedRouteInventory: async () => ({ A: { ore: 100 }, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [{ id: 'craft:1', atMs: 50, location: 'A', res: 'ore', amount: 100 }],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [{ id: 'estimate:craft2', atMs: 40, location: 'A', res: 'ore', amount: 100, source: 'craft-estimate' }],
    planSharedAutomatedTravel: (_fleets, _inventory, events) => [{ modes: events.length ? ['warp', 'subwarp'] : [] }],
    Date,
  });

  const plan = await buildAutomatedTravelForecast({}, makeTwoLegRoute(), 0, [{ mint: 'ore', amount: 10 }]);

  assert.deepEqual(Array.from(plan.modes), ['warp', 'subwarp']);
  assert.equal(plan.estimated, false);
  assert.equal(plan.productionEvents.length, 1);
  assert.equal(plan.productionEvents[0].id, 'craft:1');
});

const deliveryScenarios = [
  {
    name: 'a partial load across token accounts',
    loadedCargo: [{ mint: 'electronics', amount: 125 }, { mint: 'electronics', amount: 75 }, { mint: 'polymer', amount: 1_000 }],
    craftAmount: 800,
    keepOne: false,
  },
  {
    name: 'a retained unit',
    loadedCargo: [{ mint: 'electronics', amount: 1 }, { mint: 'polymer', amount: 1_000 }],
    craftAmount: 1_000,
    keepOne: true,
  },
  {
    name: 'an empty cargo snapshot',
    loadedCargo: [],
    craftAmount: 1_000,
    keepOne: false,
  },
];

for (const { name, loadedCargo, craftAmount, keepOne } of deliveryScenarios) {
  test(`Automated forecast uses actual delivery amounts for ${name}`, async () => {
    const electronics = { res: 'electronics', amt: 1_000, requiredAmount: 1_000, cargoTotal: true };
    const durations = { warpMs: 20_000, subwarpMs: 180_000 };
    const legs = [
      { ...durations, source: 'A', destination: 'B', manifest: [electronics, { res: 'polymer', amt: 1_000, cargoTotal: true }] },
      { ...durations, source: 'B', destination: 'C', manifest: [electronics] },
      { ...durations, source: 'C', destination: 'A', manifest: [] },
    ];
    const { buildAutomatedTravelForecast } = loadFunctions([
      'buildAutomatedTravelForecast',
      'planTransportCargoUnload',
      'cloneAutomatedInventory',
      'applyAutomatedProductionEvents',
      'getAutomatedRequiredManifest',
      'canWithdrawAutomatedManifest',
      'adjustAutomatedInventoryForManifest',
      'compressAutomatedTravelPlan',
    ], {
      Date: class extends Date { static now() { return 1; } },
      globalSettings: { transportKeep1: keepOne },
      sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
      getAutomatedRouteLeg: (_fleet, leg) => leg,
      readAutomatedRouteInventory: async () => ({ A: {}, B: { electronics: 0 }, C: {} }),
      collectAutomatedCraftingProductionEvents: async () => [{
        id: 'electronics-craft', atMs: 120_001, location: 'B', res: 'electronics', amount: craftAmount,
      }],
      collectAutomatedMiningProductionEvents: async () => [],
      collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    });
    const plan = await buildAutomatedTravelForecast({}, legs, 0, loadedCargo);
    assert.deepEqual(Array.from(plan.modes), ['subwarp', 'warp', 'warp']);
  });
}

test('Automated forecast credits only the unloadable hold and bank amounts for checked ammo', async () => {
  const fleet = { ammoBank: 'bank' };
  const route = makeTwoLegRoute({ amount: 1_000 });
  route[0].manifest = [{ res: 'ammo', amt: 1_000, cargoTotal: true }, { res: 'food', amt: 1_000 }];
  const { buildAutomatedTravelForecast } = loadFunctions([
    'buildAutomatedTravelForecast',
    'getAutomatedRequiredManifest',
    'planTransportCargoUnload',
    'getTransportAmmoBankAmount',
    'getParsedTokenAmount',
  ], {
    globalSettings: { transportUseAmmoBank: true, transportKeep1: true },
    sageGameAcct: { account: { mints: { ammo: 'ammo' } } },
    tokenProgramPK: 'token',
    solanaReadConnection: {
      getParsedTokenAccountsByOwner: async owner => {
        assert.equal(owner, fleet.ammoBank);
        return { value: [{ account: { data: { parsed: { info: { mint: 'ammo', tokenAmount: { uiAmount: 300 } } } } } }] };
      },
    },
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    readAutomatedRouteInventory: async () => ({ A: {}, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [{ id: 'craft', location: 'A', res: 'ammo', amount: 10 }],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    planSharedAutomatedTravel: ([fleetPlan]) => {
      assert.deepEqual(Array.from(fleetPlan.cargo, entry => ({ ...entry })), [
        { res: 'ammo', amt: 418, cargoTotal: true },
      ]);
      return [{ modes: ['warp'] }];
    },
  });
  await buildAutomatedTravelForecast(fleet, route, 0, [{ mint: 'ammo', amount: 120 }, { mint: 'food', amount: 1_000 }]);
});

test('future Automated manifests convert cargo capacity to weighted token amounts', () => {
  const { getAutomatedRouteLeg } = loadFunctions(['getAutomatedRouteLeg'], {
    getTransportCoordKey: value => value,
    calculateMovementDistance: () => 1,
    ConvertCoords: value => value,
    calculateWarpTime: () => 1,
    calculateSubwarpTime: () => 2,
    cloneTransportManifest: manifest => manifest.map(entry => ({ ...entry })),
    cargoItems: [{ token: 'electronics', size: 2 }],
    globalSettings: { transportUseAmmoBank: false },
    sageGameAcct: { account: { mints: { ammo: { toString: () => 'ammo' }, fuel: { toString: () => 'fuel' } } } },
    Math,
  });

  const leg = getAutomatedRouteLeg(
    { cargoCapacity: 100, fuelCapacity: 0, ammoCapacity: 0, maxWarpDistance: 100, warpCooldown: 0 },
    { source: 'A', destination: 'B', manifest: [{ res: 'electronics', amt: 100, cargoTotal: true }] },
  );

  assert.equal(leg.manifest[0].requiredAmount, 50);
});

test('Automated falls back to conservative Subwarp and a dash when the forecast fails', async () => {
  let statusUpdates = 0;
  const fleet = { cargoHold: 'cargo', label: 'Eagle Fleet' };
  const { resolveAutomatedTravelMode } = loadFunctions(['resolveAutomatedTravelMode'], {
    solanaReadConnection: {
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    },
    tokenProgramPK: 'token-program',
    cargoItems: [],
    calculateAutomatedTravelMode: () => ({
      moveType: 'warp',
      loadedCargoVolume: 10,
      requiredVolume: 10,
      thresholdVolume: 9.5,
    }),
    globalSettings: { transportUseAmmoBank: false },
    sageGameAcct: { account: { mints: { ammo: { toString: () => 'ammo' }, fuel: { toString: () => 'fuel' } } } },
    buildAutomatedTravelForecast: async () => { throw new Error('forecast unavailable'); },
    updateAssistStatus: () => { statusUpdates += 1; },
    cLog: () => {},
    FleetTimeStamp: () => '',
    Date,
  });

  const moveType = await resolveAutomatedTravelMode(fleet, [], { legs: [{}] });

  assert.equal(moveType, 'subwarp');
  assert.deepEqual(Array.from(fleet.automatedTravelPlan), []);
  assert.equal(fleet.automatedTravelPlanPending, true);
  assert.equal(statusUpdates, 1);
});

test('Automated uses conservative Subwarp and a dash when no craft ETA is available', async () => {
  let statusUpdates = 0;
  const fleet = { cargoHold: 'cargo', label: 'Eagle Fleet' };
  const { resolveAutomatedTravelMode } = loadFunctions(['resolveAutomatedTravelMode'], {
    solanaReadConnection: { getParsedTokenAccountsByOwner: async () => ({ value: [] }) },
    tokenProgramPK: 'token-program',
    cargoItems: [],
    calculateAutomatedTravelMode: () => ({ moveType: 'subwarp', loadedCargoVolume: 0, requiredVolume: 10, thresholdVolume: 9.5 }),
    globalSettings: { transportUseAmmoBank: false },
    sageGameAcct: { account: { mints: { ammo: { toString: () => 'ammo' }, fuel: { toString: () => 'fuel' } } } },
    buildAutomatedTravelForecast: async () => ({ modes: [], reason: 'awaiting_final_output', productionEvents: [] }),
    updateAssistStatus: () => { statusUpdates += 1; },
    cLog: () => {},
    FleetTimeStamp: () => '',
    Date,
  });

  const moveType = await resolveAutomatedTravelMode(fleet, [], { legs: [{}] });

  assert.equal(moveType, 'subwarp');
  assert.deepEqual(Array.from(fleet.automatedTravelPlan), []);
  assert.equal(fleet.automatedTravelPlanPending, true);
  assert.equal(statusUpdates, 1);
});

test('unchecked Food cannot force Subwarp when the Electronics forecast favors Warp', async () => {
  const route = makeTwoLegRoute({ amount: 39_687, warpMs: 22_361, subwarpMs: 333_742 });
  route[0].manifest[0].res = 'electronics';
  route[1].manifest = [{ res: 'food', amt: 60_000, cargoTotal: false }];
  const now = Date.parse('2026-11-22T08:59:08+01:00');
  const cargo = [{ mint: 'food', amount: 50_000 }, { mint: 'electronics', amount: 1 }];
  const fleet = { cargoHold: 'cargo', cargoCapacity: 79_380 };
  const { calculateAutomatedTravelMode, resolveAutomatedTravelMode } = loadFunctions([
    'cloneAutomatedInventory',
    'applyAutomatedProductionEvents',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'calculateAutomatedTravelMode',
    'buildAutomatedTravelForecast',
    'resolveAutomatedTravelMode',
    'planTransportCargoUnload',
  ], {
    Date: class extends Date { static now() { return now; } },
    solanaReadConnection: {
      getParsedTokenAccountsByOwner: async () => ({
        value: cargo.map(({ mint, amount }) => ({
          account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount: amount } } } } },
        })),
      }),
    },
    tokenProgramPK: 'token-program',
    cargoItems: [{ token: 'food', size: 1 }, { token: 'electronics', size: 2 }],
    globalSettings: { transportUseAmmoBank: true },
    sageGameAcct: { account: { mints: { ammo: 'ammo', fuel: 'fuel' } } },
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    readAutomatedRouteInventory: async () => ({ A: { electronics: 404_057 }, B: { food: 1 } }),
    collectAutomatedCraftingProductionEvents: async () => [{
      id: 'electronics-craft',
      res: 'electronics',
      location: 'A',
      amount: 1_700_000,
      atMs: Date.parse('2026-11-22T10:07:51+01:00'),
      source: 'craft',
    }],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    FleetTimeStamp: () => '',
    TimeToStr: () => '',
    updateAssistStatus: () => {},
    cLog: () => {},
  });

  const manifest = route[1].manifest;
  const baseline = calculateAutomatedTravelMode({
    manifest, loadedCargo: cargo, cargoCapacity: fleet.cargoCapacity, cargoSizes: { food: 1, electronics: 2 },
  });
  assert.equal(baseline.moveType, 'subwarp');

  assert.equal(await resolveAutomatedTravelMode(fleet, manifest, { legs: route, currentLegIndex: 1 }), 'warp');
  assert.equal(fleet.automatedTravelPlan[0], 'warp');

  route[0].manifest[0].cargoTotal = false;
  assert.equal(await resolveAutomatedTravelMode(fleet, manifest, { legs: route, currentLegIndex: 1 }), 'subwarp');
});

test('Automated uses the first mode and displays the estimated sequence until the forecast is confirmed', async () => {
  let statusUpdates = 0;
  let estimated = true;
  const fleet = { cargoHold: 'cargo', label: 'Eagle Fleet' };
  const { resolveAutomatedTravelMode, getAutomatedTravelPlanSuffix } = loadFunctions([
    'resolveAutomatedTravelMode', 'getAutomatedTravelPlanSuffix', 'compressAutomatedTravelPlan',
  ], {
    solanaReadConnection: { getParsedTokenAccountsByOwner: async () => ({ value: [] }) },
    tokenProgramPK: 'token-program',
    cargoItems: [],
    calculateAutomatedTravelMode: () => ({ moveType: 'warp', loadedCargoVolume: 10, requiredVolume: 10, thresholdVolume: 9.5 }),
    globalSettings: { transportUseAmmoBank: false },
    sageGameAcct: { account: { mints: { ammo: { toString: () => 'ammo' }, fuel: { toString: () => 'fuel' } } } },
    buildAutomatedTravelForecast: async () => ({ modes: ['subwarp', 'warp'], estimated, productionEvents: [] }),
    updateAssistStatus: () => { statusUpdates += 1; },
    cLog: () => {},
    FleetTimeStamp: () => '',
    Date,
  });

  const moveType = await resolveAutomatedTravelMode(fleet, [], { legs: [{}] });

  assert.equal(moveType, 'subwarp');
  assert.deepEqual(Array.from(fleet.automatedTravelPlan), ['subwarp', 'warp']);
  assert.equal(fleet.automatedTravelPlanPending, false);
  assert.equal(getAutomatedTravelPlanSuffix(fleet), ' | ~1sw1w');

  estimated = false;
  await resolveAutomatedTravelMode(fleet, [], { legs: [{}] });
  assert.equal(getAutomatedTravelPlanSuffix(fleet), ' | 1sw1w');
  assert.equal(statusUpdates, 2);
});

test('both packaged userscripts contain profile-wide production forecast wiring', () => {
  for (const file of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /collectAutomatedCraftingProductionEvents/);
    assert.match(source, /buildAutomatedTravelForecast/);
    assert.match(source, /automatedTravelPlan/);
  }
});
