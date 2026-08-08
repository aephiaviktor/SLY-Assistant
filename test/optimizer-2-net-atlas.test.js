const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
	const start = source.indexOf(`function ${name}(`);
	assert.notEqual(start, -1, `${name} must exist`);
	const bodyStart = source.indexOf('{', start);
	let depth = 0;
	for (let index = bodyStart; index < source.length; index++) {
		if (source[index] === '{') depth += 1;
		if (source[index] === '}') depth -= 1;
		if (depth === 0) return source.slice(start, index + 1);
	}
	throw new Error(`Could not extract ${name}`);
}

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

test('execution summary feeds Optimizer 2 from the current faction epoch ATLAS pool', () => {
	assert.match(source, /computeUpgradeAutomationNetAtlasPlan\(neutralComponentPlan, componentPerformanceMetrics\.rows, expectedTotalLpByEod, pricingHistoryDebug\.latest\?\.atlasPool, now\)/);
	assert.doesNotMatch(source, /computeUpgradeAutomationNetAtlasPlan\(neutralComponentPlan, componentPerformanceMetrics\.rows, expectedTotalLpByEod, profitStats\.atlasPool, now\)/);
	assert.match(source, /optimizer2\.lpValue === null/);
});

test('current ONI epoch inputs create colored pools and reallocate target crew', () => {
	const context = {
		UPGRADE_AUTOMATION_MIN_JOB_CREW: 10,
		getUpgradeAutomationPlanningHorizon: () => ({ planningHours: 6 }),
		getUpgradeAutomationPerformanceComponentName: component => component === 'SDU' ? 'Survey Data Unit' : component,
		projectUpgradeAutomationFinalRow: (row, crew) => ({
			finalUpgradingHour: Math.floor(crew * 3600 / row.secondsPerUnit),
			finalUpgradingDay: Math.floor(crew * 21600 / row.secondsPerUnit),
			finalBufferDays: crew > 0 ? row.inventoryGlobal / Math.max(1, crew) : Infinity
		})
	};
	vm.createContext(context);
	vm.runInContext(`${extractFunction('computeUpgradeAutomationNetAtlasPlan')}; this.computePlan = computeUpgradeAutomationNetAtlasPlan;`, context);
	const rows = [
		{ name: 'Framework', displayName: 'Framework', crew: 20, secondsPerUnit: 12, lpPerUnit: 68, inventoryPhantom: 1000, inventoryGlobal: 100000, phantomUpgradeEligible: true },
		{ name: 'Electronics', displayName: 'Electronics', crew: 20, secondsPerUnit: 14, lpPerUnit: 92, inventoryPhantom: 1000, inventoryGlobal: 100000, phantomUpgradeEligible: true },
		{ name: 'Electromagnet', displayName: 'Electromagnet', crew: 20, secondsPerUnit: 16, lpPerUnit: 133, inventoryPhantom: 1000, inventoryGlobal: 100000, phantomUpgradeEligible: true },
		{ name: 'Survey Data Unit', displayName: 'Survey Data Unit', crew: 20, secondsPerUnit: 120, lpPerUnit: 1325, inventoryPhantom: 1000, inventoryGlobal: 100000, phantomUpgradeEligible: true }
	];
	const metrics = [
		{ component: 'Framework', priceGm: 0.00305 },
		{ component: 'Electronics', priceGm: 0.004203 },
		{ component: 'Electromagnet', priceGm: 0.007141 },
		{ component: 'Survey Data Unit', priceGm: 0.0925 }
	];
	const result = context.computePlan(rows, metrics, 20_000_000_000, 2_000_000, new Date('2026-08-08T06:00:00Z'));
	assert.ok(result.sourcePoolCount > 0);
	assert.ok(result.destPoolCount > 0);
	assert.ok(result.transfers > 0);
	assert.ok(result.rows.some(row => row.optimizer2Source));
	assert.ok(result.rows.some(row => row.optimizer2Destination));
	assert.ok(result.rows.some(row => row.optimizer2Crew !== row.crew));
});
