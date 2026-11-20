const J = (data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const stamp=()=>new Date().toISOString();
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
async function pubg(env,platform,path){
  if(!env.PUBG_API_KEY)throw Error('PUBG_API_KEY 비밀키가 설정되지 않았습니다');
  // Shared D1 gate, deliberately conservative: max 8 requests per rolling minute.
  const gate=await env.DB.prepare("SELECT v FROM meta WHERE k='api_gate'").first();
  const now=Date.now();const arr=gate?JSON.parse(gate.v).filter(t=>now-t<60000):[];
  if(arr.length>=8)throw Error('API_RATE_LIMIT: 잠시 후 다시 갱신해 주세요');
  arr.push(now);
  await env.DB.prepare("INSERT INTO meta(k,v) VALUES('api_gate',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(arr)).run();
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
async function ranked(env,p){
 const seasons=await pubg(env,p.platform,'seasons');const season=seasons.data?.find(s=>s.attributes?.isCurrentSeason)?.id;
 if(!season)return {season:null,rp:null};
 const d=await pubg(env,p.platform,`players/${encodeURIComponent(p.id)}/seasons/${encodeURIComponent(season)}/ranked`);
 const modes=d.data?.attributes?.rankedGameModeStats||{};
 return {season,rp:(modes['squad-fpp']||modes.squad||{}).currentRankPoint??null};
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
async function pollPlayer(env,p){
 const d=await pubg(env,p.platform,`players/${encodeURIComponent(p.id)}`);
 const ids=(d.data?.relationships?.matches?.data||[]).map(x=>x.id).reverse();
 const unseen=[];
 for(const id of ids){if(!(await env.DB.prepare('SELECT 1 FROM processed WHERE player=? AND match_id=?').bind(p.id,id).first()))unseen.push(id);}
 // A bounded batch is essential for free-tier CPU, external API limits and request duration.
 const batch=unseen.slice(0,2);let applied=0;
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
   const price=Math.max(100,Math.round(row.price*(1+pct/100)));
   await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO ticks(player,match_id,created,price,change_pct,kills,damage,rank,reason) VALUES(?,?,?,?,?,?,?,?,?)').bind(p.id,id,attrs.createdAt||stamp(),price,pct,kills,damage,rank,isRanked?'경쟁전 경기':'일반전 경기'),
    env.DB.prepare('UPDATE players SET price=?,updated=? WHERE id=?').bind(price,stamp(),p.id),
    env.DB.prepare('INSERT OR IGNORE INTO processed(player,match_id) VALUES(?,?)').bind(p.id,id)
   ]);applied++;
  }else await env.DB.prepare('INSERT OR IGNORE INTO processed(player,match_id) VALUES(?,?)').bind(p.id,id).run();
 }
 // Only compare RP when all currently discoverable matches have been processed.
 if(unseen.length<=batch.length){
  const r=await ranked(env,p);
  const delta=r.season===p.season&&r.rp!=null&&p.rp!=null?r.rp-p.rp:null;
  if(delta){
   const w=await env.DB.prepare("SELECT v FROM settings WHERE k='rp_weight'").first();
   const pct=clamp(clamp(delta/5,-10,10)*Number(w?.v??50)/100,-10,10);
   const row=await env.DB.prepare('SELECT price FROM players WHERE id=?').bind(p.id).first();
   const price=Math.max(100,Math.round(row.price*(1+pct/100)));
   await env.DB.prepare('INSERT INTO ticks(player,match_id,created,price,change_pct,rp_delta,reason) VALUES(?,?,?,?,?,?,?)').bind(p.id,`rp:${crypto.randomUUID()}`,stamp(),price,pct,delta,'RP 구간 변화').run();
   await env.DB.prepare('UPDATE players SET price=? WHERE id=?').bind(price,p.id).run();
  }
  await env.DB.prepare('UPDATE players SET rp=?,season=?,updated=? WHERE id=?').bind(r.rp,r.season,stamp(),p.id).run();
  if(r.rp!=null)await env.DB.prepare('INSERT INTO snapshots(player,created,season,rp) VALUES(?,?,?,?)').bind(p.id,stamp(),r.season,r.rp).run();
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
 const pending=await db.prepare("SELECT q.player,p.* FROM sync_queue q JOIN players p ON p.id=q.player WHERE q.status='pending' ORDER BY q.last_checked IS NOT NULL,q.last_checked ASC,q.player LIMIT 2").all();
 let checked=0,applied=0,failures=0;
 for(const p of pending.results){
  try{
   const r=await pollPlayer(env,p);
   checked++;applied+=r.applied;
   await db.prepare("UPDATE sync_queue SET status='done',attempts=attempts+1,last_checked=?,last_error=NULL,applied=? WHERE player=?").bind(stamp(),r.applied,p.id).run();
  }catch(e){
   const msg=String(e.message||e);
   if(msg.startsWith('API_RATE_LIMIT')||msg.includes('(429)'))break;
   failures++;
   await db.prepare("UPDATE sync_queue SET status='error',attempts=attempts+1,last_checked=?,last_error=? WHERE player=?").bind(stamp(),msg.slice(0,300),p.id).run();
  }
 }
 const counts=await db.prepare("SELECT status,COUNT(*) AS n FROM sync_queue GROUP BY status").all();
 const stats=Object.fromEntries(counts.results.map(x=>[x.status,x.n]));
 await db.prepare("INSERT INTO meta(k,v) VALUES('sync_finished',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(stamp()).run();
 if(failures)await db.prepare("INSERT INTO meta(k,v) VALUES('sync_error',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(failures+'명 조회 오류 (선수별 갱신 현황 확인)').run();
 else await db.prepare("DELETE FROM meta WHERE k='sync_error'").run();
 return {checked,applied,pending:stats.pending||0,failed:stats.error||0,completed:stats.done||0};
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
  return {ok:true};
 }
 if(path==='/api/investors/trade'){
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
    db.prepare('INSERT INTO investor_holdings(account_id,player_id,quantity,cost_basis) VALUES(?,?,?,0) ON CONFLICT(account_id,player_id) DO UPDATE SET quantity=quantity+excluded.quantity,cost_basis=MAX(0,cost_basis-?)').bind(accountId,playerId,-quantity,costRemoved),
    db.prepare('UPDATE investor_accounts SET balance=balance+? WHERE id=?').bind(total,accountId),
    db.prepare('INSERT INTO investor_trades(account_id,player_id,side,quantity,price,total,created) VALUES(?,?,?,?,?,?,?)').bind(accountId,playerId,side,quantity,player.price,total,now)
   ]);
  }
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
  return {ok:true,account:owner,holdings:data.holdings.filter(x=>x.account_id===owner.id),trades:data.trades.filter(x=>x.nickname===OWNER_NICK)};
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

export default {
 async scheduled(event,env,ctx){ctx.waitUntil(sync(env).catch(async e=>{try{await env.DB.prepare("INSERT INTO meta(k,v) VALUES('sync_error',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(e.message||e)).run()}catch(_){}}));},
 async fetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 try{
  if(path==='/api/state'&&request.method==='GET'){
   const [p,t,last,error]=await Promise.all([env.DB.prepare('SELECT * FROM players ORDER BY price DESC').all(),env.DB.prepare('SELECT * FROM ticks ORDER BY id DESC LIMIT 250').all(),env.DB.prepare("SELECT v FROM meta WHERE k='sync_finished'").first(),env.DB.prepare("SELECT v FROM meta WHERE k='sync_error'").first()]);
   const queue=await env.DB.prepare("SELECT name,q.status,q.last_checked,q.last_error,q.applied FROM sync_queue q JOIN players p ON p.id=q.player ORDER BY p.name").all().catch(()=>({results:[]}));
   const completed=queue.results.filter(x=>x.status==='done').length;
   return J({players:p.results,ticks:t.results,connected:!!env.PUBG_API_KEY,interval:300,sync:{running:false,last_finished:last?.v||null,error:error?.v||null,completed,queue:queue.results}});
  }
  if(path==='/api/health'&&request.method==='GET')return J({ok:true,bindings:{db:!!env.DB,assets:!!env.ASSETS,admin_token:!!env.ADMIN_TOKEN,admin_password:!!env.ADMIN_PASSWORD,pubg_api_key:!!env.PUBG_API_KEY},deployment:'auth-diagnostics-v1'});
  if(path.startsWith('/api/')&&request.method==='POST'){
   const adminCredential=env.ADMIN_TOKEN||env.ADMIN_PASSWORD;
   if(!adminCredential)return J({error:'관리자 인증키가 현재 실행 중인 Worker에 연결되지 않았습니다. /api/health 확인'},503);
   if(request.headers.get('X-Admin-Token')!==adminCredential)return J({error:'관리자 인증값이 올바르지 않습니다'},403);
   if(Number(request.headers.get('content-length')||0)>10000)return J({error:'요청이 너무 큽니다'},413);
   const body=await request.json().catch(()=>({}));
   if(['/api/owner/state','/api/owner/fund','/api/owner/trade'].includes(path))return J(await ownerAction(env,path,body));
   if(path.startsWith('/api/investors/'))return J({error:'시청자 거래 기능이 비활성화되었습니다'},403);

   if(path==='/api/auth/check')return J({ok:true,message:'관리자 인증 성공'});
   if(path==='/api/players')return J({ok:true,...await register(env,String(body.name||'').trim(),String(body.platform||'steam'))});
   if(path==='/api/sync')return J({ok:true,status:await sync(env)});
   if(path==='/api/delete'){await env.DB.prepare('DELETE FROM players WHERE id=?').bind(body.id).run();return J({ok:true});}
   if(path==='/api/settings'){const w=Number(body.rp_weight);if(!Number.isFinite(w)||w<0||w>100)throw Error('RP 비중은 0~100');await env.DB.prepare("INSERT INTO settings(k,v) VALUES('rp_weight',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(w)).run();return J({ok:true});}
  }
  if(path==='/admin'||path==='/overlay')return env.ASSETS.fetch(new Request(new URL(`${path}.html`,url),request));
  return env.ASSETS.fetch(request);
 }catch(e){return J({error:String(e.message||e)},400);}
}};
