#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'SLY_Assistant.user.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0, quote = '', escaped = false;
  for (let i = bodyStart; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = { URL };
vm.createContext(context);
vm.runInContext(`${extractFunction('optimizationInfluxString')}\nthis.escapeField = optimizationInfluxString;`, context);
assert.equal(context.escapeField('a"b\\c\nd'), '"a\\"b\\\\c d"', 'field strings are line-protocol escaped');

context.globalSettings = { influxURL: 'https://influx.example/api/v2/write?org=aephia&bucket=slya', influxDB: 'slya' };
vm.runInContext(`${extractFunction('buildInfluxWriteUrl')}\nthis.buildUrl = buildInfluxWriteUrl;`, context);
assert.equal(new URL(context.buildUrl()).searchParams.get('bucket'), 'slya', 'default writes keep the configured bucket');
assert.equal(new URL(context.buildUrl('optimization')).searchParams.get('bucket'), 'optimization', 'optimization writes override only the bucket');
assert.equal(new URL(context.buildUrl('optimization')).searchParams.get('org'), 'aephia', 'bucket override preserves other URL parameters');

assert.match(source, /className = 'scan-optimization-toggle'/, 'fleet config exposes the optimization checkbox');
assert.match(source, /scanOptimizationEnabled: scanOptimizationEnabled/, 'fleet config persists the opt-in');
assert.match(source, /scanOptimizationExperimentId: scanOptimizationExperimentId/, 'fleet config persists experiment continuity');
assert.match(source, /sendScanningOptimizationEvent\(fleet, 'transaction'/, 'all fleet transactions use the central telemetry hook');
const transactionHook = source.slice(
  source.indexOf("sendScanningOptimizationEvent(fleet, 'transaction'"),
  source.indexOf("if(!instructionError", source.indexOf("sendScanningOptimizationEvent(fleet, 'transaction'"))
);
assert.doesNotMatch(transactionHook, /`operation=\$\{optimizationInfluxString/, 'operation is not duplicated as both a tag and field');
assert.match(transactionHook, /`,operation=\$\{influxEscape/, 'operation remains available as a transaction tag');
assert.match(source, /sendScanningOptimizationEvent\(userFleets\[i\], 'scan_result'/, 'scan outcomes emit linked result events');
const scanResultHook = source.slice(
  source.indexOf("sendScanningOptimizationEvent(userFleets[i], 'scan_result'"),
  source.indexOf("].join(','), ',operation=SCAN');", source.indexOf("sendScanningOptimizationEvent(userFleets[i], 'scan_result'")) + 34
);
assert.match(scanResultHook, /durationMs=/, 'scan results include transaction duration');
assert.match(scanResultHook, /txFeeLamports=/, 'scan results include transaction fees');
assert.match(scanResultHook, /txCostSol=/, 'scan results include transaction cost');
assert.match(scanResultHook, /error=/, 'scan results include the transaction error field');
assert.match(scanResultHook, /operation=SCAN/, 'scan results identify the associated transaction operation');
assert.match(source, /slyaTxDurationMs = Date\.now\(\) - macroOpStart/, 'confirmed transactions retain duration for linked result events');
assert.match(source, /sendToInflux\(`optimization_event,\$\{tags\} \$\{fields\}`, 'optimization'\)/, 'optimization events target the dedicated bucket');
assert.match(source, /moveWhileScanning=\$\{fleet\?\.scanMove \? 'true' : 'false'\}/, 'Move While Scanning is included in each parameter snapshot');

console.log('scanning optimization telemetry tests passed');
