'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadFunction(name, sourcePath = path.join('SLY_Assistant.user.js')) {
  const source = fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8');
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in SLY_Assistant.user.js`);

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

  const context = vm.createContext({ globalSettings: { transportKeep1: false } });
  vm.runInContext(`${source.slice(start, end + 1)}; this.result = ${name};`, context);
  return { fn: context.result, context };
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
