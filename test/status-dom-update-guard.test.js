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

function loadHelper(file, name = 'setInnerHtmlIfChanged', context = {}) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const fnText = extractFunction(source, name);
  vm.createContext(context);
  vm.runInContext(
    `${fnText}\nthis.result = ${name};`,
    context,
  );
  return context.result;
}

test('the forecast disclosure keeps its open state on refresh and swallows clicks on the forecast', () => {
  const children = [];
  const cell = {
    querySelector: () => children[0],
    appendChild: child => children.push(child),
  };
  const document = {
    createElement(tag) {
      if (tag !== 'details') return { textContent: '' };
      const details = new EventTarget();
      const content = [];
      details.appendChild = child => content.push(child);
      details.remove = () => children.pop();
      Object.defineProperties(details, {
        firstElementChild: { get: () => content[0] },
        lastElementChild: { get: () => content[1] },
      });
      return details;
    },
  };
  const update = loadHelper(USERSCRIPTS[0], 'updateAssistTravelForecast', { document });
  update(cell, { suffix: ' | 2w rt → … | 28 rt', expanded: '2w3sw10w13sw rt' });
  const [details] = children;
  const click = new Event('click', { bubbles: true, cancelable: true });
  details.dispatchEvent(click);
  assert.equal(click.cancelBubble, true);
  assert.equal(click.defaultPrevented, false);

  details.open = true;
  update(cell, { suffix: ' | 1w rt → … | 27 rt', expanded: '1w3sw10w13sw rt' });
  assert.equal(children[0], details);
  assert.equal(details.open, true);
  assert.equal(details.firstElementChild.textContent, ' | 1w rt → … | 27 rt');
  assert.equal(details.lastElementChild.textContent, '1w3sw10w13sw rt');

  update(cell, undefined);
  assert.equal(children.length, 0);
});

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

  test(`status drag: ${file} releases edge anchors without resizing the panel`, () => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const anchorAssistWindowForDrag = loadHelper(file, 'anchorAssistWindowForDrag');
    const elem = {
      offsetLeft: 884,
      offsetTop: 82,
      style: { width: '', right: '20px', bottom: '' },
      getBoundingClientRect: () => ({ width: 300 }),
    };

    const anchored = anchorAssistWindowForDrag(elem);

    assert.equal(JSON.stringify(anchored), JSON.stringify({ left: 884, top: 82, previousWidth: '' }));
    assert.equal(elem.style.right, 'auto');
    assert.equal(elem.style.bottom, 'auto');
    assert.equal(elem.style.left, '884px');
    assert.equal(elem.style.top, '82px');
    assert.equal(elem.style.width, '300px');
    assert.match(source, /resize:both; overflow-y:auto; overflow-x:hidden; min-width:320px; min-height:120px;/);
  });
}
