const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

assert.match(source, /scanOptimizationResupplyStartedAt = Date\.now\(\)/, 'resupply should start one persisted exclusion interval');
assert.match(source, /const resupplyFields = Number\(fleet\.scanOptimizationResupplyStartedAt \|\| 0\) > 0 \? ',resupplyExcluded=true' : ''/, 'all optimization telemetry during the full resupply lifecycle should be marked excluded');
assert.match(source, /resupplyExcludedSeconds=\$\{resupplyExcludedSeconds\}/, 'the first resumed scan should report the full excluded round-trip duration');
assert.match(source, /scanOptimizationResupplyStartedAt = 0/, 'the exclusion should end after the first successful resumed scan');
assert.match(source, /'scanOptimizationResupplyStartedAt'\]\) saved\[key\] = fleet\[key\]/, 'resupply lifecycle state should survive a restart');

console.log('scanning optimization resupply exclusion tests passed');
