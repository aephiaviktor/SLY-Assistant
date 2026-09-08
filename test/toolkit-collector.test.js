'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
const {createSlyaToolkitCollector}=require('../lib/toolkit-collector');
const {anchor}=require('../electron-app/app/anchor-browserified');
const {Buffer:bufferModule}=require('../electron-app/app/buffer-browserified');
const BufferB=bufferModule.Buffer, PublicKey=anchor.web3.PublicKey;
const fixture=require('./fixtures/toolkit-mainnet.json');
const coder=new anchor.BorshAccountsCoder(require('../lib/toolkit-upkeep-idl.json'));
const program=new PublicKey('SAGE2HAwep459SNq61LHvjxPk4pLPEJLoMETef7f7EE'),game=new PublicKey('GAMEzqJehF8yAnKiTARUuhZMvLvkZVAsCVri5vSfemLr');
const hash=async s=>crypto.createHash('sha256').update(s).digest('hex');
const canonical=s=>Object.fromEntries(['faction','starbase','starbasePublicKey','slot','observedAt','globalTime','localTime','balance','depletionRate','reserve','level'].map(k=>[k,s[k]]));
function setup(disk=new Map()) {
 let offline=false,failedFaction=null,failSave=false,at=fixture.states[0].observedAt*1000,callback;
 const writes=[],calls=[],reports=[];
 const account=i=>({data:BufferB.from(fixture.raw.value[i].data[0],'base64'),owner:program});
 const actualCoder={decode:(name,data)=>name==='game'?{gameState:game}:coder.decode(name,data)};
 const connection={getAccountInfo:async(_,commitment)=>{assert.equal(commitment,'finalized');calls.push('game');return {owner:program,data:BufferB.alloc(0)};},getMultipleAccountsInfoAndContext:async(keys,commitment)=>{
  assert.equal(commitment,'finalized');const index=fixture.states.findIndex(s=>s.starbasePublicKey===keys[0].toBase58());assert.ok(index>=0);calls.push(fixture.states[index].faction);
  if(failedFaction===fixture.states[index].faction)throw Error('rpc private');
  return {context:fixture.raw.context,value:[account(index),account(3),{owner:program,data:BufferB.alloc(0)},account(4)]};
 }};
 const options={connection,coder:actualCoder,PublicKey,Buffer:BufferB,game,program,hash,now:()=>at,
 getDestination:()=>({identity:'primary'}),load:async key=>disk.has(key)?structuredClone(disk.get(key)):null,
 save:async(key,v)=>{if(failSave)throw Error('disk');disk.set(key,structuredClone(v));},publish:async(_,lines)=>{if(offline)throw Error('private http');writes.push(lines);},report:s=>reports.push(s),setTimer:fn=>{callback=fn;return 1;},clearTimer:()=>{callback=null;}};
 const collector=createSlyaToolkitCollector(options);
 return {collector,options,disk,writes,calls,reports,setOffline:v=>offline=v,setFailedFaction:v=>failedFaction=v,setFailSave:v=>failSave=v,setAt:v=>at=v,tick:()=>callback(),hasTimer:()=>!!callback};
}
test('bundled browser decoder captures all finalized PHANTOMs and preserves MSA point identity',async()=>{
 const s=setup();await s.collector.collect(true);assert.equal(s.writes.length,3);
 for(let i=0;i<3;i++) {
  const row=canonical(fixture.states[i]);const record=JSON.stringify(row).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
  assert.equal(s.writes[i],`starbase_toolkit_clock_v1,faction=${row.faction},starbase=${row.starbase},address=${row.starbasePublicKey},observation=${await hash(JSON.stringify(row))} record="${record}" ${BigInt(row.observedAt)*1000000000n}`);
 }
 await s.collector.collect(true);assert.equal(s.writes.length,3);
});
test('offline restart retries saved points without RPC; save failure forbids publication',async()=>{
 const a=setup();a.setOffline(true);await a.collector.collect(true);assert.equal(a.disk.size,3);assert.equal(a.writes.length,0);
 const b=setup(a.disk);await b.collector.collect(false);assert.equal(b.calls.length,0);assert.equal(b.writes.length,3);
 const c=setup();c.setFailSave(true);await c.collector.collect(true);assert.equal(c.writes.length,0);
});
test('one faction failure does not suppress others; destination changes do not drain old queue',async()=>{
 const a=setup();a.setFailedFaction('MUD');await a.collector.collect(true);assert.equal(a.writes.length,2);assert.ok(a.reports.some(r=>r.faction==='MUD' && r.status==='capture_failed'));
 const b=setup();b.setOffline(true);await b.collector.collect(true);b.options.getDestination=()=>({identity:'different'});
 const different=createSlyaToolkitCollector(b.options);b.setOffline(false);await different.collect(false);assert.equal(b.writes.length,0);
 assert.doesNotMatch(JSON.stringify(a.reports),/private/);
});
test('hourly and midnight scheduling is single-flight, retry-only between captures and stops on unload',async()=>{
 const s=setup(),base=Date.parse('2026-09-07T12:00:00Z');s.setAt(base);await s.collector.start();const initial=s.calls.length;
 for(let i=1;i<120;i++){s.setAt(base+i*30000);await s.tick();}assert.equal(s.calls.length,initial);
 s.setAt(base+3600000);await s.tick();assert.equal(s.calls.length,initial*2);
 s.setAt(Date.parse('2026-09-07T23:55:00Z'));await s.tick();const before=s.calls.length;
 s.setAt(Date.parse('2026-09-07T23:55:30Z'));await s.tick();assert.equal(s.calls.length,before+initial);
 s.collector.stop();assert.equal(s.hasTimer(),false);
});
test('both shipped scripts embed collector exactly and initialize independently of automation flags',()=>{
 const a=fs.readFileSync('SLY_Assistant.user.js','utf8'),b=fs.readFileSync('electron-app/app/SLY_Assistant.user.js','utf8');assert.equal(a,b);
 const core=fs.readFileSync('lib/toolkit-collector.js','utf8').split("if(typeof module!==")[0];assert.ok(a.includes(core));
 const wiring=a.slice(a.indexOf('// Own collection in SLYA'),a.indexOf('let cargoStatsDefinitionAcctPK'));
 assert.match(wiring,/endpoints:\(\)=>readRPCs/);assert.match(wiring,/void toolkitCollector.start/);assert.doesNotMatch(wiring,/upgradeAutomationEnabled|sendToInflux/);
});
test('Toolkit RPC bounds offline retries and preserves finalized commitment',async()=>{
 const {createSlyaToolkitRpc}=require('../lib/toolkit-collector');let attempts=0;
 class Connection {
  constructor(url,options){this.url=url;this.options=options;assert.equal(options.disableRetryOnRateLimit,true);}
  async getAccountInfo(key,commitment){assert.equal(commitment,'finalized');return this.options.fetch(this.url,{});}
 }
 const rpc=createSlyaToolkitRpc({Connection,endpoints:()=>['first','second','third'],fetch:async()=>{attempts++;throw Error('private');}});
 await assert.rejects(rpc.getAccountInfo('game','finalized'),/^Error: toolkit_rpc_unavailable$/);assert.equal(attempts,2);
 let cleared=0;
 const timeoutRpc=createSlyaToolkitRpc({Connection,endpoints:()=>['first'],setTimer:fn=>setTimeout(fn,5),clearTimer:timer=>{cleared++;clearTimeout(timer);},fetch:async(_,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('abort'))))});
 await assert.rejects(timeoutRpc.getAccountInfo('game','finalized'),/toolkit_rpc_unavailable/);assert.equal(cleared,1);
});
