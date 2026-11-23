'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { anchor } = require('../anchor-browserified');

const { PublicKey } = anchor.web3;
const owner = new PublicKey(Buffer.alloc(32, 1));
const profile = new PublicKey(Buffer.alloc(32, 2));
const delegate = new PublicKey(Buffer.alloc(32, 3));
const otherDelegate = new PublicKey(Buffer.alloc(32, 4));
const profileProgram = new PublicKey('pprofELXjL5Kck7Jn5hCpwAL82DpTkSYBENzahVtbc9');
const sage = new PublicKey('SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE');
const points = new PublicKey('Point2iBvz7j5TMVef8nEgpmz4pDr7tU7v3RjAfkQbM');
const pointsStore = new PublicKey('PsToRxhEPScGt1Bxpm7zNDRzaMk31t8Aox7fyewoVse');
const source = fs.readFileSync(path.join(__dirname, '..', 'Freelance_System_Core',
  'SLY_Freelance_System_Core.user.js'), 'utf8');

function profileData(entries) {
  const header = Buffer.alloc(30);
  header.writeUInt16LE(entries.length, 28);
  const keys = entries.map(([key, scope]) => Buffer.concat([
    key.toBuffer(), scope.toBuffer(), Buffer.alloc(8, 255), Buffer.alloc(8),
  ]));
  return Buffer.concat([header, ...keys]);
}

function loadGrantFlow(entries, settings = new Map()) {
  const transactions = [];
  const endpoints = [];
  const fields = {
    '#walletModal': { style: { display: 'none' } },
    '#walletModal .assist-modal-error': {},
    '#walletSelection': { value: 'phantom' },
    '#starAtlasRpcKey': {},
    '#selectWalletBtn': {},
  };
  const context = {
    URL,
    GM_getValue: (key, fallback) => settings.get(key) ?? fallback,
    GM_setValue: (key, value) => settings.set(key, value),
    solana: {},
    BrowserAnchor: { anchor },
    solanaWeb3: {
      ...anchor.web3,
      Connection: class {
        constructor(endpoint) {
          endpoints.push(new URL(endpoint));
        }
        async getAccountInfo(address) {
          assert.ok(address.equals(profile));
          return { owner: profileProgram, data: profileData(entries) };
        }
      },
    },
    MutationObserver: class {},
    document: { querySelector: selector => fields[selector] ?? { value: '' } },
    actualOwner: owner,
    actualProfile: profile,
    transactions,
  };
  const startup = '    observer.observe(document, {childList: true, subtree: true});\n    waitForLabs(null, null);';
  assert.ok(source.includes(startup));
  vm.runInNewContext(source.replace(startup, `
    userPublicKey = actualOwner;
    userProfilePublicKey = actualProfile;
    getPermissionedAccounts = async () => {};
    manageProfileToggle = () => {};
    txSignAndSend = async instructions => {
      transactions.push(Array.from(instructions, ({ instruction }) => instruction));
      return { meta: { err: null } };
    };
    globalThis.grant = key => {
      if (!solanaConnection) configureRpc('test-key');
      return addKeyToProfile(key);
    };
    globalThis.selectWallet = selectWalletToggle;
  `), context);
  return { grant: context.grant, transactions, endpoints, fields, selectWallet: context.selectWallet };
}

test('FLY restores only SAGE access when the signer already has both Points scopes', async () => {
  const entries = [[owner, profileProgram], [delegate, points], [delegate, pointsStore], [otherDelegate, sage]];
  const { grant, transactions } = loadGrantFlow(entries);
  await grant(delegate.toBase58());

  assert.equal(transactions.length, 1);
  const [instruction] = transactions[0];
  assert.equal(transactions[0].length, 1);
  assert.ok(instruction.programId.equals(profileProgram));
  assert.ok(instruction.keys[0].pubkey.equals(owner));
  assert.ok(instruction.keys[2].pubkey.equals(profile));
  assert.ok(instruction.keys[4].pubkey.equals(delegate));
  assert.ok(instruction.data.subarray(16, 48).equals(sage.toBuffer()));
  assert.equal(Buffer.from(instruction.data).readBigInt64LE(48), -1n);
  assert.equal(instruction.data.subarray(56, 64).toString('hex'), '00fcbf0900000000');

  entries.push([delegate, sage]);
  assert.equal((await grant(delegate.toBase58())).name, 'AccountExists');
  assert.equal(transactions.length, 1);
});

test('FLY grants the three standard scopes to a new delegate', async () => {
  const { grant, transactions } = loadGrantFlow([[owner, profileProgram]]);
  await grant(delegate.toBase58());
  assert.deepEqual(Array.from(transactions[0], instruction => instruction.data.subarray(16, 48).toString('hex')),
    [sage, points, pointsStore].map(scope => scope.toBuffer().toString('hex')));
});

test('FLY rejects a profile authority and malformed keys before submitting a transaction', async () => {
  const { grant, transactions } = loadGrantFlow([[owner, profileProgram]]);
  assert.equal((await grant(owner.toBase58())).name, 'ProfileAuthority');
  assert.equal((await grant('invalid-key')).name, 'InvalidAccount');
  assert.equal(transactions.length, 0);
});

test('FLY requires a Star Atlas RPC key and reuses it from local storage', async () => {
  const settings = new Map();
  const { endpoints, fields, selectWallet } = loadGrantFlow([], settings);
  assert.equal(endpoints.length, 0);
  const pendingSelection = selectWallet();
  await fields['#selectWalletBtn'].onclick();
  assert.equal(endpoints.length, 0);
  assert.match(fields['#walletModal .assist-modal-error'].textContent, /Enter your Star Atlas RPC API key/);
  assert.equal(fields['#walletModal'].style.display, 'block');

  fields['#starAtlasRpcKey'].value = ' test+key&value ';
  await fields['#selectWalletBtn'].onclick();
  assert.equal(await pendingSelection, 'phantom');
  assert.equal(fields['#starAtlasRpcKey'].value, '');
  assert.equal(settings.get('starAtlasRpcApiKey'), 'test+key&value');
  assert.equal(endpoints[0].origin + endpoints[0].pathname, 'https://mainnet-rpc.staratlas.com/mainnet');
  assert.equal(endpoints[0].searchParams.get('apiKey'), 'test+key&value');

  const restarted = loadGrantFlow([], settings);
  const restartedSelection = restarted.selectWallet();
  await restarted.fields['#selectWalletBtn'].onclick();
  assert.equal(await restartedSelection, 'phantom');
  assert.equal(restarted.endpoints[0].href, endpoints[0].href);
});
