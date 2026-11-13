// 生成人工标注表（本地，含真实内容，勿提交）：每个回复时刻列出候选记忆编号与各路得分。
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {createLocalEmbedding} from '../../backend-ts/src/retrieval/retrieval-embedding.ts';
import {buildQueryTokens,scoreTokens} from '../../backend-ts/src/retrieval/retrieval-lexical.ts';
const [dbPath,contactId,modelDir]=process.argv.slice(2);
const db=new DatabaseSync(dbPath,{readOnly:true});
const mem=scope=>db.prepare(`SELECT m.id,v.body FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no WHERE m.state='active' AND ${scope==='owner'?"m.scope_kind='self'":"m.contact_id=?"} ORDER BY m.id`).all(...(scope==='owner'?[]:[contactId])).map(r=>({scope,text:String(r.body)}));
const pool=[...mem('contact'),...mem('owner')].map((p,i)=>({...p,tag:`${p.scope==='contact'?'C':'O'}${String(i+1).padStart(2,'0')}`}));
const msgs=db.prepare("SELECT sender_role r,text_body t FROM message WHERE contact_id=? AND text_body IS NOT NULL AND trim(text_body)<>'' ORDER BY sent_at,order_key").all(contactId);
const moments=[];for(let i=0;i<msgs.length-1;i++)if(msgs[i].r!=='owner'&&msgs[i+1].r==='owner')moments.push(i);
const picked=moments.filter((_,k)=>k%Math.max(1,Math.floor(moments.length/120))===0).slice(-120).filter((_,k)=>k%4===0);
const model=await createLocalEmbedding(modelDir);
const cos=(a,b)=>{let d=0,x=0,y=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];x+=a[i]*a[i];y+=b[i]*b[i];}return d/Math.sqrt(x*y);};
const mv=await model.embed(pool.map(p=>p.text));
const data=[];
for(const [n,i] of picked.entries()){
 const query=msgs.slice(Math.max(0,i-4),i+1).map(m=>m.t).join('\n');
 const [qv]=await model.embed([query]);const tokens=buildQueryTokens(query);
 const rec=pool.map((p,k)=>({tag:p.tag,scope:p.scope,cos:cos(qv,mv[k]),lex:scoreTokens(tokens,p.text).score}));
 const top=(f,k)=>[...rec].sort((a,b)=>f(b)-f(a)).slice(0,k).map(r=>r.tag);
 const cand=[...new Set([...top(r=>r.cos,6),...top(r=>r.lex,4),...top(r=>0.8*r.cos+0.2*r.lex,6)])];
 data.push({n:n+1,query,rec,cand});
}
writeFileSync(new URL('./label-data.json',import.meta.url),JSON.stringify({pool:pool.map(p=>({tag:p.tag,scope:p.scope})),data}));
const legend=pool.map(p=>`${p.tag} ${p.text}`).join('\n');
const sheet=data.map(d=>`### 时刻${d.n}\n最近消息：${d.query.replace(/\n/g,' / ')}\n候选：${d.cand.map(t=>{const r=d.rec.find(x=>x.tag===t);return `${t}(余${r.cos.toFixed(2)}/词${r.lex.toFixed(2)})`;}).join('  ')}\n`).join('\n');
writeFileSync(new URL('./label-sheet.md',import.meta.url),`# 记忆图例\n${legend}\n\n# 标注表\n${sheet}`);
console.log('moments',data.length,'avg candidates',(data.reduce((a,d)=>a+d.cand.length,0)/data.length).toFixed(1));
await model.close();
