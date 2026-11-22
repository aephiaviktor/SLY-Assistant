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
  const context = vm.createContext({ ...globals });
  vm.runInContext(`${names.map(name => readFunctionSource(name)).join('\n')}; this.out = { ${names.join(', ')} };`, context);
  return context.out;
}

function makeTwoLegRoute({ warpMs = 10, subwarpMs = 30, amount = 10 } = {}) {
  return [
    { source: 'A', destination: 'B', warpMs, subwarpMs, manifest: [{ res: 'ore', amt: amount, cargoTotal: true }] },
    { source: 'B', destination: 'A', warpMs, subwarpMs, manifest: [] },
  ];
}

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

test('CSS Automated fallback projects up to 48 stock-funded legs from either direction', async () => {
  const capacity = 201_428;
  const legs = makeTwoLegRoute({ amount: capacity });
  let stock = 16_754_612;
  const { buildAutomatedTravelForecast } = loadFunctions([
    'buildAutomatedTravelForecast', 'getAutomatedCssTravelMode', 'planAutomatedTravelModes',
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
  const { planAutomatedTravelModes, compressAutomatedTravelPlan } = loadFunctions([
    'cloneAutomatedInventory',
    'applyAutomatedProductionEvents',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'planAutomatedTravelModes',
  ]);
  const plan = planAutomatedTravelModes({
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
  assert.match(compressAutomatedTravelPlan(plan.modes), /^\d+w(?:\d+sw)+/);
});

test('Automated planner recalculates back to warp when a confirmed unload raises stock', () => {
  const { planAutomatedTravelModes } = loadFunctions([
    'cloneAutomatedInventory',
    'applyAutomatedProductionEvents',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'planAutomatedTravelModes',
  ]);
  const input = {
    nowMs: 0,
    legs: makeTwoLegRoute(),
    currentLegIndex: 0,
    currentLegLoaded: true,
    inventory: { A: { ore: 0 }, B: {} },
    productionEvents: [{ atMs: 25, location: 'A', res: 'ore', amount: 10 }],
    horizonLegs: 4,
  };
  const constrained = planAutomatedTravelModes(input);
  const replenished = planAutomatedTravelModes({ ...input, inventory: { A: { ore: 100 }, B: {} } });
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
});

test('Automated keeps Warp through a missing mining ETA only when stock covers the full forecast', async () => {
  const capacity = 91_081;
  let copperStock = 66_169_918;
  const legs = [
    { source: '11,-16', destination: '2,-23', warpMs: 357_000, subwarpMs: 3_564_000, manifest: [{ res: 'copper', amt: capacity, cargoTotal: true }] },
    { source: '2,-23', destination: '11,-16', warpMs: 357_000, subwarpMs: 3_564_000, manifest: [{ res: 'food', amt: 3_500 }] },
  ];
  const { buildAutomatedTravelForecast, resolveAutomatedTravelMode } = loadFunctions([
    'buildAutomatedTravelForecast', 'getAutomatedCssTravelMode', 'planAutomatedTravelModes',
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

test('estimated final-craft ETA forecasts up to 48 legs using the estimated output and the runway departure mode', async () => {
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
    'planAutomatedTravelModes',
    'planAutomatedStockRunway',
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
  assert.equal(plan.summary, '1sw4w1sw42w');

  eta = 60;
  const stocked = await buildAutomatedTravelForecast({}, route, 0, [{ mint: 'ore', amount: 10 }]);
  assert.equal(stocked.summary, '48w');

  batch = 10;
  const shortfall = await buildAutomatedTravelForecast({}, route, 0, [{ mint: 'ore', amount: 10 }]);
  assert.equal(shortfall.summary, '8w');
  assert.equal(shortfall.reason, 'inventory_horizon');
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
    planAutomatedTravelModes: input => ({ modes: input.productionEvents.length ? ['warp', 'subwarp'] : [] }),
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
      'planAutomatedTravelModes',
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
    planAutomatedTravelModes: input => {
      assert.deepEqual(Array.from(input.currentLoadedManifest, entry => ({ ...entry })), [
        { res: 'ammo', amt: 418, cargoTotal: true },
      ]);
      return { modes: ['warp'] };
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

test('estimated stock runway aligns the last current-stock cargo arrival immediately after craft completion', () => {
  const { planAutomatedStockRunway } = loadFunctions([
    'cloneAutomatedInventory',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'planAutomatedStockRunway',
  ]);
  const plan = planAutomatedStockRunway({
    nowMs: 0,
    targetAtMs: 100,
    legs: makeTwoLegRoute({ warpMs: 10, subwarpMs: 30, amount: 10 }),
    currentLegIndex: 0,
    currentLegLoaded: true,
    currentLoadedManifest: [{ res: 'ore', amt: 10, cargoTotal: true }],
    inventory: { A: { ore: 20 }, B: {} },
  });

  // Current loaded cargo plus two stock-funded loads: five legs through the last
  // cargo arrival. 50ms all-Warp + three 20ms slowdowns = 110ms, the closest
  // reachable arrival at or after the 100ms craft ETA.
  assert.equal(plan.lastCargoArrivalMs, 110);
  assert.equal(plan.modes.length, 5);
  assert.equal(plan.modes.filter(mode => mode === 'subwarp').length, 3);
  assert.equal(plan.modes[0], 'subwarp');
});

test('estimated stock runway keeps all Warp when its earliest last cargo arrival is already after craft completion', () => {
  const { planAutomatedStockRunway } = loadFunctions([
    'cloneAutomatedInventory',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'planAutomatedStockRunway',
  ]);
  const plan = planAutomatedStockRunway({
    nowMs: 0,
    targetAtMs: 40,
    legs: makeTwoLegRoute({ warpMs: 10, subwarpMs: 30, amount: 10 }),
    currentLegIndex: 0,
    currentLegLoaded: true,
    currentLoadedManifest: [{ res: 'ore', amt: 10, cargoTotal: true }],
    inventory: { A: { ore: 20 }, B: {} },
  });

  assert.equal(plan.lastCargoArrivalMs, 50);
  assert.deepEqual(Array.from(plan.modes), ['warp', 'warp', 'warp', 'warp', 'warp']);
});

test('estimated stock runway keeps Warp when the craft completes before the next unfunded pickup', () => {
  const { planAutomatedStockRunway } = loadFunctions([
    'cloneAutomatedInventory',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'planAutomatedStockRunway',
  ]);
  const input = {
    nowMs: 0,
    legs: makeTwoLegRoute(),
    currentLoadedManifest: [{ res: 'ore', amt: 10, cargoTotal: true }],
    inventory: { A: { ore: 20 }, B: {} },
  };

  // The last stocked load arrives at 50ms, and the next pickup is at 60ms.
  for (const targetAtMs of [55, 60]) {
    const plan = planAutomatedStockRunway({ ...input, targetAtMs });
    assert.equal(plan.lastCargoArrivalMs, 50);
    assert.deepEqual(Array.from(plan.modes), ['warp', 'warp', 'warp', 'warp', 'warp']);
  }

  const shortfall = planAutomatedStockRunway({ ...input, targetAtMs: 61 });
  assert.equal(shortfall.modes[0], 'subwarp');

  const laterCraft = planAutomatedStockRunway({
    ...input,
    targetAtMs: 85,
    legs: [
      input.legs[0],
      { ...input.legs[1], destination: 'C', manifest: [{ res: 'polymer', amt: 10, cargoTotal: true }] },
      { ...input.legs[1], source: 'C' },
    ],
    inventory: { A: { ore: 20 }, B: { polymer: 30 } },
    productionEvents: [
      { source: 'craft-estimate', atMs: 85, location: 'B', res: 'polymer', amount: 10 },
      { source: 'craft-estimate', atMs: 95, location: 'A', res: 'ore', amount: 10 },
    ],
  });
  // The ore pickup at 90ms still needs to wait for the ore craft at 95ms.
  assert.equal(laterCraft.modes[0], 'subwarp');
});

test('estimated stock runway uses the latest possible arrival when even all Subwarp is too early', () => {
  const { planAutomatedStockRunway } = loadFunctions([
    'cloneAutomatedInventory',
    'getAutomatedRequiredManifest',
    'canWithdrawAutomatedManifest',
    'adjustAutomatedInventoryForManifest',
    'compressAutomatedTravelPlan',
    'planAutomatedStockRunway',
  ]);
  const plan = planAutomatedStockRunway({
    nowMs: 0,
    targetAtMs: 200,
    legs: makeTwoLegRoute({ warpMs: 10, subwarpMs: 30, amount: 10 }),
    currentLegIndex: 0,
    currentLegLoaded: true,
    currentLoadedManifest: [{ res: 'ore', amt: 10, cargoTotal: true }],
    inventory: { A: { ore: 20 }, B: {} },
  });

  assert.equal(plan.reason, 'runway_shortfall');
  assert.equal(plan.lastCargoArrivalMs, 150);
  assert.deepEqual(Array.from(plan.modes), ['subwarp', 'subwarp', 'subwarp', 'subwarp', 'subwarp']);
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
    'planAutomatedTravelModes',
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
