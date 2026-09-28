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

test('Automated forecast suffix is compact and appended only for valid Automated plans', () => {
  const { compressAutomatedTravelPlan, getAutomatedTravelPlanSuffix, getAssistStatusRowModel } = loadFunctions([
    'compressAutomatedTravelPlan',
    'getAutomatedTravelPlanSuffix',
    'getAssistStatusRowModel',
  ]);
  assert.equal(compressAutomatedTravelPlan(['warp', 'warp', 'subwarp', 'subwarp', 'subwarp', 'warp']), '2w3sw1w');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: ['warp', 'warp', 'subwarp'] }), ' | 2w1sw');
  assert.equal(getAutomatedTravelPlanSuffix({ automatedTravelPlan: [] }), '');
  assert.deepEqual(
    JSON.parse(JSON.stringify(getAssistStatusRowModel({ publicKey: 'fleet', label: 'Hauler', state: 'Warp [28,21] 14:32', automatedTravelPlan: ['warp', 'warp', 'subwarp'] }, []))),
    { section: 'fleet', cells: ['Hauler', 'Warp [28,21] 14:32 | 2w1sw'] },
  );
});

test('Automated forecast still builds from current stock when no production event is visible', async () => {
  const { buildAutomatedTravelForecast } = loadFunctions(['buildAutomatedTravelForecast'], {
    getAutomatedRouteLeg: (_fleet, leg) => leg,
    getAutomatedRequiredManifest: manifest => manifest.filter(entry => entry.cargoTotal),
    readAutomatedRouteInventory: async () => ({ A: { ore: 100 }, B: {} }),
    collectAutomatedCraftingProductionEvents: async () => [],
    collectAutomatedMiningProductionEvents: async () => [],
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

  assert.deepEqual(Array.from(plan.modes), ['warp', 'warp']);
  assert.deepEqual(Array.from(plan.productionEvents), []);
});

test('Automated decision remains visible when the extended forecast fails', async () => {
  let statusUpdates = 0;
  const fleet = { cargoHold: 'cargo', label: 'Eagle Fleet' };
  const { resolveAutomatedTravelMode } = loadFunctions(['resolveAutomatedTravelMode'], {
    solanaReadConnection: {
      getParsedTokenAccountsByOwner: async () => ({ value: [] }),
    },
    tokenProgramPK: 'token-program',
    cargoItems: [],
    calculateAutomatedTravelMode: () => ({
      moveType: 'subwarp',
      loadedCargoVolume: 0,
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
  assert.deepEqual(Array.from(fleet.automatedTravelPlan), ['subwarp']);
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
