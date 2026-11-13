// 只读对照：不同检索词取法下 L1 记忆的命中情况。不调用模型；终端只输出汇总，明细写入本地 review.md（已被 git 忽略）。
// 用法：node eval2.mjs <库副本> <contact_id>
import {DatabaseSync} from 'node:sqlite';
import {writeFileSync} from 'node:fs';
import {selectReplyKnowledge} from '../../backend-ts/src/reply/sqlite/candidates/knowledge-budget.ts';
const [dbPath,contactId]=process.argv.slice(2);
const db=new DatabaseSync(dbPath,{readOnly:true});
const mem=scope=>db.prepare(`SELECT m.id,v.body,v.adoption_mode FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no WHERE m.state='active' AND ${scope==='owner'?"m.scope_kind='self'":"m.contact_id=?"} ORDER BY m.id`).all(...(scope==='owner'?[]:[contactId])).map(r=>({kind:'memory',id:String(r.id),scopeKind:scope,text:String(r.body),qualification:r.adoption_mode==='auto'?'auto':'confirmed'}));
const items=[...mem('contact'),...mem('owner')];
const msgs=db.prepare("SELECT sender_role r,text_body t FROM message WHERE contact_id=? AND text_body IS NOT NULL AND trim(text_body)<>'' ORDER BY sent_at,order_key").all(contactId);
const pick=q=>selectReplyKnowledge(items,q).filter(x=>x.kind==='memory');
const cnt=(sel,scope)=>sel.filter(x=>x.scopeKind===scope).length;
const avg=a=>(a.reduce((x,y)=>x+y,0)/Math.max(1,a.length)).toFixed(2);
// 回复时刻：对方连续发言的最后一条；其后的第一条本人消息作为“草稿”的替身（真实写出的回复）。
const moments=[];for(let i=0;i<msgs.length-1;i++)if(msgs[i].r!=='owner'&&msgs[i+1].r==='owner')moments.push(i);
const picked=moments.filter(i=>Array.from(msgs[i+1].t).length>=Number(process.env.MIN_DRAFT??0)).filter((_,k,a)=>k%Math.max(1,Math.floor(a.length/120))===0).slice(-120);
const prefixed=w=>w.map(m=>`${m.r==='owner'?'我':'对方'}：${m.t}`).join('\n');
const lastRun=(w)=>{let k=w.length;while(k>0&&w[k-1].r!=='owner')k--;return w.slice(k).slice(-5);};
const variants={
 '想想-现状(50条头尾200)':(w)=>prefixed(w),
 '想想-最近5条原文':(w)=>w.slice(-5).map(m=>m.t).join('\n'),
 '想想-最近3条原文':(w)=>w.slice(-3).map(m=>m.t).join('\n'),
 '想想-对方最后一轮(≤5条)':(w)=>lastRun(w).map(m=>m.t).join('\n'),
};
const res={};for(const k of Object.keys(variants))res[k]={c:[],o:[],any:0};
const exprRes={'表达-现状(草稿+50条)':{c:[],o:[],any:0},'表达-只用草稿':{c:[],o:[],any:0}};
const review=[];
for(const i of picked){
 const w=msgs.slice(Math.max(0,i-49),i+1),draft=msgs[i+1].t;
 for(const [k,f] of Object.entries(variants)){const s=pick(f(w));res[k].c.push(cnt(s,'contact'));res[k].o.push(cnt(s,'owner'));if(s.length)res[k].any++;}
 const cur=pick(draft+'\n'+prefixed(w)),neu=pick(draft);
 for(const [k,s] of [['表达-现状(草稿+50条)',cur],['表达-只用草稿',neu]]){exprRes[k].c.push(cnt(s,'contact'));exprRes[k].o.push(cnt(s,'owner'));if(s.length)exprRes[k].any++;}
 if(review.length<25){const a=pick(variants['想想-现状(50条头尾200)'](w)),b=pick(variants['想想-最近5条原文'](w));review.push(`## 时刻 ${review.length+1}\n对方最近：${w.slice(-3).map(m=>m.t).join(' / ')}\n本人实际回复（草稿替身）：${draft}\n- 想想·现状选中：${a.map(x=>x.text).join(' ｜ ')||'（无）'}\n- 想想·最近5条选中：${b.map(x=>x.text).join(' ｜ ')||'（无）'}\n- 表达·现状选中：${cur.map(x=>x.text).join(' ｜ ')||'（无）'}\n- 表达·只用草稿选中：${neu.map(x=>x.text).join(' ｜ ')||'（无）'}\n`);}
}
console.log('回复时刻',picked.length);
for(const [k,v] of [...Object.entries(res),...Object.entries(exprRes)])console.log(`${k}｜联系人均 ${avg(v.c)} 条｜本人均 ${avg(v.o)} 条｜至少命中1条的时刻 ${v.any}/${picked.length}`);
writeFileSync(new URL('./review.md',import.meta.url),'# 本地人工核对用（含真实内容，勿提交）\n\n'+review.join('\n'));
