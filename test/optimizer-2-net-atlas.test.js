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
	assert.match(source, /economicMassOf/);
	assert.match(source, /Math\.abs\(sourceMass - destMass\)/);
	assert.match(source, /sourceReferenceNetAtlas/);
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
		globalSettings: { upgradeAutomationAggressivenessStartHour: 6 },
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
		{ name: 'Framework', displayName: 'Framework', crew: 101, secondsPerUnit: 12, lpPerUnit: 68, inventoryPhantom: 8_791_663, inventoryGlobal: 100000, phantomUpgradeEligible: true },
		{ name: 'Electronics', displayName: 'Electronics', crew: 20, secondsPerUnit: 14, lpPerUnit: 92, inventoryPhantom: 4_797_958, inventoryGlobal: 100000, phantomUpgradeEligible: true },
		{ name: 'Electromagnet', displayName: 'Electromagnet', crew: 20, secondsPerUnit: 16, lpPerUnit: 133, inventoryPhantom: 3_163_704, inventoryGlobal: 100000, phantomUpgradeEligible: true }
	];
	const metrics = [
		{ component: 'Framework', priceGm: 0.00409616 },
		{ component: 'Electronics', priceGm: 0.00565940 },
		{ component: 'Electromagnet', priceGm: 0.00925088 }
	];
	const neutralResult = context.computePlan(rows, metrics, 20_000_000_000, 2_000_000, new Date('2026-08-08T06:00:00Z'));
	assert.equal(neutralResult.targetMultiplier, 0);
	assert.equal(neutralResult.neutralMultiplier, 1);
	assert.equal(neutralResult.transfers, 0);
	assert.equal(neutralResult.rows.find(row => row.name === 'Framework').optimizer2Crew, 101);

	const midpointResult = context.computePlan(rows, metrics, 20_000_000_000, 2_000_000, new Date('2026-08-08T14:30:00Z'));
	assert.ok(Math.abs(midpointResult.targetMultiplier - 0.5) < 1e-12);
	assert.ok(Math.abs(midpointResult.neutralMultiplier - 0.5) < 1e-12);
	assert.equal(midpointResult.transfers, 51);
	assert.equal(midpointResult.rows.find(row => row.name === 'Framework').optimizer2Crew, 50);

	const result = context.computePlan(rows, metrics, 20_000_000_000, 2_000_000, new Date('2026-08-08T23:00:00Z'));
	assert.equal(result.targetMultiplier, 1);
	assert.equal(result.neutralMultiplier, 0);
	assert.ok(result.sourcePoolCount > 0);
	assert.ok(result.destPoolCount > 0);
	assert.ok(result.transfers > 0);
	const framework = result.rows.find(row => row.name === 'Framework');
	const electronics = result.rows.find(row => row.name === 'Electronics');
	const electromagnet = result.rows.find(row => row.name === 'Electromagnet');
	assert.equal(framework.optimizer2Source, true);
	assert.equal(electronics.optimizer2Destination, true);
	assert.equal(electromagnet.optimizer2Destination, true);
	assert.equal(framework.optimizer2Crew, 0);
	assert.equal(electronics.optimizer2Crew + electromagnet.optimizer2Crew, 141);
	assert.ok(electromagnet.optimizer2Crew > electronics.optimizer2Crew);
	assert.ok(Math.abs((electromagnet.optimizer2Crew - 20) - (electronics.optimizer2Crew - 20)) <= 1);
});

test('Optimizer 2 panel shows NET ATLAS per second and omits upgrading per hour columns', () => {
	const sectionStart = source.indexOf("openSection('lp-auto-optimizer-2')");
	const sectionEnd = source.indexOf("content += closeSection;", sectionStart);
	const section = source.slice(sectionStart, sectionEnd);
	assert.match(section, /<b>GM Price<\/b>/);
	assert.match(section, /<b>NET ATLAS\/s<\/b>/);
	assert.match(section, /Neutral multiplier ×/);
	assert.match(section, /Target multiplier ×/);
	assert.doesNotMatch(section, /Upgrading<br>\/ Hour/);
});
