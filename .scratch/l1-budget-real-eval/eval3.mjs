// 只读标定：本机 embedding 余弦相似度分布，以及不同门槛下“语义补充”的命中情况。不联网、不调用对话模型。
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {createLocalEmbedding} from '../../backend-ts/src/retrieval/retrieval-embedding.ts';
import {buildQueryTokens,scoreTokens} from '../../backend-ts/src/retrieval/retrieval-lexical.ts';
const [dbPath,contactId]=process.argv.slice(2);
const db=new DatabaseSync(dbPath,{readOnly:true});
const mem=scope=>db.prepare(`SELECT m.id,v.body FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no WHERE m.state='active' AND ${scope==='owner'?"m.scope_kind='self'":"m.contact_id=?"} ORDER BY m.id`).all(...(scope==='owner'?[]:[contactId])).map(r=>({scope,text:String(r.body)}));
const pool=[...mem('contact'),...mem('owner')];
const msgs=db.prepare("SELECT sender_role r,text_body t FROM message WHERE contact_id=? AND text_body IS NOT NULL AND trim(text_body)<>'' ORDER BY sent_at,order_key").all(contactId);
const moments=[];for(let i=0;i<msgs.length-1;i++)if(msgs[i].r!=='owner'&&msgs[i+1].r==='owner')moments.push(i);
const picked=moments.filter((_,k)=>k%Math.max(1,Math.floor(moments.length/120))===0).slice(-120);
const model=await createLocalEmbedding();
const cos=(a,b)=>{let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return d/Math.sqrt(x*y);};
const mv=await model.embed(pool.map(p=>p.text));
const taus=[0.40,0.45,0.50,0.55,0.60,0.65];
const rows={'想想(最近5条)':[], '表达(以真实回复代替草稿,≥12字)':[]};
const review=[];
async function run(name,query){
 const [qv]=await model.embed([query.length>400?Array.from(query).slice(0,200).join('')+Array.from(query).slice(-200).join(''):query]);
 const tokens=buildQueryTokens(query);
 const rec=pool.map((p,i)=>({p,cos:cos(qv,mv[i]),lex:scoreTokens(tokens,p.text).score}));
 rows[name].push(rec);return rec;
}
for(const i of picked){
 const w=msgs.slice(Math.max(0,i-49),i+1);
 const q1=w.slice(-5).map(m=>m.t).join('\n'),rec=await run('想想(最近5条)',q1);
 const draft=msgs[i+1].t;if(Array.from(draft).length>=12)await run('表达(以真实回复代替草稿,≥12字)',draft);
 if(review.length<20){const extra=rec.filter(r=>r.lex<0.15&&r.cos>=0.5).sort((a,b)=>b.cos-a.cos).slice(0,3);review.push(`## 时刻 ${review.length+1}\n对方最近：${w.slice(-3).map(m=>m.t).join(' / ')}\n- 词法已命中：${rec.filter(r=>r.lex>=0.15).map(r=>r.p.text).join(' ｜ ')||'（无）'}\n- 仅语义(≥0.5)补充：${extra.map(r=>`[${r.cos.toFixed(2)}] ${r.p.text}`).join(' ｜ ')||'（无）'}\n`);}
}
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))].toFixed(3);};
for(const [name,list] of Object.entries(rows)){
 if(!list.length)continue;
 const all=list.flat().map(r=>r.cos),lexHit=list.flat().filter(r=>r.lex>=0.15).map(r=>r.cos),top=list.map(rec=>Math.max(...rec.map(r=>r.cos)));
 console.log(`\n[${name}] 时刻 ${list.length}｜全部配对余弦 p50/p90/max = ${q(all,.5)}/${q(all,.9)}/${q(all,1)}｜词法命中配对余弦 p10/p50 = ${lexHit.length?q(lexHit,.1)+'/'+q(lexHit,.5):'-'}（${lexHit.length}对）｜每时刻最高余弦 p50/p90 = ${q(top,.5)}/${q(top,.9)}`);
 for(const t of taus){
  const sem=list.map(rec=>rec.filter(r=>r.cos>=t&&r.lex<0.15).length),lex=list.map(rec=>rec.filter(r=>r.lex>=0.15).length);
  console.log(`  τ=${t.toFixed(2)}：仅语义补充 平均 ${(sem.reduce((a,b)=>a+b,0)/list.length).toFixed(2)} 条/时刻，有补充的时刻 ${sem.filter(x=>x>0).length}/${list.length}｜词法命中均值 ${(lex.reduce((a,b)=>a+b,0)/list.length).toFixed(2)}`);
 }
}
writeFileSync(new URL('./review-semantic.md',import.meta.url),'# 本地人工核对用（含真实内容，勿提交）\n\n'+review.join('\n'));
await model.close();
