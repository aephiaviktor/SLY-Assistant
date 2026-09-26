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
  vm.runInContext(`${readFunctionSource('planCargoMineFallback', sourcePath)}; this.plan = planCargoMineFallback;`, context);
  return context.plan;
}

test('Cargo / Mine starts one fallback cycle only after a required-load wait passes mining preflight', () => {
  const plan = loadPlanner();
  assert.equal(plan({ assignment: 'Cargo / Mine', fleetState: 'Idle', waitingResource: 'Electronics', mineResource: 'carbon', suppliesReady: true, hasCargoSpace: true, atConfiguredLocation: true }).action, 'start-mining');
});

test('missing mining supplies retains the cargo wait instead of producing an error', () => {
  const plan = loadPlanner();
  assert.deepEqual(JSON.parse(JSON.stringify(plan({ assignment: 'Cargo / Mine', fleetState: 'Idle', waitingResource: 'Electronics', mineResource: 'carbon', suppliesReady: false, hasCargoSpace: true, atConfiguredLocation: true }))), { action: 'wait', status: 'Waiting for Electronics', reason: 'Missing mining supplies' });
});

test('blank fallback resource keeps normal Waiting behavior', () => {
  const plan = loadPlanner();
  assert.equal(plan({ assignment: 'Cargo / Mine', fleetState: 'Idle', waitingResource: 'Fuel', mineResource: '', suppliesReady: true, hasCargoSpace: true, atConfiguredLocation: true }).action, 'wait');
});

test('completed fallback cycle unloads before transport is rechecked', () => {
  const plan = loadPlanner();
  assert.equal(plan({ assignment: 'Cargo / Mine', fleetState: 'Idle', waitingResource: 'Electronics', mineResource: 'carbon', fallbackActive: true, suppliesReady: true, hasCargoSpace: false, atConfiguredLocation: true }).action, 'unload-recheck');
});

test('active on-chain mining continues through the mining handler', () => {
  const plan = loadPlanner();
  assert.equal(plan({ assignment: 'Cargo / Mine', fleetState: 'MineAsteroid', waitingResource: 'Electronics', mineResource: 'carbon', fallbackActive: true, suppliesReady: true, hasCargoSpace: true, atConfiguredLocation: true }).action, 'continue-mining');
});

test('first fallback row maps to Target and second row maps to Starbase', () => {
  const context = vm.createContext({
    ConvertCoords: value => String(value || '').split(',').map(Number),
    CoordsEqual: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]),
  });
  vm.runInContext(`${readFunctionSource('getCargoMineLocationConfig')}; this.resolveLocation = getCargoMineLocationConfig;`, context);
  const config = { dest: '5,6', starbase: '1,2', cargoMineTargetResource: 'carbon', cargoMineStarbaseResource: 'iron' };
  assert.deepEqual(JSON.parse(JSON.stringify(context.resolveLocation(config, [5, 6]))), { coord: '5,6', resource: 'carbon', location: 'Target' });
  assert.deepEqual(JSON.parse(JSON.stringify(context.resolveLocation(config, [1, 2]))), { coord: '1,2', resource: 'iron', location: 'Starbase' });
});

test('Cargo / Mine editor has one location-aware fallback selector per transport row', () => {
  const source = readSource();
  assert.ok(source.includes("assistAssignments = ['', 'Scan', 'Mine', 'Transport', 'Cargo / Mine', 'Supply Chain']"));
  assert.match(source, /cargo-mine-target-resource/);
  assert.match(source, /cargo-mine-starbase-resource/);
  assert.match(source, /Missing mining supplies/);
  assert.match(source, /getMineableCargoItemsAtCoords/);
  assert.match(source, /transportResource.style.width = '64px'/);
  assert.match(source, /transportResourcePerc.style.width = '52px'/);
  assert.match(source, /transportResourceCrew.style.width = '34px'/);
});


test('fallback mining unloads all ordinary cargo before mining and again before route recheck', () => {
  const context = vm.createContext({});
  vm.runInContext(`${readFunctionSource('getCargoMineUnloadEntries')}; this.getEntries = getCargoMineUnloadEntries;`, context);
  const entries = JSON.parse(JSON.stringify(context.getEntries({ value: [
    { account: { data: { parsed: { info: { mint: 'electronics', tokenAmount: { uiAmount: 30 } } } } } },
    { account: { data: { parsed: { info: { mint: 'food', tokenAmount: { uiAmount: 12 } } } } } },
    { account: { data: { parsed: { info: { mint: 'carbon', tokenAmount: { uiAmount: 4 } } } } } },
  ] })));
  assert.deepEqual(entries, [
    { mint: 'electronics', amount: 30 },
    { mint: 'food', amount: 12 },
    { mint: 'carbon', amount: 4 },
  ]);

  const source = readSource();
  const handler = readFunctionSource('handleCargoMine');
  assert.ok(source.includes("unloadAllCargoMineCargo(i, locationConfig.coord, 'Cargo / Mine: clearing cargo for mining', fleetState, dockedCoords)"));
  assert.ok(source.includes("unloadAllCargoMineCargo(i, coord, 'Cargo / Mine: unloading after mining')"));
  assert.ok(source.includes('await unloadAllCargoMineCargo(i, locationConfig.coord'));
  assert.ok(handler.indexOf('await unloadAllCargoMineCargo(i, locationConfig.coord') < handler.indexOf('await runCargoMineMiningCycle('));
  assert.ok(!source.includes('preserveCargo: true'));
  assert.ok(!source.includes('const minedAmount = Math.max(0, currentAmount - baseline)'));
});

test('already-docked fallback clears cargo at the actual Starbase without docking twice', () => {
  const source = readSource();
  const handler = readFunctionSource('handleCargoMine');
  const clearance = readFunctionSource('unloadAllCargoMineCargo');

  assert.match(handler, /fleetStateExtra/);
  assert.ok(handler.includes('getCargoMineDockedCoords(fleetState, fleetStateExtra)'));
  assert.ok(handler.includes('getCargoMineLocationConfig(fleetParsedData, effectiveFleetCoords)'));
  assert.ok(clearance.includes("fleetState === 'StarbaseLoadingBay'"));
  assert.ok(clearance.includes('if(!alreadyDocked) await execDock'));
  assert.ok(clearance.includes('await execUndock(fleet, unloadCoord)'));
  assert.ok(source.includes('handleCargoMine(i, fleetParsedData, fleetState, fleetCoords, fleetMining, extra)'));
});

test('runtime dispatch uses Cargo / Mine orchestration and both source copies match', () => {
  const source = readSource();
  assert.ok(source.includes("fleetParsedData.assignment == 'Cargo / Mine'"));
  assert.ok(source.includes('handleCargoMine(i, fleetParsedData, fleetState, fleetCoords, fleetMining, extra)'));
  assert.equal(source, readSource(path.join('electron-app', 'app', 'SLY_Assistant.user.js')));
});
