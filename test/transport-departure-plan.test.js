'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const test = require('node:test');
const source = fs.readFileSync('SLY_Assistant.user.js', 'utf8');
function fn(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let end = source.indexOf('{', start), depth = 0;
  for (; end < source.length; end++) { if(source[end] === '{') depth++; if(source[end] === '}' && --depth === 0) break; }
  return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, end + 1);
}
const manifest = [{res:'electronics',amt:30000,cargoTotal:true},{res:'framework',amt:60000,cargoTotal:true}];
const sizes = {electronics:2,framework:1,inbound:1};
function context(extra = {}) {
  const c = vm.createContext(extra);
  for(const name of ['getTransportRequiredLoadWait','isTransportPriorityFull','simulateTransportRequiredLoad']) vm.runInContext(fn(name),c);
  return c;
}
test('already aboard capacity-limited Electronics resolves the same gate as newly loaded Electronics', () => {
  const c = context();
  const result = c.simulateTransportRequiredLoad(manifest,{electronics:25357},1,sizes,{});
  assert.equal(result.ready,true);
  assert.equal(result.plannedAmount,0);
  assert.equal(c.getTransportRequiredLoadWait(manifest,{electronics:25357},1,sizes),null);
});
test('one keep-one Electronics residue does not make a hold filled with unrelated cargo priority-full', () => {
  const c=context();
  assert.notEqual(c.getTransportRequiredLoadWait(manifest,{electronics:1,inbound:50712},1,sizes),null);
});
function parsed(amounts) { return {value:Object.entries(amounts).map(([mint,amount])=>({pubkey:mint,account:{data:{parsed:{info:{mint,tokenAmount:{uiAmount:amount}}}}}}))}; }
for(const [name,aboard,stock,waiting] of [
  ['already loaded',{electronics:25357},{},''],
  ['newly loaded',{}, {electronics:60000},''],
  ['checked absent',{}, {},'Electronics, Framework'],
  ['later checked alternative',{}, {framework:60000},''],
]) test(`production loader: ${name}`,async()=>{
  const transfers=[];
  const fleet={label:'Phantom',cargoCapacity:50715,cargoHold:{toBuffer:()=>Buffer.alloc(0)},state:'Idle'};
  const c=context({userFleets:[fleet],globalSettings:{},sageGameAcct:{account:{mints:{ammo:'ammo'}}},
    solanaReadConnection:{getParsedTokenAccountsByOwner:async()=>parsed(aboard)},tokenProgramPK:{toBuffer:()=>Buffer.alloc(0)},programPK:{},
    BrowserAnchor:{anchor:{web3:{PublicKey:{findProgramAddressSync:()=>['ata']}}}},solanaWeb3:{PublicKey:class { toBuffer(){return Buffer.alloc(0);} }},
    cargoItems:[{token:'electronics',name:'Electronics',size:2},{token:'framework',name:'Framework',size:1}],cargoTypes:[],
    cLog(){},FleetTimeStamp:()=>'',updateFleetState:(f,s)=>{f.state=s;},recordTransportLoadDiagnostic(){},
    execCargoFromStarbaseToFleet:async(...args)=>{const mint=args[3],amount=Math.min(args[6],stock[mint]||0);if(amount)transfers.push([mint,amount]);return amount?{amount,transactions:[{mint,amount}]}:{name:'NotEnoughResource'};},
    hasUsefulTransportCargoForManifest:(_m,a)=>Object.values(a).some(x=>x>1),
  });
  vm.runInContext(fn('buildTransportRequiredLoadThresholds'),c);
  vm.runInContext(fn('handleTransportLoading'),c);
  const result=await c.handleTransportLoading(0,'0,0',manifest,true,0);
  assert.equal(result.waitingResource,waiting);
  assert.equal(result.success,true);
  if(name==='already loaded') assert.equal(transfers.length,0);
  if(name==='newly loaded') assert.deepEqual(transfers,[['electronics',25357]]);
  if(name==='later checked alternative') assert.deepEqual(transfers,[['framework',50715]]);
});
test('preflight subtracts inbound unload before deciding whether departure cargo fills the hold', async()=>{
 const fleet={cargoHold:'fleet',cargoCapacity:50715};
 const c=context({globalSettings:{transportKeep1:true},cargoItems:Object.entries(sizes).map(([token,size])=>({token,name:token,size})),
  solanaReadConnection:{getParsedTokenAccountsByOwner:async()=>parsed({inbound:50715})},tokenProgramPK:{},sageGameAcct:{account:{mints:{ammo:'ammo',fuel:'fuel'}}},
  readTransportStarbaseUsableCargoAmounts:async()=>({}),recordTransportLoadDiagnostic(){},getTransportRequiredLoadLabel:()=> 'Electronics, Framework',
 });
 if(source.includes('function planTransportCargoUnload(')) vm.runInContext(fn('planTransportCargoUnload'),c);
 vm.runInContext(fn('preflightTransportRequiredLoadRetry'),c);
 const result=await c.preflightTransportRequiredLoadRetry(fleet,'0,0',manifest,[{res:'inbound',amt:50715}]);
 assert.equal(result.ready,false,'inbound cargo must not falsely release departure gate');
});
for(const mode of ['warp','warp-smart','subwarp']) test(`production stop retry: ${mode} stays read-only, then already-loaded cargo departs`, async()=>{
  let aboard={};
  let stocks={};
  const moves=[], tx=[];
  const fleet={label:'Phantom',publicKey:'fleet',cargoHold:'hold',cargoCapacity:50715,crewCount:0,requiredCrew:0,passengerCapacity:0,transportLoadRetryResource:'Electronics, Framework'};
  const c=context({userFleets:[fleet],globalSettings:{},cargoItems:Object.entries(sizes).map(([token,size])=>({token,name:token,size})),
    ConvertCoords:s=>s.split(',').map(Number),resolveWarpSmartTravelMode:(mode,wait)=>mode==='warp-smart'?(wait?'subwarp':'warp'):mode,
    cloneTransportManifest:m=>m.map(x=>({...x})),applyTransportTotalRemaining:m=>m,
    hasTransportManifest:m=>m.some(x=>x.res&&x.amt>0),
    checkCargo:async(a,b)=>({currentManifest:a,destinationManifest:b,needToLoad:true,needToUnload:false}),
    logTransportCrewDecision(){},getFleetFuelData:async()=>({fuelNeeded:0,capacity:100,amount:100}),
    sageGameAcct:{account:{mints:{ammo:'ammo',fuel:'fuel'}}},
    solanaReadConnection:{getParsedTokenAccountsByOwner:async()=>parsed(aboard)},tokenProgramPK:{},
    readTransportStarbaseUsableCargoAmounts:async()=>({...stocks}),recordTransportLoadDiagnostic(){},
    getTransportRequiredLoadLabel:()=> 'Electronics, Framework',
    scheduleTransportLoadRetry:(f,label)=>{f.state='Waiting for '+label;},
    clearTransportLoadRetry:f=>{f.transportLoadRetryResource='';},
    persistFleetTransportRouteState:async(_i,effective)=>moves.push(effective),cLog(){},FleetTimeStamp:()=>'',
    execDock:async()=>{tx.push('dock');throw Error('Unexpected paid work');},
  });
  for(const name of ['resolveWarpSmartTravelMode','planTransportCargoUnload','preflightTransportRequiredLoadRetry','handleTransportStop']) vm.runInContext(fn(name),c);
  for(let n=0;n<3;n++) {
    stocks={electronics:n?10000:0};
    assert.equal(await c.handleTransportStop(0,'0,0','1,1',[{res:'inbound',amt:50000}],manifest,mode,true),false);
    assert.equal(fleet.resupplying,false);
  }
  assert.deepEqual(tx,[]);
  assert.deepEqual(moves,[]);
  aboard={electronics:25357};stocks={};
  assert.equal(await c.handleTransportStop(0,'0,0','1,1',[{res:'inbound',amt:50000}],manifest,mode,true),true);
  assert.deepEqual(tx,[],'ready onboard cargo must not trigger dock/unload/load');
  assert.deepEqual(moves,[mode==='warp-smart'?'subwarp':mode]);
  // The wait was consumed. The next ordinary leg resolves Warp Smart to Warp.
  assert.equal(fleet.transportLoadRetryResource,'');
  assert.equal(c.resolveWarpSmartTravelMode(mode,false),mode==='warp-smart'?'warp':mode);
});
test('unload planner merges duplicate entries and applies hold/bank keep-one consistently',()=>{
 const c=context();vm.runInContext(fn('planTransportCargoUnload'),c);
 const result=c.planTransportCargoUnload([{res:'ammo',amt:100},{res:'ammo',amt:50},{res:'electronics',amt:5,extra:true}],{ammo:20,electronics:10},200,'ammo',true);
 assert.equal(result.entries[0].amount,19);
 assert.equal(result.entries[0].deficit,131);
 assert.equal(result.ammoToUnload,130);
 assert.equal(result.entries[1].amount,4);
});
test('preflight read failure remains a waiting result, never authorizes paid work',async()=>{
 const c=context({cargoItems:[],getTransportRequiredLoadLabel:()=> 'Electronics',
  solanaReadConnection:{getParsedTokenAccountsByOwner:async()=>{throw Error('RPC unavailable');}},tokenProgramPK:{},recordTransportLoadDiagnostic(){}});
 vm.runInContext(fn('preflightTransportRequiredLoadRetry'),c);
 const result=await c.preflightTransportRequiredLoadRetry({cargoHold:'fleet'},'0,0',manifest,[]);
 assert.equal(result.ready,false);assert.equal(result.readFailed,true);assert.equal(result.waitingLabel,'Electronics');
});
