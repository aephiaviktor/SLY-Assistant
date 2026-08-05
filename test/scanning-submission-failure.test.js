const fs = require('fs');
const path = require('path');
const assert = require('assert');

for (const relativePath of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

  assert.match(
    source,
    /const SCAN_SUBMISSION_RETRY_DELAY_MS = 10000;/,
    `${relativePath}: scan submission retries should use a bounded delay`
  );
  assert.match(
    source,
    /if\(Number\(userFleets\[i\]\.scanSubmissionRetryAt \|\| 0\) > Date\.now\(\)\) return;/,
    `${relativePath}: handleScan should honor the retry delay before another submission`
  );
  assert.match(
    source,
    /const scanSucceeded = Boolean\(scanResult && scanResult\.meta && !scanResult\.meta\.err\);/,
    `${relativePath}: only a confirmed transaction without a meta error is a successful scan`
  );
  assert.match(
    source,
    /if\(!scanSucceeded\) \{[\s\S]*?scanSubmissionRetryAt = Date\.now\(\) \+ SCAN_SUBMISSION_RETRY_DELAY_MS;[\s\S]*?Scan submission failed; retrying[\s\S]*?return;[\s\S]*?\}/,
    `${relativePath}: a missing or failed transaction should schedule a retry and leave before scan accounting`
  );

  const failureGuard = source.indexOf('if(!scanSucceeded) {', source.indexOf('async function handleScan'));
  const persistedCooldown = source.indexOf('await saveScanEnd(i);', failureGuard);
  assert.ok(failureGuard >= 0 && persistedCooldown > failureGuard, `${relativePath}: expected failure guard before persisted cooldown`);
}

console.log('scanning submission failure tests passed');
