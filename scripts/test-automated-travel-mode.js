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

const context = {};
vm.createContext(context);
vm.runInContext(`${extractFunction('calculateAutomatedTravelMode')}\nthis.calculate = calculateAutomatedTravelMode;`, context);

const sizes = { cargo: 2, ammo: 1, fuel: 1 };
const base = {
  manifest: [], loadedCargo: [], cargoCapacity: 1000, ammoCapacity: 100, fuelCapacity: 200,
  ammoMint: 'ammo', fuelMint: 'fuel', cargoSizes: sizes
};

assert.equal(context.calculate(base).moveType, 'warp', 'an intentionally empty leg warps');
assert.equal(context.calculate({ ...base, manifest: [{ res: 'cargo', amt: 400 }], loadedCargo: [{ mint: 'cargo', amount: 380 }] }).moveType, 'warp', '95% of a below-capacity configured volume warps');
assert.equal(context.calculate({ ...base, manifest: [{ res: 'cargo', amt: 400 }], loadedCargo: [{ mint: 'cargo', amount: 379 }] }).moveType, 'subwarp', 'less than 95% of configured volume subwarps');
assert.equal(context.calculate({ ...base, manifest: [{ res: 'cargo', amt: 600 }], loadedCargo: [{ mint: 'cargo', amount: 475 }] }).moveType, 'warp', '95% of cargo capacity warps when configured volume exceeds capacity');
assert.equal(context.calculate({ ...base, manifest: [{ res: 'ammo', amt: 200 }], loadedCargo: [{ mint: 'ammo', amount: 95 }] }).moveType, 'warp', 'ammo-bank capacity is removed before calculating cargo-hold demand');
assert.equal(context.calculate({ ...base, manifest: [{ res: 'fuel', amt: 300 }], loadedCargo: [{ mint: 'fuel', amount: 95 }] }).moveType, 'warp', 'fuel-tank capacity is removed before calculating cargo-hold demand');

console.log('automated travel-mode tests passed');
