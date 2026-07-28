'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

function loadResolver(file) {
  const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext([
    "function normalizeUpgradeAutomationLpInstance(value) { return String(value).toUpperCase() === 'USTUR' ? 'UST' : String(value).toUpperCase(); }",
    extractFunction(source, 'getUpgradeAutomationAephiaFactionKeys'),
    extractFunction(source, 'getUpgradeAutomationAephiaDailyFinal'),
    'this.resolveDailyFinal = getUpgradeAutomationAephiaDailyFinal;'
  ].join('\n'), context);
  return context.resolveDailyFinal;
}

const summary = {
  dailyFinal: {
    factions: {
      MUD: [{ date: '2026-07-27', redeemedLp: '34698229663', playerProfiles: [
        { profile: 'mud-player', contribution: '628942497' }
      ] }],
      Ustur: [{ date: '2026-07-27', redeemedLp: '24263677898', playerProfiles: [
        { profile: 'ust-player', contribution: '2196254496' }
      ] }]
    }
  },
  dailyFinalFromIntervals: {
    factions: {
      ONI: [{ date: '2026-07-27', redeemedLp: '29395495492', playerProfiles: [
        { profile: 'oni-player', contribution: '2972396352' }
      ] }]
    }
  }
};

for (const file of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  test(`${file} resolves faction and player yesterday LP from Aephia daily finals`, () => {
    const resolve = loadResolver(file);
    assert.deepEqual({ ...resolve(summary, 'MUD', '2026-07-27', 'mud-player') }, {
      factionLp: 34698229663,
      playerLp: 628942497,
      source: 'dailyFinal',
      matchedFactionKey: 'MUD'
    });
    assert.deepEqual({ ...resolve(summary, 'UST', '2026-07-27', 'ust-player') }, {
      factionLp: 24263677898,
      playerLp: 2196254496,
      source: 'dailyFinal',
      matchedFactionKey: 'Ustur'
    });
  });

  test(`${file} falls back to interval-derived daily finals and returns zero for an absent player`, () => {
    const resolve = loadResolver(file);
    assert.deepEqual({ ...resolve(summary, 'ONI', '2026-07-27', 'other-player') }, {
      factionLp: 29395495492,
      playerLp: 0,
      source: 'dailyFinalFromIntervals',
      matchedFactionKey: 'ONI'
    });
  });
}
