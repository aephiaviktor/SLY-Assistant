'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadBuilders() {
  const context = vm.createContext({
    BigInt,
    Math,
    Number,
    String,
    URL,
    globalSettings: { influxURL: 'https://example.invalid/api/v2/write?bucket=slya&precision=ms' },
    getSlyaInfluxInstanceTag: () => 'USTUR1',
    getUpgradeAutomationInfluxFactionTag: () => 'UST',
    influxEscape: (value) => String(value).replaceAll(' ', '\\ '),
    optimizationInfluxString: (value) => JSON.stringify(String(value ?? '')),
  });
  vm.runInContext(`
    ${extractFunction('getSlyaInfluxPrecision')}
    ${extractFunction('formatSlyaInfluxTimestamp')}
    ${extractFunction('getSlyaCostEventTimestamp')}
    ${extractFunction('buildSlyaFuelCostSourceEvent')}
    ${extractFunction('getSlyaTransactionFeeSourceEvents')}
    ${extractFunction('buildSlyaCostSourceEventLine')}
    this.api = { getSlyaCostEventTimestamp, buildSlyaFuelCostSourceEvent, getSlyaTransactionFeeSourceEvents, buildSlyaCostSourceEventLine };
  `, context);
  return context.api;
}

const tx = (signature, lamports = 5000, blockTime = 1785830000, position = null) => ({
  slyaTxHash: signature,
  slyaTxFeeLamports: lamports,
  blockTime,
  ...(position == null ? {} : { slyaTxEventPosition: position }),
});

const movement = (cycleId, movementIndex, assignment = 'Transport', burnedFuel = 12.5, result = tx('sig-a')) => ({
  cycleId,
  movementIndex,
  movementEventId: `${cycleId}:${movementIndex}`,
  fleetAccount: 'fleet-account',
  fleetLabel: 'Fleet A',
  assignment,
  burnedFuel,
  txResult: result,
});

test('two Fuel movements in one cycle have stable distinct plan positions and assignment-independent identity', () => {
  const { buildSlyaFuelCostSourceEvent } = loadBuilders();
  const first = buildSlyaFuelCostSourceEvent(movement('cycle-1', 0, 'Transport'));
  const second = buildSlyaFuelCostSourceEvent(movement('cycle-1', 1, 'Supply Chain'));
  const reassigned = buildSlyaFuelCostSourceEvent(movement('cycle-1', 0, 'Supply Chain'));
  assert.equal(first.eventIdentity, 'fuel:cycle-1:0');
  assert.equal(second.eventIdentity, 'fuel:cycle-1:1');
  assert.equal(reassigned.eventIdentity, first.eventIdentity);
});

test('Fuel retry retains identity and block timestamp while equal source values remain separate', () => {
  const { buildSlyaFuelCostSourceEvent, buildSlyaCostSourceEventLine } = loadBuilders();
  const one = buildSlyaFuelCostSourceEvent(movement('cycle-1', 0));
  const retry = buildSlyaFuelCostSourceEvent(movement('cycle-1', 0));
  const two = buildSlyaFuelCostSourceEvent(movement('cycle-1', 1));
  assert.deepEqual(retry, one);
  assert.notEqual(two.eventIdentity, one.eventIdentity);
  assert.notEqual(buildSlyaCostSourceEventLine(two), buildSlyaCostSourceEventLine(one));
  assert.match(buildSlyaCostSourceEventLine(one), / fuelQuantity=12\.5/);
  assert.match(buildSlyaCostSourceEventLine(one), / 1785830000000$/);
});

test('SOL fee identity uses real signature and exact native lamports', () => {
  const { getSlyaTransactionFeeSourceEvents, buildSlyaCostSourceEventLine } = loadBuilders();
  const [fee] = getSlyaTransactionFeeSourceEvents(tx('real-signature', 987654));
  assert.equal(fee.eventIdentity, 'sol_fee:real-signature');
  assert.equal(fee.txFeeLamports, 987654);
  assert.match(buildSlyaCostSourceEventLine(fee), /txFeeLamports=987654i/);
});

test('transaction replay is identical; distinct signatures and real positions remain separate', () => {
  const { getSlyaTransactionFeeSourceEvents } = loadBuilders();
  const first = getSlyaTransactionFeeSourceEvents(tx('sig-1', 5000))[0];
  assert.deepEqual(getSlyaTransactionFeeSourceEvents(tx('sig-1', 5000))[0], first);
  assert.notEqual(getSlyaTransactionFeeSourceEvents(tx('sig-2', 5000))[0].eventIdentity, first.eventIdentity);
  assert.notEqual(
    getSlyaTransactionFeeSourceEvents(tx('shared', 5000, 1785830000, 0))[0].eventIdentity,
    getSlyaTransactionFeeSourceEvents(tx('shared', 5000, 1785830000, 1))[0].eventIdentity,
  );
});

test('unsigned/preflight, missing signature, missing fee, and unstable timestamp fail closed', () => {
  const { getSlyaTransactionFeeSourceEvents, buildSlyaFuelCostSourceEvent } = loadBuilders();
  assert.equal(getSlyaTransactionFeeSourceEvents(null).length, 0);
  assert.equal(getSlyaTransactionFeeSourceEvents({ meta: { fee: 5000 }, blockTime: 1 }).length, 0);
  assert.equal(getSlyaTransactionFeeSourceEvents({ slyaTxHash: 'sig', blockTime: 1 }).length, 0);
  assert.equal(getSlyaTransactionFeeSourceEvents({ slyaTxHash: 'sig', slyaTxFeeLamports: 5000 }).length, 0);
  assert.equal(buildSlyaFuelCostSourceEvent({ ...movement('cycle', 0), movementEventId: '' }), null);
});

test('event point identity prevents timestamp collisions and stores no valuation', () => {
  const { buildSlyaFuelCostSourceEvent, buildSlyaCostSourceEventLine } = loadBuilders();
  const first = buildSlyaCostSourceEventLine(buildSlyaFuelCostSourceEvent(movement('cycle', 0)));
  const second = buildSlyaCostSourceEventLine(buildSlyaFuelCostSourceEvent(movement('cycle', 1)));
  assert.match(first, /^cargo_cost_source_event_v1,eventType=fuel,eventIdentity=fuel:cycle:0,/);
  assert.match(second, /^cargo_cost_source_event_v1,eventType=fuel,eventIdentity=fuel:cycle:1,/);
  assert.doesNotMatch(first, /priceATL|estimated|amountATL/);
});

test('compatibility movement telemetry and cadence stay in the established send', () => {
  assert.match(source, /const movementFields = `type="warp",burnedFuel=\$\{burnedFuel\},moveTime=\$\{moveTime\},moveDist=\$\{moveDist\}\$\{buildSlyaTxCostInfluxFields\(movementTxResult\)\}`/);
  assert.match(source, /sendToInflux\(`movement,\$\{movementTags\} \$\{movementFields\}`\)/);
  assert.match(source, /const writeBody = queuedCostEvents\.length/);
  assert.doesNotMatch(source, /setInterval\([^\n]*cargo_cost_source_event_v1|setTimeout\([^\n]*cargo_cost_source_event_v1/);
});
