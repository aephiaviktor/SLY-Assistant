'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

for (const file of ['SLY_Assistant.user.js', 'electron-app/app/SLY_Assistant.user.js']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const start = source.indexOf('    let customReadRPCs = []');
  const end = source.indexOf('    let customKeypair = null;');
  assert.ok(start >= 0 && end > start, 'RPC initialization must be present');

  test(`${file}: initial and rebuilt RPC pools use Star Atlas and retain the configured fallback`, () => {
    const context = vm.createContext({ globalSettings: {} });
    vm.runInContext(source.slice(start, end), context);
    const initialUrl = vm.runInContext('saRPCs[0]', context);
    const parsed = new URL(initialUrl);
    assert.equal(parsed.origin, 'https://mainnet-rpc.staratlas.com');
    assert.equal(parsed.pathname, '/mainnet');
    assert.ok(parsed.searchParams.get('apiKey'));
    for (const pool of ['readRPCs', 'writeRPCs']) {
      assert.deepEqual(Array.from(vm.runInContext(pool, context)), [initialUrl]);
    }

    context.globalSettings.heliusRpcURL = 'https://mainnet.helius-rpc.com/?api-key=test-fallback';
    vm.runInContext('rebuildRpcPools()', context);
    for (const pool of ['saRPCs', 'readRPCs', 'writeRPCs']) {
      assert.deepEqual(Array.from(vm.runInContext(pool, context)), [initialUrl, context.globalSettings.heliusRpcURL]);
    }

    context.globalSettings.heliusRpcURL = vm.runInContext('DEFAULT_HELIUS_RPC_URL_PLACEHOLDER', context);
    vm.runInContext('rebuildRpcPools()', context);
    assert.deepEqual(Array.from(vm.runInContext('readRPCs', context)), [initialUrl]);
    assert.deepEqual(Array.from(vm.runInContext('writeRPCs', context)), [initialUrl]);
  });
}

test('standalone applies the Star Atlas Origin header to both RPC hosts', () => {
  const source = fs.readFileSync(path.join(root, 'electron-app/main.js'), 'utf8');
  const start = source.indexOf('const filter = {');
  const end = source.indexOf('\nvar win', start);
  assert.ok(start >= 0 && end > start, 'RPC request hook must be present');
  let registration;
  const counters = [];
  vm.runInNewContext(source.slice(start, end), {
    session: { defaultSession: { webRequest: {
      onBeforeSendHeaders(filter, handler) { registration = { filter, handler }; },
    } } },
    mainProcessDiagnostics: { increment(name) { counters.push(name); } },
  });
  assert.deepEqual(Array.from(registration.filter.urls), [
    'https://rpc.ironforge.network/*',
    'https://mainnet-rpc.staratlas.com/*',
  ]);
  for (const url of registration.filter.urls) {
    const details = { url: url.replace('*', 'mainnet?apiKey=test-key'), requestHeaders: { 'Content-Type': 'application/json' } };
    let response;
    registration.handler(details, result => { response = result; });
    assert.equal(response.requestHeaders.Origin, 'https://based.staratlas.com');
    assert.equal(response.requestHeaders['Content-Type'], 'application/json');
  }
  assert.equal(counters.length, 2);
});
