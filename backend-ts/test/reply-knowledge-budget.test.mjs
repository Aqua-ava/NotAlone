import test from 'node:test';
import assert from 'node:assert/strict';
import {selectRankedReplyMemories,selectReplyDocuments,REPLY_DOCUMENT_BUDGET} from '../src/reply/sqlite/candidates/knowledge-budget.ts';
import {REPLY_SEARCH_BUDGET} from '../src/reply/sqlite/retrieval-policy.ts';

const fullBudget=()=>({contact:REPLY_SEARCH_BUDGET.contactMemories,owner:REPLY_SEARCH_BUDGET.ownerMemories});
function memory(id,scopeKind='contact',kind='memory',text='园艺完整资料。'){
 return {id,kind,scopeKind,text,versionNo:1n,contactId:scopeKind==='contact'?'synthetic-contact':null,publicationId:null,qualification:kind==='memory_candidate'?'unconfirmed':'confirmed',sources:[]};
}
const anchors=items=>items.map(({id,versionNo})=>({id,versionNo}));
function source(items,{stale=new Set()}={}){
 const opened=[];
 return {opened,memories:items,open(header){opened.push(header.id);return stale.has(header.id)?null:header;}};
}

test('正式记忆服从共享检索的全局顺序，不按正文或确认方式重排',()=>{
 const contact={...memory('contact','contact','memory','他喜欢爬山。'),qualification:'auto'},owner=memory('owner','owner','memory','公司报销流程复杂。'),other=memory('other','contact','memory','徒步装备已经买好。');
 assert.deepEqual(selectRankedReplyMemories(source([contact,other,owner]),anchors([owner,contact,other]),fullBudget()),[owner,contact,other]);
});

test('正式记忆只接纳精确ID与版本，候选、未知或未排名身份不获得新注入资格',()=>{
 const current={...memory('current'),versionNo:2n},unlisted=memory('unlisted'),candidate=memory('candidate','contact','memory_candidate');
 const ranked=[{id:'missing',versionNo:1n},{id:current.id,versionNo:1n},{id:candidate.id,versionNo:1n}];
 const input=source([unlisted,candidate,current]);
 assert.deepEqual(selectRankedReplyMemories(input,ranked,fullBudget()),[]);assert.deepEqual(input.opened,[]);
 assert.deepEqual(selectRankedReplyMemories(input,[...ranked,...anchors([current])],fullBudget()),[current]);
 assert.deepEqual(selectRankedReplyMemories(source([current,unlisted]),[],fullBudget()),[],'空检索结果不回退到词法注入');
});

test('正式记忆按整轮剩余额度独立计数，保留完整长正文，不修改调用者预算',()=>{
 const contacts=Array.from({length:7},(_,n)=>memory(`c${n}`,'contact','memory','𠀀'.repeat(900)+n));
 const owners=Array.from({length:5},(_,n)=>memory(`o${n}`,'owner','memory','𠀀'.repeat(500)+n));
 const ranked=anchors(Array.from({length:7},(_,n)=>[contacts[n],owners[n]].filter(Boolean)).flat());
 const input=source([...owners,...contacts]),budget={contact:2,owner:1};
 const selected=selectRankedReplyMemories(input,ranked,budget);
 assert.deepEqual(selected,[contacts[0],owners[0],contacts[1]]);assert.deepEqual(budget,{contact:2,owner:1});
 assert.deepEqual(input.opened,selected.map(item=>item.id));
 assert.equal(Array.from(selected[0].text).length,901);assert.equal(Array.from(selected[1].text).length,501);
 const full=selectRankedReplyMemories(source([...owners,...contacts]),ranked,fullBudget());
 assert.equal(full.filter(item=>item.scopeKind==='contact').length,5);assert.equal(full.filter(item=>item.scopeKind==='owner').length,3);
});

test('来源失效沿共享排名补位，重复锚点不重复核验或消耗预算',()=>{
 const contacts=Array.from({length:8},(_,n)=>memory(`contact-${n}`)),ranked=anchors(contacts);ranked.splice(1,0,ranked[0]);
 const input=source(contacts,{stale:new Set(['contact-1','contact-3'])});
 assert.deepEqual(selectRankedReplyMemories(input,ranked,fullBudget()).map(item=>item.id),['contact-0','contact-2','contact-4','contact-5','contact-6']);
 assert.deepEqual(input.opened,['contact-0','contact-1','contact-2','contact-3','contact-4','contact-5','contact-6']);
});

test('预算选择只物化可能入选的排名项，不遍历其余记忆来源',()=>{
 const contacts=Array.from({length:50},(_,n)=>memory(`contact-${n}`)),input=source(contacts);
 assert.deepEqual(selectRankedReplyMemories(input,anchors(contacts),fullBudget()),contacts.slice(0,5));
 assert.deepEqual(input.opened,contacts.slice(0,5).map(item=>item.id));
 const exhausted=source(contacts);assert.deepEqual(selectRankedReplyMemories(exhausted,anchors(contacts),{contact:0,owner:0}),[]);assert.deepEqual(exhausted.opened,[]);
});

function document(id,text,projection){return {...memory(id,'contact','document',text),qualification:'published',publicationId:'synthetic-publication',projection};}
test('初始文档目录按条数与Unicode字符预算选完整条目，独立保留长期背景',()=>{
 const directories=Array.from({length:14},(_,n)=>document(`d${n}`,'𠀀'.repeat(100),{kind:'directory',blockCount:1}));
 const profiles=[document('too-long','长'.repeat(REPLY_DOCUMENT_BUDGET.profileChars+1)),document('profile-a','𠀀'.repeat(700)),document('profile-b','𠀀'.repeat(501)),document('profile-c','𠀀'.repeat(500))];
 const selected=selectReplyDocuments([...directories,...profiles,memory('memory'),memory('candidate','contact','memory_candidate')]);
 assert.deepEqual(selected,[...directories.slice(0,12),profiles[1],profiles[3]]);
 assert.equal(selected.every(item=>item.kind==='document'),true);
});

test('目录字符预算放不下时跳过完整项，不截断或挤占长期背景',()=>{
 const a=document('a','𠀀'.repeat(900),{kind:'directory',blockCount:1}),b=document('b','𠀀'.repeat(701),{kind:'directory',blockCount:1}),c=document('c','𠀀'.repeat(700),{kind:'directory',blockCount:1}),profile=document('profile','完整长期背景');
 assert.deepEqual(selectReplyDocuments([a,b,c,profile]),[a,c,profile]);
});
