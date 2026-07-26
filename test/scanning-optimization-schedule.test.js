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
    extractFunction(source, 'buildScanningOptimizationValues'),
    extractFunction(source, 'buildScanningOptimizationSchedule'),
    'this.buildValues = buildScanningOptimizationValues;',
    'this.buildSchedule = buildScanningOptimizationSchedule;'
  ].join('\n'), context);
  return { source, buildValues: context.buildValues, buildSchedule: context.buildSchedule };
}

for (const file of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  test(`${file} builds balanced scanning optimization schedules`, () => {
    const { source, buildValues, buildSchedule } = loadScheduleHelpers(file);
    assert.deepEqual(Array.from(buildValues(8, 18, 2)), [8, 10, 12, 14, 16, 18]);
    assert.deepEqual(Array.from(buildValues(5, 1, 2)), [5, 3, 1]);
    assert.deepEqual(Array.from(buildValues(1, 5, 0)), []);

    const values = Array.from(buildValues(8, 18, 2));
    const schedule = Array.from(buildSchedule(values, 10, 50, () => 0.5), block => ({ ...block }));
    assert.equal(schedule.length, 30);
    assert.equal(schedule.reduce((sum, block) => sum + block.scans, 0), 300);
    for (const value of values) assert.equal(schedule.filter(block => block.value === value).length, 5);
    assert.equal(buildSchedule(values, 10, 45).length, 0);

    assert.match(source, /scan-optimization-parameter/);
    assert.match(source, /scan-optimization-scans-per-block/);
    assert.match(source, /scan-optimization-scans-per-value/);
  });
}
