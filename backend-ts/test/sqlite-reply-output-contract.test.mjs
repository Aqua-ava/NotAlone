import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture} from './fixtures/sqlite-reply-candidates/support.mjs';
import {SqliteReplyCandidateService} from '../src/reply/sqlite/candidates/service.ts';
import {SqliteReplyTurns} from '../src/reply/sqlite/candidates/turns.ts';
import {parseReplyOutput} from '../src/reply/sqlite/candidates/versions.ts';

// 已返回的匿名合成邀请，只回放正文，不包含供应商头、身份或原运行路径。
const missingBasis=JSON.parse(await readFile(new URL('./fixtures/sqlite-reply-candidates/invitation-without-basis.json',import.meta.url),'utf8'));
const invitation='周六下午我想去图书馆，帮我写一条自然简短的邀请，不替我承诺具体时间。';
async function prepared(t,output){
 const f=await fixture(t,{synchronizeHistory:false,content:JSON.stringify(output)}),contactId=f.ids[0];
 const page=f.channel.page;
 f.channel.page=async(...args)=>{const response=await page(...args),row=response.records[0];return {...response,records:[{...row,localId:'1',text:'我一直偏好绿茶。'},{...row,localId:'2',text:'我长期住在海城。'}]};};
 await f.contacts.setReading(true);await f.history.synchronize(contactId);
 const discussion=await f.discussions.newDiscussion(contactId),service=new SqliteReplyCandidateService(f.storage,f.owner);
 const turns=new SqliteReplyTurns({...f,service,authorize:async()=>{}});t.after(()=>turns.close());
 const input={contactId,discussionId:discussion.id,requestKey:randomUUID(),text:invitation,confirmedContact:true};
 return {...f,contactId,discussion,service,turns,input};
}

for(const [name,output,code] of [
 ['漏掉依据字段',missingBasis,'reply_output_invalid'],
 ['空白候选正文',{candidates:[{parts:[''],basis:[3]}]},'reply_content_invalid'],
 ['引用未出站的材料编号',{candidates:missingBasis.candidates.map(candidate=>({...candidate,basis:[999]}))},'reply_basis_not_actual_input'],
])test(`实际DSH和SQLite拒绝${name}，成功回执保持已结算且失败原因可区分`,async t=>{
 const f=await prepared(t,output);
 await assert.rejects(f.turns.generate(f.input),{code});
 const status=await f.service.status(f.contactId,f.discussion.id,f.input.requestKey);
 assert.equal(status.phase,'failed');assert.equal(status.sent,true);assert.equal(status.errorCode,code);assert.equal(status.retryable,true);
 const views=await f.service.view(f.contactId,f.discussion.id);assert.equal(views.length,1);assert.deepEqual(views[0].candidates,[]);
 const trace=await f.discussions.trace(f.contactId,f.discussion.id,views[0].requestId);
 assert.equal(trace.calls.length,1);assert.equal(trace.calls[0].state,'succeeded');assert.equal(trace.calls[0].settlement_state, 'settled');
 assert.equal(trace.events.some(event=>event.kind==='assistant_message'),false);
 await f.service.status(f.contactId,f.discussion.id,f.input.requestKey);await assert.rejects(f.turns.generate(f.input),{code:'discussion_request_stale'});
 assert.equal(f.requests.length,1,'失败核对或同键重试不得重新出站');
 assert.deepEqual(await f.service.view(f.ids[1],(await f.discussions.newDiscussion(f.ids[1])).id),[]);
 assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});

test('实际DSH收到完整数字JSON示例，合法依据随三组邀请原子保存并可编辑',async t=>{
 const valid={candidates:missingBasis.candidates.map(candidate=>({...candidate,basis:[3]}))},f=await prepared(t,valid);
 await f.turns.generate(f.input);
 const wire=f.requests[0],system=typeof wire.system==='string'?wire.system:(wire.system??[]).map(block=>block.text??'').join('');
 const example=system.split('只输出JSON：')[1]?.split('。basis')[0];assert.ok(example,'正式提示词给出候选结构示例');assert.doesNotThrow(()=>parseReplyOutput(example),'示例自身必须包含合法数字依据');
 const views=await f.service.view(f.contactId,f.discussion.id);assert.equal(views[0].generationState,'committed');assert.equal(views[0].candidates.length,3);
 for(const [index,candidate] of views[0].candidates.entries()){
  assert.deepEqual(candidate.parts,missingBasis.candidates[index].parts);assert.deepEqual(candidate.basis.map(item=>[item.itemNo,item.kind,item.text,item.verification]),[[3,'entry',invitation,'actual_input']]);
 }
 const candidate=views[0].candidates[0],edited=await f.service.edit({contactId:f.contactId,discussionId:f.discussion.id,candidateId:candidate.candidateId,versionNo:1,parts:['周六下午一起去图书馆吗？时间再商量。']});assert.equal(edited.versionNo,2);
 assert.equal(f.requests.length,1);assert.deepEqual(await f.storage.check(),{integrity:'ok',foreignKeys:'ok'});
});
