const fs = require('fs');
const path = require('path');
const assert = require('assert');

for (const relativePath of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const scanBranchStart = source.indexOf("else if (fleetParsedData.assignment == 'Scan' && fleetState == 'Idle') {");
  assert.ok(scanBranchStart >= 0, `${relativePath}: expected scanning scheduler branch`);
  const scanBranch = source.slice(scanBranchStart, source.indexOf("else if (fleetParsedData.assignment == 'Mine')", scanBranchStart));
  assert.doesNotMatch(
    scanBranch,
    /updateFleetState\(userFleets\[i\], fleetState\);/,
    `${relativePath}: scanning scheduler must not overwrite Scanned/Waiting/Retry state with chain-level Idle`
  );
}

console.log('scanning runtime state tests passed');
