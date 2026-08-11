'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

test('state-backup restore preserves user craft amount and crew but excludes volatile runtime fields', () => {
  const match = source.match(/const PERSISTENT_CRAFT_CONFIG_KEYS = \[([^\]]+)\];/);
  assert.ok(match, 'PERSISTENT_CRAFT_CONFIG_KEYS must exist');
  const keys = Array.from(match[1].matchAll(/'([^']+)'/g), item => item[1]);

  assert.deepEqual(keys, ['coordinates', 'item', 'amount', 'crew', 'special', 'belowAmount']);

  for (const volatileKey of [
    'state',
    'craftingId',
    'craftingCoords',
    'feeAtlas',
    'nextAmount',
    'nextRuntime',
    'lpAutomationUpdatedAt',
    'lpAutomationCycleStamp',
    'errorCount'
  ]) {
    assert.equal(keys.includes(volatileKey), false, `${volatileKey} must not be restored from stale backup runtime state`);
  }
});
