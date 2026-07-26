#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0, bodyStart = -1, quote = '', escaped = false;
  for (let i = paramsStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') paramsDepth++;
    else if (ch === ')' && --paramsDepth === 0) {
      bodyStart = source.indexOf('{', i);
      break;
    }
  }
  assert.notEqual(bodyStart, -1, `${name} body must exist`);
  let depth = 0;
  quote = '';
  escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = {
  Date,
  String,
  ConvertCoords: (value) => String(value).split(',').map(Number),
  validTargets: [
    { x: 21, y: 0, name: 'MRZ-21' },
    { x: 17, y: 0, name: 'MRZ-17' },
  ],
};
vm.createContext(context);
vm.runInContext(`
  ${extractFunction('getFleetTelemetryHomeCoord')}
  ${extractFunction('getFleetTelemetryHomeStarbaseName')}
  ${extractFunction('normalizeFleetTelemetryRouteValue')}
  ${extractFunction('hasFleetTelemetryRouteChanged')}
  this.getHomeName = getFleetTelemetryHomeStarbaseName;
  this.hasRouteChanged = hasFleetTelemetryRouteChanged;
`, context);

const fleet = { starbaseCoord: '17,0' };
assert.equal(
  context.getHomeName(fleet, { starbase: '21,0' }),
  'MRZ-21',
  'cycle anchor comes from the configured first starbase, not the fleet current/target starbase'
);
assert.equal(
  context.hasRouteChanged({ id: 'old-cycle', homeCoord: '25,14', assignment: 'Transport' }, fleet, { starbase: '21,0', assignment: 'Transport' }),
  true,
  'a changed configured home invalidates the persisted accounting cycle'
);
assert.equal(
  context.hasRouteChanged({ id: 'same-cycle', homeCoord: '21,0', assignment: 'Transport' }, fleet, { starbase: '21,0', assignment: 'Transport' }),
  false,
  'the same configured route preserves the persisted accounting cycle'
);
assert.equal(
  context.hasRouteChanged({ id: 'assignment-cycle', homeCoord: '21,0', assignment: 'Supply Chain' }, fleet, { starbase: '21,0', assignment: 'Transport' }),
  true,
  'an assignment change also invalidates the persisted accounting cycle'
);

const getCycleFunction = extractFunction('getFleetTelemetryCostCycle');
assert.match(
  getCycleFunction,
  /hasFleetTelemetryRouteChanged/
);
assert.match(
  getCycleFunction,
  /archiveFleetTelemetryCostCycle/
);

const loadFunction = extractFunction('addFleetTelemetryCargoLoad');
assert.doesNotMatch(
  loadFunction,
  /cycle\.originStarbase\s*=\s*starbase/,
  'the first observed cargo load must not redefine the cost-cycle anchor'
);

const finalizeFunction = extractFunction('maybeFinalizeFleetTelemetryCostCycle');
assert.match(
  finalizeFunction,
  /originStarbase=\$\{influxEscape\(item\.originStarbase \|\| 'unknown'\)\}/,
  'Influx allocation rows must use each cargo lot pickup starbase as their origin'
);
assert.match(
  finalizeFunction,
  /homeStarbase=\$\{influxEscape\(homeStarbase \|\| 'unknown'\)\}/,
  'Influx allocation rows retain the configured cycle anchor separately'
);
assert.match(
  finalizeFunction,
  /splitTelemetryCost\(cycle\.burnedFuel, volumeWeights\)/,
  'the complete cycle fuel cost must be allocated by delivered cargo volume'
);
assert.match(
  finalizeFunction,
  /splitTelemetryCost\(cycle\.txCostSol, volumeWeights\)/,
  'the complete cycle transaction cost must be allocated by delivered cargo volume'
);
assert.doesNotMatch(
  finalizeFunction,
  /loadedWeights/,
  'cycle allocation must not depend on which leg carried an asset'
);
assert.match(
  finalizeFunction,
  /cargo_cycle_completed[^\n]+legCount=\$\{completedLegCount\}i/,
  'finalization must emit one explicit completion event with the configured leg count'
);

const movementFunction = extractFunction('addFleetTelemetryMovementCost');
assert.doesNotMatch(
  movementFunction,
  /maybeFinalizeFleetTelemetryCostCycle/,
  'movement coordinates must not decide when a round trip is complete'
);

const supplyChainFunction = extractFunction('handleSupplyChain');
assert.match(
  supplyChainFunction,
  /activeTransportPlusRouteIndex === transportPlusLegs\.length - 1/,
  'Supply Chain must close only after the final configured route leg'
);
assert.match(
  supplyChainFunction,
  /maybeFinalizeFleetTelemetryCostCycle[^\n]+transportPlusLegs\.length/,
  'Supply Chain completion must report its actual route leg count'
);

console.log('cargo cost-cycle tests passed');
