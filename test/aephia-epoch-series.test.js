'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');
const now = new Date('2026-11-14T07:46:37.068Z');
const today = Math.floor(now.getTime() / 86400000);
const plain = value => JSON.parse(JSON.stringify(value));

function extract(name) {
  const match = new RegExp(`^\\t(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  const rest = source.slice(match.index + 1);
  const end = rest.slice(1).search(/\n\t(?:async )?function /);
  assert.notEqual(end, -1, `${name} has a following function`);
  return rest.slice(0, end + 1);
}

function constant(name) {
  const match = new RegExp(`^\\tconst ${name} = [\\s\\S]*?;\\n`, 'm').exec(source);
  assert.ok(match, `${name} exists`);
  return match[0];
}

function runtime(overrides = {}) {
  const context = vm.createContext({
    Date, AbortController, setTimeout, clearTimeout,
    globalSettings: { upgradeAutomationLpInstance: 'MUD' },
    getAephiaApiKey: () => 'test-token',
    getAephiaTokenCacheKey: token => `cache:${token}`,
    fetch: async () => { throw new Error('Unexpected network request'); },
    ...overrides
  });
  const names = [
    'normalizeUpgradeAutomationLpInstance',
    'getUpgradeAutomationAephiaFactionKeys',
    'parseUpgradeAutomationAephiaRowTimeMs',
    'parseUpgradeAutomationAephiaInteger',
    'buildUpgradeAutomationAephiaEpochSeries',
    'fetchUpgradeAutomationEpochSeries',
    'getUpgradeAutomationEpochAtlasPool',
    'resolveUpgradeAutomationOptimizer2AtlasPool',
    'fetchUpgradeAutomationAephiaSummary',
    'requestUpgradeAutomationAephiaSummary',
    'fetchUpgradeAutomationAephiaLpToday',
    'fetchUpgradeAutomationPricingHistory',
    'computeUpgradeAutomationControl',
    'utcDayProgress',
    'recordUpgradeAutomationLpRedemptionTotal'
  ];
  vm.runInContext([
    constant('UPGRADE_AUTOMATION_AEPHIA_SUMMARY_API'),
    constant('UPGRADE_AUTOMATION_FACTION_CONFIG'),
    constant('UPGRADE_AUTOMATION_ATLAS_POOL_OVERRIDES'),
    "let upgradeAutomationAephiaSummaryCache = { fetchedAt: 0, tokenKey: '', data: null };",
    'let upgradeAutomationAephiaSummaryInFlight = null;',
    ...names.map(extract)
  ].join('\n'), context);
  return context;
}

function snapshot(dayIndex, redeemedLp, hour = 7, extra = {}) {
  const timestamp = dayIndex * 86400000 + hour * 3600000;
  return { dayIndex, timestamp, dateTime: new Date(timestamp).toISOString(), redeemedLp: String(redeemedLp), ...extra };
}

function summary(faction = 'MUD', extra = {}) {
  return {
    version: 5, generatedAt: now.toISOString(),
    interval: { windowDays: 30, snapshotCount: 9, factions: {
      [faction]: Array.from({ length: 9 }, (_, index) => snapshot(today - 8 + index, (index + 1) * 1000000000, 7, extra))
    } }
  };
}

function response(data, status = 200) {
  return { status, text: async () => typeof data === 'string' ? data : JSON.stringify(data) };
}

test('v5 cumulative snapshots become sorted decimal daily totals, never summed', () => {
  const ctx = runtime();
  const data = summary();
  data.interval.factions.MUD = [
    snapshot(today, '7288436982', 7),
    snapshot(today - 1, '4000000000', 23),
    snapshot(today, '5000000000', 6),
    snapshot(today - 1, '2000000000', 12),
    snapshot(today + 1, '9999999999', 0),
    snapshot(today, '7000000000', 7) // correction at the same timestamp wins
  ];
  assert.deepEqual(plain(ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now)), [
    { dayIndex: today - 1, totalPoints: 4000000000, totalTokens: null },
    { dayIndex: today, totalPoints: 7000000000, totalTokens: null }
  ]);
  data.interval.factions.MUD.pop();
  assert.equal(ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now)[1].totalPoints, 7288436982);
});

test('completed days prefer daily finals, then interval-derived finals; today stays live', () => {
  const ctx = runtime();
  const data = summary();
  const day = offset => new Date((today + offset) * 86400000).toISOString().slice(0, 10);
  data.dailyFinalFromIntervals = { factions: { MUD: [
    { date: day(-2), redeemedLp: '4200000000' },
    { date: day(-1), redeemedLp: '8000000000' }
  ] } };
  data.dailyFinal = { factions: { MUD: [
    { date: day(-1), timestamp: now.getTime(), redeemedLp: '8100000000' },
    { date: day(0), redeemedLp: '9999999999' },
    { date: day(-3), redeemedLp: '0' }
  ] } };
  const rows = ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now);
  assert.equal(rows.find(r => r.dayIndex === today - 3).totalPoints, 0);
  assert.equal(rows.find(r => r.dayIndex === today - 2).totalPoints, 4200000000);
  assert.equal(rows.find(r => r.dayIndex === today - 1).totalPoints, 8100000000);
  assert.equal(rows.at(-1).totalPoints, 9000000000);
});

test('daily finals can supply history even when interval history is absent', () => {
  const data = { dailyFinal: { factions: { MUD: [{ date: '2026-11-13', redeemedLp: '34' }] } } };
  assert.equal(runtime().buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now)[0].totalPoints, 34);
});

test('supports decimal day indexes, ISO time, and seconds/milliseconds as numbers or strings', () => {
  const ctx = runtime();
  for (const fields of [
    { dayIndex: today }, { dayIndex: String(today) },
    { timestamp: now.getTime() }, { timestamp: String(now.getTime()) },
    { timestamp: Math.floor(now.getTime() / 1000) }, { timestamp: String(Math.floor(now.getTime() / 1000)) },
    { dateTime: now.toISOString() }
  ]) {
    const data = { interval: { factions: { MUD: [{ ...fields, redeemedLp: '100' }] } } };
    assert.equal(ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now)[0].dayIndex, today);
  }
});

test('timestamp day wins over conflicting dayIndex at UTC midnight', async () => {
  const data = summary();
  data.interval.factions.MUD = [snapshot(today - 1, 100, 23, { dayIndex: today })];
  const ctx = runtime({ fetch: async () => response(data) });
  assert.equal(ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now)[0].dayIndex, today - 1);
  await assert.rejects(ctx.fetchUpgradeAutomationAephiaLpToday('MUD', now), /aephia_summary_lp_today_missing/);
});

test('maps LP instances to MUD, ONI and all supported Ustur aliases', async () => {
  for (const [instance, key] of [[1, 'MUD'], [2, 'ONI'], [3, 'UST'], ['3', 'USTUR'], [3, 'Ustur']]) {
    const ctx = runtime({ fetch: async () => response(summary(key)) });
    const rows = await ctx.fetchUpgradeAutomationEpochSeries(instance, now);
    assert.equal(rows.length, 9);
    assert.equal(rows.at(-1).totalPoints, 9000000000);
  }
  await assert.rejects(runtime().fetchUpgradeAutomationEpochSeries(4, now), /unknown_lp_instance/);
  assert.throws(() => runtime().buildUpgradeAutomationAephiaEpochSeries(summary('ONI'), 'MUD', now), /faction_series_missing/);
});

test('rejects invalid or unsafe LP amounts rather than inventing zero totals', () => {
  const ctx = runtime();
  for (const value of [null, undefined, '', ' ', '0x10', '1e4', '-1', -1, 1.5, false, [], '9007199254740992']) {
    const data = { interval: { factions: { MUD: [{ dayIndex: today, redeemedLp: value }] } } };
    assert.throws(() => ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now), /invalid_redeemed_lp/);
  }
  for (const row of [{}, { dayIndex: 'bad' }, { dayIndex: -1 }, { dayIndex: null }]) {
    const data = { interval: { factions: { MUD: [{ ...row, redeemedLp: '1' }] } } };
    assert.throws(() => ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now), /invalid_epoch_day/);
  }
  const data = { dailyFinal: { factions: { MUD: [{ date: '2026-02-30', redeemedLp: '1' }] } } };
  assert.throws(() => ctx.buildUpgradeAutomationAephiaEpochSeries(data, 'MUD', now), /invalid_epoch_day/);
});

test('all factions use the operator-confirmed daily pools regardless of API token fields', () => {
  const ctx = runtime();
  for (const [faction, expected] of [['MUD', 1991250], ['ONI', 2000000], ['UST', 2000000]]) {
    for (const totalTokens of [null, undefined, 0, 'bad', '100000000000000']) {
      assert.equal(ctx.getUpgradeAutomationEpochAtlasPool({ dayIndex: today, totalTokens }, faction), expected);
    }
  }
});

test('the actual LP control calculation uses Aephia history and the latest current-day total', async () => {
  const ctx = runtime({ fetch: async () => response(summary()) });
  const rows = await ctx.fetchUpgradeAutomationEpochSeries(1, now);
  const control = ctx.computeUpgradeAutomationControl(rows, now);
  const last7 = [2, 3, 4, 5, 6, 7, 8];
  const weights = [1, 7 / 6, 4 / 3, 3 / 2, 5 / 3, 11 / 6, 2];
  const expected = last7.reduce((sum, value, i) => sum + value * 1000000000 * weights[i], 0) / weights.reduce((a, b) => a + b, 0);
  assert.equal(control.avg7Weighted, expected);
  assert.equal(control.todayTotal, 9000000000);
  assert.equal(await ctx.fetchUpgradeAutomationAephiaLpToday('MUD', now), control.todayTotal);
  assert.throws(() => ctx.computeUpgradeAutomationControl(rows.slice(0, -1), now), /lp_today_missing/);
  assert.throws(() => ctx.computeUpgradeAutomationControl(rows.slice(-3), now), /not_enough_history_for_avg7/);
  rows.at(-1).totalPoints = 0;
  assert.equal(ctx.computeUpgradeAutomationControl(rows, now).todayTotal, 0);
});

test('pricing and Optimizer 2 work for every faction without an API reward-pool field', async () => {
  for (const [faction, apiKey, expected] of [['MUD', 'MUD', 1991250], ['ONI', 'ONI', 2000000], ['UST', 'Ustur', 2000000], ['USTUR', 'USTUR', 2000000]]) {
    const ctx = runtime({ globalSettings: { upgradeAutomationLpInstance: faction }, fetch: async () => response(summary(apiKey)) });
    const pricing = await ctx.fetchUpgradeAutomationPricingHistory(now);
    assert.equal(pricing.error, '');
    assert.equal(pricing.rows.length, 9);
    for (const row of pricing.rows) {
      assert.equal(row.atlasPool, expected);
      assert.equal(row.lpValue, expected / row.lpRedemption);
    }
    assert.equal(ctx.resolveUpgradeAutomationOptimizer2AtlasPool(faction, pricing.latest), expected);
    assert.equal(ctx.resolveUpgradeAutomationOptimizer2AtlasPool(faction, null), expected);
  }
});

test('switching factions shares the summary download but keeps each faction LP and pool separate', async () => {
  const data = summary();
  data.interval.factions.ONI = summary('ONI').interval.factions.ONI.map(row => ({ ...row, redeemedLp: String(Number(row.redeemedLp) * 2) }));
  data.interval.factions.Ustur = summary('Ustur').interval.factions.Ustur.map(row => ({ ...row, redeemedLp: String(Number(row.redeemedLp) * 3) }));
  let calls = 0;
  const ctx = runtime({ fetch: async () => { calls++; return response(data); } });
  for (const [faction, instance, lp, pool] of [['MUD', 1, 9000000000, 1991250], ['ONI', 2, 18000000000, 2000000], ['UST', 3, 27000000000, 2000000]]) {
    ctx.globalSettings.upgradeAutomationLpInstance = faction;
    const epochs = await ctx.fetchUpgradeAutomationEpochSeries(instance, now);
    const control = ctx.computeUpgradeAutomationControl(epochs, now);
    const pricing = await ctx.fetchUpgradeAutomationPricingHistory(now);
    assert.equal(control.todayTotal, lp);
    assert.equal(await ctx.fetchUpgradeAutomationAephiaLpToday(faction, now), lp);
    assert.equal(pricing.latest.lpValue, pool / lp);
    assert.equal(ctx.resolveUpgradeAutomationOptimizer2AtlasPool(faction, pricing.latest), pool);
  }
  assert.equal(calls, 1);
});

test('redemption telemetry writes the adapted current-day amount', async () => {
  let line;
  const ctx = runtime({
    fetch: async () => response(summary()),
    influxEscape: value => value,
    getSlyaInfluxInstanceTag: () => 'test-instance',
    sendToInflux: async value => { line = value; return true; }
  });
  const result = await ctx.recordUpgradeAutomationLpRedemptionTotal('MUD', now);
  assert.equal(result.sent, true);
  assert.equal(result.totalLp, 9000000000);
  assert.match(line, /totalLp=9000000000i/);
});

test('concurrent consumers share one authenticated large response and reuse the cache', async () => {
  const data = summary();
  const profile = { profile: 'test-profile', contribution: '2074052396', redemptionCount: 1, redemptions: [{ redemption: 'test-redemption', lp: '2074052396' }] };
  data.interval.factions.MUD = Array.from({ length: 3000 }, (_, i) => snapshot(today - Math.floor((2999 - i) / 100), 7288436982, 7, { playerProfiles: Array(10).fill(profile) }));
  const body = JSON.stringify(data);
  assert.ok(body.length > 4000000);
  let calls = 0;
  const ctx = runtime({ fetch: async (url, options) => {
    calls++;
    assert.equal(url, 'https://store-sage-lp.aephia.workers.dev/summary');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return response(body);
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => ctx.fetchUpgradeAutomationEpochSeries(1, now)));
  assert.equal(calls, 1);
  assert.equal(results[0].length, 30);
  assert.equal(results[0].at(-1).totalPoints, 7288436982);
  await ctx.fetchUpgradeAutomationAephiaSummary();
  assert.equal(calls, 1);
});

test('HTTP, malformed JSON, transport and missing-key failures stay explicit and can retry', async () => {
  for (const [mock, message] of [
    [async () => response({ error: 'forbidden' }, 403), /aephia_summary_http_403/],
    [async () => response('{"version":5,'), /aephia_summary_invalid_json/],
    [async () => response('<html>error</html>'), /aephia_summary_non_json_response/],
    [async () => { throw new Error('offline'); }, /aephia_summary_network_error/]
  ]) {
    const ctx = runtime({ fetch: mock });
    await assert.rejects(ctx.fetchUpgradeAutomationAephiaSummary(), message);
    ctx.fetch = async () => response(summary());
    assert.equal((await ctx.fetchUpgradeAutomationEpochSeries(1, now)).length, 9);
  }
  await assert.rejects(runtime({ getAephiaApiKey: () => '' }).fetchUpgradeAutomationAephiaSummary(), /aephia_api_key_missing/);
});

test('native fetch timeout covers body download and clears the timer', async () => {
  let fireTimeout, cleared = false;
  const ctx = runtime({
    setTimeout: (fn, ms) => { assert.equal(ms, 60000); fireTimeout = fn; return 1; },
    clearTimeout: id => { assert.equal(id, 1); cleared = true; },
    fetch: async (_url, options) => ({ status: 200, text: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      fireTimeout();
    }) })
  });
  await assert.rejects(ctx.fetchUpgradeAutomationAephiaSummary(), /aephia_summary_timeout/);
  assert.equal(cleared, true);
});

test('GM transport uses the same token, deadline, cache and explicit timeout errors', async () => {
  let calls = 0;
  const ctx = runtime({ GM_xmlhttpRequest: options => {
    calls++;
    assert.equal(options.timeout, 60000);
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    options.onload({ status: 200, responseText: JSON.stringify(summary()) });
  } });
  await Promise.all([ctx.fetchUpgradeAutomationEpochSeries(1, now), ctx.fetchUpgradeAutomationAephiaLpToday('MUD', now)]);
  assert.equal(calls, 1);
  const timedOut = runtime({ GM_xmlhttpRequest: options => options.ontimeout() });
  await assert.rejects(timedOut.fetchUpgradeAutomationAephiaSummary(), /aephia_summary_timeout/);
});

test('token rotation neither shares another token request nor lets its old response replace the cache', async () => {
  let token = 'old', finishOld, calls = 0;
  const ctx = runtime({
    getAephiaApiKey: () => token,
    fetch: async (_url, options) => {
      calls++;
      if (options.headers.Authorization === 'Bearer old') return new Promise(resolve => { finishOld = resolve; });
      return response({ ...summary(), marker: 'new' });
    }
  });
  const old = ctx.fetchUpgradeAutomationAephiaSummary();
  token = 'new';
  assert.equal((await ctx.fetchUpgradeAutomationAephiaSummary()).marker, 'new');
  finishOld(response({ ...summary(), marker: 'old' }));
  assert.equal((await old).marker, 'old');
  assert.equal((await ctx.fetchUpgradeAutomationAephiaSummary()).marker, 'new');
  assert.equal(calls, 2);
});

test('expired summary cache refreshes instead of serving indefinite data', async () => {
  let calls = 0;
  const ctx = runtime({ fetch: async () => { calls++; return response(summary()); } });
  await ctx.fetchUpgradeAutomationAephiaSummary();
  vm.runInContext('upgradeAutomationAephiaSummaryCache.fetchedAt = Date.now() - 30001;', ctx);
  await ctx.fetchUpgradeAutomationAephiaSummary();
  assert.equal(calls, 2);
});

test('production runtime contains no Ryden endpoint or legacy category lookup', () => {
  assert.doesNotMatch(source, /api\.ryden\.systems|UPGRADE_AUTOMATION_STATS_API|UPGRADE_AUTOMATION_POINTS_CATEGORY|points_category_not_found/);
});
