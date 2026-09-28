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

function loadHelper(file, name = 'setInnerHtmlIfChanged') {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fnText = extractFunction(source, name);
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${fnText}\nthis.result = ${name};`,
    context,
  );
  return context.result;
}

function makeFakeElement(initialHtml) {
  const state = { html: String(initialHtml) };
  const calls = { setter: 0, getter: 0 };
  return {
    state,
    calls,
    get innerHTML() {
      calls.getter += 1;
      return state.html;
    },
    set innerHTML(value) {
      calls.setter += 1;
      state.html = String(value);
    },
  };
}

for (const file of USERSCRIPTS) {
  test(`status-dom-update-guard: ${file} skips redundant innerHTML writes`, () => {
    const setInnerHtmlIfChanged = loadHelper(file);

    // 1. Identical string: zero setter calls, returns false
    {
      const el = makeFakeElement('Active');
      const result = setInnerHtmlIfChanged(el, 'Active');
      assert.strictEqual(result, false, 'identical string must return false');
      assert.strictEqual(el.calls.setter, 0, 'identical string must not invoke the setter');
      assert.strictEqual(el.state.html, 'Active', 'innerHTML must be unchanged');
    }

    // 2. Changed value: exactly one setter call, returns true
    {
      const el = makeFakeElement('Active');
      const result = setInnerHtmlIfChanged(el, 'Stopping ...');
      assert.strictEqual(result, true, 'changed value must return true');
      assert.strictEqual(el.calls.setter, 1, 'changed value must invoke the setter exactly once');
      assert.strictEqual(el.state.html, 'Stopping ...', 'innerHTML must be updated');
    }

    // 3. Numeric 12 vs string "12": no setter call, returns false
    {
      const el = makeFakeElement('12');
      const result = setInnerHtmlIfChanged(el, 12);
      assert.strictEqual(result, false, 'numeric 12 vs existing "12" must return false');
      assert.strictEqual(el.calls.setter, 0, 'numeric 12 vs existing "12" must not invoke the setter');
      assert.strictEqual(el.state.html, '12', 'innerHTML must remain "12"');
    }
  });

  test(`status sections: ${file} render fleet and crafting columns independently`, () => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const getAssistStatusRowModel = loadHelper(file, 'getAssistStatusRowModel');
    const targets = [{ x: 1, y: 2, name: 'MRZ-5' }];

    assert.equal(
      JSON.stringify(getAssistStatusRowModel({ publicKey: 'fleet-pk', label: 'Finch Fleet', state: 'Mine [07:19]', foodCnt: 99, sduCnt: 42 }, targets)),
      JSON.stringify({ section: 'fleet', cells: ['Finch Fleet', 'Mine [07:19]'] }),
    );
    assert.equal(
      JSON.stringify(getAssistStatusRowModel({ label: 'craft3', coordinates: '1,2', crew: 7, state: '⚒ Polymer [06:50]' }, targets)),
      JSON.stringify({ section: 'craft', cells: ['craft3', 'MRZ-5', '7', '⚒ Polymer [06:50]'] }),
    );

    assert.match(source, /assist-status-section-header/);
    assert.match(source, /Slot<\/td><td>Starbase<\/td><td>Crew<\/td><td>Crafting Job \(time\)<\/td>/);
    assert.doesNotMatch(source, /<td>Fleet<\/td><td>Food<\/td><td>SDUs<\/td>/);
    assert.match(source, /rgba\(255, 190, 77, 0\.14\)/);
    assert.match(source, /cachedStatus\?\.foodCnt/);
    assert.match(source, /cachedStatus\?\.sduCnt/);
  });
}
