import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {setup} from './reply-assistant-erasure-support.mjs';
import {ReplyAssistantGuards} from '../src/reply/generation/reply-assistant-guards.ts';
import {canonical,fingerprint} from '../src/reply/generation/reply-assistant-erasure.ts';
function ports(x){return {requireReplySourcesCurrent:async()=>[],requireDependencies:async()=>{},requireCurrentReplyMemory:async()=>{},requireGenerationMemoryDependencies:async()=>{},historicalBasisRevision:async()=> 'b'.repeat(64),readReplyBasisChanges:async()=>[],requireSavedSkillPolicy:async()=>{},requireActiveBinding:async()=>x.binding,navigationDependencyIds:()=>[],registeredNavigationDependencies:async()=>[]};}
async function request(x,g){const r=(await x.f.client.query('SELECT * FROM reply_request WHERE id=$1',[g.request])).rows[0];return {...r,request_id:r.id};}
async function identity(x,g,normalized='synthetic',auth){const input=auth?canonical({reply:normalized,continuation:auth.continuation}):normalized;await x.f.client.query('UPDATE assistant_session_turn SET input_digest=$2 WHERE id=$1',[g.turn,createHash('sha256').update(x.binding+':'+input).digest('hex')]);}
test('助手start复验实际digest，只有内部完整continuation身份可领取',async t=>{
 const x=await setup(t),parent=await x.generation(),g=await x.generation([],parent),guard=new ReplyAssistantGuards(ports(x)),r=await request(x,g);
 const auth={continuation:g.payload.continuation,continuation_reference:null};await identity(x,g,'synthetic',auth);
 await assert.rejects(guard.prepareAssistantReplyStart(x.f.client,r),{code:'reply_context_invalidated'});
 await guard.prepareAssistantReplyStart(x.f.client,r,auth);
 await assert.rejects(guard.prepareAssistantReplyStart(x.f.client,{...r,normalized_input:'changed'},auth),{code:'reply_input_conflict'});
});
test('提交拒绝旧current输入，scope和当前binding复验后仅更新本turn',async t=>{
 const x=await setup(t),g=await x.generation(),guard=new ReplyAssistantGuards(ports(x)),r=await request(x,g);await identity(x,g);
 const context={evidence:[],snapshot:{},skill_library_revision:0};await guard.prepareAssistantReplyCommit(x.f.client,r,context);
 await x.generation();await assert.rejects(guard.prepareAssistantReplyCommit(x.f.client,r,context),{code:'reply_context_invalidated'});
});
test('讨论CURRENT失败不等于HISTORY失效，模型快照不可偷偷替换',async t=>{
 const x=await setup(t),g=await x.generation(),guard=new ReplyAssistantGuards(ports(x)),r=await request(x,g);
 const snap={version:1,scope:{owner_id:x.owner,contact_id:x.contact},session_id:x.session,request_key:g.key,current_input_version_id:g.input,current_turn_id:g.turn,current_payload_sha256:fingerprint(['a'.repeat(64),g.payload,x.binding]),records:[]};
 await guard.captureReplyDiscussion(x.f.client,r,snap);
 await assert.rejects(guard.captureReplyDiscussion(x.f.client,r,{...snap,current_payload_sha256:'0'.repeat(64)}),{code:'reply_context_invalidated'});
 await x.generation();await assert.rejects(guard.requireReplyDiscussion(x.f.client,r,snap,true),{code:'reply_context_invalidated'});
 assert.deepEqual(await guard.requireReplyDiscussion(x.f.client,r,null,false),[]);
});
test('续写basis在领取时固定，版本变化拒绝提交且不重写父候选',async t=>{
 const x=await setup(t),parent=await x.generation(),candidate=randomUUID();
 await x.f.client.query("INSERT INTO reply_candidate(id,reply_request_id,owner_id,contact_id,conversation_binding_id,ordinal,candidate_text,basis,risk_notes)VALUES($1,$2,$3,$4,$5,0,'合成原稿','合成依据','[]')",[candidate,parent.request,x.owner,x.contact,x.binding]);
 const g=await x.generation(),r={...await request(x,g),continued_from_candidate_id:candidate},p=ports(x),guard=new ReplyAssistantGuards(p);
 await x.f.client.query('UPDATE reply_request SET continued_from_candidate_id=$2 WHERE id=$1',[g.request,candidate]);
 const basis=await guard.captureContinuationBasis(x.f.client,r);assert.equal(basis.text,'合成原稿');
 const context={evidence:[],snapshot:{},skill_library_revision:0,continuation_basis:basis};await guard.requireContinuationBasis(x.f.client,r,context);
 p.historicalBasisRevision=async()=> 'c'.repeat(64);await assert.rejects(guard.requireContinuationBasis(x.f.client,r,context),{code:'reply_context_invalidated'});
 assert.equal((await x.f.client.query('SELECT candidate_text FROM reply_candidate WHERE id=$1',[candidate])).rows[0].candidate_text,'合成原稿');
});
test('讨论来源不能把同owner其他联系人原始来源当作本联系人依据',async t=>{
 const x=await setup(t),guard=new ReplyAssistantGuards(ports(x)),other=randomUUID(),source=randomUUID();
 await x.f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'另一合成联系人')",[other,x.owner]);
 await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','synthetic.jsonl',$4,1)",[source,x.owner,other,'d'.repeat(64)]);
 // 已存在的同owner异联系人来源不得通过泛owner资格端口的成功结果。
 await assert.rejects(guard.verifiedDiscussionDependencies(x.f.client,{owner_id:x.owner,contact_id:x.contact},[source],true),{code:'reply_context_invalidated'});
 await assert.rejects(guard.verifiedDiscussionDependencies(x.f.client,{owner_id:x.owner,contact_id:x.contact},[x.owner],true),{code:'reply_context_invalidated'});
 const ownSource=randomUUID();await x.f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'wechat_jsonl','own-synthetic.jsonl',$4,1)",[ownSource,x.owner,x.contact,'e'.repeat(64)]);
 assert.deepEqual(await guard.verifiedDiscussionDependencies(x.f.client,{owner_id:x.owner,contact_id:x.contact},[ownSource],false),[ownSource]);
});
