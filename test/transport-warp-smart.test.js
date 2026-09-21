'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function readSource(sourcePath = 'SLY_Assistant.user.js') {
  return fs.readFileSync(path.join(__dirname, '..', sourcePath), 'utf8');
}

function readFunctionSource(name, sourcePath = 'SLY_Assistant.user.js') {
  const source = readSource(sourcePath);
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in ${sourcePath}`);
  const bodyStart = source.indexOf('{', start);
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

function loadFunctions(names) {
  const context = vm.createContext({});
  vm.runInContext(`${names.map(name => readFunctionSource(name)).join('\n')}; this.out = { ${names.join(', ')} };`, context);
  return context.out;
}

test('Warp Smart is preference 5 and resolves only a completed required-load wait to one Subwarp leg', () => {
  const { transportSubwarpPrefToMoveType, transportMoveTypeToSubwarpPref, resolveWarpSmartTravelMode } = loadFunctions([
    'transportSubwarpPrefToMoveType',
    'transportMoveTypeToSubwarpPref',
    'resolveWarpSmartTravelMode',
  ]);
  assert.equal(transportSubwarpPrefToMoveType(5), 'warp-smart');
  assert.equal(transportMoveTypeToSubwarpPref('warp-smart'), 5);
  assert.equal(resolveWarpSmartTravelMode('warp-smart', false), 'warp');
  assert.equal(resolveWarpSmartTravelMode('warp-smart', true), 'subwarp');
  assert.equal(resolveWarpSmartTravelMode('warp', true), 'warp');
  assert.equal(resolveWarpSmartTravelMode('subwarp', true), 'subwarp');
});

test('Warp Smart is the first travel choice before Automated in Transport and Supply Chain', () => {
  for (const sourcePath of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = readSource(sourcePath);
    const options = '<option value="5">Warp Smart</option><option value="4">Automated</option>';
    assert.equal(source.split(options).length - 1, 2);
  }
});

test('production transport paths consume a required-load wait as one Subwarp leg and retain Warp Smart configuration', () => {
  for (const sourcePath of ['SLY_Assistant.user.js', path.join('electron-app', 'app', 'SLY_Assistant.user.js')]) {
    const source = readSource(sourcePath);
    assert.match(source, /resumedRequiredLoadWait/);
    assert.match(source, /resolveWarpSmartTravelMode\(configuredMoveType, resumedRequiredLoadWait\)/);
    assert.match(source, /transportEffectiveMoveType/);
    assert.match(source, /activeLeg\.moveType == 'warp-smart'/);
  }
});
