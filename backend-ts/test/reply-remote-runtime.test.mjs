import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {normalizeReplyInput,parseReplyRequest} from '../src/reply-contract.ts';
function modelEvidence(body){
 const found=[];
 const visit=value=>{
  if(Array.isArray(value)){for(const item of value)visit(item);}
  else if(value&&typeof value==='object'){
   if(Array.isArray(value.evidence))found.push(...value.evidence);
   for(const [key,item]of Object.entries(value))if(key!=='evidence')visit(item);
  }else if(typeof value==='string'){
   try{visit(JSON.parse(value));}catch{
    const start=value.indexOf('{'),end=value.lastIndexOf('}');
    if(start>=0&&end>start){try{visit(JSON.parse(value.slice(start,end+1)));}catch{}}
   }
  }
 };
 visit(body);assert.ok(found.length,'从真实官方Messages读取证据');return found;
}
test('Python薄桥→私有HTTP→真实service/官方Agent/PG：A准备零出站、一次生成、原DTO重放及越权拒绝',{timeout:60000},async t=>{
 const f=await createStorageFixture();
 assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') IS NOT NULL AS migrated")).rows[0].migrated,true,'正式migrator必须建立110模型回执表');
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID(),turn=randomUUID(),input=randomUUID(),key=randomUUID(),token='synthetic-reply-private-token-'.repeat(3);
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成回复本人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成回复联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 const body={contact_id:contact,idempotency_key:key,content:{type:'rewrite_draft',draft_text:'明天见',input_kind:'draft',include_relationship_context:false},skill_disabled:true};
 await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query('INSERT INTO assistant_session_turn(id,session_id,owner_id,contact_id,input_version_id,idempotency_key,conversation_binding_id,input_digest,input_payload)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[turn,session,owner,contact,input,key,binding,createHash('sha256').update(binding+':'+normalizeReplyInput(parseReplyRequest(body))).digest('hex'),JSON.stringify({content:body.content})]);
 await f.client.query("INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,input_type,turn_id)VALUES($1,$2,$3,$4,$5,'generation',$6)",[input,session,owner,contact,binding,turn]);
 await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
 const host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:()=>f.close()},(_req,res,requests,events)=>{
  const evidence=modelEvidence(requests.at(-1).body);useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次原句',citation_ids:[evidence[0].evidence_id],risk_notes:[]}]});sendEvents(res,events);
 });
 const child=spawn(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[new URL('./reply-remote-python-fixture.py',import.meta.url).pathname],{env:{PATH:process.env.PATH,PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname,NOTALONE_DISABLE_DOTENV:'1'},stdio:['pipe','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>stderr+=d);const exit=once(child,'exit');t.after(async()=>{child.stdin.end();if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;});
 const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();child.stdin.write(JSON.stringify({url:host.url,token,owner_id:owner,contact_id:contact,conversation_binding_id:binding,idempotency_key:key})+'\n');
 const call=async(operation,extra={})=>{child.stdin.write(JSON.stringify({operation,...extra})+'\n');const next=await lines.next();assert.equal(next.done,false,stderr);return JSON.parse(next.value);};
 assert.deepEqual(await call('prepare'),{ok:true,prepared:true});assert.equal(host.requests.length,0);
 const prepared=(await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context;assert.equal(prepared.version,2);assert.equal(prepared.schema_revision,15);
 assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,0);
 const first=await call('generate');assert.equal(first.ok,true,JSON.stringify(first));assert.equal(first.reply.candidates[0].text,'明天见');assert.ok(first.reply.candidates[0].messages[0].message_id);assert.equal(first.reply.input_budget.state,'ready');assert.equal(host.requests.length,1);
 const replay=await call('replay');assert.deepEqual(replay,first);assert.equal(host.requests.length,1);
 const row=(await f.client.query('SELECT id,candidate_text FROM reply_candidate WHERE reply_request_id=$1',[first.reply.reply_request_id])).rows[0];assert.equal(row.id,first.reply.candidates[0].candidate_id);assert.equal(row.candidate_text,'明天见');
 const receipt=(await f.client.query('SELECT outcome,input_budget FROM model_call_receipt')).rows;assert.equal(receipt.length,1);assert.equal(receipt[0].outcome,'succeeded');assert.match(receipt[0].input_budget.request_sha256,/^[a-f0-9]{64}$/);
 assert.deepEqual((await f.client.query('SELECT prepared_context FROM assistant_session_turn WHERE id=$1',[turn])).rows[0].prepared_context,prepared);
 assert.deepEqual(await call('bad_binding',{binding:randomUUID(),key:randomUUID()}),{ok:false,error:'ReplyInputInvalidatedError'});assert.equal(host.requests.length,1);
 const oversized=await call('oversized',{key:randomUUID()});assert.equal(oversized.ok,false);assert.equal(oversized.error,'InputBudgetExceededError',JSON.stringify(oversized));
 const budget=oversized.input_budget;assert.equal(budget.state,'exceeded');assert.ok(budget.input_tokens>0);assert.equal(budget.output_reserve_tokens,256);assert.equal(budget.safety_margin_tokens,128);assert.equal(budget.measurement_kind,'approximate');assert.ok(budget.measurement_id);assert.ok(budget.input_tokens+budget.output_reserve_tokens+budget.safety_margin_tokens>budget.context_window_tokens);
 assert.equal(host.requests.length,1);assert.equal((await f.client.query('SELECT count(*)::int n FROM model_call_receipt')).rows[0].n,1);
 child.stdin.end();assert.equal((await exit)[0],0,stderr);
 const pythonNetwork=stderr.split('\n').filter(line=>line.startsWith('PYTHON_NETWORK ')).map(line=>JSON.parse(line.slice('PYTHON_NETWORK '.length)));assert.equal(pythonNetwork.length,5);for(const address of pythonNetwork)assert.deepEqual(address,{host:'127.0.0.1',port:Number(new URL(host.url).port)});
});
