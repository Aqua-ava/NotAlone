// 真实模型对照（含真实内容，勿提交）：同一回复时刻、同一近期聊天，只改 L1 记忆的选取方式。
// 臂：OLD=改动前（最近50条做字面检索，5/600、3/240）｜NEW=混合检索（最近5条，0.8稠密+0.2稀疏，门槛0.48）｜NONE=不带 L1 记忆。
// 提示词沿用线上系统提示与输入材料格式；模型与端点沿用应用配置（deepseek-flash，Messages 端点，temperature 0，thinking 关）。
// 用法：node --no-warnings ab.mjs <库副本> <contact_id> [最多时刻数]
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {buildQueryTokens,RELEVANCE_THRESHOLD} from '../../backend-ts/src/retrieval/retrieval-lexical.ts';
import {rankMemories} from '../../backend-ts/src/retrieval/retrieval-ranking.ts';
import {messageTimePrefix} from '../../backend-ts/src/reply/sqlite/candidates/input.ts';
import {toneLabel} from '../../backend-ts/src/reply/sqlite/candidates/workspace.ts';
import {readSqliteModelEnvironment} from '../../backend-ts/src/host/sqlite-model-config.ts';

const [dbPath,contactId,limitArg]=process.argv.slice(2);
const env=await readSqliteModelEnvironment(new URL('../../.env',import.meta.url).pathname,process.env);
const key=env.NOTALONE_DEEPSEEK_API_KEY,model=env.NOTALONE_DEEPSEEK_MODEL||'deepseek-flash';
const base=(env.NOTALONE_DEEPSEEK_BASE_URL||'https://api.deepseek.com').replace(/\/+$/,'');
if(!key)throw new Error('未配置模型密钥');
const db=new DatabaseSync(dbPath,{readOnly:true});
const mem=scope=>db.prepare(`SELECT m.id,v.body,v.adoption_mode FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no WHERE m.state='active' AND ${scope==='owner'?"m.scope_kind='self'":"m.contact_id=?"} ORDER BY m.id`).all(...(scope==='owner'?[]:[contactId])).map(r=>({kind:'memory',id:String(r.id),scopeKind:scope,text:String(r.body),qualification:r.adoption_mode==='auto'?'auto':'confirmed'}));
const pool=[...mem('contact'),...mem('owner')].map((p,i)=>({...p,tag:`${p.scopeKind==='contact'?'C':'O'}${String(i+1).padStart(2,'0')}`}));
const msgs=db.prepare("SELECT sender_role r,text_body t,sent_at FROM message WHERE contact_id=? AND text_body IS NOT NULL AND trim(text_body)<>'' ORDER BY sent_at,order_key").all(contactId);
const {data}=JSON.parse(readFileSync(new URL('./label-data.json',import.meta.url)));
// 与 eval5 相同的时刻选取（保证与人工标注的 27 个时刻一一对应）
const moments=[];for(let i=0;i<msgs.length-1;i++)if(msgs[i].r!=='owner'&&msgs[i+1].r==='owner')moments.push(i);
const picked=moments.filter((_,k)=>k%Math.max(1,Math.floor(moments.length/120))===0).slice(-120).filter((_,k)=>k%4===0);
if(picked.length!==data.length)throw new Error(`时刻数不一致 ${picked.length} vs ${data.length}`);

function oldSelect(query){
 const tokens=buildQueryTokens(query),out=[];
 for(const [scope,maxCount,maxChars] of [['contact',5,600],['owner',3,240]]){
  const sub=pool.filter(i=>i.scopeKind===scope);let chars=0,count=0;
  const ranked=sub.length&&tokens.length?rankMemories(sub.map(item=>({item,text:item.text,memory_id:item.id,adoption_method:item.qualification==='confirmed'?'manual':'auto',confidence:0,valid_at:null})),tokens,sub.length):[];
  for(const {item,relevance_score} of ranked){const size=Array.from(item.text).length;if(relevance_score<RELEVANCE_THRESHOLD||count>=maxCount||chars+size>maxChars)continue;out.push(item);count++;chars+=size;}
 }
 return out;
}
function newSelect(rec){
 const byTag=new Map(pool.map(p=>[p.tag,p]));
 const sc=rec.map(r=>({...r,s:0.8*r.cos+0.2*r.lex}));
 const pick=(scope,cap)=>sc.filter(r=>r.scope===scope&&r.s>=0.48).sort((a,b)=>b.s-a.s).slice(0,cap).map(r=>byTag.get(r.tag));
 return [...pick('contact',5),...pick('owner',3)];
}

const system=readFileSync(new URL('../../backend-ts/src/reply/sqlite/candidates/turns.ts',import.meta.url),'utf8').match(/const systemPrompt='((?:[^'\\]|\\.)*)';/)[1];
function buildPrompt(i,memories){
 const win=msgs.slice(Math.max(0,i-49),i+1);
 const items=[];
 for(const m of win)items.push({kind:'message',text:messageTimePrefix(BigInt(m.sent_at))+`${m.r==='owner'?'我':'对方'}：${m.t}`});
 items.push({kind:'entry',text:`本次工作区请求：用户请求帮我想想；尚未确认任何立场，候选只是可选建议。\n语气要求：${toneLabel('original')}\n关系背景：已启用`});
 for(const m of memories)items.push({kind:'memory',text:m.text});
 return '本次工作区动作：帮我想想。用户没有提供草稿时尚未确认任何立场，所有说法都只是可选思路。\n\n实际输入材料（编号用于basis）：\n'+items.map((it,n)=>`[${n+1}] ${it.kind}\n${it.text}`).join('\n\n')+'\n\n输出检查：每条候选必须同时包含parts和basis两个字段；basis至少填写一个本次实际材料编号。只写parts的候选无法交付。';
}
async function call(prompt){
 for(let attempt=0;attempt<3;attempt++){
  const res=await fetch(`${base}/anthropic/v1/messages`,{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
   body:JSON.stringify({model,max_tokens:2000,temperature:0,thinking:{type:'disabled'},system,messages:[{role:'user',content:prompt}]})});
  const body=await res.text();
  if(!res.ok){if(attempt<2){await new Promise(r=>setTimeout(r,2000));continue;}return {error:`HTTP ${res.status} ${body.slice(0,200)}`};}
  try{const text=JSON.parse(body).content.filter(b=>b.type==='text').map(b=>b.text).join('');
   const json=JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g,'').trim());return {candidates:json.candidates};}
  catch(e){return {error:'解析失败 '+String(body).slice(-400)};}
 }
}
const limit=Number(limitArg??picked.length);
const only=process.env.ONLY?new Set(process.env.ONLY.split(',').map(Number)):null;
const jobs=[];
for(const [n,i] of picked.slice(0,limit).entries()){
 if(only&&!only.has(n+1))continue;
 const rec=data[n].rec;
 const oldQuery=msgs.slice(Math.max(0,i-49),i+1).map(m=>`${m.r==='owner'?'我':'对方'}：${m.t}`).join('\n');
 const oldSel=oldSelect(oldQuery),newSel=newSelect(rec);
 const same=oldSel.map(x=>x.tag).sort().join()===newSel.map(x=>x.tag).sort().join();
 jobs.push({n:n+1,i,arms:{OLD:oldSel,NEW:newSel,NONE:[]},same});
}
const results=[];
let next=0;
async function worker(){
 while(next<jobs.length){
  const job=jobs[next++];const out={n:job.n,same:job.same,tags:{},gen:{}};
  for(const arm of ['OLD','NEW','NONE']){
   out.tags[arm]=job.arms[arm].map(x=>x.tag);
   if(arm==='NEW'&&job.same){out.gen.NEW=out.gen.OLD;continue;}
   out.gen[arm]=await call(buildPrompt(job.i,job.arms[arm]));
  }
  results.push(out);process.stderr.write(`moment ${job.n} done\n`);
 }
}
await Promise.all([worker(),worker(),worker()]);
if(only){const prev=JSON.parse(readFileSync(new URL('./ab/results.json',import.meta.url))).results.filter(r=>!only.has(r.n));results.push(...prev);}
results.sort((a,b)=>a.n-b.n);
mkdirSync(new URL('./ab/',import.meta.url),{recursive:true});
writeFileSync(new URL('./ab/results.json',import.meta.url),JSON.stringify({pool:pool.map(p=>({tag:p.tag,text:p.text})),results,moments:picked.slice(0,limit).map((i,k)=>({n:k+1,recent:msgs.slice(Math.max(0,i-3),i+1).map(m=>`${m.r==='owner'?'我':'对方'}：${m.t}`),actual:msgs[i+1].t}))}));
console.log('完成',results.length,'个时刻；相同选取（OLD=NEW）',results.filter(r=>r.same).length,'；失败',results.filter(r=>Object.values(r.gen).some(g=>g?.error)).length);
