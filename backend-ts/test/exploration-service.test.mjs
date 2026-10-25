import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {homedir} from 'node:os';
import {rm} from 'node:fs/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startExplorationRuntimeHost,useTool,sendEvents} from './exploration-runtime-support.mjs';
import {payloadJson} from './exploration-public-support.mjs';
test('公开探索→原A准备→真实C候选；建议未确认、停止、新开、同键不重发及跨联系人拒绝',{timeout:60000},async t=>{
 const f=await createStorageFixture();
 t.after(async()=>{await f.client.end();execFileSync(homedir()+'/miniconda3/envs/NotAlone/bin/python',['-c',"import sys,psycopg\nfrom psycopg import sql\nassert sys.argv[1].startswith('notalone_ts_host_') and sys.argv[1].endswith('_test')\nwith psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:c.execute(sql.SQL('DROP DATABASE {}').format(sql.Identifier(sys.argv[1])))",f.client.database]);await rm(f.directory,{recursive:true});});
 const owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),session=randomUUID(),source=randomUUID(),message=randomUUID(),token='synthetic-exploration-service-token-'.repeat(2);
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成人')",[owner]);await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[contact,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
 await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','合成来源',$4,1)",[source,owner,contact,'a'.repeat(64)]);
 await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text','最近有空吗','2026-01-01T01:02:03.123456Z')",[message,owner,contact]);
 await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,'line:1','{}')",[randomUUID(),message,owner,contact,source]);
 let invalidOutput=false;
 const host=await startExplorationRuntimeHost(t,(req,res,requests,events)=>{
  const payload=payloadJson(requests.at(-1).body.messages[0].content[0].text);const id=payload.evidence[0].evidence_id;if(invalidOutput){useTool(events,'ExplorationOutput',{broken:true});sendEvents(res,events);return;}
  if(requests.at(-1).body.tools.some(x=>x.name==='ReplyRuntimeOutput')){useTool(events,'ReplyRuntimeOutput',{candidates:[{text:'最近还好吗？',basis:'依据本次已选意愿和当前原话',citation_ids:[id],risk_notes:[]}],used_skill_version_id:null});sendEvents(res,events);return;}
  assert.deepEqual(requests.at(-1).body.tools.map(x=>x.name),['ExplorationOutput']);assert.equal(payload.scene,'initiate_conversation');assert.equal(payload.evidence[0].fingerprint,undefined);
  useTool(events,'ExplorationOutput',{understanding:'合成近况询问',ambiguities:[],citation_ids:[id],options:[{intent:'了解近况',label:'关心',reason:'近期原话',citation_ids:[id],recommended:true,pause:false},{intent:'稍后联系',label:'稍后',reason:'由用户决定',citation_ids:[],recommended:false,pause:false}],question:null,current_step:'选择本次意愿',tradeoffs:[]});sendEvents(res,events);
 },false,{pluginPath:'test/exploration-service-plugin.ts',allowPostgres:true,environment:{NOTALONE_SYNTHETIC_DATABASE:f.client.database,NOTALONE_SYNTHETIC_REPLY_OWNER:owner,NOTALONE_SYNTHETIC_REPLY_TOKEN:token}});
 const child=spawn(homedir()+'/miniconda3/envs/NotAlone/bin/python',['test/exploration-public-fixture.py','--database','host=/tmp dbname='+f.client.database,'--owner',owner,'--remote-url',host.url,'--remote-token',token],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1'},stdio:['pipe','pipe','pipe']});
 let output='';child.stderr.on('data',b=>output+=b);const exited=once(child,'exit');
 const publicHost=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('公开夹具启动超时 '+output)),15000);child.stdout.on('data',b=>{output+=b;const m=output.match(/READY (.+)\n/);if(m){clearTimeout(timer);resolve(JSON.parse(m[1]));}});child.once('exit',()=>{clearTimeout(timer);reject(Error('公开夹具退出 '+output));});});
 const closePublic=async()=>{if(child.exitCode===null&&child.signalCode===null)child.stdin.end();const [code]=await exited;assert.equal(code,0,output);};t.after(closePublic);
 const send=async(action,request,extra={})=>{
  const rbody=structuredClone(request);const id=rbody.exploration_id;delete rbody.exploration_id;
  const cid=extra.contact_id??contact;let path=`/api/contacts/${cid}/assistant-sessions/${session}/explorations`;
  if(action!=='open')path+='/'+id;if(!['open','read'].includes(action))path+='/'+action;
  if(action==='confirm'){rbody.generate=!rbody.selection_only;delete rbody.selection_only;}
  const r=await fetch(publicHost.url+path,{method:action==='read'?'GET':'POST',headers:{Authorization:`Bearer ${publicHost.token}`,'Content-Type':'application/json',[publicHost.manual_header]:cid},...(action==='read'?{}:{body:JSON.stringify(rbody)})});const body=await r.json();return {status:r.status,body:r.ok?{result:body}:body};
 };
 const open={operation_key:randomUUID(),content:{type:'purpose_exploration',purpose_hint:'了解近况',skill_mode:'disabled'}};
 let response=await send('open',open);assert.equal(response.status,200,JSON.stringify(response.body));let result=response.body.result;
 assert.equal(result.kind,'directions');assert.equal(result.confirmed_intent,null);assert.equal(result.evidence[0].evidence_id,message);assert.equal(result.options[0].recommended,true);assert.equal(host.requests.length,1);
 assert.deepEqual((await send('open',open)).body.result,result);assert.equal(host.requests.length,1);
 assert.equal((await send('read',{exploration_id:result.exploration_id},{contact_id:randomUUID()})).status,409);assert.equal(host.requests.length,1);
 assert.equal((await send('stop',{exploration_id:result.exploration_id,input_version_id:result.input_version_id})).status,200);
 assert.equal((await send('confirm',{exploration_id:result.exploration_id,input_version_id:result.input_version_id,suggestion_id:result.options[0].suggestion_id,selection_only:true})).status,409);assert.equal(host.requests.length,1);
 response=await send('open',{...open,operation_key:randomUUID(),expected_input_version_id:result.input_version_id});assert.equal(response.status,200,JSON.stringify(response.body));result=response.body.result;assert.equal(result.confirmed_intent,null);assert.equal(host.requests.length,2);
 assert.equal((await send('confirm',{exploration_id:result.exploration_id,input_version_id:result.input_version_id,suggestion_id:result.options[0].suggestion_id,selection_only:true})).body.result.confirmed_intent,'了解近况');
 const command={exploration_id:result.exploration_id,input_version_id:result.input_version_id,suggestion_id:result.options[0].suggestion_id,generate:true};
 const prepared=await send('prepare-confirm',command);assert.equal(prepared.status,200,JSON.stringify(prepared.body));assert.equal(prepared.body.result.kind,'prepared');assert.equal(host.requests.length,2);
 const generated=await send('confirm',{...command,selection_only:false});assert.equal(generated.status,200,JSON.stringify(generated.body));assert.equal(generated.body.result.kind,'generated');assert.ok(JSON.stringify(generated.body).includes('最近还好吗'));assert.equal(host.requests.length,3);
 assert.deepEqual((await send('confirm',{...command,selection_only:false})).body.result,generated.body.result);assert.equal(host.requests.length,3);
 assert.equal((await send('confirm',{exploration_id:result.exploration_id,input_version_id:result.input_version_id,direct_intent:'改方向',selection_only:true})).status,409);assert.equal(host.requests.length,3);
 const saved=(await f.client.query("SELECT t.state,t.reply_request_id,(SELECT count(*)::int FROM reply_candidate c WHERE c.reply_request_id=t.reply_request_id) AS candidates FROM assistant_session_turn t WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.session_id=$3 AND t.id=$4",[owner,contact,session,prepared.body.result.generation.turn_id])).rows[0];
 assert.equal(saved.state,'completed');assert.ok(saved.reply_request_id);assert.equal(saved.candidates,1);
 const sources=(await f.client.query('SELECT evidence_id FROM reply_context_evidence WHERE reply_request_id=$1',[saved.reply_request_id])).rows;assert.ok(sources.some(x=>x.evidence_id===message));
 invalidOutput=true;const malformed=await send('open',{...open,operation_key:randomUUID(),expected_input_version_id:prepared.body.result.generation.input_version_id});assert.equal(malformed.status,409,JSON.stringify(malformed.body));assert.equal(host.requests.length,4);
 await closePublic();await host.stop();assert.equal((await f.client.query('SELECT count(*)::int AS n FROM model_call_receipt WHERE request_id=$1',[result.exploration_id])).rows[0].n,1);
});
