'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const USERSCRIPTS = [
  'SLY_Assistant.user.js',
  'electron-app/app/SLY_Assistant.user.js',
];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the userscript`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}: unbalanced braces`);
}

function loadResolver(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const expirationHelper = extractFunction(source, 'isProfileKeyActive');
  const resolver = extractFunction(source, 'resolveProfileKeyIndexes');
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${expirationHelper}\n${resolver}\nthis.resolveProfileKeyIndexes = resolveProfileKeyIndexes;`,
    context,
  );
  return { source, resolveProfileKeyIndexes: context.resolveProfileKeyIndexes };
}

function profileKey(key, scope, expireTime = -1) {
  return {
    key: { toString: () => key },
    scope: { toString: () => scope },
    expireTime: { toString: () => String(expireTime) },
  };
}

for (const file of USERSCRIPTS) {
  test(`profile-key-index-validation: ${file} resolves current signer instead of stale saved index`, () => {
    const { resolveProfileKeyIndexes } = loadResolver(file);
    const keys = Array.from({ length: 19 }, (_, index) => profileKey(`other-${index}`, 'other-scope'));
    keys[5] = profileKey('active-signer', 'points-program');
    keys[6] = profileKey('active-signer', 'sage-program');
    keys[18] = profileKey('different-signer', 'sage-program');

    const resolved = resolveProfileKeyIndexes(
      keys,
      'active-signer',
      { sage: 'sage-program', points: 'points-program' },
      1_800_000_000,
    );

    assert.equal(resolved.sage, 6);
    assert.equal(resolved.points, 5);
  });

  test(`profile-key-index-validation: ${file} rejects expired matching keys`, () => {
    const { resolveProfileKeyIndexes } = loadResolver(file);
    const keys = [
      profileKey('active-signer', 'sage-program', 1_700_000_000),
      profileKey('active-signer', 'sage-program', -1),
    ];

    const resolved = resolveProfileKeyIndexes(
      keys,
      'active-signer',
      { sage: 'sage-program' },
      1_800_000_000,
    );

    assert.equal(resolved.sage, 1);
  });

  test(`profile-key-index-validation: ${file} validates saved selections during startup`, () => {
    const { source } = loadResolver(file);
    const initUserStart = source.indexOf('function initUser()');
    const initUserEnd = source.indexOf('\n\tfunction ', initUserStart + 1);
    const initUser = source.slice(initUserStart, initUserEnd > initUserStart ? initUserEnd : source.length);

    assert.match(initUser, /getAccountInfo\(userProfileAcct\)/);
    assert.match(initUser, /resolveProfileKeyIndexes\(/);
    assert.match(initUser, /Saved profile key indexes changed/);
    assert.match(initUser, /globalSettings\.savedProfile = \[userProfileAcct\.toString\(\), userProfileKeyIdx, pointsProfileKeyIdx\]/);
  });
}
