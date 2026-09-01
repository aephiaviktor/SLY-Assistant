'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extract(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers.map(marker => source.indexOf(marker)).find(index => index >= 0) ?? -1;
  assert.notEqual(start, -1, `missing production function ${name}`);
  const body = source.indexOf('{', source.indexOf(')', start));
  let depth = 0, quote = '', escaped = false;
  for (let index = body; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if ('"\'`'.includes(char)) { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated production function ${name}`);
}

function api() {
  const names = ['getUpgradeDuplicateProcessStartTime', 'decideUpgradeDuplicateRecovery', 'findBlockingActiveUpgradeProcess', 'runUpgradeStartSingleFlight'];
  const context = vm.createContext({ Map, Set, Promise, Math, Number, Object, String });
  vm.runInContext(`const upgradeStartSingleFlights=new Map();\n${names.map(extract).join('\n')}\nthis.api={${names.join(',')}};`, context);
  return context.api;
}

const process = (craftingId, startTime, overrides = {}) => ({
  craftingId,
  recipeName: 'Radiation Absorber Upgrade',
  component: 'Radiation Absorber',
  status: 1,
  startTime,
  endTime: startTime + 3600,
  completed: false,
  assignedLabel: '',
  telemetryTracked: false,
  ...overrides,
});

test('selects only the newer untracked duplicate when the older process owns a slot', () => {
  const decision = api().decideUpgradeDuplicateRecovery([
    process(101, 1000, { assignedLabel: 'craft1' }),
    process(102, 1028),
  ], new Map([['Radiation Absorber', 1]]));
  assert.equal(decision.action, 'abandon');
  assert.equal(decision.canonical.craftingId, 101);
  assert.equal(decision.duplicate.craftingId, 102);
});

test('telemetry ownership is sufficient to retain the canonical process', () => {
  const decision = api().decideUpgradeDuplicateRecovery([
    process(201, 1000, { telemetryTracked: true }),
    process(202, 1028),
  ], new Map([['Radiation Absorber', 1]]));
  assert.equal(decision.action, 'abandon');
  assert.equal(decision.duplicate.craftingId, 202);
});

test('with no tracked process, a single planned component keeps the oldest confirmed process', () => {
  const decision = api().decideUpgradeDuplicateRecovery([
    process(301, 1000),
    process(302, 1028),
  ], new Map([['Radiation Absorber', 1]]));
  assert.equal(decision.action, 'abandon');
  assert.equal(decision.canonical.craftingId, 301);
  assert.equal(decision.duplicate.craftingId, 302);
});

test('ambiguous ownership never abandons either process', () => {
  const cases = [
    [process(401, 1000, { assignedLabel: 'craft1' }), process(402, 1028, { assignedLabel: 'craft2' })],
    [process(403, 1000), process(404, 1028)],
    [process(405, 1000), process(406, 1028, { assignedLabel: 'craft1' })],
  ];
  const plans = [new Map([['Radiation Absorber', 1]]), new Map(), new Map([['Radiation Absorber', 1]])];
  cases.forEach((processes, index) => assert.equal(api().decideUpgradeDuplicateRecovery(processes, plans[index]).action, 'ambiguous'));
});

test('one recovery cycle selects at most one newest duplicate', () => {
  const decision = api().decideUpgradeDuplicateRecovery([
    process(501, 1000, { assignedLabel: 'craft1' }),
    process(502, 1028),
    process(503, 1056),
  ], new Map([['Radiation Absorber', 1]]));
  assert.equal(decision.action, 'abandon');
  assert.equal(decision.duplicate.craftingId, 503);
});

test('start guard blocks any existing process for the same upgrade recipe', () => {
  const processes = [process(601, 1000), process(602, 1000, { recipeName: 'Framework Upgrade', component: 'Framework' })];
  assert.equal(api().findBlockingActiveUpgradeProcess(processes, 'Radiation Absorber Upgrade').craftingId, 601);
  assert.equal(api().findBlockingActiveUpgradeProcess(processes, 'Toolkit Upgrade'), null);
});

test('single-flight starts once and marks a concurrent caller as blocked', async () => {
  const upgradeApi = api();
  let starts = 0;
  let release;
  const operation = () => new Promise(resolve => {
    starts += 1;
    release = () => resolve({ craftingId: 701 });
  });
  const first = upgradeApi.runUpgradeStartSingleFlight('profile:starbase:recipe', operation);
  const second = upgradeApi.runUpgradeStartSingleFlight('profile:starbase:recipe', operation);
  await Promise.resolve();
  release();
  assert.equal((await first).craftingId, 701);
  const coalesced = await second;
  assert.equal(coalesced.blockedByExistingUpgrade, true);
  assert.equal(coalesced.craftingId, 701);
  assert.equal(coalesced.coalesced, true);
  assert.equal(starts, 1);
});

test('production wiring keeps userscripts identical and guards immediately before start', () => {
  assert.match(source, /recoverDuplicateUpgradeProcessForCrewWait/);
  assert.match(source, /runUpgradeStartSingleFlight/);
  assert.match(source, /findBlockingActiveUpgradeProcess/);
  assert.match(source, /runUpgradeStartSingleFlight[\s\S]*execStartCrafting/);
  const electron = fs.readFileSync(path.join(__dirname, '..', 'electron-app', 'app', 'SLY_Assistant.user.js'), 'utf8');
  assert.equal(electron, source);
});
