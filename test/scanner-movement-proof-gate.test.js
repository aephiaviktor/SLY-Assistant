const fs = require('fs');
const path = require('path');
const assert = require('assert');

const files = ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js'];

function replayScannerOutcome(result, initialScanEnd = 123456) {
  const state = { moved: false, scanEnd: initialScanEnd, persisted: false, scanAllowed: false, retryable: false };
  const confirmedTx = result.confirmationStatus === 'confirmed' && Boolean(result.txSignature);
  const confirmedChain = result.chainStateAfter === 'Idle' && result.targetReached === true;
  const proven = !result.alreadyAtTarget && result.completed === true && (confirmedTx || confirmedChain);
  if (result.alreadyAtTarget) state.scanAllowed = true;
  else if (proven) {
    state.moved = true;
    state.scanEnd = initialScanEnd + 1;
    state.persisted = true;
  } else {
    state.retryable = true;
  }
  return state;
}

for (const relativePath of files) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  const movement = source.slice(source.indexOf('async function handleMovement'), source.indexOf('async function saveScanEnd'));
  const subwarp = movement.slice(movement.indexOf('} else if (currentFuelCnt + currentCargoFuelCnt >= subwarpCost)'), movement.indexOf("blockedReason = 'insufficient_or_invalid_fuel'"));
  const init = subwarp.indexOf("const fleetParsedData = JSON.parse(fleetSavedData);");
  const reserve = subwarp.indexOf('reserveFleetTelemetryMovementEvent(userFleets[i], fleetParsedData)');
  assert.ok(init >= 0 && init < reserve, `${relativePath}: fleetParsedData must be initialized before telemetry reservation`);
  assert.strictEqual((subwarp.match(/const fleetParsedData =/g) || []).length, 1, `${relativePath}: subwarp path must have one authoritative initialization`);

  const core = source.slice(source.indexOf('async function handleScanCore'), source.indexOf('function influxEscape'));
  const movementCall = core.indexOf('await handleMovement(');
  const movedTrue = core.indexOf('moved = true;', movementCall);
  const scanEndMutation = core.indexOf('userFleets[i].scanEnd =', movementCall);
  const persistence = core.indexOf('await saveScanEnd(i);', movementCall);
  const proofGate = core.indexOf('else if (hasConfirmedMovementProof(diagnostic.movement))', movementCall);
  assert.ok(movementCall >= 0 && proofGate > movementCall, `${relativePath}: movement must execute before proof evaluation`);
  assert.ok(movedTrue > proofGate && scanEndMutation > proofGate && persistence > proofGate,
    `${relativePath}: moved, scanEnd, and persistence must occur only inside the proof branch`);
  assert.match(core, /catch \(error\) \{[\s\S]*classifyMovementDiagnosticFailure[\s\S]*return;/,
    `${relativePath}: movement exceptions must stay inside the scanner loop`);
  assert.match(core, /if \(diagnostic\.movement\.alreadyAtTarget\) \{[\s\S]*fleetCoords = destCoords\.slice\(0, 2\);/,
    `${relativePath}: authoritative at-target state must continue with target coordinates`);
  assert.match(core, /else \{\s*return;\s*\}/,
    `${relativePath}: unproven movement must leave without scanning at stale coordinates`);

  assert.strictEqual((movement.match(/getParsedTokenAccountsByOwner/g) || []).length, 2,
    `${relativePath}: no movement RPC reads were added`);
  assert.strictEqual((core.match(/handleMovement\(/g) || []).length, 1,
    `${relativePath}: no movement attempts were added`);
  assert.strictEqual((core.match(/execScan\(/g) || []).length, 1,
    `${relativePath}: no scan attempts were added`);
  assert.match(core, /const scanSucceeded = Boolean\(scanResult && scanResult\.meta && !scanResult\.meta\.err\)/,
    `${relativePath}: v243 confirmed scan guard must remain`);
  assert.match(source, /else if \(fleetParsedData\.assignment == 'Scan' && fleetState == 'Idle'\)/,
    `${relativePath}: v244 runtime scanner branch must remain`);
}

const capturedFailures = [
  ['SF01-OPOD', 'Ff2Tznex', 'unexpected_exception'],
  ['SF02-RANGER', '2zkTvsQv', 'unexpected_exception'],
  ['SF03-RAYFARM', 'e14Xwi2c', 'unexpected_exception'],
  ['SF04-CHI', 'UyysHvQp', 'unexpected_exception'],
  ['SF08-RANGER', 'EmqgC7M3', 'unexpected_exception']
];
for (const [fleet, account, blockedReason] of capturedFailures) {
  const result = replayScannerOutcome({ started: true, completed: false, alreadyAtTarget: false, blockedReason,
    txSignature: '', chainStateBefore: 'Idle', chainStateAfter: '', targetReached: false,
    submissionStatus: 'not_attempted', confirmationStatus: 'not_attempted' });
  assert.deepStrictEqual(result, { moved: false, scanEnd: 123456, persisted: false, scanAllowed: false, retryable: true }, `${fleet}/${account}`);
}

for (const blockedReason of ['second_chain_read_not_idle', 'insufficient_or_invalid_fuel', 'missing_prerequisite',
  'transaction_construction_failure', 'pre_submission_failure', 'submission_failure', 'confirmation_failure', 'unexpected_exception']) {
  const result = replayScannerOutcome({ completed: false, alreadyAtTarget: false, blockedReason, txSignature: '', chainStateAfter: '', targetReached: false, confirmationStatus: 'not_confirmed' });
  assert.strictEqual(result.moved, false, blockedReason);
  assert.strictEqual(result.persisted, false, blockedReason);
  assert.strictEqual(result.scanAllowed, false, blockedReason);
  assert.strictEqual(result.retryable, true, blockedReason);
}

const unconfirmedSignature = replayScannerOutcome({ completed: false, alreadyAtTarget: false, txSignature: 'sig-only', confirmationStatus: 'not_confirmed', chainStateAfter: '', targetReached: false });
assert.strictEqual(unconfirmedSignature.moved, false, 'an unconfirmed signature is not proof');

const confirmed = replayScannerOutcome({ completed: true, alreadyAtTarget: false, txSignature: 'confirmed-sig', confirmationStatus: 'confirmed', chainStateAfter: 'Idle', targetReached: true });
assert.deepStrictEqual(confirmed, { moved: true, scanEnd: 123457, persisted: true, scanAllowed: false, retryable: false });

const baleen = replayScannerOutcome({ completed: false, alreadyAtTarget: true, txSignature: '', confirmationStatus: 'not_attempted', chainStateAfter: 'Idle', targetReached: true });
assert.deepStrictEqual(baleen, { moved: false, scanEnd: 123456, persisted: false, scanAllowed: true, retryable: false });

const configuredScanners = 13;
const rentalEnded = new Set(['MUD:Dogs Fleet', 'MUD:Yellow Cup Black Coral Fleet', 'ONI:VZUS opod-1']);
const configuredNames = ['MUD:Jackal Fleet', ...rentalEnded, 'ONI:Duck Fleet',
  'USTUR2:Baleen Whale Fleet', 'USTUR2:EMPIRIA-F4-1', 'USTUR2:SF01-OPOD', 'USTUR2:SF02-RANGER',
  'USTUR2:SF03-RAYFARM', 'USTUR2:SF04-CHI', 'USTUR2:SF05-CHI', 'USTUR2:SF08-RANGER'];
assert.strictEqual(configuredNames.length, configuredScanners);
assert.strictEqual(configuredNames.filter(name => !rentalEnded.has(name)).length, 10);
for (const name of rentalEnded) assert.strictEqual(rentalEnded.has(name), true, `${name}: not currently managed — rental ended`);

console.log('scanner movement proof-gate tests passed');
