'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const userscriptFiles = ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js'];

for (const file of userscriptFiles) {
  test('automated panels use a bounded two-column layout with scrollable full-height content: ' + file, () => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const declaration of ['#assistStatus {', 'top: 36px;', 'left: 10px;', 'overflow:auto;', 'width:calc((100vw - 30px) * 0.30);', 'max-height:calc(100vh - 100px)']) assert.ok(source.includes(declaration), declaration);
    for (const declaration of ['#assistLpAutomation {', 'top:36px; right:10px;', 'width:calc((100vw - 30px) * 0.68);', 'max-height:calc(100vh - 80px); overflow-y:auto; overflow-x:hidden;']) assert.ok(source.includes(declaration), declaration);
    assert.ok(source.includes("document.body.append(assistStatus)"));
    assert.ok(source.includes("assistStatus.style.display = 'block'"));
    assert.ok(source.includes("assistLpAutomation.style.display = 'block'"));
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
