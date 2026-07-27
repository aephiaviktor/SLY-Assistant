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

function loadScheduleHelpers(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const context = { Math };
  vm.createContext(context);
  vm.runInContext([
    "const SCANNING_OPTIMIZATION_PARAMETER_KEYS = new Set(['scanMin','scanMin2','scanSearchDist']);",
    extractFunction(source, 'buildScanningOptimizationValues'),
    extractFunction(source, 'shuffleScanningOptimizationItems'),
    extractFunction(source, 'buildScanningOptimizationQueueSchedule'),
    'this.buildValues = buildScanningOptimizationValues;',
    'this.buildQueue = buildScanningOptimizationQueueSchedule;'
  ].join('\n'), context);
  return { source, buildValues: context.buildValues, buildQueue: context.buildQueue };
}

for (const file of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  test(`${file} builds independent and combination scanning optimization schedules`, () => {
    const { source, buildValues, buildQueue } = loadScheduleHelpers(file);
    assert.deepEqual(Array.from(buildValues(8, 18, 2)), [8, 10, 12, 14, 16, 18]);
    assert.deepEqual(Array.from(buildValues(5, 1, 2)), [5, 3, 1]);
    assert.deepEqual(Array.from(buildValues(1, 5, 0)), []);

    const queue = [
      { parameter: 'scanMin', start: 8, end: 20, step: 4 },
      { parameter: 'scanMin2', start: 1, end: 3, step: 1 }
    ];
    const independent = Array.from(buildQueue(queue, 10, false, () => 0.5), block => JSON.parse(JSON.stringify(block)));
    assert.equal(independent.length, 7);
    assert.equal(independent.reduce((sum, block) => sum + block.scans, 0), 70);
    assert.equal(independent.filter(block => Object.hasOwn(block.values, 'scanMin')).length, 4);
    assert.equal(independent.filter(block => Object.hasOwn(block.values, 'scanMin2')).length, 3);

    const combinations = Array.from(buildQueue(queue, 10, true, () => 0.5), block => JSON.parse(JSON.stringify(block)));
    assert.equal(combinations.length, 12);
    assert.equal(combinations.reduce((sum, block) => sum + block.scans, 0), 120);
    assert.ok(combinations.every(block => Object.keys(block.values).length === 2));
    assert.equal(buildQueue([queue[0]], 10, true).length, 0);

    assert.match(source, /scan-optimization-parameter-rows/);
    assert.match(source, /scan-optimization-scans-per-block/);
    assert.doesNotMatch(source, /scan-optimization-scans-per-value/);
    assert.match(source, /Test value combinations/);
  });
}
