const fs = require('fs');
const path = require('path');
const assert = require('assert');

const files = ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js'];
const requiredReasons = [
  'second_chain_read_not_idle', 'already_at_target', 'insufficient_or_invalid_fuel',
  'missing_prerequisite', 'transaction_construction_failure', 'pre_submission_failure',
  'submission_failure', 'confirmation_failure', 'confirmed_movement', 'unexpected_exception'
];

for (const relativePath of files) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
  assert.match(source, /@aephia-version 0\.7\.35-246/);
  assert.match(source, /schema: 'slya\.movement-decision\.v1'/);
  for (const reason of requiredReasons) assert.ok(source.includes(`'${reason}'`), `${relativePath}: missing ${reason}`);

  const wrapper = source.slice(source.indexOf('async function handleScan(i,'), source.indexOf('async function handleScanCore'));
  assert.match(wrapper, /try \{[\s\S]*return await handleScanCore/);
  assert.match(wrapper, /finally \{[\s\S]*emitMovementDecisionDiagnostic/);
  assert.match(source, /catch \(error\) \{ try \{ console\.warn/);
  assert.match(source, /scan_end_changed_without_signature/);
  assert.match(source, /sanitizeMovementDiagnosticError/);
  assert.doesNotMatch(source, /movementDiagnostic\.(?:privateKey|secret|seed|rpc|authorization)/i);

  const core = source.slice(source.indexOf('async function handleScanCore'), source.indexOf('function influxEscape'));
  assert.match(core, /await handleMovement\([^;]+diagnostic\.movement\);/);
  assert.match(core, /if \(diagnostic\.movement\.alreadyAtTarget\)/,
    `${relativePath}: already-at-target must be separated from new movement`);
  assert.match(core, /else if \(hasConfirmedMovementProof\(diagnostic\.movement\)\)/,
    `${relativePath}: movement state changes must be proof-gated`);
  assert.match(core, /const scanSucceeded = Boolean\(scanResult && scanResult\.meta && !scanResult\.meta\.err\)/,
    `${relativePath}: v243 confirmed-result behavior must remain`);

  const movement = source.slice(source.indexOf('async function handleMovement'), source.indexOf('async function saveScanEnd'));
  assert.match(movement, /chainStateBefore = fleetState/);
  assert.match(movement, /chainStateAfter = fleetState/);
  assert.match(movement, /return movementDiagnostic \|\| warpCooldownFinished/);
  assert.strictEqual((movement.match(/getParsedTokenAccountsByOwner/g) || []).length, 2,
    `${relativePath}: instrumentation must add no token-account RPC reads`);
  assert.strictEqual((core.match(/execScan\(/g) || []).length, 1, `${relativePath}: exactly one scan attempt site`);
  assert.strictEqual((core.match(/handleMovement\(/g) || []).length, 1, `${relativePath}: exactly one movement attempt site`);

  assert.doesNotMatch(source, /fleetParsedData\.(?:movementDiagnostic|diagnostic)/);
  assert.doesNotMatch(source, /saveFleetConfig\([^\n]*(?:movementDiagnostic|diagnostic)/);
  assert.match(source, /else if \(fleetParsedData\.assignment == 'Scan' && fleetState == 'Idle'\)/,
    `${relativePath}: v244 scanner scheduler branch must remain`);
}

console.log('movement decision diagnostic tests passed');

// Execute the pure diagnostic classifiers directly to cover every result category.
{
  const source = fs.readFileSync(path.join(__dirname, '..', files[0]), 'utf8');
  function extract(name, nextName) {
    const start = source.indexOf(`function ${name}`);
    const end = source.indexOf(`function ${nextName}`, start);
    assert.ok(start >= 0 && end > start, `extract ${name}`);
    return source.slice(start, end);
  }
  const code = [
    extract('sanitizeMovementDiagnosticError', 'classifyMovementDiagnosticFailure'),
    extract('classifyMovementDiagnosticFailure', 'recordMovementTransactionDiagnostic'),
    extract('recordMovementTransactionDiagnostic', 'emitMovementDecisionDiagnostic'),
    'return { sanitizeMovementDiagnosticError, classifyMovementDiagnosticFailure, recordMovementTransactionDiagnostic };'
  ].join('\n');
  const api = Function(code)();
  assert.strictEqual(api.classifyMovementDiagnosticFailure({ message: 'instruction construction failed' }), 'transaction_construction_failure');
  assert.strictEqual(api.classifyMovementDiagnosticFailure({ message: 'sendTransaction rejected' }), 'submission_failure');
  assert.strictEqual(api.classifyMovementDiagnosticFailure({ message: 'confirmation timeout' }), 'confirmation_failure');
  assert.strictEqual(api.classifyMovementDiagnosticFailure({ message: 'unknown' }, { submissionStatus: 'attempted' }), 'pre_submission_failure');
  assert.strictEqual(api.classifyMovementDiagnosticFailure({ message: 'unknown' }), 'unexpected_exception');

  const noTx = {}; api.recordMovementTransactionDiagnostic(noTx, null);
  assert.deepStrictEqual([noTx.blockedReason, noTx.submissionStatus, noTx.confirmationStatus], ['submission_failure', 'failed', 'not_confirmed']);
  const failed = {}; api.recordMovementTransactionDiagnostic(failed, { slyaTxHash: 'sig', meta: { err: { InstructionError: [0, 'x'] } } });
  assert.deepStrictEqual([failed.blockedReason, failed.txSignature, failed.confirmationStatus], ['confirmation_failure', 'sig', 'failed']);
  const success = {}; api.recordMovementTransactionDiagnostic(success, { slyaTxHash: 'sig', meta: { err: null } });
  assert.deepStrictEqual([success.txSignature, success.submissionStatus, success.confirmationStatus], ['sig', 'submitted', 'confirmed']);
  const clean = api.sanitizeMovementDiagnosticError(new Error('api-key=secret authorization:bearer private-key=abc safe text'));
  assert.ok(!/secret|bearer|abc/.test(clean.message));
}
