const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const sources = {
  userscript: fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8'),
  electron: fs.readFileSync(path.join(__dirname, '..', 'electron-app/app/SLY_Assistant.user.js'), 'utf8'),
};

function loadHelper(source) {
  const match = source.match(/function calculateScanningMovementOpportunityCost\([\s\S]*?\n\t\}/);
  assert.ok(match, 'movement opportunity-cost helper should exist');
  const context = {};
  vm.runInNewContext(`${match[0]}; this.calculate = calculateScanningMovementOpportunityCost;`, context);
  return context.calculate;
}

for (const [label, source] of Object.entries(sources)) {
  const calculate = loadHelper(source);
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(calculate(1_000, 90, 301_000))),
    { movementSeconds: 90, cooldownOverlapSeconds: 90, opportunityCostMovementSeconds: 0 },
    `${label}: cooldown fully covers movement`
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(calculate(1_000, 420, 301_000))),
    { movementSeconds: 420, cooldownOverlapSeconds: 300, opportunityCostMovementSeconds: 120 },
    `${label}: cooldown partially covers movement`
  );
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(calculate(301_000, 180, 301_000))),
    { movementSeconds: 180, cooldownOverlapSeconds: 0, opportunityCostMovementSeconds: 180 },
    `${label}: movement starts after cooldown ends`
  );

  assert.match(
    source,
    /movementSeconds=\$\{Number\(context\.movementSeconds \|\| 0\)\}/,
    `${label}: movement telemetry should expose movementSeconds`
  );
  assert.match(
    source,
    /cooldownOverlapSeconds=\$\{Number\(context\.cooldownOverlapSeconds \|\| 0\)\}/,
    `${label}: movement telemetry should expose cooldownOverlapSeconds`
  );
  assert.match(
    source,
    /opportunityCostMovementSeconds=\$\{Number\(context\.opportunityCostMovementSeconds \|\| 0\)\}/,
    `${label}: movement telemetry should expose opportunityCostMovementSeconds`
  );
  assert.match(
    source,
    /pauseSeconds=\$\{pauseDurationSeconds\}i/,
    `${label}: scan_result optimization event should include pauseSeconds`
  );
  assert.match(
    source,
    /pauseCount=\$\{needPause \? 1 : 0\}i/,
    `${label}: scan_result optimization event should include pauseCount`
  );
}

console.log('scanning analytics metric tests passed');
