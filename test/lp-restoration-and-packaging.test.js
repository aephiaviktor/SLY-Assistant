'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.join(__dirname, '..');
const canonicalPath = path.join(root, 'SLY_Assistant.user.js');
const packagedPath = path.join(root, 'electron-app/app/SLY_Assistant.user.js');
const canonical = fs.readFileSync(canonicalPath, 'utf8');
const packaged = fs.readFileSync(packagedPath, 'utf8');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const nextFunction = source.indexOf('\n\tfunction ', start + 10);
  const nextAsyncFunction = source.indexOf('\n\tasync function ', start + 10);
  const candidates = [nextFunction, nextAsyncFunction].filter(index => index > start);
  return source.slice(start, Math.min(...candidates));
}

test('packaged userscript is byte-identical to the canonical root', () => {
  assert.equal(sha256(packaged), sha256(canonical));
  assert.deepEqual(fs.readFileSync(packagedPath), fs.readFileSync(canonicalPath));
});

test('LP Control panel exposes the current forecast and uninstalled metrics', () => {
  const panelStart = canonical.indexOf("openSection('lp-auto-control')");
  const panelEnd = canonical.indexOf("openSection('lp-auto-components')", panelStart);
  const panel = canonical.slice(panelStart, panelEnd);
  for (const label of [
    'Expected Additional LP by EOD',
    'Expected Total LP by EOD',
    'Uninstalled LP (&lt;24h)',
    'Uninstalled LP (&gt;24h)',
  ]) assert.match(panel, new RegExp(label.replace(/[()]/g, '\\$&')), `missing ${label}`);
  assert.doesNotMatch(panel, /Projected LP Today/, 'LP Control must not silently revert to the legacy-only layout');
  assert.match(panel, /Unavailable.*expectedLpByEodError/s, 'failed forecast must be explicit');
  assert.match(panel, /expectedLpByEod !== null[^\n]+: '-'/, 'unavailable forecast must render explicitly');
  assert.match(panel, /LP Control using last good data; refresh issue:/, 'refresh failure must remain visible with last-good data');
  assert.match(panel, /LP Control error:/, 'complete calculation failure must render as an error');
});

test('hourly snapshot publishes a complete optimization_upgrading aggregate', () => {
  const builder = extractFunction(canonical, 'buildUpgradeAutomationUpgradingOptimizationLines');
  const emitter = extractFunction(canonical, 'emitUpgradeAutomationInfluxSnapshot');
  for (const field of [
    'aggressiveness', 'aggressiveness_abs', 'aggressiveness_rel',
    'expected_additional_lp_eod', 'expected_total_lp_eod',
    'faction_lp_installed_today', 'neutral_lp_target',
    'oldest_uninstalled_over_24h_age_seconds', 'optimizer_lp_target',
    'phantom_crew', 'player_lp_installed_today', 'requested_lp_target',
    'uninstalled_over_24h_lp', 'uninstalled_under_24h_lp',
  ]) assert.ok(builder.includes(field), `aggregate missing ${field}`);
  assert.match(builder, /Number\.isFinite\(Number\(summary\.expectedLpByEod\)\)/, 'invalid expected LP must not corrupt the aggregate');
  assert.match(builder, /Number\.isFinite\(Number\(summary\.expectedTotalLpByEod\)\)/, 'invalid expected total must not corrupt the aggregate');
  assert.match(emitter, /buildUpgradeAutomationUpgradingOptimizationLines\(/);
  assert.match(emitter, /await sendToInflux\(optimizationLine, 'optimization'\)/);
  assert.match(emitter, /appendUpgradeAutomationLog\(`\[UPGRADE-AUTO\]\[INFLUX\] sending/, 'send progress must be visible before failures');
  assert.match(emitter, /skip influx tracking disabled/, 'the existing per-instance tracking setting remains authoritative');
});

test('the scheduled :50 path reaches the optimization publisher', () => {
  const scheduler = extractFunction(canonical, 'startUpgradeAutomationInfluxSnapshotScheduler');
  const snapshot = extractFunction(canonical, 'runUpgradeAutomationSnapshot');
  assert.match(scheduler, /if \(min !== 50\) return;[\s\S]*runUpgradeAutomationSnapshot\(now, 'INFLUX'\)/);
  assert.match(snapshot, /emitUpgradeAutomationInfluxSnapshot\(now, lastLpControlSummary, lastExecutionSummary\)/);
});

test('release tooling deterministically synchronizes canonical bytes before packaging', () => {
  const bump = fs.readFileSync(path.join(root, 'scripts/bump-aephia-version.js'), 'utf8');
  assert.match(bump, /writeFileSync\(packagedPath, updatedCanonical\)/);
  assert.match(bump, /byte-identical|Buffer\.compare|\.equals\(/);
});
