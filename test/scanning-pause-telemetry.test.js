const fs = require('fs');
const path = require('path');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

assert.match(
  source,
  /const pauseDurationMs = Math\.max\(globalSettings\.scanPauseTime \* 1000, userFleets\[i\]\.scanCooldown \* 1000 \+ 2000\);/,
  'pause duration should retain the existing minimum cooldown behavior'
);
assert.match(
  source,
  /pauseTelemetryFields = `,pauseCount=1i,pauseSeconds=\$\{Math\.ceil\(pauseDurationMs \/ 1000\)\}i`;/,
  'a pause should add count and duration fields using Influx integer syntax'
);
assert.match(
  source,
  /cargoRoomLeft=\$\{userFleets\[i\]\.cargoCapacity - cargoCnt - sduFound\}\$\{pauseTelemetryFields\}\$\{buildSlyaTxCostInfluxFields\(scanResult\)\}/,
  'pause fields should be written into the existing sdu measurement point'
);

console.log('scanning pause telemetry tests passed');
