'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const userscriptFiles = ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js'];

for (const file of userscriptFiles) {
  test('automated panels stay visible and fit their contents: ' + file, () => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const autoStart = source.match(/if\(globalSettings\.autoStartScript\) \{([^}]+)\}/)?.[1] || '';
    assert.match(autoStart, /toggleAssistant\(/, 'auto-start branch must be present');
    assert.doesNotMatch(autoStart, /assistStatusToggle\(/, 'auto-start must not close Status');
    assert.match(source, /assistStatus\.style\.display = 'block'/);
    assert.ok(source.includes('resize:both; overflow-y:auto; overflow-x:hidden; min-width:280px;'));
    assert.match(source, /#assistStatus \.assist-modal-body table\.main \{[^}]*table-layout:fixed;/);
    assert.ok(source.includes('width:calc(84% / 9); min-width:0; overflow-wrap:anywhere;'));
    assert.ok(source.includes('#assistLpAutomation .lp-auto-summary-table { table-layout: fixed; width: 100%; }'));
    assert.ok(source.includes('#assistLpAutomation .lp-auto-summary-table td, #assistLpAutomation .lp-auto-summary-table th { white-space:normal !important; overflow-wrap:anywhere; }'));
    assert.ok(!source.includes('min-width: 165px; padding-left: 18px;'));
    assert.match(source, /#assistLpAutomation \.lp-auto-optimizer-2 \.lp-auto-summary-table \{[^}]*table-layout:fixed;/);
    assert.ok(!source.includes('width: 12%; overflow: visible; text-overflow: clip;'));
  });
}

test('Electron applies three zoom levels only on update relaunch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron-app/main.js'), 'utf8');
  assert.match(source, /--slya-update-zoom/);
  assert.match(source, /setZoomFactor/);
  assert.match(source, /Math\.pow\(1\.1, 3\)/);
  assert.match(source, /update-zoom-pending/);
  assert.match(source, /win\.maximize\(\)/);
});
