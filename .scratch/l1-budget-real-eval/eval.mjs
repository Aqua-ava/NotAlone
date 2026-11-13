// 只读对比 L1 联系人/本人记忆在“旧字符预算”与“无字符预算”下的选取；不调用模型，只输出汇总。
// 用法：node eval.mjs <库副本路径> <contact_id>
import {DatabaseSync} from 'node:sqlite';
import {buildQueryTokens,RELEVANCE_THRESHOLD} from '../../backend-ts/src/retrieval/retrieval-lexical.ts';
import {rankMemories} from '../../backend-ts/src/retrieval/retrieval-ranking.ts';
import {selectReplyKnowledge} from '../../backend-ts/src/reply/sqlite/candidates/knowledge-budget.ts';
const [dbPath,contactId]=process.argv.slice(2);
const db=new DatabaseSync(dbPath,{readOnly:true});
const mem=scope=>db.prepare(`SELECT m.id,v.body,v.adoption_mode FROM memory m JOIN memory_version v ON v.owner_id=m.owner_id AND v.memory_id=m.id AND v.version_no=m.current_version_no WHERE m.state='active' AND ${scope==='owner'?"m.scope_kind='self'":"m.contact_id=?"} ORDER BY m.id`).all(...(scope==='owner'?[]:[contactId])).map(r=>({kind:'memory',id:String(r.id),scopeKind:scope,text:String(r.body),qualification:r.adoption_mode==='auto'?'auto':'confirmed'}));
const items=[...mem('contact'),...mem('owner')];
const msgs=db.prepare("SELECT sender_role r,text_body t,sent_at FROM message WHERE contact_id=? AND text_body IS NOT NULL AND trim(text_body)<>'' ORDER BY sent_at,order_key").all(contactId);
// 旧预算（联系人5条/600字符，本人3条/240字符），逻辑与改动前一致：超限条目跳过、继续后面的。
function oldSelect(all,query){
 const tokens=buildQueryTokens(query),out=[];
 for(const [scope,maxCount,maxChars] of [['contact',5,600],['owner',3,240]]){
  const pool=all.filter(i=>i.scopeKind===scope);let chars=0,count=0;
  const ranked=pool.length&&tokens.length?rankMemories(pool.map(item=>({item,text:item.text,memory_id:item.id,adoption_method:item.qualification==='confirmed'?'manual':'auto',confidence:0,valid_at:null})),tokens,pool.length):[];
  for(const {item,relevance_score} of ranked){const size=Array.from(item.text).length;if(relevance_score<RELEVANCE_THRESHOLD||count>=maxCount||chars+size>maxChars)continue;out.push(item);count++;chars+=size;}
 }
 return out;
}
function relevant(all,query,scope){const tokens=buildQueryTokens(query);const pool=all.filter(i=>i.scopeKind===scope);return (pool.length&&tokens.length?rankMemories(pool.map(item=>({item,text:item.text,memory_id:item.id,adoption_method:'manual',confidence:0,valid_at:null})),tokens,pool.length):[]).filter(r=>r.relevance_score>=RELEVANCE_THRESHOLD).length;}
const len=t=>Array.from(t).length;
const pct=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s.length?s[Math.min(s.length-1,Math.floor(p*s.length))]:0;};
console.log('记忆池：联系人',items.filter(i=>i.scopeKind==='contact').length,'条，本人',items.filter(i=>i.scopeKind==='owner').length,'条；消息',msgs.length,'条');
for(const scope of ['contact','owner'])console.log(scope,'单条长度 p50/p90/max =',pct(items.filter(i=>i.scopeKind===scope).map(i=>len(i.text)),.5),pct(items.filter(i=>i.scopeKind===scope).map(i=>len(i.text)),.9),Math.max(0,...items.filter(i=>i.scopeKind===scope).map(i=>len(i.text))));
// 回复时刻：对方连续发言的最后一条；取最近至多 N 个，每次用其前 50 条消息作查询（与正式冻结输入一致：不含时间）。
const moments=[];for(let i=0;i<msgs.length;i++)if(msgs[i].r!=='owner'&&(i===msgs.length-1||msgs[i+1].r==='owner'))moments.push(i);
const N=Number(process.env.MOMENTS??120);const stride=Math.max(1,Math.floor(moments.length/N));const picked=moments.filter((_,k)=>k%stride===0).slice(-N);
const stat={contact:{old:[],neu:[],rel:[],oldChars:[],newChars:[],drop:0,more:0,empty0:0},owner:{old:[],neu:[],rel:[],oldChars:[],newChars:[],drop:0,more:0,empty0:0}};
const qlen=[];
for(const i of picked){
 const win=msgs.slice(Math.max(0,i-49),i+1);const query=win.map(m=>`${m.r==='owner'?'我':'对方'}：${m.t}`).join('\n');qlen.push(len(query));
 const o=oldSelect(items,query),n=selectReplyKnowledge(items,query);
 for(const scope of ['contact','owner']){
  const a=o.filter(x=>x.scopeKind===scope),b=n.filter(x=>x.kind==='memory'&&x.scopeKind===scope),s=stat[scope];
  s.old.push(a.length);s.neu.push(b.length);s.rel.push(relevant(items,query,scope));s.oldChars.push(a.reduce((t,x)=>t+len(x.text),0));s.newChars.push(b.reduce((t,x)=>t+len(x.text),0));
  if(b.length>a.length)s.more++;if(b.length===0)s.empty0++;if(a.length<Math.min(s.rel.at(-1),scope==='contact'?5:3))s.drop++;
 }
}
console.log('回复时刻',picked.length,'个；查询长度 p50/max =',pct(qlen,.5),Math.max(...qlen));
const avg=a=>(a.reduce((x,y)=>x+y,0)/Math.max(1,a.length)).toFixed(2);
for(const scope of ['contact','owner']){const s=stat[scope];
 console.log(`[${scope}] 过阈值相关条数均值 ${avg(s.rel)}｜旧：条数 ${avg(s.old)} 字符 ${avg(s.oldChars)}（p90 ${pct(s.oldChars,.9)}）｜新：条数 ${avg(s.neu)} 字符 ${avg(s.newChars)}（p90 ${pct(s.newChars,.9)} max ${Math.max(0,...s.newChars)}）｜新比旧多选的时刻 ${s.more}/${picked.length}｜旧版被字符预算少选的时刻 ${s.drop}/${picked.length}｜新版零命中 ${s.empty0}/${picked.length}`);}
