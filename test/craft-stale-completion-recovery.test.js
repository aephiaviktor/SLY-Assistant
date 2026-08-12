'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

test('crew-wait recovery may bind a completed ordinary craft even when its old recipe differs', () => {
  assert.match(source, /function isRecoverableStaleCompletedCraftingProcess\(/);
  assert.match(source, /allowStaleCompletedCraft/);
  assert.match(source, /isRecoverableStaleCompletedCraftingProcess\(craftingProcess, craftTime, isCraftingRecipe\)/);
  assert.match(source, /recoverCraftingProcessForSlot\(starbase, starbasePlayer, targetRecipe, userCraft, craftTime, upgradeTime, \{ allowStaleCompletedCraft: true \}\)/);
});

test('stale completion fallback remains craft-only and requires an actually elapsed completable process', () => {
  const functionStart = source.indexOf('function isRecoverableStaleCompletedCraftingProcess(');
  const functionEnd = source.indexOf('\n\t}', functionStart);
  assert.notEqual(functionStart, -1);
  const body = source.slice(functionStart, functionEnd + 3);
  assert.match(body, /if \(!isCraftingRecipe\) return false/);
  assert.match(body, /\[2, 3\]\.includes\(status\)/);
  assert.match(body, /Number\(endTime\) < Number\(craftTime\?\.starbaseTime/);
});
