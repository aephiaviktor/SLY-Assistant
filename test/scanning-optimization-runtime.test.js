'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadRuntime(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    extractFunction(source, 'getScanningOptimizationRuntimeState'),
    extractFunction(source, 'getScanningOptimizationDisplayState'),
    extractFunction(source, 'advanceScanningOptimizationRuntime'),
    'this.getState = getScanningOptimizationRuntimeState;',
    'this.getDisplay = getScanningOptimizationDisplayState;',
    'this.advance = advanceScanningOptimizationRuntime;'
  ].join('\n'), context);
  return { source, getState: context.getState, getDisplay: context.getDisplay, advance: context.advance };
}

for (const file of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  test(`${file} advances only through completed optimization blocks`, () => {
    const { getState, advance } = loadRuntime(file);
    const fleet = {
      scanOptimizationEnabled: true,
      scanOptimizationRunEnabled: true,
      scanOptimizationParameter: 'scanMin',
      scanOptimizationSchedule: [{ value: 8, scans: 2 }, { value: 10, scans: 2 }],
      scanOptimizationBlockIndex: 0,
      scanOptimizationBlockScansCompleted: 0
    };

    assert.deepEqual({ ...getState(fleet) }, {
      active: true, complete: false, blockIndex: 0, blockScansCompleted: 0,
      totalBlocks: 2, totalScans: 4, completedScans: 0, value: 8, scansInBlock: 2
    });

    const first = advance(fleet);
    assert.equal(first.changedValue, false);
    assert.equal(fleet.scanOptimizationBlockScansCompleted, 1);
    assert.equal(fleet.scanMin, 8);

    const boundary = advance(fleet);
    assert.equal(boundary.changedValue, true);
    assert.equal(fleet.scanOptimizationBlockIndex, 1);
    assert.equal(fleet.scanOptimizationBlockScansCompleted, 0);
    assert.equal(fleet.scanMin, 10);

    advance(fleet);
    const complete = advance(fleet);
    assert.equal(complete.complete, true);
    assert.equal(fleet.scanOptimizationRunEnabled, false);
    assert.equal(fleet.scanOptimizationBlockIndex, 2);
    assert.equal(fleet.scanMin, 10, 'completion leaves the final tested value in place');
  });

  test(`${file} keeps paused and invalid runs inert`, () => {
    const { advance } = loadRuntime(file);
    const paused = { scanOptimizationEnabled: true, scanOptimizationRunEnabled: false, scanOptimizationSchedule: [{ value: 1, scans: 1 }] };
    assert.equal(advance(paused).advanced, false);
    assert.equal(paused.scanOptimizationBlockIndex, undefined);

    const invalid = { scanOptimizationEnabled: true, scanOptimizationRunEnabled: true, scanOptimizationParameter: 'notAllowed', scanOptimizationSchedule: [{ value: 1, scans: 1 }] };
    const invalidResult = advance(invalid);
    assert.equal(invalidResult.advanced, false);
    assert.equal(invalidResult.notRunnable, true);
  });

  test(`${file} reports running, paused, and completed progress with cooldown ETA`, () => {
    const { getDisplay } = loadRuntime(file);
    const fleet = {
      scanOptimizationEnabled: true,
      scanOptimizationRunEnabled: true,
      scanOptimizationParameter: 'scanMin',
      scanOptimizationSchedule: [{ value: 8, scans: 2 }, { value: 10, scans: 2 }],
      scanOptimizationBlockIndex: 0,
      scanOptimizationBlockScansCompleted: 1,
      scanCooldown: 900
    };

    assert.deepEqual({ ...getDisplay(fleet) }, {
      status: 'Running', parameter: 'scanMin', value: 8,
      blockNumber: 1, totalBlocks: 2, blockScansCompleted: 1, scansInBlock: 2,
      completedScans: 1, totalScans: 4, remainingScans: 3,
      percentComplete: 25, estimatedRemainingSeconds: 2706
    });

    fleet.scanOptimizationRunEnabled = false;
    assert.equal(getDisplay(fleet).status, 'Paused');
    fleet.scanOptimizationBlockIndex = 2;
    fleet.scanOptimizationBlockScansCompleted = 0;
    assert.equal(getDisplay(fleet).status, 'Completed');
  });

  test(`${file} persists runtime progress and exposes block/value telemetry`, () => {
    const { source } = loadRuntime(file);
    assert.match(source, /saveScanningOptimizationRuntime/);
    assert.match(source, /await advanceScanningOptimizationAfterCompletedScan\(userFleets\[i\]\)/);
    assert.match(source, /scanOptimizationBlockIndex/);
    assert.match(source, /scanOptimizationBlockScansCompleted/);
    assert.match(source, /phase=\$\{influxEscape\(phase\)\}/);
    assert.match(source, /variant=\$\{influxEscape\(variant\)\}/);
    assert.match(source, /optimizationParameter=/);
    assert.match(source, /optimizationValue=/);
    assert.match(source, /optimizationBlockNumber=/);
    assert.match(source, /optimizationTotalBlocks=/);
    assert.match(source, /scanOptimizationStatus\.innerText = formatScanningOptimizationStatus\(\{\.\.\.fleetParsedData, scanCooldown: fleet\.scanCooldown\}\)/);
    assert.doesNotMatch(source, /formatScanningOptimizationStatus\(\{\.\.\.fleetParsedData, scanCooldown: fleet\.account/);
  });
}
