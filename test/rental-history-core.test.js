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
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function loadCore() {
  const constants = source.match(/const SLYA_RENTAL_DAY_MS[\s\S]*?let slyaRentalHistoryRefreshInFlight = false;/)?.[0];
  assert.ok(constants, 'rental constants must exist');
  const context = vm.createContext({ BigInt, Date, Math, Number, Object, String, influxEscape: String, optimizationInfluxString: JSON.stringify, formatSlyaInfluxTimestamp: String });
  vm.runInContext(`${constants}\n${extractFunction('readSlyaRentalPublicKeyBytes')}\n${extractFunction('decodeSlyaCurrentRentalContract')}\n${extractFunction('decodeSlyaLegacyRentalContract')}\n${extractFunction('decodeSlyaCurrentRental')}\n${extractFunction('decodeSlyaLegacyRental')}\n${extractFunction('getSlyaRenterPaidDailyRate')}\n${extractFunction('buildSlyaRentalDailyPoints')}\n${extractFunction('buildSlyaRentalDailyPointLine')}\n${extractFunction('getSlyaAssignedRentalFleetConfigs')}\nthis.api={decodeSlyaCurrentRentalContract,decodeSlyaLegacyRentalContract,decodeSlyaCurrentRental,decodeSlyaLegacyRental,getSlyaRenterPaidDailyRate,buildSlyaRentalDailyPoints,buildSlyaRentalDailyPointLine,getSlyaAssignedRentalFleetConfigs};`, context);
  return context.api;
}

test('current SRSLY economics include base, service fee, and ATLAS bid exactly once', () => {
  const { getSlyaRenterPaidDailyRate } = loadCore();
  const rate = getSlyaRenterPaidDailyRate({ rate: 100000000n, serviceFee: 200000000n, bidAtlas: 300000000n, startTimeSeconds: 0n, endTimeSeconds: 864000n }, 'current');
  assert.equal(rate, 1.5);
});

test('legacy effective renter-paid rate is preserved without adding another fee', () => {
  const { getSlyaRenterPaidDailyRate } = loadCore();
  assert.equal(getSlyaRenterPaidDailyRate({ effectiveRateAtlasPerDay: 12.75 }, 'legacy'), 12.75);
});

test('UTC first and last days are prorated by exact interval overlap', () => {
  const { buildSlyaRentalDailyPoints } = loadCore();
  const start = Date.parse('2026-08-25T12:00:00Z');
  const end = Date.parse('2026-08-27T06:00:00Z');
  const points = buildSlyaRentalDailyPoints({ fleetAccount: 'fleet', contractId: 'contract', rentalId: 'rental', startTimeMs: start, endTimeMs: end, dailyRateAtlas: 24 }, end);
  assert.deepEqual(Array.from(points, (point) => [point.overlapSeconds, point.rentalCostAtlas]), [[43200, 12], [86400, 24], [21600, 6]]);
});

test('an active interval only emits the observed portion and can deterministically overwrite it later', () => {
  const { buildSlyaRentalDailyPoints } = loadCore();
  const interval = { fleetAccount: 'fleet', contractId: 'contract', rentalId: 'rental', startTimeMs: Date.parse('2026-08-25T00:00:00Z'), endTimeMs: Date.parse('2026-08-27T00:00:00Z'), dailyRateAtlas: 24 };
  const noon = buildSlyaRentalDailyPoints(interval, Date.parse('2026-08-25T12:00:00Z'));
  const complete = buildSlyaRentalDailyPoints(interval, Date.parse('2026-08-26T00:00:00Z'));
  assert.equal(noon[0].rentalCostAtlas, 12);
  assert.equal(complete[0].rentalCostAtlas, 24);
  assert.equal(noon[0].dayStartMs, complete[0].dayStartMs);
});

test('point identity excludes SLYA instance and mutable assignment metadata', () => {
  const { buildSlyaRentalDailyPoints, buildSlyaRentalDailyPointLine } = loadCore();
  const [point] = buildSlyaRentalDailyPoints({ fleetAccount: 'fleet', contractId: 'contract', rentalId: 'rental', startTimeMs: 0, endTimeMs: 86400000, dailyRateAtlas: 5, assignment: 'Scan', profile: 'profile', faction: 'UST', programGeneration: 'current' }, 86400000);
  const line = buildSlyaRentalDailyPointLine(point);
  assert.match(line, /^fleet_rental_daily_v1,fleetAccount=fleet,contractId=contract,rentalId=rental,schemaVersion=1 /);
  assert.doesNotMatch(line.split(' ')[0], /instance|assignment|profile|faction/);
});

test('invalid, owned, or incomplete interval data fails closed', () => {
  const { buildSlyaRentalDailyPoints } = loadCore();
  assert.deepEqual(Array.from(buildSlyaRentalDailyPoints({ fleetAccount: 'fleet', contractId: '', rentalId: '', startTimeMs: 0, endTimeMs: 1, dailyRateAtlas: 0 }, 1)), []);
});

test('only fleet-config entries with a non-empty assignment own emission and carry observed crew facts', () => {
  const { getSlyaAssignedRentalFleetConfigs } = loadCore();
  const fleets = [
    { publicKey: { toString: () => 'assigned' }, label: 'Fleet A', requiredCrew: 42, crewCount: 42 },
    { publicKey: { toString: () => 'unassigned' }, label: 'Fleet B', requiredCrew: 7, crewCount: 0 },
    { publicKey: { toString: () => 'missing' }, label: 'Fleet C' },
  ];
  const result = getSlyaAssignedRentalFleetConfigs(fleets, { assigned: { assignment: 'Scan' }, unassigned: { assignment: '' } });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [{ fleetAccount: 'assigned', fleetLabel: 'Fleet A', assignment: 'Scan', requiredCrew: 42, crewCount: 42 }]);
});

test('daily rental points preserve fleet-account crew facts without claiming crew provenance', () => {
  const { buildSlyaRentalDailyPoints, buildSlyaRentalDailyPointLine } = loadCore();
  const [point] = buildSlyaRentalDailyPoints({ fleetAccount: 'fleet', contractId: 'contract', rentalId: 'rental', startTimeMs: 0, endTimeMs: 86400000, dailyRateAtlas: 5, requiredCrew: 42, crewCount: 42 }, 86400000);
  const line = buildSlyaRentalDailyPointLine(point);
  assert.match(line, /requiredCrew=42i/);
  assert.match(line, /crewCount=42i/);
  assert.match(line, /crewSnapshotSource="fleet_account_observed"/);
  assert.doesNotMatch(line, /crewIncluded|rentedWithCrew|crewProvidedByRental/);
});

test('integration batches contract and rental reads and schedules replayable refreshes', () => {
  assert.match(source, /requiredCrew: entry\.requiredCrew, crewCount: entry\.crewCount/);
  assert.match(source, /getMultipleAccountsInfo\(candidates\.map\(\(entry\) => entry\.contract\), 'confirmed'\)/);
  assert.match(source, /getMultipleAccountsInfo\(active\.map\(\(entry\) => entry\.rental\), 'confirmed'\)/);
  assert.match(source, /await sendToInflux\(lines\.join\('\\n'\)\)/);
  assert.match(source, /setInterval\(\(\) => \{ refreshSlyaRentalHistory\(\); \}, 15 \* 60 \* 1000\)/);
  assert.doesNotMatch(source, /fleet_rental_daily_v1[^\n]*instance=/);
});
