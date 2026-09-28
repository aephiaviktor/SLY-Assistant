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
  const bodyStart = source.indexOf('{', functionStart);
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

test('Automated forecast suffix is compact and shows a dash while no exact plan is available', () => {
  const { compressAutomatedTravelPlan, getAutomatedTravelPlanSuffix, getAssistStatusRowModel } = loadFunctions([
    'compressAutomatedTravelPlan',
    'getAutomatedTravelPlanSuffix',
    'getAssistStatusRowModel',
  ]);
  assert.equal(compressAutomatedTravelPlan(['warp', 'warp', 'subwarp', 'subwarp', 'subwarp', 'warp']), '2w3sw1w');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: ['warp', 'warp', 'subwarp'] }), ' | 2w1sw');
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

test('Automated forecast waits for a direct final-output event instead of extrapolating current stock', async () => {
  const { buildAutomatedTravelForecast } = loadFunctions(['buildAutomatedTravelForecast'], {
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedRequiredManifest: manifest => manifest.filter(entry => entry.cargoTotal),
    readAutomatedRouteInventory: async () => ({ A: { ore: 100 }, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    planAutomatedTravelModes: input => ({ modes: ['warp', 'warp'], productionEvents: input.productionEvents }),
    Date,
  });

  const plan = await buildAutomatedTravelForecast(
    {},
    makeTwoLegRoute(),
    0,
    'warp',
    [{ mint: 'ore', amount: 10 }],
  );

  assert.deepEqual(Array.from(plan.modes), []);
  assert.equal(plan.reason, 'awaiting_final_output');
  assert.deepEqual(Array.from(plan.productionEvents), []);
});

test('estimated final-craft ETA chooses Subwarp internally but keeps the displayed plan pending', async () => {
  const route = makeTwoLegRoute({ warpMs: 10, subwarpMs: 30, amount: 10 });
  const { buildAutomatedTravelForecast } = loadFunctions(['buildAutomatedTravelForecast'], {
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedRequiredManifest: manifest => manifest.filter(entry => entry.cargoTotal),
    readAutomatedRouteInventory: async () => ({ A: { ore: 0 }, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [{ id: 'estimate:craft2', atMs: 40, location: 'A', res: 'ore', amount: 100, source: 'craft-estimate' }],
    planAutomatedStockRunway: input => {
      assert.equal(input.targetAtMs, 40);
      return { modes: ['subwarp', 'warp'], summary: '1sw1w', completedLegs: 2, lastCargoArrivalMs: 41 };
    },
    planAutomatedTravelModes: () => { throw new Error('exact planner must not run for an estimated event'); },
    Date,
  });

  const plan = await buildAutomatedTravelForecast({}, route, 0, 'warp', [{ mint: 'ore', amount: 10 }]);

  assert.equal(plan.estimated, true);
  assert.equal(plan.modes[0], 'subwarp');
});

test('Automated forecast starts when a direct final-output event is visible', async () => {
  const { buildAutomatedTravelForecast } = loadFunctions(['buildAutomatedTravelForecast'], {
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedRequiredManifest: manifest => manifest.filter(entry => entry.cargoTotal),
    readAutomatedRouteInventory: async () => ({ A: { ore: 100 }, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [{ id: 'craft:1', atMs: 50, location: 'A', res: 'ore', amount: 100 }],
    collectAutomatedMiningProductionEvents: async () => [],
    collectAutomatedEstimatedCraftingProductionEvents: async () => [],
    planAutomatedTravelModes: input => ({ modes: input.productionEvents.length ? ['warp', 'subwarp'] : [] }),
    Date,
  });

  const plan = await buildAutomatedTravelForecast({}, makeTwoLegRoute(), 0, 'warp', [{ mint: 'ore', amount: 10 }]);

  assert.deepEqual(Array.from(plan.modes), ['warp', 'subwarp']);
  assert.equal(plan.productionEvents.length, 1);
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

test('Automated uses an estimated plan first mode while keeping the dash', async () => {
  let statusUpdates = 0;
  const fleet = { cargoHold: 'cargo', label: 'Eagle Fleet' };
  const { resolveAutomatedTravelMode } = loadFunctions(['resolveAutomatedTravelMode'], {
    solanaReadConnection: { getParsedTokenAccountsByOwner: async () => ({ value: [] }) },
    tokenProgramPK: 'token-program',
    cargoItems: [],
    calculateAutomatedTravelMode: () => ({ moveType: 'warp', loadedCargoVolume: 10, requiredVolume: 10, thresholdVolume: 9.5 }),
    globalSettings: { transportUseAmmoBank: false },
    sageGameAcct: { account: { mints: { ammo: { toString: () => 'ammo' }, fuel: { toString: () => 'fuel' } } } },
    buildAutomatedTravelForecast: async () => ({ modes: ['subwarp', 'warp'], estimated: true, productionEvents: [] }),
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

test('both packaged userscripts contain profile-wide production forecast wiring', () => {
  for (const file of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(source, /collectAutomatedCraftingProductionEvents/);
    assert.match(source, /buildAutomatedTravelForecast/);
    assert.match(source, /automatedTravelPlan/);
  }
});
