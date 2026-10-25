/** 固定候选的独立公开运输探针；仅使用合成身份、本机假供应商与随机测试库。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const source=process.env.NOTALONE_SPEC_REVIEW_SOURCE;
if(!source)throw new Error('需要显式指定固定源码快照');
const load=path=>import(pathToFileURL(`${source}/backend-ts/${path}`).href);
const {pureTsFixture}=await load('test/pure-ts-runtime-fixture.mjs');
const {syntheticProvider,actualEvidenceId}=await load('test/pure-ts-provider-fixture.mjs');
const {sendEvents,useTool}=await load('test/reply-service-runtime-support.mjs');
const evidence={candidate:'ff45f2ec296c4cead326d2ab6f3cf7770c9396ab',checks:[]};
const check=(name,detail={})=>evidence.checks.push({name,...detail});

test('正式launcher：重叠手动/桌面准备、取消重试、继续与分片CAS',{timeout:60000},async t=>{
 const f=await pureTsFixture(t),owner=randomUUID(),contact=randomUUID(),other=randomUUID(),desktop=randomUUID(),manual=randomUUID();
 await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
 for(const id of [contact,other])await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[id,owner]);
 await f.client.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-scope','synthetic-contact')",[desktop,owner,contact]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[manual,owner,contact]);
 let holdNext=false,entered,release;
 const provider=await syntheticProvider(t,async(body,res)=>{
  const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'合成本次草稿',citation_ids:[actualEvidenceId(body)],risk_notes:[]}]});
  if(holdNext){holdNext=false;release=()=>sendEvents(res,events);entered();return;}sendEvents(res,events);
 });
 const environment={NOTALONE_OWNER_ID:owner,NOTALONE_DEEPSEEK_API_KEY:'synthetic-only',NOTALONE_SYNTHETIC_PROVIDER_URL:provider.url};
 const app=await f.start(environment);
 const request=(path,body,manualMode=false,method)=>app.request(path,body,method??(body===undefined?'GET':'POST'),app.connection.token,manualMode?{'x-notalone-manual-contact':contact}:{});
 const manualSession=await request(`/api/contacts/${contact}/assistant-session/default`,{},true);
 const desktopSession=await request(`/api/contacts/${contact}/assistant-sessions`,{});
 assert.equal(manualSession.status,200);assert.equal(desktopSession.status,200);
 const manualPath=`/api/contacts/${contact}/assistant-sessions/${manualSession.data.session_id}`;
 const desktopPath=`/api/contacts/${contact}/assistant-sessions/${desktopSession.data.session_id}`;
 const makeInput=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true});
 const commands=[makeInput(),makeInput()];
 const prepares=await Promise.all([[manualPath,true],[desktopPath,false]].map(([path,mode],i)=>app.request(`${path}/replies/prepare`,commands[i],'POST',app.connection.token,{Prefer:'respond-async',...(mode?{'x-notalone-manual-contact':contact}:{})})));
 assert.deepEqual(prepares.map(item=>item.status),[202,202]);
 const statusPaths=prepares.map((item,i)=>`${[manualPath,desktopPath][i]}/replies/prepare/status/${item.data.preparation_id}`);
 const poll=async(path,mode)=>{for(let i=0;i<80;i++){const result=await request(path,undefined,mode);if(result.status!==202)return result;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('公开准备未在有界期限终结');};
 const receipts=await Promise.all([poll(statusPaths[0],true),poll(statusPaths[1],false)]);
 assert.deepEqual(receipts.map(item=>item.status),[200,200],JSON.stringify(receipts));assert.equal(provider.requests.length,0);
 assert.equal((await request(statusPaths[0],undefined,false)).status,404,'桌面范围不得领取手动准备句柄');
 assert.equal((await request(statusPaths[1],undefined,true)).status,404,'手动范围不得领取桌面准备句柄');
 const rows=(await f.client.query('SELECT idempotency_key,conversation_binding_id FROM assistant_session_turn WHERE owner_id=$1',[owner])).rows;
 assert.equal(rows.find(row=>row.idempotency_key===commands[0].idempotency_key).conversation_binding_id,manual);
 assert.equal(rows.find(row=>row.idempotency_key===commands[1].idempotency_key).conversation_binding_id,desktop);
 check('async prepare scope isolation',{prepared_count:2,physical_calls:0});
 const generated=await Promise.all([request(`${manualPath}/replies`,commands[0],true),request(`${desktopPath}/replies`,commands[1])]);
 assert.deepEqual(generated.map(item=>item.status),[200,200],JSON.stringify(generated));assert.equal(provider.requests.length,2);
 const saved=(await f.client.query('SELECT idempotency_key,conversation_binding_id FROM reply_request WHERE owner_id=$1',[owner])).rows;
 assert.equal(saved.find(row=>row.idempotency_key===commands[0].idempotency_key).conversation_binding_id,manual);
 assert.equal(saved.find(row=>row.idempotency_key===commands[1].idempotency_key).conversation_binding_id,desktop);
 assert.deepEqual(await request(`${manualPath}/replies`,commands[0],true),generated[0]);assert.equal(provider.requests.length,2);
 check('concurrent manual and desktop generation persisted',{physical_calls:2});
 const held=makeInput(),ready=new Promise(resolve=>entered=resolve);holdNext=true;
 const generating=request(`${manualPath}/replies`,held,true);await ready;
 const heldRow=(await f.client.query('SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND idempotency_key=$2',[owner,held.idempotency_key])).rows[0];
 const stopped=await request(`${manualPath}/interrupt`,{request_key:held.idempotency_key,input_version_id:heldRow.input_version_id,reason:'user_cancelled'},true);
 assert.equal(stopped.status,200,JSON.stringify(stopped));assert.equal(stopped.data.interruption_reason,'user_cancelled');release();
 const late=await generating;assert.equal(late.status,409,JSON.stringify(late));
 assert.equal(Number((await f.client.query('SELECT count(*) AS n FROM reply_candidate WHERE owner_id=$1 AND reply_request_id=(SELECT id FROM reply_request WHERE owner_id=$1 AND idempotency_key=$2)',[owner,held.idempotency_key])).rows[0].n),0);
 const retry={original_turn_id:heldRow.id,original_input_version_id:heldRow.input_version_id,request_key:randomUUID()};
 const preparedRetry=await request(`${manualPath}/retry-interrupted/prepare`,retry,true);assert.equal(preparedRetry.status,200,JSON.stringify(preparedRetry));
 const recovered=await request(`${manualPath}/retry-interrupted`,retry,true);assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.data.state,'completed');
 check('public interruption drops late result and explicit retry succeeds',{late_status:late.status});
 const candidate=recovered.data.reply.candidates[0];
 const command={idempotency_key:randomUUID(),expected_input_version_id:recovered.data.input_version_id,instruction:'第一条，简短一点',displayed_group:{session_id:manualSession.data.session_id,candidate_group_id:recovered.data.reply.reply_request_id,candidates:[{number:1,candidate_id:candidate.candidate_id,version_id:candidate.candidate_id}]}};
 const continuedPreparation=await request(`${manualPath}/continue/prepare`,command,true);assert.equal(continuedPreparation.status,200,JSON.stringify(continuedPreparation));
 const continued=await request(`${manualPath}/continue`,command,true);assert.equal(continued.status,200,JSON.stringify(continued));assert.equal(continued.data.turn_id,continuedPreparation.data.turn_id);assert.equal(continued.data.continuation.candidate_id,candidate.candidate_id);
 check('public continue prepare to business terminal');
 const original=await request(`${manualPath}/candidates/${candidate.candidate_id}/versions?page=0`,undefined,true);assert.equal(original.status,200);
 let parent=candidate.candidate_id,firstEdit;
 for(const text of ['第一次编辑','第二次编辑']){const edited=await request(`${manualPath}/candidates/${candidate.candidate_id}/versions?receipt=1`,{edit_key:randomUUID(),parent_version_id:parent,messages:[{message_id:candidate.messages[0].message_id,text}]},true);assert.equal(edited.status,200,JSON.stringify(edited));parent=edited.data.version_id;firstEdit??=parent;}
 const bounded=await request(`${manualPath}/candidates/${candidate.candidate_id}/versions?page=1&through=${firstEdit}`,undefined,true);assert.equal(bounded.status,200);assert.equal(bounded.data.version_count,2);assert.equal(bounded.data.next_page,null);assert.equal(bounded.data.default_display_version_id,firstEdit);
 check('through pagination freezes earlier version',{version_count:bounded.data.version_count});
 // 公开记录大输入，使会话跨越256KiB；不直接伪造A/C或候选锚点。
 for(let i=0;i<5;i++){const content={type:'purpose_exploration',purpose_hint:`${i}😀${'合'.repeat(3900)}`,correction:'成'.repeat(3900),requirements:'录'.repeat(3900),answer:'入'.repeat(3900),confirmed_intent:'文'.repeat(3900)};const input=await request(`${desktopPath}/inputs`,{content},false);assert.equal(input.status,200,JSON.stringify(input));}
 let part=await request(`${desktopPath}?read_part=0`);assert.equal(part.status,200);assert.ok(part.data.part_count>1);
 const readId=part.data.read_id,fragments=[part.data.payload_fragment],partCount=part.data.part_count;
 assert.ok(Buffer.byteLength(part.data.payload_fragment)<=256*1024);
 for(let i=1;i<partCount;i++){part=await request(`${desktopPath}?read_part=${i}&read_id=${readId}`);assert.equal(part.status,200);assert.ok(Buffer.byteLength(part.data.payload_fragment)<=256*1024);fragments.push(part.data.payload_fragment);}
 const joined=fragments.join('');assert.equal(createHash('sha256').update(joined).digest('hex'),readId);assert.equal(JSON.parse(joined).session_id,desktopSession.data.session_id);
 const added=await request(`${desktopPath}/inputs`,{content:{type:'purpose_exploration',purpose_hint:'分片后修改'}});assert.equal(added.status,200);
 assert.equal((await request(`${desktopPath}?read_part=1&read_id=${readId}`)).status,409);
 check('256KiB UTF8 fragments hash CAS',{part_count:partCount});
 const calls=provider.requests.length;
 await request('/api/runtime/shutdown',{});assert.equal(await app.host.waitForExit(7000),true);
 const restarted=await f.start(environment);const reopened=await restarted.request(manualPath,undefined,'GET',restarted.connection.token,{'x-notalone-manual-contact':contact});assert.equal(reopened.status,200,JSON.stringify(reopened));assert.equal(provider.requests.length,calls);
 await restarted.request('/api/runtime/shutdown',{});assert.equal(await restarted.host.waitForExit(7000),true);
 check('shutdown reopen retains business history without replay',{physical_calls:calls});
});

test.after(async()=>{if(process.env.NOTALONE_SPEC_REVIEW_RESULT)await writeFile(process.env.NOTALONE_SPEC_REVIEW_RESULT,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});});
