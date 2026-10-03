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
    for (const declaration of ['#assistStatus {', 'left: 10px;', 'overflow:auto;', 'width:calc((100vw - 30px) * 0.30);', 'max-height:calc(100vh - 100px)']) assert.ok(source.includes(declaration), declaration);
    for (const declaration of ['#assistLpAutomation {', 'top: 70px; right: 10px;', 'width:calc((100vw - 30px) * 0.68);', 'max-height:calc(100vh - 80px); overflow:auto;']) assert.ok(source.includes(declaration), declaration);
  });
}

test('Electron applies three zoom levels only on update relaunch', () => {
  const source = fs.readFileSync(path.join(ROOT, 'electron-app/main.js'), 'utf8');
  assert.match(source, /--slya-update-zoom/);
  assert.match(source, /currentZoomLevel \+ 3/);
  assert.match(source, /setZoomLevel\(currentZoomLevel \+ 3/);
});
