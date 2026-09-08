/* Toolkit clock producer. Embedded in both userscript distributions by
 * scripts/embed-toolkit-collector.py; no Electron-only dependency. */
function createSlyaToolkitCollector({ connection, coder, PublicKey, Buffer, game, program, getDestination, load, save, publish, hash, report = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const factions = {MUD:[0,-24,'MUD-PHANTOM'],ONI:[-28,21,'ONI-PHANTOM'],USTUR:[28,21,'UST-PHANTOM']};
  const fields = ['faction','starbase','starbasePublicKey','slot','observedAt','globalTime','localTime','balance','depletionRate','reserve','level'];
  let stopped=false, running=false, timer, lastTick=null, lastHour=null, lastRetry=null;
  const seed = n => { const b=Buffer.alloc(8); let v=BigInt.asUintN(64,BigInt(n)); for(let i=0;i<8;i++){b[i]=Number(v&255n);v>>=8n;} return b; };
  const u64 = (data,offset) => { let v=0n; for(let i=7;i>=0;i--) v=(v<<8n)+BigInt(data[offset+i]); return v; };
  const addresses = Object.fromEntries(Object.entries(factions).map(([f,[x,y]])=>[f,PublicKey.findProgramAddressSync([Buffer.from('Starbase'),game.toBuffer(),seed(x),seed(y)],program)[0]]));
  function canonical(raw, faction) {
    if (!raw || raw.faction!==faction || raw.starbase!==factions[faction][2] || raw.starbasePublicKey!==addresses[faction].toBase58()) return null;
    const s=Object.fromEntries(fields.map(k=>[k,raw[k]]));
    for (const k of fields.slice(3)) { if(s[k]==null || s[k]==='') return null; s[k]=Number(s[k]?.toString()); if (!Number.isSafeInteger(s[k]) || s[k]<0) return null; }
    if(s.globalTime>s.observedAt || s.localTime>s.globalTime || s.level>6 || (s.reserve>0 && (!(s.depletionRate>0) || s.depletionRate%100))) return null;
    return s;
  }
  async function capture(faction) {
    const info=await connection.getAccountInfo(game,'finalized');
    if(!info?.owner.equals(program)) throw Error('capture');
    const stateKey=new PublicKey(coder.decode('game',info.data).gameState);
    const result=await connection.getMultipleAccountsInfoAndContext([addresses[faction],stateKey,game,new PublicKey('SysvarC1ock11111111111111111111111111111111')],'finalized');
    const [sb,gs,g,clock]=result.value || [];
    if(![sb,gs,g].every(a=>a?.owner.equals(program)) || !clock || clock.data.length<40 || Number(u64(clock.data,0))!==result.context.slot || !new PublicKey(coder.decode('game',g.data).gameState).equals(stateKey)) throw Error('capture');
    const star=coder.decode('starbase',sb.data), state=coder.decode('gameState',gs.data);
    const upkeep=state.fleet.upkeep['level'+Number(star.level)];
    const observed=canonical({faction,starbase:factions[faction][2],starbasePublicKey:addresses[faction].toBase58(),slot:result.context.slot,observedAt:Number(BigInt.asIntN(64,u64(clock.data,32))),globalTime:star.upkeepToolkitGlobalLastUpdate,localTime:star.upkeepToolkitLastUpdate,balance:star.upkeepToolkitBalance,depletionRate:upkeep?.toolkitDepletionRate,reserve:upkeep?.toolkitReserve,level:star.level},faction);
    if(!observed) throw Error('capture');
    return observed;
  }
  function line(row,id) {
    const tag=v=>String(v).replace(/([ ,=])/g,'\\$1');
    const record=JSON.stringify(row).replace(/\\/g,'\\\\').replace(/"/g,'\\"');
    return `starbase_toolkit_clock_v1,faction=${tag(row.faction)},starbase=${tag(row.starbase)},address=${tag(row.starbasePublicKey)},observation=${id} record="${record}" ${BigInt(row.observedAt)*1000000000n}`;
  }
  async function collect(doCapture) {
    // Snapshot destination once per pass; tokens are never journalled/hashed/logged.
    const destination=getDestination();
    if (!destination) { report({status:'not_configured'}); return; }
    const destinationId=await hash(destination.identity);
    for(const faction of Object.keys(factions)) {
      try {
        const key='slya-toolkit-clock-v1:'+destinationId+':'+faction;
        const stored=await load(key);
        if(stored && (stored.version!==1 || !Array.isArray(stored.rows))) throw Error('cache');
        const rows=new Map();
        const minimum=Math.floor(now()/1000)-35*86400;
        for(const item of stored?.rows || []) {
          const row=canonical(item.row,faction);
          if(row && row.observedAt>=minimum && row.observedAt<=Math.floor(now()/1000)) rows.set(await hash(JSON.stringify(row)),{row,published:item.published===true});
        }
        let captureFailed=false;
        if(doCapture) {
          try { const row=await capture(faction),id=await hash(JSON.stringify(row)); if(!rows.has(id)) rows.set(id,{row,published:false}); }
          catch(_) { captureFailed=true; }
        }
        const journal={version:1,rows:[...rows.values()]};
        // Persist before HTTP. A failed write cannot lose or acknowledge an observation.
        await save(key,journal);
        const pending=[...rows].filter(([,item])=>!item.published);
        for(let offset=0;offset<Math.min(512,pending.length);offset+=128) {
          const batch=pending.slice(offset,offset+128);
          await publish(destination,batch.map(([id,item])=>line(item.row,id)).join('\n'));
          for(const [,item] of batch) item.published=true;
          await save(key,journal);
        }
        report({faction,status:captureFailed?'capture_failed':'ok',pending:journal.rows.filter(x=>!x.published).length});
      } catch(_) { report({faction,status:'retry_pending'}); }
    }
  }
  async function tick() {
    if(stopped || running) return;
    running=true;
    const at=now(),phase=((at%86400000)+86400000)%86400000,hour=Math.floor(at/3600000);
    const due=lastTick===null || hour!==lastHour || at-lastTick>90000 || at<lastTick || phase>=86100000 || phase<600000;
    lastTick=at;
    try { if(due) {lastHour=hour;lastRetry=at;await collect(true);} else if(lastRetry===null || at-lastRetry>=300000) {lastRetry=at;await collect(false);} }
    catch(_) {report({status:'retry_pending'});}
    finally {running=false;if(!stopped) timer=setTimer(tick,30000);}
  }
  return {start:tick,stop(){stopped=true;clearTimer(timer);},collect};
}
// Reuse SLYA's configured read providers, but not its indefinitely retrying
// automation proxy: offline capture must settle so queued uploads can retry.
function createSlyaToolkitRpc({ Connection, endpoints, fetch: transport, count = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const call = async (method,args) => {
    for(const endpoint of [...new Set(endpoints())].filter(Boolean).slice(0,2)) {
      try {
        const connection=new Connection(endpoint,{commitment:'finalized',disableRetryOnRateLimit:true,
          fetch:async (url,options) => {
            const controller=new AbortController(),timer=setTimer(()=>controller.abort(),15000);
            try {
              count();
              const response=await transport(url,{...options,signal:controller.signal});
              // Include body download in the deadline, not just HTTP headers.
              const body=await response.arrayBuffer();
              return new Response([204,205,304].includes(response.status)?null:body,{status:response.status,statusText:response.statusText,headers:response.headers});
            }
            finally {clearTimer(timer);}
          }});
        return await connection[method](...args);
      } catch(_) { /* Bounded fallback. Do not log provider URLs or responses. */ }
    }
    throw new Error('toolkit_rpc_unavailable');
  };
  return Object.fromEntries(['getAccountInfo','getMultipleAccountsInfoAndContext'].map(method=>[method,(...args)=>call(method,args)]));
}
if(typeof module!=='undefined' && module.exports) module.exports={createSlyaToolkitCollector,createSlyaToolkitRpc};
