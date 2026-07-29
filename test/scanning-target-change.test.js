const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

assert.match(
  source,
  /const scanTargetChanged = fleetAssignment === 'Scan' && String\(fleetParsedData\?\.dest \|\| ''\) !== String\(fleetDestCoord \|\| ''\);/,
  'scan target changes should be detected only for scanning fleets'
);
assert.match(source, /if\(scanTargetChanged\) fleetScanEnd = Date\.now\(\);/, 'an old scanning pause should expire when the target changes');

const resetBlock = source.match(/if\(scanTargetChanged\) \{([\s\S]*?)\n\s*\}/)?.[1] || '';
for(const expected of [
  'scanAutoMoveTo = null',
  'lastScanCoord = null',
  'startupScanBlockCheck = false',
  'scanBlockIdx = 0',
  'scanSkipCnt = 0',
  'scanStrikes = 0'
]) {
  assert.ok(resetBlock.includes(expected), `target-change reset should include ${expected}`);
}

assert.doesNotMatch(
  resetBlock,
  /scanOptimization(?:Schedule|BlockIndex|BlockScansCompleted|RunEnabled)\s*=/,
  'target changes should not reset optimization progress'
);

console.log('scanning target change tests passed');
