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
  if(!res.ok)throw Error(`PUBG API ${res.status}`);
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
 const p=d.data?.[0];if(!p)throw Error('선수를 찾지 못했습니다');
 if(await env.DB.prepare('SELECT id FROM players WHERE id=?').bind(p.id).first())throw Error('이미 등록된 선수입니다');
 const r=await ranked(env,{id:p.id,platform});
 await env.DB.prepare('INSERT INTO players(id,name,platform,rp,season,updated,created) VALUES(?,?,?,?,?,?,?)').bind(p.id,p.attributes?.name||name,platform,r.rp,r.season,stamp(),stamp()).run();
 const ids=p.relationships?.matches?.data||[];
 for(const m of ids)await env.DB.prepare('INSERT OR IGNORE INTO processed(player,match_id) VALUES(?,?)').bind(p.id,m.id).run();
 if(r.rp!=null)await env.DB.prepare('INSERT INTO snapshots(player,created,season,rp) VALUES(?,?,?,?)').bind(p.id,stamp(),r.season,r.rp).run();
 return p.id;
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
  if(stats&&String(attrs.matchType||'').toLowerCase()==='competitive'){
   const kills=Number(stats.kills||0),damage=Number(stats.damageDealt||0),rank=Number(stats.winPlace||16);
   const perf=clamp(kills*.8+damage/200+(rank===1?3:rank<=5?1:rank>=13?-3:rank>=9?-1:0)-3,-10,10);
   const row=await env.DB.prepare('SELECT price FROM players WHERE id=?').bind(p.id).first();
   const w=await env.DB.prepare("SELECT v FROM settings WHERE k='rp_weight'").first();
   const pct=clamp(perf*(1-Number(w?.v??50)/100),-10,10);
   const price=Math.max(100,Math.round(row.price*(1+pct/100)));
   await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO ticks(player,match_id,created,price,change_pct,kills,damage,rank,reason) VALUES(?,?,?,?,?,?,?,?,?)').bind(p.id,id,attrs.createdAt||stamp(),price,pct,kills,damage,rank,'경쟁전 경기'),
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
 const now=Date.now();const prev=await env.DB.prepare("SELECT v FROM meta WHERE k='sync_started'").first();
 if(prev&&now-Number(prev.v)<300000)return 'cooldown';
 await env.DB.prepare("INSERT INTO meta(k,v) VALUES('sync_started',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(now)).run();
 const rows=await env.DB.prepare('SELECT * FROM players ORDER BY COALESCE(updated,created) ASC LIMIT 1').all();
 if(!rows.results.length)return 'no_players';
 try{const result=await pollPlayer(env,rows.results[0]);await env.DB.prepare("INSERT INTO meta(k,v) VALUES('sync_finished',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(stamp()).run();return result;}
 catch(e){await env.DB.prepare("INSERT INTO meta(k,v) VALUES('sync_error',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(e.message)).run();throw e;}
}
export default {async fetch(request,env){
 const url=new URL(request.url),path=url.pathname;
 try{
  if(path==='/api/state'&&request.method==='GET'){
   const [p,t,last,error]=await Promise.all([env.DB.prepare('SELECT * FROM players ORDER BY price DESC').all(),env.DB.prepare('SELECT * FROM ticks ORDER BY id DESC LIMIT 250').all(),env.DB.prepare("SELECT v FROM meta WHERE k='sync_finished'").first(),env.DB.prepare("SELECT v FROM meta WHERE k='sync_error'").first()]);
   return J({players:p.results,ticks:t.results,connected:!!env.PUBG_API_KEY,interval:300,sync:{running:false,last_finished:last?.v||null,error:error?.v||null,completed:0}});
  }
  if(path.startsWith('/api/')&&request.method==='POST'){
   if(!env.ADMIN_TOKEN)return J({error:'ADMIN_TOKEN 비밀키가 설정되지 않았습니다'},403);
   if(request.headers.get('X-Admin-Token')!==env.ADMIN_TOKEN)return J({error:'관리자 토큰이 올바르지 않습니다'},403);
   if(Number(request.headers.get('content-length')||0)>10000)return J({error:'요청이 너무 큽니다'},413);
   const body=await request.json().catch(()=>({}));
   if(path==='/api/players')return J({ok:true,id:await register(env,String(body.name||'').trim(),String(body.platform||'steam'))});
   if(path==='/api/sync')return J({ok:true,status:await sync(env)});
   if(path==='/api/delete'){await env.DB.prepare('DELETE FROM players WHERE id=?').bind(body.id).run();return J({ok:true});}
   if(path==='/api/settings'){const w=Number(body.rp_weight);if(!Number.isFinite(w)||w<0||w>100)throw Error('RP 비중은 0~100');await env.DB.prepare("INSERT INTO settings(k,v) VALUES('rp_weight',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(String(w)).run();return J({ok:true});}
  }
  if(path==='/admin'||path==='/overlay')return env.ASSETS.fetch(new Request(new URL(`${path}.html`,url),request));
  return env.ASSETS.fetch(request);
 }catch(e){return J({error:String(e.message||e)},400);}
}};
