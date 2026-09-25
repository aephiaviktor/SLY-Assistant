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
