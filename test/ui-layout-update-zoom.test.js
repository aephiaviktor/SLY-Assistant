'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const userscriptFiles = ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js'];

for (const file of userscriptFiles) {
  test('automated panels stay visible and fit their contents: ' + file, () => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const autoStart = source.match(/if\(globalSettings\.autoStartScript\) \{([^}]+)\}/)?.[1] || '';
    assert.match(autoStart, /toggleAssistant\(/, 'auto-start branch must be present');
    assert.doesNotMatch(autoStart, /assistStatusToggle\(/, 'auto-start must not close Status');
    assert.match(source, /assistStatus\.style\.display = 'block'/);
    assert.ok(source.includes('resize:both; overflow-y:auto; overflow-x:hidden; min-width:320px;'));
    assert.ok(source.includes('width:max(320px, calc((100vw - 24px) * 0.28))'));
    assert.ok(source.includes('width:calc(100vw - 24px - max(320px, calc((100vw - 24px) * 0.28)))'));
    assert.match(source, /#assistStatus \.assist-modal-body table\.main \{[^}]*table-layout:fixed;/);
    assert.ok(source.includes('width:calc(84% / 9); min-width:0; overflow-wrap:anywhere;'));
    assert.ok(source.includes('#assistLpAutomation .lp-auto-summary-table { table-layout: fixed; width: 100%; }'));
    assert.ok(source.includes('#assistLpAutomation .lp-auto-summary-table td, #assistLpAutomation .lp-auto-summary-table th { white-space:normal !important; overflow-wrap:anywhere; }'));
    assert.ok(!source.includes('min-width: 165px; padding-left: 18px;'));
    assert.match(source, /#assistLpAutomation \.lp-auto-optimizer-2 \.lp-auto-summary-table \{[^}]*table-layout:fixed;/);
    assert.ok(!source.includes('width: 12%; overflow: visible; text-overflow: clip;'));
  });
}

test('Electron applies two standard manual zoom-in steps on update relaunch only', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron-app/main.js'), 'utf8');
  const functionSource = source.match(/function applyUpdateRelaunchZoom\(win\)\s*\{[\s\S]*?\n\}\n\nconst loadApp/)?.[0];
  assert.ok(functionSource, 'update relaunch zoom hook must exist');
  assert.match(source, /--slya-update-zoom/);
  assert.match(source, /update-zoom-pending/);
  assert.match(source, /win\.maximize\(\)/);

  for (const updatePending of [true, false]) {
    let onLoad;
    const appliedZoom = [];
    const win = { webContents: {
      once: (event, callback) => { assert.equal(event, 'did-finish-load'); onLoad = callback; },
      setZoomFactor: factor => appliedZoom.push(factor),
    } };
    const context = {
      UPDATE_RELAUNCH_ZOOM_PENDING: updatePending,
      setTimeout: callback => callback(),
    };
    vm.runInNewContext(functionSource.replace(/\n\nconst loadApp$/, ''), context);
    context.applyUpdateRelaunchZoom(win);
    if (updatePending) {
      assert.equal(typeof onLoad, 'function');
      onLoad();
      assert.deepEqual(appliedZoom, [1.25], 'two manual zoom-in steps from 100% reach 125%');
    } else {
      assert.equal(onLoad, undefined, 'ordinary loads must not install the zoom hook');
      assert.deepEqual(appliedZoom, []);
    }
  }
});
