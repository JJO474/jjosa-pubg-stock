const J = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const stamp=()=>new Date().toISOString();
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
async function pubg(env,platform,path){
  if(!env.PUBG_API_KEY)throw Error('PUBG_API_KEY 비밀키가 설정되지 않았습니다');
  // Matches are not rate-limited by PUBG; only meter player/season requests.
  const exempt=path.startsWith('matches/');
  // Shared D1 gate, deliberately conservative: max 8 requests per rolling minute.
  const gate=await env.DB.prepare("SELECT v FROM meta WHERE k='api_gate'").first();
  const now=Date.now();const arr=gate?JSON.parse(gate.v).filter(t=>now-t<60000):[];
  if(!exempt){if(arr.length>=8)throw Error('API_RATE_LIMIT: 잠시 후 다시 갱신해 주세요');
  arr.push(now);
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES('api_gate',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(arr)).run();}
  const res=await fetch(`https://api.pubg.com/shards/${platform}/${path}`,{headers:{Authorization:`Bearer ${env.PUBG_API_KEY}`,Accept:'application/vnd.api+json','User-Agent':'JJOSAStock/3.0'}});
  if(!res.ok){
    let apiError='';
    try{const body=await res.json();apiError=String(body?.errors?.[0]?.detail||body?.errors?.[0]?.title||body?.message||'').slice(0,180)}catch(_){}
    const context=path.startsWith('players?')?'선수 닉네임 조회':'PUBG 데이터 조회';
    const detail=res.status===401?'PUBG API 인증 실패 (401)':res.status===403?'PUBG API 접근 거부 (403)':res.status===404?`${context} 실패 (PUBG API 404)`:res.status===429?'PUBG API 요청 제한 (429)':`${context} 실패 (PUBG API ${res.status})`;
    throw Error(detail+(apiError?' — '+apiError:''));
  }
  return res.json();
}
async function steamTop100(env){
 const db=env.DB,key='steam_top100_as_fpp',cached=await db.prepare('SELECT v FROM meta WHERE k=?').bind(key).first();
 let prior=null;try{prior=cached?JSON.parse(cached.v):null}catch(_){}
 if(prior&&Date.now()-Date.parse(prior.updated)<14400000)return prior;
 try{
  const seasons=await pubg(env,'steam','seasons');
  const season=seasons.data?.find(x=>x.attributes?.isCurrentSeason)?.id;
  if(!season)throw Error('현재 시즌을 확인할 수 없습니다');
  const data=await pubg(env,'pc-as','leaderboards/'+encodeURIComponent(season)+'/squad-fpp');
  const included=(data.included||[]).filter(x=>x.type==='player');
  const entries=included.map((x,i)=>{const a=x.attributes||{},v=a.stats||{};return {id:x.id,name:a.name||'',rank:Number(a.rank)||i+1,rp:Number(v.rankPoints)||0,kda:v.kda==null?null:Number(v.kda),tier:v.tier||null,subTier:v.subTier||null}}).sort((a,b)=>a.rank-b.rank).slice(0,500);
  if(!entries.length)throw Error('PUBG 리더보드 결과가 비어 있습니다');
  const result={region:'pc-as',mode:'squad-fpp',season,updated:stamp(),entries};
  if(prior&&prior.season===season&&Array.isArray(prior.entries)){
   const old=new Map(prior.entries.map(x=>[x.id,x.rank]));
   const changes=entries.map(x=>({...x,previous_rank:old.get(x.id)||null,delta:old.has(x.id)?old.get(x.id)-x.rank:null})).filter(x=>x.previous_rank!==null&&x.delta!==0||x.previous_rank===null);
   await db.prepare("INSERT INTO meta(k,v) VALUES('steam_rank_changes_as_fpp',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify({season,updated:stamp(),changes})).run();
  }
  await db.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(key,JSON.stringify(result)).run();
  return result;
 }catch(e){if(prior)return {...prior,stale:true,error:String(e.message||e)};throw e}
}
async function ranked(env,p){
 const seasons=await pubg(env,p.platform,'seasons');const season=seasons.data?.find(s=>s.attributes?.isCurrentSeason)?.id;
 if(!season)return {season:null,rp:null};
 const d=await pubg(env,p.platform,`players/${encodeURIComponent(p.id)}/seasons/${encodeURIComponent(season)}/ranked`);
 const modes=d.data?.attributes?.rankedGameModeStats||{};
 const mode=modes['squad-fpp']||modes.squad||{};
 return {season,rp:mode.currentRankPoint??null,tier:mode.currentTier?.tier||null,subTier:mode.currentTier?.subTier||null,rankMode:modes['squad-fpp']?'squad-fpp':'squad'};
}
async function register(env,name,platform){
 if(!['steam','kakao'].includes(platform))throw Error('steam 또는 kakao 플랫폼만 지원합니다');
 if(!name||name.length>64)throw Error('닉네임을 입력해 주세요');
 const d=await pubg(env,platform,`players?filter[playerNames]=${encodeURIComponent(name)}`);
 const p=d.data?.[0];if(!p)throw Error('PUBG API가 선수 데이터를 반환하지 않았습니다 (200, 빈 목록). 플랫폼: '+platform+', 닉네임: '+name);
 if(await env.DB.prepare('SELECT id FROM players WHERE id=?').bind(p.id).first())throw Error('이미 등록된 선수입니다');
 // Register the verified account first. Ranked stats are optional and can be
 // temporarily unavailable or rate-limited; they must not block registration.
 const now=stamp();
 await env.DB.prepare('INSERT INTO players(id,name,platform,rp,season,updated,created) VALUES(?,?,?,?,?,?,?)').bind(p.id,p.attributes?.name||name,platform,null,null,now,now).run();
 const ids=p.relationships?.matches?.data||[];
 if(ids.length){
  for(let i=0;i<ids.length;i+=40){
   await env.DB.batch(ids.slice(i,i+40).map(m=>env.DB.prepare('INSERT OR IGNORE INTO processed(player,match_id) VALUES(?,?)').bind(p.id,m.id)));
  }
 }
 let rankedStatus='pending';
 try{
  const r=await ranked(env,{id:p.id,platform});
  await env.DB.prepare('UPDATE players SET rp=?,season=? WHERE id=?').bind(r.rp,r.season,p.id).run();
  if(r.rp!=null)await env.DB.prepare('INSERT INTO snapshots(player,created,season,rp) VALUES(?,?,?,?)').bind(p.id,now,r.season,r.rp).run();
  rankedStatus=r.rp==null?'unavailable':'ok';
 }catch(e){rankedStatus='pending';}
 return {id:p.id,rankedStatus};
}
const EFFECT_DEFAULTS={momentum:{enabled:false,weight:100,cap:1.2},chicken:{enabled:false,weight:100,cap:1.2},surprise:{enabled:false,weight:100,cap:1},rp:{enabled:false,weight:100,cap:.8},mood:{enabled:false,weight:100,cap:.5},record:{enabled:false,weight:100,cap:.8},rival:{enabled:false,weight:100,cap:.6},dormant:{enabled:false,weight:100,cap:.6},event:{enabled:false,weight:100,cap:1}};
async function effectSchema(db){
 await db.prepare("CREATE TABLE IF NOT EXISTS price_effect_settings (k TEXT PRIMARY KEY,v TEXT NOT NULL,updated TEXT NOT NULL)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS price_effect_events (player TEXT NOT NULL,match_id TEXT NOT NULL,created TEXT NOT NULL,base_pct REAL NOT NULL,bonus_pct REAL NOT NULL,final_pct REAL NOT NULL,previous_price INTEGER NOT NULL,new_price INTEGER NOT NULL,details TEXT NOT NULL,PRIMARY KEY(player,match_id))").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS price_effect_audit (id INTEGER PRIMARY KEY AUTOINCREMENT,created TEXT NOT NULL,previous TEXT NOT NULL,next TEXT NOT NULL)").run();
}
function validateEffects(raw){
 const effects={};
 for(const [k,d] of Object.entries(EFFECT_DEFAULTS)){
 const v=raw?.effects?.[k]||d;
 if(typeof v.enabled!=='boolean'||!Number.isFinite(Number(v.weight))||Number(v.weight)<0||Number(v.weight)>200||!Number.isFinite(Number(v.cap))||Number(v.cap)<0||Number(v.cap)>3)throw Error('효과 설정 범위 오류: '+k);
 effects[k]={enabled:v.enabled,weight:Number(v.weight),cap:Number(v.cap)};
 }
 const globalCap=Number(raw?.globalCap??3);
 if(!Number.isFinite(globalCap)||globalCap<0||globalCap>5)throw Error('전체 상한은 0~5%p');
 return {effects,globalCap};
}
async function getEffectConfig(db){
 await effectSchema(db);const row=await db.prepare("SELECT v FROM price_effect_settings WHERE k='active'").first();
 return row?validateEffects(JSON.parse(row.v)):validateEffects({effects:EFFECT_DEFAULTS,globalCap:3});
}
function effectCalculation(input,config){
 const {base,history,kills,damage,rank,marketScore,rpDelta,rpTierChange,rivalScore,dormantDays,eventPct}=input,detail={};
 const add=(id,raw)=>{const c=config.effects[id];if(c.enabled&&raw){detail[id]=Number(clamp(raw*c.weight/100,-c.cap,c.cap).toFixed(4))}};
 const games=history.filter(t=>t.kills!=null);
 let streak=0;
 for(const g of games){const sign=Math.sign(Number(g.change_pct));if(!sign)break;if(streak&&Math.sign(streak)!==sign)break;streak+=sign}
 const a=Math.abs(streak);add('momentum',Math.sign(streak)*(a>=5?1.2:a>=3?.7:a>=2?.3:0));
 let chickenStreak=rank===1?1:0;
 if(rank===1)for(const g of games){if(Number(g.rank)===1)chickenStreak++;else break}
 add('chicken',chickenStreak>=3?1.2:chickenStreak===2?.8:chickenStreak===1?.4:0);
 const prior=games.slice(0,10);
 if(prior.length>=5&&kills!=null&&damage!=null){
 const avg=prior.reduce((a,t)=>a+Number(t.kills||0)*.8+Number(t.damage||0)/200,0)/prior.length;
 const current=Number(kills)*.8+Number(damage)/200;
 const ratio=avg>=1?current/avg:null;
 add('surprise',ratio===null?0:ratio>=2?1:ratio>=1.5?.5:ratio<=.5?-.5:0);
 }
 if(rpTierChange==='up')add('rp',.8);else if(rpTierChange==='down')add('rp',-.8);
 if(Number.isFinite(marketScore))add('mood',marketScore>=76?.5:marketScore>=56?.2:marketScore<=24?-.5:marketScore<=44?-.2:0);
 if(games.length>=10&&kills!=null&&damage!=null){
 const highKills=Math.max(...games.map(g=>Number(g.kills||0))),highDamage=Math.max(...games.map(g=>Number(g.damage||0)));
 const k=Number(kills)>highKills,d=Number(damage)>highDamage;
 add('record',k&&d?0.8:(k||d?0.5:0));
 }
 if(Number.isFinite(rivalScore))add('rival',rivalScore);
 if(Number.isFinite(dormantDays)&&dormantDays>=14)add('dormant',dormantDays>=30?-.6:-.3);
 if(Number.isFinite(eventPct))add('event',eventPct);
 const rawBonus=Object.values(detail).reduce((a,b)=>a+b,0),bonus=clamp(rawBonus,-config.globalCap,config.globalCap);
 return {details:detail,raw_bonus_pct:Number(rawBonus.toFixed(4)),bonus_pct:Number(bonus.toFixed(4)),final_pct:Number(clamp(base+bonus,-10,10).toFixed(4))};
}
async function calculateMatchEffects(db,p,input,config){
 const history=await db.prepare('SELECT kills,damage,rank,change_pct FROM ticks WHERE player=? AND kills IS NOT NULL ORDER BY id DESC LIMIT 30').bind(p.id).all();
 // Compare only pre-existing completed match records; do not retroactively reprice peers.
 let rivalScore=null,dormantDays=null,eventPct=null;
 if(config.effects.rival.enabled){
  const peers=await db.prepare('SELECT player,AVG(kills*0.8+damage/200.0) AS avg_score FROM (SELECT player,kills,damage,ROW_NUMBER() OVER(PARTITION BY player ORDER BY id DESC) AS rn FROM ticks WHERE kills IS NOT NULL AND player<>?) WHERE rn<=5 GROUP BY player HAVING COUNT(*)>=3 ORDER BY ABS(avg_score-?) ASC LIMIT 1').bind(p.id,Number(input.kills||0)*.8+Number(input.damage||0)/200).all();
  const peer=peers.results[0];
  if(peer){const score=Number(input.kills||0)*.8+Number(input.damage||0)/200;rivalScore=score>Number(peer.avg_score)*1.2?.4:score<Number(peer.avg_score)*.8?-.4:0}
 }
 if(config.effects.dormant.enabled){
  const last=await db.prepare('SELECT created FROM ticks WHERE player=? AND kills IS NOT NULL ORDER BY id DESC LIMIT 1').bind(p.id).first();
  if(last?.created)dormantDays=Math.max(0,(Date.parse(stamp())-Date.parse(last.created))/86400000);
 }
 if(config.effects.event.enabled){
  const row=await db.prepare("SELECT v FROM settings WHERE k='active_market_event'").first();
  if(row){try{const e=JSON.parse(row.v);if(Date.parse(e.expires)>Date.now())eventPct=Number(e.pct)}catch(_){}}
 }
 return effectCalculation({...input,history:history.results,marketScore:null,rivalScore,dormantDays,eventPct},config);
}

async function pollPlayer(env,p,prefetched=null){
 const d=prefetched||await pubg(env,p.platform,`players/${encodeURIComponent(p.id)}`);
 const ids=(d.data?.relationships?.matches?.data||[]).map(x=>x.id).reverse();
 const unseen=[];
 for(const id of ids){if(!(await env.DB.prepare('SELECT 1 FROM processed WHERE player=? AND match_id=?').bind(p.id,id).first()))unseen.push(id);}
 // A bounded batch is essential for free-tier CPU, external API limits and request duration.
 const batch=unseen.slice(0,2);let applied=0;const effectConfig=await getEffectConfig(env.DB);
 for(const id of batch){
  const m=await pubg(env,p.platform,`matches/${encodeURIComponent(id)}`);
  const attrs=m.data?.attributes||{};
  const stats=m.included?.filter(x=>x.type==='participant').map(x=>x.attributes?.stats).find(x=>x?.playerId===p.id);
  const matchType=String(attrs.matchType||'').toLowerCase();
  // PUBG API: competitive=ranked, official=normal. Ignore custom/arcade/AI matches.
  const isRanked=matchType==='competitive',isNormal=matchType==='official';
  if(stats&&(isRanked||isNormal)){
   const kills=Number(stats.kills||0),damage=Number(stats.damageDealt||0),rank=Number(stats.winPlace||16);
   const perf=clamp(kills*.8+damage/200+(rank===1?3:rank<=5?1:rank>=13?-3:rank>=9?-1:0)-3,-10,10);
   const row=await env.DB.prepare('SELECT price FROM players WHERE id=?').bind(p.id).first();
   const w=await env.DB.prepare("SELECT v FROM settings WHERE k='rp_weight'").first();
   // Ranked retains the existing RP/performance split. Normal matches have no RP:
   // apply a reduced 50%-strength performance change to limit farming volatility.
   const pct=clamp(isRanked?perf*(1-Number(w?.v??50)/100):perf*0.5,-10,10);
   const effect=await calculateMatchEffects(env.DB,p,{base:pct,kills,damage,rank},effectConfig);
   const price=Math.max(100,Math.round(row.price*(1+effect.final_pct/100)));
   await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO ticks(player,match_id,created,price,change_pct,kills,damage,rank,reason) VALUES(?,?,?,?,?,?,?,?,?)').bind(p.id,id,attrs.createdAt||stamp(),price,effect.final_pct,kills,damage,rank,isRanked?'경쟁전 경기':'일반전 경기'),
    env.DB.prepare('UPDATE players SET price=?,updated=? WHERE id=?').bind(price,stamp(),p.id),
    env.DB.prepare('INSERT OR IGNORE INTO price_effect_events(player,match_id,created,base_pct,bonus_pct,final_pct,previous_price,new_price,details) VALUES(?,?,?,?,?,?,?,?,?)').bind(p.id,id,stamp(),pct,effect.bonus_pct,effect.final_pct,row.price,price,JSON.stringify(effect.details)),
    env.DB.prepare('INSERT OR IGNORE INTO processed(player,match_id) VALUES(?,?)').bind(p.id,id)
   ]);applied++;
  }else await env.DB.prepare('INSERT OR IGNORE INTO processed(player,match_id) VALUES(?,?)').bind(p.id,id).run();
 }
 // Only compare RP when all currently discoverable matches have been processed.
 if(unseen.length<=batch.length){
  const rpMetaKey='rp_checked:'+p.id;
  const rpMeta=await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind(rpMetaKey).first();
  if(!rpMeta||Date.now()-Date.parse(rpMeta.v)>1800000){
  const r=await ranked(env,p);
  const delta=r.season===p.season&&r.rp!=null&&p.rp!=null?r.rp-p.rp:null;
  // RP is informational only: ranked match placement is already priced in perf.
  // Do not apply a second RP price change for the same competitive results.
  await env.DB.prepare('UPDATE players SET rp=?,season=?,updated=? WHERE id=?').bind(r.rp,r.season,stamp(),p.id).run();
  if(r.rp!=null)await env.DB.prepare('INSERT INTO snapshots(player,created,season,rp) VALUES(?,?,?,?)').bind(p.id,stamp(),r.season,r.rp).run();
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind('rank_detail:'+p.id,JSON.stringify({tier:r.tier,subTier:r.subTier,rankMode:r.rankMode,season:r.season,checked:stamp()})).run();
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(rpMetaKey,stamp()).run();
  }
 }
 return {applied,remaining:Math.max(0,unseen.length-batch.length)};
}
async function sync(env){
 // Every five minutes, enqueue all listed players; a one-minute worker drains
 // the queue within the shared PUBG API request budget.
 const db=env.DB,now=Date.now(),cycle=Math.floor(now/300000);
 await db.prepare("CREATE TABLE IF NOT EXISTS sync_queue (player TEXT PRIMARY KEY, cycle INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_checked TEXT, last_error TEXT, applied INTEGER NOT NULL DEFAULT 0)").run();
 const prior=await db.prepare("SELECT v FROM meta WHERE k='sync_cycle'").first();
 if(Number(prior?.v)!==cycle){
  const players=await db.prepare('SELECT id FROM players').all();
  if(players.results.length){
   await db.batch(players.results.map(p=>db.prepare("INSERT INTO sync_queue(player,cycle,status,attempts,last_error) VALUES(?,?,'pending',0,NULL) ON CONFLICT(player) DO UPDATE SET cycle=excluded.cycle,status=CASE WHEN sync_queue.status='pending' THEN 'pending' ELSE 'pending' END,attempts=0,last_error=NULL").bind(p.id,cycle)));
  }
  await db.prepare("INSERT INTO meta(k,v) VALUES('sync_cycle',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(cycle)).run();
 }
 const pending=await db.prepare("SELECT q.player,p.* FROM sync_queue q JOIN players p ON p.id=q.player WHERE q.status='pending' ORDER BY q.last_checked IS NOT NULL,q.last_checked ASC,q.player LIMIT 10").all();
 let checked=0,applied=0,failures=0;
 const groups=new Map();
 for(const p of pending.results){const shard=String(p.platform||'steam');if(!groups.has(shard))groups.set(shard,[]);groups.get(shard).push(p)}
 for(const [shard,players] of groups){
  let data;
  try{data=await pubg(env,shard,'players?filter[playerIds]='+encodeURIComponent(players.map(p=>p.id).join(',')))}
  catch(e){if(String(e.message||e).includes('429')||String(e.message||e).startsWith('API_RATE_LIMIT'))break;failures++;continue}
  const byId=new Map((data.data||[]).map(x=>[x.id,x]));
  for(const p of players){
  try{
   const playerData=byId.get(p.id);
   if(!playerData)throw Error('PUBG 선수 조회 결과에 계정 없음');
   const r=await pollPlayer(env,p,{data:playerData});
   checked++;applied+=r.applied;
   await db.prepare("UPDATE sync_queue SET status='done',attempts=attempts+1,last_checked=?,last_error=NULL,applied=? WHERE player=?").bind(stamp(),r.applied,p.id).run();
  }catch(e){
   const msg=String(e.message||e);
   if(msg.startsWith('API_RATE_LIMIT')||msg.includes('(429)'))break;
   failures++;
   await db.prepare("UPDATE sync_queue SET status='error',attempts=attempts+1,last_checked=?,last_error=? WHERE player=?").bind(stamp(),msg.slice(0,300),p.id).run();
  }
 }
 }
 const counts=await db.prepare("SELECT status,COUNT(*) AS n FROM sync_queue GROUP BY status").all();
 const stats=Object.fromEntries(counts.results.map(x=>[x.status,x.n]));
 await db.prepare("INSERT INTO meta(k,v) VALUES('sync_finished',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(stamp()).run();
 if(failures)await db.prepare("INSERT INTO meta(k,v) VALUES('sync_error',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(failures+'명 조회 오류 (선수별 갱신 현황 확인)').run();
 else await db.prepare("DELETE FROM meta WHERE k='sync_error'").run();
 return {checked,applied,pending:stats.pending||0,failed:stats.error||0,completed:stats.done||0};
}



const kstDate=iso=>new Date(new Date(iso).getTime()+9*3600000).toISOString().slice(0,10);
function candleKey(iso,period){
 const d=kstDate(iso);if(period==='1d')return d;
 const x=new Date(d+'T00:00:00Z');
 if(period==='1w'){x.setUTCDate(x.getUTCDate()-(x.getUTCDay()+6)%7);return x.toISOString().slice(0,10);}
 return d.slice(0,7);
}
async function candleData(db,id,period){
 const [ticks,trades,p]=await Promise.all([
 db.prepare('SELECT id,created,price,change_pct FROM ticks WHERE player=? ORDER BY id ASC LIMIT 4000').bind(id).all(),
 db.prepare('SELECT created,quantity FROM investor_trades WHERE player_id=? ORDER BY id ASC LIMIT 4000').bind(id).all(),
 db.prepare('SELECT id,name,price,created FROM players WHERE id=?').bind(id).first()
 ]);
 if(!p)return null;
 const buckets=new Map();let prev=10000;
 const ensure=(key,price)=>{if(!buckets.has(key))buckets.set(key,{time:key,open:price,high:price,low:price,close:price,volume:0,events:0});return buckets.get(key)};
 for(const t of ticks.results){
 const price=Number(t.price),key=candleKey(t.created,period),c=ensure(key,prev);
 c.high=Math.max(c.high,price);c.low=Math.min(c.low,price);c.close=price;c.events++;prev=price;
 }
 for(const t of trades.results){const key=candleKey(t.created,period),c=ensure(key,prev);c.volume+=Number(t.quantity)||0;}
 return {player:{id:p.id,name:p.name,price:p.price},period,candles:[...buckets.values()].sort((a,b)=>a.time.localeCompare(b.time)).slice(-360),limited:ticks.results.length>=4000||trades.results.length>=4000};
}
async function marketAnalytics(db){
 const [players,ticks,vol]=await Promise.all([
 db.prepare('SELECT id,name,price,rp,platform,created FROM players ORDER BY id').all(),
 db.prepare('SELECT player,price,change_pct,kills,damage,rank,created,id FROM ticks ORDER BY id DESC LIMIT 12000').all(),
 db.prepare("SELECT player_id,SUM(quantity) AS volume,SUM(total) AS turnover FROM investor_trades WHERE created>=? GROUP BY player_id").bind(new Date(Date.now()-86400000).toISOString()).all()
 ]);
 const byPlayer=new Map(),vmap=new Map(vol.results.map(v=>[v.player_id,v]));
 for(const t of ticks.results){if(!byPlayer.has(t.player))byPlayer.set(t.player,[]);byPlayer.get(t.player).push(t)}
 const now=Date.now(),dayStart=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Seoul'}));dayStart.setHours(0,0,0,0);
 const items=players.results.map(p=>{
 const arr=byPlayer.get(p.id)||[],recent=arr.filter(t=>Date.parse(t.created)>=now-30*86400000),games=recent.filter(t=>t.kills!=null),last=arr[0],v=vmap.get(p.id);
 const prior=last&&Number.isFinite(Number(last.change_pct))&&Math.abs(Number(last.change_pct))<99?Number(last.price)/(1+Number(last.change_pct)/100):Number(p.price);
 const first=arr[arr.length-1],base=first?Number(first.price):10000;
 const returns=arr.slice(0,30).map(t=>Number(t.change_pct)).filter(Number.isFinite),mean=returns.length?returns.reduce((a,b)=>a+b,0)/returns.length:0;
 const volatility=returns.length>1?Math.sqrt(returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1)):0;
 return {id:p.id,name:p.name,price:Number(p.price),rp:p.rp,platform:p.platform,change_pct:prior?((Number(p.price)-prior)/prior)*100:0,volume:Number(v?.volume||0),turnover:Number(v?.turnover||0),baseline:base>0?base:10000,average_kills:games.length?games.reduce((a,t)=>a+Number(t.kills||0),0)/games.length:null,average_damage:games.length?games.reduce((a,t)=>a+Number(t.damage||0),0)/games.length:null,games:games.length,volatility,history_points:arr.length};
 });
 const index=items.length?items.reduce((sum,p)=>sum+p.price/p.baseline,0)/items.length*1000:1000;
 const historyDates=new Set();
 for(const t of ticks.results){const d=kstDate(t.created);historyDates.add(d)}
 const days=[...historyDates].sort().slice(-90);
 const ascending=new Map([...byPlayer].map(([id,arr])=>[id,arr.slice().reverse()]));
 const cursors=new Map(items.map(p=>[p.id,{index:0,price:p.baseline}]));
 const history=[];
 for(const day of days){
  const end=Date.parse(day+'T14:59:59.999Z');
  for(const p of items){const cur=cursors.get(p.id),arr=ascending.get(p.id)||[];while(cur.index<arr.length&&Date.parse(arr[cur.index].created)<=end){cur.price=Number(arr[cur.index].price);cur.index++}}
  const value=items.length?items.reduce((sum,p)=>sum+cursors.get(p.id).price/p.baseline,0)/items.length*1000:1000;
  history.push({date:day,value:Number(value.toFixed(2))});
 }
 if(!history.length||history.at(-1).value!==Number(index.toFixed(2)))history.push({date:kstDate(stamp()),value:Number(index.toFixed(2))});
 return {index:{value:Number(index.toFixed(2)),method:'equal_weight_first_observed',constituents:items.length,history,history_note:'현재 상장 종목 기준으로 과거 가격을 재구성한 참고 지수이며 상장·상장폐지 시 과거 수치가 변경될 수 있습니다.'},rankings:{gainers:items.slice().sort((a,b)=>b.change_pct-a.change_pct).slice(0,10),losers:items.slice().sort((a,b)=>a.change_pct-b.change_pct).slice(0,10),volume:items.slice().sort((a,b)=>b.volume-a.volume).slice(0,10),turnover:items.slice().sort((a,b)=>b.turnover-a.turnover).slice(0,10)},players:items,generated_at:stamp(),history_limited:ticks.results.length>=12000};
}

async function marketSchema(db){
 await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS portfolio_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,account_id INTEGER NOT NULL,created TEXT NOT NULL,cash INTEGER NOT NULL,holdings_value INTEGER NOT NULL,total_value INTEGER NOT NULL,reason TEXT NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_portfolio_account ON portfolio_snapshots(account_id,id)"),
 db.prepare("CREATE TABLE IF NOT EXISTS market_notices(id INTEGER PRIMARY KEY AUTOINCREMENT,created TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,category TEXT NOT NULL DEFAULT '공지')")
 ]);
}
async function snapshotAccount(db,accountId,reason){
 await marketSchema(db);
 const a=await db.prepare("SELECT balance FROM investor_accounts WHERE id=?").bind(accountId).first();if(!a)return;
 const h=await db.prepare("SELECT COALESCE(SUM(h.quantity*p.price),0) AS value FROM investor_holdings h JOIN players p ON p.id=h.player_id WHERE h.account_id=? AND h.quantity>0").bind(accountId).first();
 const cash=Number(a.balance),value=Number(h?.value||0);
 await db.prepare("INSERT INTO portfolio_snapshots(account_id,created,cash,holdings_value,total_value,reason) VALUES(?,?,?,?,?,?)").bind(accountId,stamp(),cash,value,cash+value,reason).run();
}
async function marketStats(db){
 await tradeSchema(db);await marketSchema(db);
 const [volume,notices,top]=await Promise.all([
  db.prepare("SELECT player_id,COUNT(*) AS trades,COALESCE(SUM(quantity),0) AS volume,COALESCE(SUM(total),0) AS turnover FROM investor_trades GROUP BY player_id ORDER BY turnover DESC LIMIT 300").all(),
  db.prepare("SELECT id,created,title,body,category FROM market_notices ORDER BY id DESC LIMIT 30").all(),
  db.prepare("SELECT p.id,p.name,COALESCE(v.trades,0) AS trades,COALESCE(v.volume,0) AS volume,COALESCE(v.turnover,0) AS turnover FROM players p LEFT JOIN (SELECT player_id,COUNT(*) AS trades,SUM(quantity) AS volume,SUM(total) AS turnover FROM investor_trades GROUP BY player_id) v ON v.player_id=p.id ORDER BY turnover DESC LIMIT 20").all()
 ]);
 return {volume:volume.results,notices:notices.results,top:top.results};
}
function tickNews(t,p){
 const pct=Number(t.change_pct||0),reason=String(t.reason||'주가 반영');
 const detail=t.kills!=null?`${t.kills}킬 · ${Math.round(t.damage||0)}딜 · ${t.rank||'—'}위`:t.rp_delta!=null?`RP ${t.rp_delta>0?'+':''}${t.rp_delta}`:'';
 return {created:t.created,category:'경기 속보',player:t.player,title:`${p?.name||'선수'} ${reason}, 주가 ${pct>=0?'상승':'하락'} ${Math.abs(pct).toFixed(2)}%`,body:`${detail} · 반영 주가 ${Number(t.price).toLocaleString('ko-KR')} P`};
}

async function tradeSchema(db){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS investor_accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, nickname TEXT NOT NULL UNIQUE COLLATE NOCASE, balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0), created TEXT NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS investor_holdings (account_id INTEGER NOT NULL, player_id TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(quantity>=0), cost_basis INTEGER NOT NULL DEFAULT 0 CHECK(cost_basis>=0), PRIMARY KEY(account_id,player_id))"),
  db.prepare("CREATE TABLE IF NOT EXISTS investor_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL, reason TEXT NOT NULL, created TEXT NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS investor_trades (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, player_id TEXT NOT NULL, side TEXT NOT NULL CHECK(side IN ('buy','sell')), quantity INTEGER NOT NULL CHECK(quantity>0), price INTEGER NOT NULL CHECK(price>0), total INTEGER NOT NULL, created TEXT NOT NULL)")
 ]);
}
async function investors(db){
 await tradeSchema(db);
 const [a,h,t]=await Promise.all([
  db.prepare("SELECT id,nickname,balance,created FROM investor_accounts ORDER BY id DESC LIMIT 300").all(),
  db.prepare("SELECT h.account_id,h.player_id,h.quantity,h.cost_basis,p.name AS player_name,p.price FROM investor_holdings h JOIN players p ON p.id=h.player_id WHERE h.quantity>0").all(),
  db.prepare("SELECT t.id,a.nickname,p.name AS player_name,t.side,t.quantity,t.price,t.total,t.created FROM investor_trades t JOIN investor_accounts a ON a.id=t.account_id LEFT JOIN players p ON p.id=t.player_id ORDER BY t.id DESC LIMIT 80").all()
 ]);
 return {accounts:a.results,holdings:h.results,trades:t.results};
}
async function investorAction(env,path,body){
 const db=env.DB;await tradeSchema(db);
 if(path==='/api/investors/create'){
  const name=String(body.nickname||'').trim();
  if(name.length<2||name.length>40)throw Error('시청자 닉네임은 2~40자로 입력해 주세요');
  await db.prepare('INSERT INTO investor_accounts(nickname,created) VALUES(?,?)').bind(name,stamp()).run();
  return {ok:true};
 }
 const accountId=Number(body.account_id);
 if(!Number.isSafeInteger(accountId)||accountId<=0)throw Error('시청자 계좌를 선택해 주세요');
 const account=await db.prepare('SELECT * FROM investor_accounts WHERE id=?').bind(accountId).first();
 if(!account)throw Error('시청자 계좌가 없습니다');
 if(path==='/api/investors/grant'){
  const amount=Number(body.amount);
  if(!Number.isSafeInteger(amount)||amount<=0||amount>1000000000)throw Error('지급액은 1~10억 P');
  await db.batch([
   db.prepare('UPDATE investor_accounts SET balance=balance+? WHERE id=?').bind(amount,accountId),
   db.prepare('INSERT INTO investor_ledger(account_id,amount,balance_after,reason,created) VALUES(?,?,(SELECT balance FROM investor_accounts WHERE id=?),?,?)').bind(accountId,amount,accountId,'스트리머 지급',stamp())
  ]);
  await snapshotAccount(db,accountId,'포인트 지급');
  return {ok:true};
 }
 if(path==='/api/investors/trade'){
  const halt=await db.prepare("SELECT v FROM settings WHERE k='market_halt'").first();
  if(halt?.v==='1')throw Error('현재 시장 거래가 일시 중지되었습니다');
  const playerId=String(body.player_id||'');
  const player=await db.prepare('SELECT id,name,price FROM players WHERE id=?').bind(playerId).first();
  if(!player)throw Error('상장된 선수가 아닙니다');
  const side=String(body.side||''),quantity=Number(body.quantity);
  if(!['buy','sell'].includes(side)||!Number.isSafeInteger(quantity)||quantity<1||quantity>100000)throw Error('거래 유형 또는 수량이 올바르지 않습니다');
  const quoted=Number(body.quoted_price);
  if(!Number.isSafeInteger(quoted)||quoted!==player.price)throw Error('주가가 변경되었습니다. 최신 가격으로 다시 확인해 주세요');
  const total=quantity*player.price;
  if(!Number.isSafeInteger(total)||total>1000000000000)throw Error('거래 금액이 너무 큽니다');
  const holding=await db.prepare('SELECT quantity,cost_basis FROM investor_holdings WHERE account_id=? AND player_id=?').bind(accountId,playerId).first();
  if(side==='buy'&&account.balance<total)throw Error('시청자 보유 포인트가 부족합니다');
  if(side==='sell'&&Number(holding?.quantity||0)<quantity)throw Error('시청자 보유 주식이 부족합니다');
  const now=stamp();
  if(side==='buy'){
   await db.batch([
    db.prepare('UPDATE investor_accounts SET balance=balance-? WHERE id=?').bind(total,accountId),
    db.prepare('INSERT INTO investor_holdings(account_id,player_id,quantity,cost_basis) VALUES(?,?,?,?) ON CONFLICT(account_id,player_id) DO UPDATE SET quantity=quantity+excluded.quantity,cost_basis=cost_basis+excluded.cost_basis').bind(accountId,playerId,quantity,total),
    db.prepare('INSERT INTO investor_trades(account_id,player_id,side,quantity,price,total,created) VALUES(?,?,?,?,?,?,?)').bind(accountId,playerId,side,quantity,player.price,total,now)
   ]);
  }else{
   const costRemoved=Math.round(Number(holding.cost_basis)*quantity/Number(holding.quantity));
   await db.batch([
    db.prepare('UPDATE investor_holdings SET quantity=quantity-?,cost_basis=MAX(0,cost_basis-?) WHERE account_id=? AND player_id=? AND quantity>=?').bind(quantity,costRemoved,accountId,playerId,quantity),
    db.prepare('UPDATE investor_accounts SET balance=balance+? WHERE id=?').bind(total,accountId),
    db.prepare('INSERT INTO investor_trades(account_id,player_id,side,quantity,price,total,created) VALUES(?,?,?,?,?,?,?)').bind(accountId,playerId,side,quantity,player.price,total,now)
   ]);
  }
  await snapshotAccount(db,accountId,side==='buy'?'주식 매수':'주식 매도');
  return {ok:true,price:player.price,total};
 }
 throw Error('알 수 없는 거래 요청');
}

const OWNER_NICK='__JJOSA_OWNER_ONLY__';
async function ownerAccount(db){
 await tradeSchema(db);
 await db.prepare('INSERT OR IGNORE INTO investor_accounts(nickname,balance,created) VALUES(?,?,?)').bind(OWNER_NICK,1000000,stamp()).run();
 return db.prepare('SELECT id,nickname,balance FROM investor_accounts WHERE nickname=?').bind(OWNER_NICK).first();
}
async function ownerAction(env,path,body){
 const db=env.DB,owner=await ownerAccount(db);
 if(path==='/api/owner/state'){
  const data=await investors(db);
  const trades=await db.prepare('SELECT t.id,t.player_id,p.name AS player_name,t.side,t.quantity,t.price,t.total,t.created FROM investor_trades t LEFT JOIN players p ON p.id=t.player_id WHERE t.account_id=? ORDER BY t.id DESC LIMIT 300').bind(owner.id).all();
  const ledger=await db.prepare('SELECT amount,balance_after,reason,created FROM investor_ledger WHERE account_id=? ORDER BY id DESC LIMIT 100').bind(owner.id).all();
  await marketSchema(db);
  const initial=await db.prepare('SELECT 1 AS exists_row FROM portfolio_snapshots WHERE account_id=? LIMIT 1').bind(owner.id).first();
  if(!initial)await snapshotAccount(db,owner.id,'최초 자산 기준점');
  const history=await db.prepare('SELECT created,cash,holdings_value,total_value,reason FROM portfolio_snapshots WHERE account_id=? ORDER BY id DESC LIMIT 240').bind(owner.id).all();
  return {ok:true,account:owner,holdings:data.holdings.filter(x=>x.account_id===owner.id),trades:trades.results,ledger:ledger.results,history:history.results.reverse()};
 }
 if(path==='/api/owner/fund'){
  const amount=Number(body.amount);
  if(!Number.isSafeInteger(amount)||amount<1||amount>1000000000)throw Error('충전 금액은 1~10억 P');
  return investorAction(env,'/api/investors/grant',{account_id:owner.id,amount});
 }
 if(path==='/api/owner/trade'){
  return investorAction(env,'/api/investors/trade',{...body,account_id:owner.id});
 }
 throw Error('지원하지 않는 요청');
}



const NOTICE_CATEGORIES={tournament:1,win:1.5,return:.8,scheduled:.3,neutral:0,break:0,other:0};
async function noticeSchema(db){
 await db.prepare("CREATE TABLE IF NOT EXISTS soop_notice_config (k TEXT PRIMARY KEY,v TEXT NOT NULL)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS soop_notice_posts (id INTEGER PRIMARY KEY AUTOINCREMENT,bj_id TEXT NOT NULL,post_no TEXT NOT NULL,player_id TEXT NOT NULL,title TEXT NOT NULL,url TEXT NOT NULL,created TEXT NOT NULL,detected TEXT NOT NULL,category TEXT NOT NULL,proposed_pct REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reviewed TEXT,applied_pct REAL NOT NULL DEFAULT 0,UNIQUE(bj_id,post_no))").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS soop_notice_log (id INTEGER PRIMARY KEY AUTOINCREMENT,created TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL)").run();
}
async function noticeConfig(db){
 await noticeSchema(db);
 const row=await db.prepare("SELECT v FROM soop_notice_config WHERE k='active'").first();
 return row?JSON.parse(row.v):{auto_check:true,interval_minutes:10,approval_mode:'optional',daily_cap:2,price_effect_enabled:false};
}
function classifyNotice(title){
 const t=String(title).slice(0,180);
 if(/개인사정|건강|사고|병원|논란|사과|휴방|잠시 쉬|방송 쉼/i.test(t))return {category:'break',pct:0};
 if(/우승|챔피언|1등 확정/i.test(t)&&/배그|PUBG|대회|경쟁전/i.test(t))return {category:'win',pct:1.5};
 if(/배그|PUBG|경쟁전/i.test(t)&&/대회|참가|출전/i.test(t))return {category:'tournament',pct:1};
 if(/배그|PUBG/i.test(t)&&/복귀|컴백/i.test(t))return {category:'return',pct:.8};
 if(/배그|PUBG|경쟁전/i.test(t)&&/방송|진행|예정/i.test(t))return {category:'scheduled',pct:.3};
 return {category:'neutral',pct:0};
}
async function ingestNotice(db,bjId,postNo,title,url){
 await noticeSchema(db);
 const c=await db.prepare("SELECT player_id FROM soop_candidates WHERE bj_id=? AND status='approved'").bind(bjId).first();
 if(!c?.player_id||!await db.prepare('SELECT id FROM players WHERE id=?').bind(c.player_id).first())throw Error('연결된 상장 선수 없음');
 if(!/^https:\/\/www\.sooplive\.com\/station\/[a-zA-Z0-9_-]+\/post\/[0-9]+$/.test(url))throw Error('올바른 SOOP 공지 URL 필요');
 if(url.split('/')[4]!==bjId||url.split('/')[6]!==String(postNo))throw Error('공지 작성 채널과 주소 불일치');
 const v=classifyNotice(title);
 await db.prepare("INSERT OR IGNORE INTO soop_notice_posts(bj_id,post_no,player_id,title,url,created,detected,category,proposed_pct,status) VALUES(?,?,?,?,?,?,?,?,?,'pending')").bind(bjId,String(postNo),c.player_id,String(title).slice(0,180),url,stamp(),stamp(),v.category,v.pct).run();
 return v;
}
async function scanNoticeBoards(env){
 const db=env.DB,cfg=await noticeConfig(db);
 if(!cfg.auto_check)return {skipped:'자동 확인 OFF'};
 // The undocumented channel endpoint is NOT called without explicit operator confirmation
 // that the intended use is authorized by SOOP. No authentication bypass or retry evasion.
 if(env.SOOP_BOARD_FETCH_APPROVED!=='true')return {skipped:'SOOP 게시판 수집 허용 여부 미확인: 수집 대기'};
 const slot=Math.floor(Date.now()/(cfg.interval_minutes*60000));
 const prev=await db.prepare("SELECT v FROM soop_notice_config WHERE k='last_scan_slot'").first();
 if(Number(prev?.v)===slot)return {skipped:'10분 확인 주기 대기'};
 await db.prepare("INSERT INTO soop_notice_config(k,v) VALUES('last_scan_slot',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(slot)).run();
 await soopSchema(db);
 const channels=await db.prepare("SELECT bj_id FROM soop_candidates WHERE status='approved' AND player_id IS NOT NULL ORDER BY bj_id LIMIT 10").all();
 let found=0,errors=[];
 for(const c of channels.results){
  try{
   const endpoint='https://api-channel.sooplive.com/v1.1/channel/'+encodeURIComponent(c.bj_id)+'/board?perPage=10&type=all&orderBy=reg_date&page=1';
   const response=await fetch(endpoint,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(7000)});
   if(!response.ok)throw Error('HTTP '+response.status);
   const data=await response.json();
   if(!Array.isArray(data.contents))throw Error('게시판 응답 형식 변경');
   const posts=[...data.contents,...(Array.isArray(data.noticeData)?data.noticeData:[])].filter(x=>String(x.userId)===c.bj_id&&/^\d+$/.test(String(x.titleNo||''))).sort((a,b)=>Number(b.titleNo)-Number(a.titleNo));
   const baseline=await db.prepare("SELECT v FROM soop_notice_config WHERE k=?").bind('baseline:'+c.bj_id).first();
   const newest=posts.length?String(posts[0].titleNo):null;
   if(!baseline){if(newest)await db.prepare("INSERT OR IGNORE INTO soop_notice_config(k,v) VALUES(?,?)").bind('baseline:'+c.bj_id,newest).run();continue}
   for(const p of posts.filter(x=>BigInt(String(x.titleNo))>BigInt(baseline.v)).slice(0,3)){
    const url='https://www.sooplive.com/station/'+c.bj_id+'/post/'+p.titleNo;
    await ingestNotice(db,c.bj_id,p.titleNo,String(p.title||'공지'),url);found++;
   }
   if(newest&&BigInt(newest)>BigInt(baseline.v))await db.prepare("UPDATE soop_notice_config SET v=? WHERE k=?").bind(newest,'baseline:'+c.bj_id).run();
  }catch(e){errors.push(c.bj_id+': '+String(e.message).slice(0,90))}
 }
 await db.prepare("INSERT INTO soop_notice_log(created,action,detail) VALUES(?,?,?)").bind(stamp(),'scan',JSON.stringify({found,errors})).run();
 return {found,errors,channels:channels.results.length};
}
async function applyNotice(db,id){
 const cfg=await noticeConfig(db),post=await db.prepare('SELECT * FROM soop_notice_posts WHERE id=?').bind(id).first();
 if(!post||post.status!=='pending')throw Error('대기 중인 공지가 아닙니다');
 const player=await db.prepare('SELECT price FROM players WHERE id=?').bind(post.player_id).first();
 if(!player)throw Error('상장된 선수가 없습니다');
 const kstDay=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 const previous=await db.prepare("SELECT COALESCE(SUM(applied_pct),0) AS total FROM soop_notice_posts WHERE player_id=? AND status='applied' AND substr(datetime(reviewed,'+9 hours'),1,10)=?").bind(post.player_id,kstDay).first();
 const remaining=Math.max(0,cfg.daily_cap-Number(previous.total||0)),pct=Math.min(Math.max(0,post.proposed_pct),remaining);
 if(!cfg.price_effect_enabled)throw Error('공지 주가 반영 스위치가 OFF입니다');
 const price=Math.max(100,Math.round(player.price*(1+pct/100)));
 const result=await db.prepare("UPDATE soop_notice_posts SET status='applied',reviewed=?,applied_pct=? WHERE id=? AND status='pending'").bind(stamp(),pct,id).run();
 if(!result.meta?.changes)throw Error('이미 처리된 공지입니다');
 await db.batch([
  db.prepare('UPDATE players SET price=?,updated=? WHERE id=?').bind(price,stamp(),post.player_id),
  db.prepare('INSERT OR IGNORE INTO ticks(player,match_id,created,price,change_pct,reason) VALUES(?,?,?,?,?,?)').bind(post.player_id,'soop-notice:'+post.bj_id+':'+post.post_no,stamp(),price,pct,'SOOP 공지 이벤트: '+post.category)
 ]);
 return {price,pct};
}


async function stockImageSchema(db){
 await db.prepare("CREATE TABLE IF NOT EXISTS stock_images(player_id TEXT PRIMARY KEY,image_data TEXT NOT NULL,updated TEXT NOT NULL)").run();
}
function validateStockImage(value){
 if(typeof value!=='string'||value.length>145000||!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))throw Error('PNG/JPG/WebP 이미지 100KB 이하만 등록할 수 있습니다');
 return value;
}
async function stockImageMap(db){
 await stockImageSchema(db);
 const r=await db.prepare('SELECT player_id,image_data FROM stock_images').all();
 return Object.fromEntries(r.results.map(x=>[x.player_id,x.image_data]));
}

async function soopSchema(db){
 await db.prepare("CREATE TABLE IF NOT EXISTS soop_candidates (bj_id TEXT PRIMARY KEY,bj_nick TEXT NOT NULL,title TEXT NOT NULL DEFAULT '',category TEXT NOT NULL DEFAULT '',viewers INTEGER NOT NULL DEFAULT 0,channel_url TEXT NOT NULL DEFAULT '',first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',pubg_name TEXT,platform TEXT,player_id TEXT)").run();
}
async function scanSoop(env,force=false){
 const db=env.DB;await soopSchema(db);
 const cycle=Math.floor(Date.now()/1800000),previous=await db.prepare("SELECT v FROM meta WHERE k='soop_scan_cycle'").first();
 if(!force&&Number(previous?.v)===cycle)return {skipped:true,reason:'30분 탐색 주기 대기'};
 if(!env.OANOR_API_KEY)throw Error('SOOP 탐색 연동을 위해 OANOR_API_KEY Worker 비밀키 설정이 필요합니다');
 const res=await fetch('https://api.oanor.com/soop-api/v1/live?limit=60',{headers:{'x-oanor-key':env.OANOR_API_KEY,'Accept':'application/json'},signal:AbortSignal.timeout(12000)});
 if(!res.ok)throw Error('SOOP 방송 정보 제공 API 오류: HTTP '+res.status);
 const data=await res.json(),broadcasts=data?.data?.broadcasts;
 if(!Array.isArray(broadcasts))throw Error('SOOP 방송 응답 형식이 예상과 다릅니다');
 let matched=0,added=0;
 for(const b of broadcasts){
  const category=String(b.category||''),title=String(b.title||''),tags=Array.isArray(b.hashtags)?b.hashtags.join(' '):'';
  if(!/배틀그라운드|PUBG|배그/i.test(category+' '+tags+' '+title))continue;
  const id=String(b.bj_id||'').trim(),nick=String(b.bj_nick||'').trim();
  if(!/^[a-zA-Z0-9_-]{2,80}$/.test(id)||!nick)continue;
  matched++;
  const existing=await db.prepare('SELECT bj_id FROM soop_candidates WHERE bj_id=?').bind(id).first();
  await db.prepare("INSERT INTO soop_candidates(bj_id,bj_nick,title,category,viewers,channel_url,first_seen,last_seen) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(bj_id) DO UPDATE SET bj_nick=excluded.bj_nick,title=excluded.title,category=excluded.category,viewers=excluded.viewers,channel_url=excluded.channel_url,last_seen=excluded.last_seen").bind(id,nick,title.slice(0,400),category.slice(0,120),Math.max(0,Number(b.viewers)||0),String(b.channel_url||'https://play.sooplive.co.kr/'+id).slice(0,300),stamp(),stamp()).run();
  if(!existing)added++;
 }
 await db.prepare("INSERT INTO meta(k,v) VALUES('soop_scan_cycle',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(cycle)).run();
 await db.prepare("INSERT INTO meta(k,v) VALUES('soop_scan_finished',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(stamp()).run();
 await db.prepare("DELETE FROM meta WHERE k='soop_scan_error'").run();
 return {checked:broadcasts.length,matched,added,coverage:'상위 최대 60개 라이브 방송 중 PUBG 관련 방송'};
}
async function soopCandidates(db){
 await soopSchema(db);
 const rows=await db.prepare("SELECT bj_id,bj_nick,title,category,viewers,channel_url,first_seen,last_seen,status,pubg_name,platform,player_id FROM soop_candidates ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,last_seen DESC LIMIT 250").all();
 const last=await db.prepare("SELECT v FROM meta WHERE k='soop_scan_finished'").first(),error=await db.prepare("SELECT v FROM meta WHERE k='soop_scan_error'").first();
 return {candidates:rows.results,mode:'manual',last_scan:last?.v||null,error:error?.v||null};
}

export default {
 async scheduled(event,env,ctx){ctx.waitUntil(scanNoticeBoards(env).catch(()=>{}));ctx.waitUntil(sync(env).catch(async e=>{try{await env.DB.prepare("INSERT INTO meta(k,v) VALUES('sync_error',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(e.message||e)).run()}catch(_){}}));},
 async fetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 try{
  if(path==='/api/soop/notices'&&request.method==='GET'){
   const config=await noticeConfig(env.DB);
   const posts=await env.DB.prepare('SELECT n.*,p.name FROM soop_notice_posts n LEFT JOIN players p ON p.id=n.player_id ORDER BY n.id DESC LIMIT 100').all();
   return J({config,posts:posts.results,collector_authorized:env.SOOP_BOARD_FETCH_APPROVED==='true'});
  }
  if(path==='/api/market/effects'&&request.method==='GET'){
   const config=await getEffectConfig(env.DB);return J({config,mode:'live_when_enabled'});
  }
  if(path==='/api/market/effects/history'&&request.method==='GET'){
   await effectSchema(env.DB);const id=url.searchParams.get('id');
   const rows=id?await env.DB.prepare('SELECT * FROM price_effect_events WHERE player=? ORDER BY created DESC LIMIT 100').bind(id).all():await env.DB.prepare('SELECT e.*,p.name FROM price_effect_events e LEFT JOIN players p ON p.id=e.player ORDER BY e.created DESC LIMIT 100').all();
   return J({events:rows.results.map(x=>({...x,details:JSON.parse(x.details)}))});
  }
  if(path==='/api/player/candles'&&request.method==='GET'){
   const id=url.searchParams.get('id')||'',period=url.searchParams.get('period')||'1d';
   if(!id||id.length>150||!['1d','1w','1m'].includes(period))return J({error:'선수 ID 또는 기간 오류'},400);
   await tradeSchema(env.DB);
   const data=await candleData(env.DB,id,period);return data?J(data):J({error:'상장된 선수가 아닙니다'},404);
  }
  if(path==='/api/market/analytics'&&request.method==='GET'){
   await tradeSchema(env.DB);
   return J(await marketAnalytics(env.DB));
  }
  if(path==='/api/market/news'&&request.method==='GET'){
   await marketSchema(env.DB);
   const [t,n]=await Promise.all([env.DB.prepare('SELECT t.*,p.name FROM ticks t JOIN players p ON p.id=t.player ORDER BY t.id DESC LIMIT 80').all(),env.DB.prepare('SELECT id,created,title,body,category FROM market_notices ORDER BY id DESC LIMIT 30').all()]);
   return J({news:[...t.results.map(x=>({...tickNews(x,{name:x.name}),player_id:x.player})),...n.results.map(x=>({...x,player_id:null}))].sort((a,b)=>String(b.created).localeCompare(String(a.created))).slice(0,80)});
  }
  if(path==='/api/market/fun'&&request.method==='GET'){
   const db=env.DB;
   const [recent,players,rankChange]=await Promise.all([
    db.prepare("SELECT t.id,t.player,t.created,t.price,t.change_pct,t.kills,t.damage,t.rank,t.reason,p.name FROM ticks t JOIN players p ON p.id=t.player ORDER BY t.id DESC LIMIT 100").all(),
    db.prepare("SELECT id,name,price FROM players").all(),
    db.prepare("SELECT v FROM meta WHERE k='steam_rank_changes_as_fpp'").first()
   ]);
   const items=recent.results;
   const alerts=items.filter(t=>Math.abs(Number(t.change_pct||0))>=5||Number(t.rank)===1||Number(t.kills)>=10).slice(0,12).map(t=>{
    const pct=Number(t.change_pct||0),kills=Number(t.kills||0);
    const kind=Math.abs(pct)>=8?(pct>0?'폭등':'폭락'):Math.abs(pct)>=5?(pct>0?'급등':'급락'):Number(t.rank)===1?'치킨':'고킬';
    return {id:t.id,player:t.player,name:t.name,kind,pct,kills,rank:t.rank,created:t.created};
   });
   const date=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
   const dayStart=date+'T00:00:00+09:00';
   const dayRows=await db.prepare("SELECT t.player,t.price,t.change_pct,t.created,p.name FROM ticks t JOIN players p ON p.id=t.player WHERE t.created>=? ORDER BY t.player,t.id").bind(dayStart).all();
   const daily=new Map();
   for(const t of dayRows.results){
    const v=Number(t.change_pct||0),end=Number(t.price||0);
    const start=v===-100?end:end/(1+v/100);
    if(!daily.has(t.player))daily.set(t.player,{id:t.player,name:t.name,start,price:end});
    else daily.get(t.player).price=end;
   }
   const kings=[...daily.values()].filter(x=>x.start>0).map(x=>({...x,pct:(x.price/x.start-1)*100})).sort((a,b)=>b.pct-a.pct).slice(0,3);
   const achievements=[];
   for(const p of players.results){
    const stats=await db.prepare("SELECT COUNT(CASE WHEN rank=1 THEN 1 END) AS chickens,MAX(kills) AS max_kills,COUNT(*) AS games FROM ticks WHERE player=? AND kills IS NOT NULL").bind(p.id).first();
    const badges=[];
    if(Number(stats.chickens)>=10)badges.push('치킨 사냥꾼');
    if(Number(stats.max_kills)>=10)badges.push('킬 머신');
    if(Number(stats.games)>=100)badges.push('베테랑');
    if(badges.length)achievements.push({id:p.id,name:p.name,badges});
   }
   let changes=[];try{changes=JSON.parse(rankChange?.v||'{}').changes||[]}catch(_){}
   return J({alerts,kings,rank_changes:changes.slice(0,10),achievements:achievements.slice(0,10),day:date,generated_at:stamp()});
  }
  if(path==='/api/leaderboard/steam'&&request.method==='GET'){
   try{return J(await steamTop100(env))}catch(e){return J({entries:[],error:String(e.message||e),region:'pc-as',mode:'squad-fpp'},503)}
  }
  if(path==='/api/state'&&request.method==='GET'){
   const [p,t,last,error,halt]=await Promise.all([env.DB.prepare('SELECT * FROM players ORDER BY price DESC').all(),env.DB.prepare('SELECT * FROM ticks ORDER BY id DESC LIMIT 250').all(),env.DB.prepare("SELECT v FROM meta WHERE k='sync_finished'").first(),env.DB.prepare("SELECT v FROM meta WHERE k='sync_error'").first(),env.DB.prepare("SELECT v FROM settings WHERE k='market_halt'").first()]);
   const queue=await env.DB.prepare("SELECT name,q.status,q.last_checked,q.last_error,q.applied FROM sync_queue q JOIN players p ON p.id=q.player ORDER BY p.name").all().catch(()=>({results:[]}));
   const completed=queue.results.filter(x=>x.status==='done').length;
   const rankRows=await env.DB.prepare("SELECT k,v FROM meta WHERE k LIKE 'rank_detail:%'").all();
   const rankMap=new Map(rankRows.results.map(x=>[x.k.slice(12),JSON.parse(x.v)]));
   const rankedPlayers=p.results.filter(x=>x.rp!=null).slice().sort((a,b)=>Number(b.rp)-Number(a.rp));
   const rankPositions=new Map(rankedPlayers.map((x,i)=>[x.id,i+1]));
   p.results=p.results.map(x=>({...x,rank_tier:rankMap.get(x.id)?.tier||null,rank_subtier:rankMap.get(x.id)?.subTier||null,rank_mode:rankMap.get(x.id)?.rankMode||null,rp_rank:rankPositions.get(x.id)||null}));
   const stockImages=await stockImageMap(env.DB);
   return J({players:p.results,stock_images:stockImages,ticks:t.results,market_halted:halt?.v==='1',connected:!!env.PUBG_API_KEY,interval:300,sync:{running:false,last_finished:last?.v||null,error:error?.v||null,completed,queue:queue.results}});
  }
  if(path==='/api/player/history'&&request.method==='GET'){
   const id=url.searchParams.get('id')||'';if(!id||id.length>150)return J({error:'올바른 선수 ID가 필요합니다'},400);
   const p=await env.DB.prepare('SELECT id,name,platform,price,rp FROM players WHERE id=?').bind(id).first();if(!p)return J({error:'상장된 선수가 아닙니다'},404);
   const ticks=await env.DB.prepare('SELECT id,player,match_id,created,price,change_pct,kills,damage,rank,rp_delta,reason FROM ticks WHERE player=? ORDER BY id DESC LIMIT 300').bind(id).all();
   return J({player:p,ticks:ticks.results});
  }
  if(path==='/api/market/overview'&&request.method==='GET'){
   const stats=await marketStats(env.DB);
   const ticks=await env.DB.prepare('SELECT t.*,p.name FROM ticks t JOIN players p ON p.id=t.player ORDER BY t.id DESC LIMIT 80').all();
   return J({...stats,news:ticks.results.map(t=>tickNews(t,{name:t.name})),generated_at:stamp()});
  }
  if(path==='/api/health'&&request.method==='GET')return J({ok:true,bindings:{db:!!env.DB,assets:!!env.ASSETS,admin_token:!!env.ADMIN_TOKEN,admin_password:!!env.ADMIN_PASSWORD,pubg_api_key:!!env.PUBG_API_KEY},deployment:'auth-diagnostics-v1'});
  if(path.startsWith('/api/')&&request.method==='POST'){
   const adminCredential=env.ADMIN_TOKEN||env.ADMIN_PASSWORD;
   if(!adminCredential)return J({error:'관리자 인증키가 현재 실행 중인 Worker에 연결되지 않았습니다. /api/health 확인'},503);
   if(request.headers.get('X-Admin-Token')!==adminCredential)return J({error:'관리자 인증값이 올바르지 않습니다'},403);
   if(Number(request.headers.get('content-length')||0)>(path==='/api/stock/image'||path==='/api/stock/list-with-image'?160000:10000))return J({error:'요청이 너무 큽니다'},413);
   const body=await request.json().catch(()=>({}));
   if(['/api/owner/state','/api/owner/fund','/api/owner/trade'].includes(path))return J(await ownerAction(env,path,body));
   if(path.startsWith('/api/investors/'))return J({error:'시청자 거래 기능이 비활성화되었습니다'},403);

   if(path==='/api/soop/notices/config'){
    const old=await noticeConfig(env.DB),next={...old,auto_check:body.auto_check===true,interval_minutes:10,approval_mode:'optional',daily_cap:2,price_effect_enabled:body.price_effect_enabled===true};
    await env.DB.prepare("INSERT INTO soop_notice_config(k,v) VALUES('active',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(next)).run();
    return J({ok:true,config:next,collector_authorized:env.SOOP_BOARD_FETCH_APPROVED==='true'});
   }
   if(path==='/api/soop/notices/scan')return J(await scanNoticeBoards(env));
   if(path==='/api/soop/notices/add'){
    const u=new URL(String(body.url||''));if(u.hostname!=='www.sooplive.com')throw Error('SOOP 공식 게시글 주소만 허용');
    const match=u.pathname.match(/^\/station\/([a-zA-Z0-9_-]+)\/post\/(\d+)$/);if(!match)throw Error('공지 URL 형식 오류');
    return J({ok:true,classification:await ingestNotice(env.DB,match[1],match[2],String(body.title||''),u.origin+u.pathname)});
   }
   if(path==='/api/soop/notices/review'){
    await noticeSchema(env.DB);const id=Number(body.id);
    if(!Number.isSafeInteger(id)||id<=0)throw Error('공지 ID 오류');
    if(body.action==='reject'){const r=await env.DB.prepare("UPDATE soop_notice_posts SET status='rejected',reviewed=? WHERE id=? AND status='pending'").bind(stamp(),id).run();return J({ok:!!r.meta?.changes})}
    if(body.action!=='approve')throw Error('승인 또는 거절 선택');
    return J({ok:true,...await applyNotice(env.DB,id)});
   }
   if(path==='/api/market/event'){
    const pct=Number(body.pct),hours=Number(body.hours),title=String(body.title||'돌발 시장 이벤트').trim().slice(0,80);
    if(!Number.isFinite(pct)||Math.abs(pct)>1||!Number.isFinite(hours)||hours<1||hours>72)throw Error('이벤트 변동률은 -1~1%, 지속 시간은 1~72시간');
    const e={title,pct,hours,expires:new Date(Date.now()+hours*3600000).toISOString()};
    await env.DB.prepare("INSERT INTO settings(k,v) VALUES('active_market_event',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(e)).run();
    return J({ok:true,event:e});
   }
   if(path==='/api/effects/config'){
    const next=validateEffects(body),old=await getEffectConfig(env.DB);
    await env.DB.batch([
     env.DB.prepare("INSERT INTO price_effect_settings(k,v,updated) VALUES('active',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v,updated=excluded.updated").bind(JSON.stringify(next),stamp()),
     env.DB.prepare('INSERT INTO price_effect_audit(created,previous,next) VALUES(?,?,?)').bind(stamp(),JSON.stringify(old),JSON.stringify(next))
    ]);
    return J({ok:true,config:next});
   }
   if(path==='/api/effects/preview'){
    const config=validateEffects(body.config||await getEffectConfig(env.DB));
    const id=String(body.player_id||''),player=await env.DB.prepare('SELECT id,name,price FROM players WHERE id=?').bind(id).first();
    if(!player)throw Error('선수를 선택해 주세요');
    const history=await env.DB.prepare('SELECT kills,damage,rank,change_pct FROM ticks WHERE player=? AND kills IS NOT NULL ORDER BY id DESC LIMIT 30').bind(id).all();
    const latest=history.results[0];if(!latest)throw Error('경기 기록이 없습니다');
    const priorEffects=await env.DB.prepare('SELECT base_pct FROM price_effect_events WHERE player=? AND match_id=(SELECT match_id FROM ticks WHERE player=? AND kills IS NOT NULL ORDER BY id DESC LIMIT 1)').bind(id,id).first();
    const base=priorEffects?Number(priorEffects.base_pct):Number(latest.change_pct);
    const result=effectCalculation({base,kills:latest.kills,damage:latest.damage,rank:latest.rank,history:history.results.slice(1),marketScore:null},config);
    return J({player,base_pct:base,preview:result,note:'최근 기록의 변동률을 기준으로 한 가상 미리보기이며 저장하지 않습니다. 기존 기록에 추가 효과가 이미 적용되었다면 기록된 원래 변동률을 사용합니다.'});
   }
   if(path==='/api/auth/check')return J({ok:true,message:'관리자 인증 성공'});
   if(path==='/api/soop/candidates')return J({...await soopCandidates(env.DB),provider_configured:!!env.OANOR_API_KEY});
   if(path==='/api/soop/add'){
    await soopSchema(env.DB);
    const raw=String(body.bj_id||'').trim();
    let id=raw;
    if(/^https?:\/\//i.test(raw)){const u=new URL(raw);if(!['play.sooplive.co.kr','bj.afreecatv.com','www.sooplive.co.kr','sooplive.co.kr'].includes(u.hostname))throw Error('SOOP 채널 주소만 입력하세요');id=u.pathname.split('/').filter(Boolean).at(-1)||'';}
    if(!/^[a-zA-Z0-9_-]{2,80}$/.test(id))throw Error('올바른 SOOP 채널 ID 또는 방송 주소를 입력하세요');
    const nick=String(body.bj_nick||'').trim();
    if(!nick||nick.length>80)throw Error('스트리머 이름을 입력하세요 (최대 80자)');
    const old=await env.DB.prepare('SELECT status FROM soop_candidates WHERE bj_id=?').bind(id).first();
    if(old?.status==='approved')throw Error('이미 상장된 스트리머입니다');
    await env.DB.prepare("INSERT INTO soop_candidates(bj_id,bj_nick,title,category,viewers,channel_url,first_seen,last_seen,status) VALUES(?,?,'','직접 등록',0,?,?,?,'pending') ON CONFLICT(bj_id) DO UPDATE SET bj_nick=excluded.bj_nick,last_seen=excluded.last_seen,status='pending'").bind(id,nick,'https://play.sooplive.co.kr/'+id,stamp(),stamp()).run();
    return J({ok:true,bj_id:id});
   }
   if(path==='/api/soop/scan')return J({error:'자동 탐색은 비활성화되었습니다. 원하는 스트리머를 직접 추가하세요.'},410);
   if(path==='/api/soop/reject'){await soopSchema(env.DB);const id=String(body.bj_id||'');const found=await env.DB.prepare('SELECT status FROM soop_candidates WHERE bj_id=?').bind(id).first();if(!found)throw Error('후보를 찾지 못했습니다');if(found.status==='approved')throw Error('이미 상장된 계정은 후보 거절로 삭제할 수 없습니다');await env.DB.prepare("UPDATE soop_candidates SET status='rejected' WHERE bj_id=?").bind(id).run();return J({ok:true});}
   if(path==='/api/soop/approve'){await soopSchema(env.DB);const id=String(body.bj_id||''),name=String(body.pubg_name||'').trim(),platform=String(body.platform||'steam');const found=await env.DB.prepare('SELECT status FROM soop_candidates WHERE bj_id=?').bind(id).first();if(!found||found.status!=='pending')throw Error('승인 대기 중인 후보만 등록할 수 있습니다');if(!name||name.length>64)throw Error('관리자가 확인한 PUBG 게임 닉네임을 입력하세요');const result=await register(env,name,platform);await env.DB.prepare("UPDATE soop_candidates SET status='approved',pubg_name=?,platform=?,player_id=? WHERE bj_id=?").bind(name,platform,result.id,id).run();return J({ok:true,...result});}
   if(path==='/api/stock/image'){
    const id=String(body.player_id||'');
    if(!id||!await env.DB.prepare('SELECT id FROM players WHERE id=?').bind(id).first())throw Error('상장된 종목을 선택하세요');
    await stockImageSchema(env.DB);
    if(body.remove===true){await env.DB.prepare('DELETE FROM stock_images WHERE player_id=?').bind(id).run();return J({ok:true,removed:true})}
    const img=validateStockImage(body.image_data);
    await env.DB.prepare("INSERT INTO stock_images(player_id,image_data,updated) VALUES(?,?,?) ON CONFLICT(player_id) DO UPDATE SET image_data=excluded.image_data,updated=excluded.updated").bind(id,img,stamp()).run();
    return J({ok:true,player_id:id});
   }
   if(path==='/api/stock/list-with-image'){
    const result=await register(env,String(body.name||'').trim(),String(body.platform||'steam'));
    if(body.image_data){
     const img=validateStockImage(body.image_data);await stockImageSchema(env.DB);
     await env.DB.prepare("INSERT INTO stock_images(player_id,image_data,updated) VALUES(?,?,?)").bind(result.id,img,stamp()).run();
    }
    return J({ok:true,...result});
   }
   if(path==='/api/players')return J({ok:true,...await register(env,String(body.name||'').trim(),String(body.platform||'steam'))});
   if(path==='/api/sync')return J({ok:true,status:await sync(env)});
   if(path==='/api/delete'){await env.DB.prepare('DELETE FROM players WHERE id=?').bind(body.id).run();return J({ok:true});}
   if(path==='/api/market/notice'){await marketSchema(env.DB);const title=String(body.title||'').trim(),content=String(body.body||'').trim();if(!title||title.length>100||content.length>1000)throw Error('공시 제목(1~100자)과 내용(최대 1000자)을 입력하세요');await env.DB.prepare('INSERT INTO market_notices(created,title,body,category) VALUES(?,?,?,?)').bind(stamp(),title,content,'운영 공시').run();return J({ok:true});}
   if(path==='/api/market/halt'){const halted=body.halted===true;await env.DB.prepare("INSERT INTO settings(k,v) VALUES('market_halt',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(halted?'1':'0').run();return J({ok:true,market_halted:halted});}
   if(path==='/api/settings'){const w=Number(body.rp_weight);if(!Number.isFinite(w)||w<0||w>100)throw Error('RP 비중은 0~100');await env.DB.prepare("INSERT INTO settings(k,v) VALUES('rp_weight',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(w)).run();return J({ok:true});}
  }
  if(path==='/admin'||path==='/overlay')return env.ASSETS.fetch(new Request(new URL(`${path}.html`,url),request));
  return env.ASSETS.fetch(request);
 }catch(e){return J({error:String(e.message||e)},400);}
}};
