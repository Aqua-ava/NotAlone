import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readReplyWorkspace,replyWorkspaceFingerprint} from '../src/reply/sqlite/candidates/workspace.ts';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';

const contactId='11111111-1111-4111-8111-111111111111';
const discussionId='22222222-2222-4222-8222-222222222222';
const validWorkspace=(overrides={})=>({action:'suggest',draftText:'',contextText:'',
 includeRelationshipContext:false,...overrides});

/** 只替换模型执行；HTTP合同、工作区解析和请求组装走真实实现。 */
async function httpFixture(t,workspace,{carriedSelectionId}={}){
 const generated=[];
 const turns={generate:async input=>{generated.push(input);return {discussionId,replayed:false,segmented:false};}};
 const http=new SqliteReplyCandidateHttp({storage:{},service:{},turns,authorize:req=>req.headers.authorization==='Bearer synthetic'});
 const server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussionId}/reply-candidates`;
 const request=async body=>{
  const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
 };
 return {generated,request,url};
}

test('工作区统一主输入接受语气与要求，拒绝已退役的独立字段',()=>{
 const draftText='想问问最近怎么样，语气温和一点，两句话以内，不要添加承诺';
 const workspace=readReplyWorkspace(validWorkspace({action:'express',draftText}));
 assert.equal(workspace.draftText,draftText);
 for(const retired of [{tone:'original'},{tone:'warm'},{instruction:''},{instruction:'简短一点'}]){
  assert.throws(()=>readReplyWorkspace(validWorkspace(retired)),{code:'reply_input_invalid'});
 }
});

test('工作区合同不再包含消息排除字段，解析结果只保留当前字段',()=>{
 const workspace=readReplyWorkspace(validWorkspace({draftText:'简短一点',contextText:'对方：最近很忙。'}));
 assert.deepEqual(workspace,{action:'suggest',draftText:'简短一点',
  contextText:'对方：最近很忙。',includeRelationshipContext:false});
 assert.equal('excludedMessageIds' in workspace,false);
});

test('工作区合同拒绝已退役的消息排除字段，不静默忽略',()=>{
 for(const excluded of [{excludedMessageIds:[]},{excludedMessageIds:[randomUUID()]},
  {excluded_message_ids:[]},{excluded_message_ids:[randomUUID()]}]) {
  assert.throws(()=>readReplyWorkspace(validWorkspace(excluded)),{code:'reply_input_invalid'},JSON.stringify(excluded));
 }
});

test('工作区指纹使用version 3，区分统一主输入的新合同',()=>{
 const workspace=readReplyWorkspace(validWorkspace({action:'express',draftText:'想问问最近怎么样，语气温和一点'}));
 const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
 assert.equal(replyWorkspaceFingerprint(workspace),hash({version:3,workspace,selectedPackageId:null,carriedSelectionId:null}));
 assert.equal(replyWorkspaceFingerprint(workspace,'33333333-3333-4333-8333-333333333333'),
  hash({version:3,workspace,selectedPackageId:'33333333-3333-4333-8333-333333333333',carriedSelectionId:null}));
 assert.notEqual(replyWorkspaceFingerprint(workspace),
  hash({version:2,workspace,selectedPackageId:null,carriedSelectionId:null}),'指纹版本必须从2升到3');
});

test('HTTP接受不含排除字段的新工作区，按背景开关与携入选稿组装请求',async t=>{
 const f=await httpFixture(t);
 const workspace=validWorkspace({draftText:'不要替我答应',contextText:'补充背景：周五有考试'});
 const accepted=await f.request({request_key:randomUUID(),text:workspace.draftText,confirmed_contact:true,workspace});
 assert.equal(accepted.status,200,JSON.stringify(accepted.data));
 assert.equal(f.generated.length,1);
 assert.deepEqual(f.generated[0].workspace,{action:'suggest',draftText:'不要替我答应',
  contextText:'补充背景：周五有考试',includeRelationshipContext:false});
 assert.equal('excludedMessageIds' in f.generated[0].workspace,false);
 const carriedSelectionId=randomUUID();
 const carried=await f.request({request_key:randomUUID(),text:'',confirmed_contact:true,carried_selection_id:carriedSelectionId,
  workspace:validWorkspace({includeRelationshipContext:true})});
 assert.equal(carried.status,200,JSON.stringify(carried.data));
 assert.equal(f.generated[1].carriedSelectionId,carriedSelectionId);
 const rejectedCarry=await f.request({request_key:randomUUID(),text:'',confirmed_contact:true,carried_selection_id:randomUUID(),
  workspace:validWorkspace({includeRelationshipContext:false})});
 assert.equal(rejectedCarry.status,400);
 assert.equal(rejectedCarry.data.error,'reply_input_invalid');
 assert.equal(f.generated.length,2,'关闭关系背景的携入不得创建请求');
});

test('HTTP拒绝携带旧排除或独立写作设置的请求，且不创建请求不调用生成',async t=>{
 const f=await httpFixture(t);
 const cases=[{tone:'original'},{tone:'warm'},{instruction:''},{instruction:'简短一点'},{excludedMessageIds:[]},{excludedMessageIds:[randomUUID()]},
  {excluded_message_ids:[]},{excluded_message_ids:[randomUUID()]}];
 for(const legacy of cases) {
  const response=await f.request({request_key:randomUUID(),text:'',confirmed_contact:true,
   workspace:validWorkspace(legacy)});
  assert.equal(response.status,400,JSON.stringify(legacy));
  assert.equal(response.data.error,'reply_input_invalid');
 }
 const topLevel=await f.request({request_key:randomUUID(),text:'本次合成想法',confirmed_contact:true,
  excluded_message_ids:[randomUUID()],workspace:validWorkspace({action:'express',draftText:'本次合成想法'})});
 assert.equal(topLevel.status,400);
 assert.equal(topLevel.data.error,'reply_input_invalid');
 assert.equal(f.generated.length,0,'旧字段请求不得创建请求或调用模型');
});
