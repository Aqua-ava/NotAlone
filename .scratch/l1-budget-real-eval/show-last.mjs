// 只读：显示真实链路最近一次回复冻结的输入（实际发给模型的材料）。含真实内容，勿提交。
// 用法：node --no-warnings show-last.mjs [contact_id] [第几近的一次，默认1]
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.env.HOME+'/Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite',{readOnly:true});
const contactId=process.argv[2]??'1c43e3c0-2d6e-47a3-85c7-00c16e648ea9',nth=Number(process.argv[3]??1);
const ctx=db.prepare("SELECT id,frozen_at,origin_kind FROM reply_context WHERE contact_id=? AND origin_kind='request' ORDER BY frozen_at DESC LIMIT 1 OFFSET ?").get(contactId,nth-1);
if(!ctx){console.log('没有该联系人的回复冻结记录');process.exit(0);}
console.log('冻结时间',new Date(Number(ctx.frozen_at)).toLocaleString('zh-CN'),'｜context',String(ctx.id).slice(0,8));
const items=db.prepare('SELECT item_no n,kind,text_body t FROM reply_candidate_input WHERE context_id=? ORDER BY item_no').all(ctx.id);
const count={};for(const i of items)count[i.kind]=(count[i.kind]??0)+1;
console.log('材料共',items.length,'项：',Object.entries(count).map(([k,v])=>`${k}×${v}`).join('，'));
const msgs=items.filter(i=>i.kind==='message');
console.log('\n—— 最近聊天（共'+msgs.length+'条，只显示最后6条；检索词=最近5条原话）——');
for(const m of msgs.slice(-6))console.log(`[${m.n}] ${m.t}`);
for(const kind of ['entry','memory','memory_candidate','document','coverage','selection']){
 const list=items.filter(i=>i.kind===kind);if(!list.length)continue;
 console.log(`\n—— ${kind}（${list.length}项）——`);
 for(const i of list)console.log(`[${i.n}] ${i.t}\n`);
}
