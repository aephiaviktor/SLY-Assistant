#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');
const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const ROOT = resolve(__dirname, '..');
const FILES = [
  'SLY_Assistant.user.js',
  'electron-app/app/SLY_Assistant.user.js',
];

function usage() {
  console.log(`Usage: node scripts/bump-aephia-version.js [options]\n\nOptions:\n  --dry-run          Print the next version without writing files\n  --set <version>    Set exact Aephia version, e.g. 0.7.35-100\n  --commit           Create a git commit after updating files\n  --tag              Create/update an annotated git tag after updating files\n  --help             Show this help\n\nDefault behavior:\n  - Reads official SLYA base from // @version\n  - Reads current Aephia version from // @aephia-version\n  - Same base: increments suffix, e.g. 0.7.35-99 -> 0.7.35-100\n  - New upstream base: resets suffix, e.g. 0.7.36 + 0.7.35-100 -> 0.7.36-00\n  - Missing Aephia version: initializes to <base>-01`);
}

function parseArgs(argv) {
  const args = { dryRun: false, set: '', commit: false, tag: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--commit') args.commit = true;
    else if (arg === '--tag') args.tag = true;
    else if (arg === '--set') args.set = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function parseOfficialVersion(text, file) {
  const match = text.match(/^\/\/\s*@version\s+([0-9]+\.[0-9]+\.[0-9]+)\s*$/m);
  if (!match) throw new Error(`${file}: missing userscript // @version x.y.z`);
  return match[1];
}

function parseAephiaVersion(text) {
  const match = text.match(/^\/\/\s*@aephia-version\s+([0-9]+\.[0-9]+\.[0-9]+-[0-9]+)\s*$/m);
  return match ? match[1] : '';
}

function assertValidAephiaVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-[0-9]+$/.test(version)) {
    throw new Error(`Invalid Aephia version: ${version}. Expected x.y.z-N, e.g. 0.7.35-100`);
  }
}

function nextAephiaVersion(base, current) {
  if (!current) return `${base}-01`;
  const match = current.match(/^([0-9]+\.[0-9]+\.[0-9]+)-([0-9]+)$/);
  if (!match) throw new Error(`Invalid current Aephia version: ${current}`);
  if (match[1] !== base) return `${base}-00`;
  const next = Number(match[2]) + 1;
  return `${base}-${String(next).padStart(2, '0')}`;
}

function updateFile(text, file, version) {
  let next = text;
  if (/^\/\/\s*@aephia-version\s+/m.test(next)) {
    next = next.replace(/^\/\/\s*@aephia-version\s+.*$/m, `// @aephia-version ${version}`);
  } else {
    next = next.replace(/^(\/\/\s*@version\s+.*)$/m, `$1\n// @aephia-version ${version}`);
  }

  if (/const\s+AEPHIA_SLYA_VERSION\s*=\s*['"][^'"]+['"];/.test(next)) {
    next = next.replace(/const\s+AEPHIA_SLYA_VERSION\s*=\s*['"][^'"]+['"];\s*\/\/[^\n]*/,
      `const AEPHIA_SLYA_VERSION = '${version}'; // Aephia build version; bump with scripts/bump-aephia-version.js`);
    next = next.replace(/const\s+AEPHIA_SLYA_VERSION\s*=\s*['"][^'"]+['"];(?!\s*\/\/)/,
      `const AEPHIA_SLYA_VERSION = '${version}';`);
  } else {
    next = next.replace(/(const\s+AEPHIA_TOKEN_VALIDATE_URL\s*=\s*'[^']+';)/,
      `$1\n    const AEPHIA_SLYA_VERSION = '${version}'; // Aephia build version; bump with scripts/bump-aephia-version.js`);
  }

  if (next === text) throw new Error(`${file}: no changes applied`);
  return next;
}

function git(args) {
  execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const primaryPath = resolve(ROOT, FILES[0]);
  const primaryText = readFileSync(primaryPath, 'utf8');
  const base = parseOfficialVersion(primaryText, FILES[0]);
  const current = parseAephiaVersion(primaryText);
  const version = args.set || nextAephiaVersion(base, current);
  assertValidAephiaVersion(version);

  const [versionBase] = version.split('-');
  if (versionBase !== base) {
    throw new Error(`Aephia version base ${versionBase} does not match official // @version ${base}`);
  }

  console.log(`Official SLYA version: ${base}`);
  console.log(`Current Aephia version: ${current || '(none)'}`);
  console.log(`Next Aephia version: ${version}`);

  for (const file of FILES) {
    const path = resolve(ROOT, file);
    const text = readFileSync(path, 'utf8');
    const fileBase = parseOfficialVersion(text, file);
    if (fileBase !== base) throw new Error(`${file}: official version ${fileBase} differs from ${base}`);
    if (args.dryRun) continue;
    writeFileSync(path, updateFile(text, file, version));
    console.log(`Updated ${file}`);
  }

  if (!args.dryRun && args.commit) {
    git(['add', ...FILES]);
    git(['commit', '-m', `Release Aephia SLYA ${version}`]);
  }

  if (!args.dryRun && args.tag) {
    git(['tag', '-a', `aephia-slya-v${version}`, '-m', `Aephia SLYA ${version}`]);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
