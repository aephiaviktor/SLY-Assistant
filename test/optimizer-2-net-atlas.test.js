const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

test('Optimizer 2 is observational and ranks pools by NET ATLAS per second', () => {
	assert.match(source, /function computeUpgradeAutomationNetAtlasPlan\(/);
	assert.match(source, /\(\(lpPerUnit \* lpValue\) - gmPrice\) \/ secondsPerUnit/);
	assert.match(source, /sourceMass <= destMass/);
	assert.match(source, /optimizer2NetAtlasPerSecond/);
	assert.match(source, /pricingATL\.priceATL/);
	assert.match(source, /lp-auto-optimizer-2/);
	assert.match(source, /rgba\(255,180,80,0\.16\)/);
	assert.match(source, /rgba\(80,170,255,0\.16\)/);
});

test('Optimizer 2 does not replace the scheduler plan input', () => {
	assert.match(source, /getUpgradeAutomationScheduleState\(\{ neutralComponentPlan: finalPlan\.rows/);
	assert.doesNotMatch(source, /getUpgradeAutomationScheduleState\(\{ neutralComponentPlan: optimizer2Plan\.rows/);
});
