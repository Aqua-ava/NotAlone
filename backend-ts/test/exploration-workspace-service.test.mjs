import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fixture} from './exploration-public-support.mjs';
import {useTool,sendEvents} from './exploration-runtime-support.mjs';
const require=createRequire(new URL('../../desktop/package.json',import.meta.url));
const {build}=require('esbuild');
const bundle=await build({entryPoints:[new URL('../../desktop/src/main/reply/client.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false});
const client=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text+'\n//# sourceURL=notalone-workspace-client.mjs\n').toString('base64')}`);
test('工作区空想法直接候选与有想法表达沿原桌面适配器；50条含长正文逐字保留',{timeout:60000},async t=>{
 const payloads=[];
 const x=await fixture(t,{importSkill:false,onRequest:async({payload,events,res})=>{
  payloads.push(payload);assert.equal(payload.input_mode,'workspace');
  const ids=payload.evidence.filter(e=>e.kind==='message').map(e=>e.evidence_id);
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:payload.workspace_action==='suggest'?'最近还好吗？':'最近辛苦了，想关心一下你的近况。',basis:'当前同联系人消息及本次工作区动作',citation_ids:ids,risk_notes:[]}]});sendEvents(res,events);return true;
 }});
 const messages=[];
 for(let i=0;i<55;i++){
  const id=randomUUID(),text=i===30?'合成长消息完整正文，'.repeat(600):'合成消息'+i,speaker=i%2?'user':'contact';messages.push({id,text,speaker});
  await x.f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,$4,'text',$5,$6)",[id,x.owner,x.contact,speaker,text,`2026-01-02T00:00:${String(i).padStart(2,'0')}.123456Z`]);
  await x.f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,$6,'{}')",[randomUUID(),id,x.owner,x.contact,x.source,'recent:'+i]);
 }
 const backend={getConnectionGeneration:()=>1,requestJson:async({path,method,body,signal})=>{const r=await fetch(x.publicHost.url+path,{method,signal,headers:{Authorization:`Bearer ${x.publicHost.token}`,'Content-Type':'application/json',[x.publicHost.manual_header]:x.contact},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Object.assign(Error(data.error),{status:r.status,code:data.error});return {data,generation:1};}};
 const signal=new AbortController().signal,input={mode:'rewrite_draft',contactId:x.contact,contactDisplayName:'合成联系人',draftText:'',userInstruction:null,includeRelationshipContext:true,inputKind:'workspace',workspaceAction:'suggest',contextText:'',excludedMessageIds:[],skillChoice:{mode:'auto',versionId:null}};
 const first=await client.generateReply(backend,input,randomUUID(),signal,x.session);assert.equal(first.candidates.length,1);assert.equal(payloads.length,1);assert.equal(payloads[0].workspace_action,'suggest');assert.equal(payloads[0].draft_text,'');assert.equal(payloads[0].fidelity_contract.current_intent,null);
 function assertHistory(payload,result){
  const visible=payload.evidence.filter(e=>e.kind==='message'),expected=messages.slice(5);assert.equal(visible.length,50);
  // 模型引用使用本轮别名；公开候选回执必须逐项恢复为原消息ID。
  assert.equal(new Set(visible.map(e=>e.evidence_id)).size,50);for(const e of visible)assert.match(e.evidence_id,/^c[1-9]\d*$/);
  assert.deepEqual(result.candidates[0].citationIds,expected.map(e=>e.id));
  for(let i=0;i<visible.length;i++){assert.equal(visible[i].text,expected[i].text);assert.equal(visible[i].speaker_role,expected[i].speaker==='user'?'owner':expected[i].speaker);}
 }
 assertHistory(payloads[0],first);
 assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM reply_exploration')).rows[0].n,0);
 const draft='最近辛苦了，我想关心一下你的近况。';const second=await client.generateReply(backend,{...input,workspaceAction:'express',draftText:draft},randomUUID(),signal,x.session,undefined,undefined,first.inputVersionId);
 assert.equal(second.candidates.length,1);assert.equal(payloads.length,2);assert.equal(payloads[1].workspace_action,'express');assert.deepEqual(payloads[1].fidelity_contract.current_intent,{source:'draft_text',text:draft});assert.equal(x.host.requests.length,2);
 assertHistory(payloads[1],second);
 const saved=(await x.f.client.query("SELECT input_payload FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 ORDER BY created_at",[x.owner,x.contact])).rows;
 assert.equal(saved[0].input_payload.content.draft_text,'');assert.equal(saved[0].input_payload.content.suggestion,undefined);assert.equal(saved[0].input_payload.content.workspace_action,'suggest');assert.equal((await x.f.client.query('SELECT count(*)::int AS n FROM reply_candidate')).rows[0].n,2);
});
