/** 正式 launcher/profile 与正常模型配置；只在供应商网络边界替换合成响应。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readdir,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {pureTsFixture} from './pure-ts-runtime-fixture.mjs';
import {syntheticProvider,actualEvidenceId} from './pure-ts-provider-fixture.mjs';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';

test('正常产品入口持续保存官方历史，真实重启恢复且按正常配置计量完整请求',{timeout:60000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),binding=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成持续讨论联系人')",[contact,owner]);
 await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-persistent-account','合成账号')",[owner]);
 await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-persistent-account','synthetic-persistent-friend')",[binding,owner,contact]);
 const candidate='合成正常入口候选：周六晚上见。';
 const provider=await syntheticProvider(t,async(body,res)=>{
  const events=[{type:'message_start',message:{id:'synthetic-persistent',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:candidate,basis:'本轮合成草稿',citation_ids:[actualEvidenceId(body)],risk_notes:[]}]});sendEvents(res,events);
 });
 const environment={NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url};
 let app=await f.start(environment);
 const request=async(path,body)=>{const result=await app.request(path,body);assert.equal(result.status,200,JSON.stringify(result));return result.data;};
 const base=`/api/contacts/${contact}/assistant-sessions`,session=await request(base,{}),path=`${base}/${session.session_id}`;
 const input=text=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:text,include_relationship_context:false},skill_disabled:true});
 const firstCommand=input('合成正常首轮：周五散步。');
 await request(`${path}/replies/prepare`,firstCommand);assert.equal(provider.requests.length,0);
 await request(`${path}/replies`,firstCommand);
 const root=join(f.directory,'assistant-runtime'),archives=(await readdir(root,{recursive:true})).filter(file=>file.endsWith('.jsonl')).sort();
 assert.equal(archives.length,1,'正常入口应在稳定业务目录保存官方日志');
 assert.equal((await stat(root)).mode&0o077,0);
 const secondCommand=input('合成正常第二轮：改为周六散步。');
 await request(`${path}/replies/prepare`,secondCommand);assert.equal(provider.requests.length,1,'带恢复历史的预检零HTTP');
 const second=await request(`${path}/replies`,secondCommand);
 assert.equal(provider.requests.length,2);
 assert.ok(provider.requests[1].messages.some(message=>message.role==='assistant'&&JSON.stringify(message).includes(candidate)));
 assert.ok(provider.requests[1].messages.some(message=>message.content.some(block=>block.type==='tool_result')),'恢复历史的真实工具结果一并进入完整预算');
 assert.doesNotMatch(JSON.stringify(provider.requests[1].messages.at(-1)),/合成正常首轮|合成正常入口候选|assistant_discussion/);
 const receipts=(await f.client.query('SELECT input_budget FROM model_call_receipt WHERE owner_id=$1 AND contact_id=$2 ORDER BY called_at,attempt_id',[owner,contact])).rows;
 assert.equal(receipts.length,2);
 for(let index=0;index<2;index++){
  const body=provider.requests[index],serialized=JSON.stringify(body),budget=receipts[index].input_budget;
  assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,393216);assert.equal(body.temperature,0);assert.deepEqual(body.thinking,{type:'disabled'});
  assert.equal(budget.context_window_tokens,1048576);assert.equal(budget.max_output_tokens,393216);assert.equal(budget.safety_margin_tokens,65536);
  assert.equal(budget.serialized_bytes,Buffer.byteLength(serialized));assert.equal(budget.request_sha256,createHash('sha256').update(serialized).digest('hex'));
  assert.ok(body.system.length>0&&body.tools.length>0&&body.tool_choice,'系统、工具与控制字段均在已计量实体内');
 }
 assert.ok(receipts[1].input_budget.serialized_bytes>receipts[0].input_budget.serialized_bytes);
 assert.equal(second.input_budget.input_tokens,receipts[1].input_budget.serialized_bytes);
 await request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
 assert.deepEqual((await readdir(root,{recursive:true})).filter(file=>file.endsWith('.jsonl')).sort(),archives,'宿主退出不清理稳定运行目录');
 app=await f.start(environment);
 assert.match(JSON.stringify(await request(path)),/合成正常入口候选/);
 await request(`${path}/resume`,{});assert.equal(provider.requests.length,2,'重启与明确继续本身不调用模型');
 await request(`${path}/replies`,input('合成正常第三轮：保留周六安排。'));
 assert.equal(provider.requests.length,3);assert.match(JSON.stringify(provider.requests[2].messages),/合成正常首轮/);
 assert.deepEqual((await readdir(root,{recursive:true})).filter(file=>file.endsWith('.jsonl')).sort(),archives);
});
