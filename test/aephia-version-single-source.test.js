'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const userscriptPaths = [
  'SLY_Assistant.user.js',
  'electron-app/app/SLY_Assistant.user.js',
];

for (const relativePath of userscriptPaths) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  assert.doesNotMatch(
    source,
    /const\s+AEPHIA_SLYA_VERSION\s*=\s*['"][0-9]+\.[0-9]+\.[0-9]+-[0-9]+['"];/,
    `${relativePath} must not duplicate the deployment version in a hard-coded UI constant`,
  );
  assert.match(
    source,
    /globalThis\.GM_info\?\.script\?\.aephiaVersion/,
    `${relativePath} must read the standalone deployment metadata`,
  );
  assert.match(
    source,
    /globalThis\.GM_info\?\.scriptMetaStr/,
    `${relativePath} must read userscript-manager deployment metadata`,
  );

  const functionSource = source.match(/function readAephiaSlyaVersion\(\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(functionSource, `${relativePath} must define the metadata version reader`);

  const standaloneContext = { GM_info: { script: { aephiaVersion: '0.7.35-218' } } };
  const standaloneReader = vm.runInNewContext(`(${functionSource})`, standaloneContext);
  assert.equal(standaloneReader(), '0.7.35-218', `${relativePath} must use Electron deployment metadata`);

  const userscriptContext = { GM_info: { scriptMetaStr: '// @name SLY Assistant\n// @aephia-version 0.7.35-219\n' } };
  const userscriptReader = vm.runInNewContext(`(${functionSource})`, userscriptContext);
  assert.equal(userscriptReader(), '0.7.35-219', `${relativePath} must use userscript deployment metadata`);
}

const indexSource = fs.readFileSync(path.join(root, 'electron-app/app/index.html'), 'utf8');
assert.match(
  indexSource,
  /window\.GM_info\s*=\s*\{\s*script:\s*\{\s*version:\s*version,\s*aephiaVersion:\s*aephiaVersion\s*\}\s*\}/,
  'Electron must expose the installed @aephia-version to the userscript UI',
);

const bumpSource = fs.readFileSync(path.join(root, 'scripts/bump-aephia-version.js'), 'utf8');
assert.doesNotMatch(
  bumpSource,
  /AEPHIA_SLYA_VERSION\s*=/,
  'The release script must only update @aephia-version, the single source of truth',
);

console.log('Aephia version single-source checks passed');
