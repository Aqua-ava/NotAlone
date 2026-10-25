/** 真实官方profile/HTTP/PG核对宿主回复装配，模型只替换为本地SSE端点。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {startReplyServiceHost,sendEvents,useTool} from './reply-service-runtime-support.mjs';
import {finishBatch,normalizeProposal,skillUuid5} from '../src/skill-learning-contract.ts';
import {wholeStrategyId} from '../src/skill-execution-view.ts';

function evidenceId(body){
  let result;
  const visit=value=>{
    if(Array.isArray(value)){for(const item of value)visit(item);return;}
    if(value&&typeof value==='object'){if(Array.isArray(value.evidence)&&value.evidence.length)result??=value.evidence[0].evidence_id;for(const item of Object.values(value))visit(item);return;}
    if(typeof value==='string'){try{visit(JSON.parse(value));}catch{const begin=value.indexOf('{'),end=value.lastIndexOf('}');if(begin>=0&&end>begin){try{visit(JSON.parse(value.slice(begin,end+1)));}catch{}}}}
  };
  visit(body);assert.ok(result,'只能使用实际官方请求包含的证据');return result;
}
const learningProposal={outcome:'draft',proposal_kind:'create',target_skill_ids:[],
  name:'synthetic-host-calm-reply',description:'用于共享宿主合成学习链路的状态说明。',scene:'合成宿主学习',
  scope_suggestion:{kind:'contact',reason:'只来自当前合成联系人，等待用户审核。'},
  methods:[{key:'clarify-first',title:'先澄清',instruction:'先核对对方所指的事情，再表达可编辑的回应。',
    replaces_method_ids:[]}]};

test('宿主回复装配：独立鉴权、原UUID重放、关闭取消实际stream并排空',{timeout:60000},async t=>{
  const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
  let host,fixtureClosing;
  const closeFixture=()=>fixtureClosing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  assert.equal((await f.client.query("SELECT to_regclass('public.model_call_receipt') AS table_name")).rows[0].table_name,'model_call_receipt','收据必须由正式migrator创建');
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成装配本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'合成联系人')",[contact,owner]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id) VALUES($1,$2,$3)',[binding,owner,contact]);
  let late=false,entered,releaseLate;
  const began=new Promise(resolve=>{entered=resolve;});
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},(_req,res,requests,events)=>{
    const id=evidenceId(requests.at(-1).body);
    useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'本次原句',citation_ids:[id],risk_notes:[]}]});
    if(late){releaseLate=()=>sendEvents(res,events);entered();return;}
    sendEvents(res,events);
  },{pluginPath:'test/host-reply-runtime-plugin.ts'});
  const scope={owner_id:owner,contact_id:contact,conversation_binding_id:binding};
  const request=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true});
  async function generate(body,auth=token){const response=await fetch(host.url+'/internal/reply/generate',{method:'POST',headers:{Authorization:`Bearer ${auth}`,'content-type':'application/json'},body:JSON.stringify({verified_scope:scope,request:body,internal:{}})});return {status:response.status,body:await response.json()};}
  const invalid=await generate(request(),'synthetic-public-token');assert.equal(invalid.status,401);assert.equal(host.requests.length,0);
  const firstRequest=request(),first=await generate(firstRequest);assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.reply.candidates[0].text,'明天见');
  const again=await generate(firstRequest);assert.equal(again.status,200);assert.deepEqual(again.body,first.body);assert.equal(host.requests.length,1);
  late=true;const lateRequest=request(),inFlight=generate(lateRequest);
  await Promise.race([began,inFlight.then(value=>{throw Error('取消前意外完成：'+value.status);})]);
  const closed=await host.request('/close-reply',{});assert.equal(closed.closed,true);assert.equal(closed.permits.foregroundActive,false);
  const cancelled=await inFlight;assert.equal(cancelled.status,409);assert.equal(cancelled.body.error,'reply_cancelled');
  releaseLate();
  const rows=(await f.client.query('SELECT outcome,dispatch,input_tokens,cost_amount FROM model_call_receipt ORDER BY created_at')).rows;
  // 本机SDK已取消并退出；未收到响应时仍不声称发送确认、已知用量或费用。
  assert.equal(rows.length,2);assert.equal(rows[0].outcome,'succeeded');assert.equal(rows[1].outcome,'cancelled');assert.equal(rows[1].dispatch,'authorized_unconfirmed');assert.equal(rows[1].input_tokens,null);assert.equal(rows[1].cost_amount,null);
  assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id WHERE r.idempotency_key=$1',[lateRequest.idempotency_key])).rows[0].n,0);
  const after=await generate(request());assert.equal(after.status,503);assert.equal(after.body.error,'reply_remote_unavailable');assert.equal(host.requests.length,2);
});
test('官方profile共享后台许可与PG台账：学习只发单次结构化提案，不自动发布并可关闭排空',{timeout:60000},async t=>{
  const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
  let host,fixtureClosing;
  const closeFixture=()=>fixtureClosing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成学习宿主本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成学习宿主联系人')",[contact,owner]);
  await f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic-learning-host','synthetic-learning-host','active')`,[binding,owner,contact]);
  const session=randomUUID(),input=randomUUID();
  await f.client.query('INSERT INTO assistant_session(id,owner_id,contact_id)VALUES($1,$2,$3)',[session,owner,contact]);
  await f.client.query(`INSERT INTO assistant_session_input(id,session_id,owner_id,contact_id,conversation_binding_id,
    input_type,content)VALUES($1,$2,$3,$4,$5,'purpose_exploration',$6)`,
  [input,session,owner,contact,binding,{type:'purpose_exploration',
    correction:'共享宿主合成纠正：先核对对方所指的事情再表达。'}]);
  await f.client.query('UPDATE assistant_session SET current_input_version_id=$2 WHERE id=$1',[session,input]);
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},
    (_req,res,requests,events)=>{
      const names=(requests.at(-1).body.tools??[]).map(tool=>tool.name);
      if(names.join(',')!=='SkillLearningProposal'){
        res.statusCode=500;res.end('{}');return;
      }
      useTool(events,'SkillLearningProposal',learningProposal,'synthetic-learning-proposal');
      sendEvents(res,events);
    },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{
      NOTALONE_SYNTHETIC_L2:'1',NOTALONE_SYNTHETIC_EXTRACTION:'1',
    }});
  const scopePath=`/api/contacts/${contact}/skill-learning`;
  const request=async(method='GET',body)=>{
    const response=await fetch(host.url+scopePath,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const enabled=await request('POST',{enabled:true,confirmed:true,expected_revision:0,operation_key:randomUUID()});
  assert.equal(enabled.status,200,JSON.stringify(enabled.body));
  const deadline=Date.now()+10_000;
  let state;
  while(Date.now()<deadline){
    state=(await request()).body;
    if(state?.task?.status==='succeeded')break;
    assert.notEqual(state?.task?.status,'failed',JSON.stringify(state));
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(state?.task?.status,'succeeded',JSON.stringify(state));
  assert.equal(state.drafts.length,1);assert.equal(state.drafts[0].status,'pending');
  assert.equal(host.requests.length,1);
  assert.deepEqual(host.requests[0].body.tools.map(tool=>tool.name),['SkillLearningProposal']);
  const receipt=(await f.client.query(`SELECT request_id,permit_id,outcome,dispatch FROM model_call_receipt
    WHERE owner_id=$1 AND contact_id=$2`,[owner,contact])).rows[0];
  assert.ok(receipt?.permit_id);assert.equal(receipt.outcome,'succeeded');
  assert.ok(['response_observed','http_accepted'].includes(receipt.dispatch));
  assert.equal((await f.client.query('SELECT count(*)::int AS count FROM reply_skill_version')).rows[0].count,0);
  assert.equal((await f.client.query('SELECT count(*)::int AS count FROM skill_review_comparison')).rows[0].count,0);
  const closed=await host.request('/close-reply',{});
  assert.equal(closed.permits.backgroundActive,0);
  const after=await fetch(host.url+scopePath,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(after.status,503);
});
test('官方profile审核对照使用同一生产上下文并生成可审核候选，批准前不发布且台账覆盖两侧调用',{timeout:60000},async t=>{
  const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
  let host,fixtureClosing;
  const closeFixture=()=>fixtureClosing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成审核宿主本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成审核宿主联系人')",[contact,owner]);
  await f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic-review-host','synthetic-review-host','active')`,[binding,owner,contact]);
  await f.client.query('INSERT INTO skill_library(owner_id,revision)VALUES($1,0)',[owner]);
  const logical=skillUuid5(contact,'learned_skill:synthetic-review-host'),method=skillUuid5(logical,'method:clarify-first');
  const strategy={name:'synthetic-review-host',description:'合成审核对照策略。',scene:'合成审核',
    document:`---\nname: synthetic-review-host\ndescription: "合成审核对照策略。"\n---\n# 合成审核\n\n## 先澄清\n先核对对方所指的事情，再表达可编辑的回应。`,
    methods:[{method_id:method,logical_skill_id:logical,key:'clarify-first',title:'先澄清',
      instruction:'先核对对方所指的事情，再表达可编辑的回应。',replaces_method_ids:[],mapping_status:'new'}],
    scope_suggestion:{kind:'contact',reason:'仅供当前合成联系人审核。',contact_id:contact}};
  const draft=randomUUID(),generation={version:1,dependencies:[],messages:{version:1,source_ids:[],source_refs:[],
    message_ids:[],message_digests:{},message_snapshots:{},message_scopes:{}},sources:{},observations:{},memories:{},preferences:{}};
  await f.client.query(`INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,
    private_evidence,target_versions,dependency_ids,source_generation,batch_key)
    VALUES($1,$2,$3,$4,'create',$5,$6,'[]','{}',$7,$8)`,
  [draft,owner,contact,logical,strategy,{materials:[],existing_skills:[]},generation,`synthetic-review-${draft}`]);
  let afterRead=false;
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},
    (_req,res,requests,events)=>{
      const body=requests.at(-1).body,names=(body.tools??[]).map(tool=>tool.name),id=evidenceId(body);
      if(names.includes('read_file')&&!afterRead){
        const path=JSON.stringify(body).match(/\/notalone\/reply-skills\/[^"\\ ]+\/SKILL\.md/)?.[0];
        assert.ok(path,'审核草稿目录须提供受控Skill路径');
        afterRead=true;useTool(events,'read_file',{file_path:path,offset:0,limit:1000},'synthetic-review-read');
        sendEvents(res,events);return;
      }
      const after=names.includes('read_file');
      useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{
        text:after?'按审核草稿：明天见，想和你确认时间。':'通用表达：明天见。',
        basis:after?'用户本次审核输入与隔离草稿。':'用户本次审核输入。',
        citation_ids:[id],risk_notes:[],
      }]},after?'synthetic-review-after':'synthetic-review-before');
      sendEvents(res,events);
    },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{
      NOTALONE_SYNTHETIC_L2:'1',NOTALONE_SYNTHETIC_EXTRACTION:'1',
    }});
  const base=`/api/contacts/${contact}/skill-learning`,confirmed={kind:'contact',contact_id:contact,scene:null};
  const request=async(suffix,method='POST',body)=>{
    const response=await fetch(host.url+base+suffix,{method,headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const compared=await request(`/drafts/${draft}/compare`,'POST',{expected_revision:1,operation_key:randomUUID(),
    input:{incoming_text:'明天见。',intent:'直接但不催促地确认时间。',scene:'合成审核'},scope:confirmed});
  assert.equal(compared.status,200,JSON.stringify(compared.body));
  assert.equal(compared.body.draft.comparison?.valid,true,JSON.stringify(compared.body));
  assert.equal(compared.body.draft.comparison.after.load_state,'loaded');
  assert.equal(compared.body.draft.comparison.before.candidates[0].text,'通用表达：明天见。');
  assert.equal(compared.body.draft.comparison.after.candidates[0].text,'按审核草稿：明天见，想和你确认时间。');
  assert.equal(host.requests.length,3);
  assert.equal((await f.client.query('SELECT count(*)::int AS count FROM reply_skill_version')).rows[0].count,0);
  const calls=(await f.client.query('SELECT side,count(*)::int AS count FROM skill_review_call GROUP BY side ORDER BY side')).rows;
  assert.deepEqual(calls,[{side:'after',count:2},{side:'before',count:1}]);
  const approved=await request(`/drafts/${draft}/approve`,'POST',{expected_revision:1,operation_key:randomUUID(),
    comparison_id:compared.body.draft.comparison.comparison_id,scope:confirmed,confirmed:true,replacements_confirmed:true});
  assert.equal(approved.status,200,JSON.stringify(approved.body));
  assert.equal(approved.body.draft.status,'published');
  assert.equal((await f.client.query('SELECT count(*)::int AS count FROM reply_skill_version')).rows[0].count,1);
  assert.equal((await f.client.query('SELECT count(*)::int AS count FROM model_call_receipt')).rows[0].count,3);
});
test('官方profile更新草稿对照强制加载冻结旧版本与隔离草稿',{timeout:60000},async t=>{
  const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),binding=randomUUID(),token=randomUUID()+randomUUID();
  let host,fixtureClosing;
  const closeFixture=()=>fixtureClosing??=f.close();
  t.after(async()=>{if(host)await host.stop();await closeFixture();});
  await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成更新审核本人')",[owner]);
  await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成更新审核联系人')",[contact,owner]);
  await f.client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,status)
    VALUES($1,$2,$3,'wechat','synthetic-update-review','synthetic-update-review','active')`,[binding,owner,contact]);
  const packagePath=join(f.directory,'synthetic-target-skill');
  await mkdir(packagePath,{recursive:true});
  await writeFile(join(packagePath,'SKILL.md'),
    '---\nname: synthetic-target-skill\ndescription: "合成更新审核目标。"\n---\n# 原方法\n\n先确认对方意思，再说明处理安排。');
  let originalSeen=false,updatedSeen=false;
  host=await startReplyServiceHost(t,{name:f.client.database,user:f.client.user,replyOwner:owner,replyToken:token,close:closeFixture},
    (_req,res,requests,events)=>{
      const body=requests.at(-1).body,serialized=JSON.stringify(body),id=evidenceId(body);
      if(serialized.includes('先确认对方意思，再说明处理安排。'))originalSeen=true;
      if(serialized.includes('先确认对方目标，再给出清晰选择。'))updatedSeen=true;
      useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{
        text:originalSeen&&!updatedSeen?'按冻结旧版回应。':'按待审更新回应。',
        basis:'用户本次审核输入与实际加载策略。',citation_ids:[id],risk_notes:[],
      }]},'synthetic-update-review');
      sendEvents(res,events);
    },{pluginPath:'test/host-reply-runtime-plugin.ts',environment:{
      NOTALONE_SYNTHETIC_L2:'1',NOTALONE_SYNTHETIC_EXTRACTION:'1',NOTALONE_SYNTHETIC_SKILL_PACKAGE:packagePath,
    }});
  const auth={Authorization:`Bearer ${token}`,'content-type':'application/json'};
  const imported=(await f.client.query("SELECT skill.id AS skill_id,version.id AS version_id FROM reply_skill skill JOIN reply_skill_version version ON version.skill_id=skill.id WHERE skill.owner_id=$1 AND skill.name='synthetic-target-skill' AND version.version_number=1",[owner])).rows[0];
  assert.ok(imported);
  const target={skill_id:imported.skill_id,version_id:imported.version_id,version_number:1,name:'synthetic-target-skill',
    description:'合成更新审核目标。',document:'# 原方法\n\n先确认对方意思，再说明处理安排。',
    methods:[{method_id:wholeStrategyId(imported.skill_id),logical_skill_id:imported.skill_id}],
    scope:{kind:'owner',contact_id:null,scene:null},source_dependency_count:0};
  const batch=finishBatch({materials:[],targets:[target],dependency_ids:[],library_revision:1,scope_revision:0,
    source_generation:{},material_budget_limited:false});
  const normalized=normalizeProposal({owner_id:owner,contact_id:contact},batch,{outcome:'draft',proposal_kind:'update',
    target_skill_ids:[target.skill_id],name:target.name,description:'合成更新审核草稿。',scene:'合成更新审核',
    scope_suggestion:{kind:'contact',reason:'只用于当前合成联系人审核。'},
    methods:[{key:'clarify-target',title:'先确认目标',instruction:'先确认对方目标，再给出清晰选择。',
      replaces_method_ids:[target.methods[0].method_id]}]}).proposal;
  const draft=randomUUID(),generation={version:1,dependencies:[],messages:{version:1,source_ids:[],source_refs:[],
    message_ids:[],message_digests:{},message_snapshots:{},message_scopes:{}},sources:{},observations:{},memories:{},preferences:{}};
  await f.client.query(`INSERT INTO skill_draft(id,owner_id,contact_id,logical_skill_id,proposal_kind,strategy,
    private_evidence,target_versions,dependency_ids,source_generation,batch_key)
    VALUES($1,$2,$3,$4,'update',$5,$6,$7,'{}',$8,$9)`,
  [draft,owner,contact,normalized.logical_skill_id,normalized.strategy,
    {materials:[],existing_skills:[target]},JSON.stringify(normalized.target_versions),generation,`synthetic-update-${draft}`]);
  const confirmed={kind:'contact',contact_id:contact,scene:null};
  const response=await fetch(`${host.url}/api/contacts/${contact}/skill-learning/drafts/${draft}/compare`,{
    method:'POST',headers:auth,body:JSON.stringify({expected_revision:1,operation_key:randomUUID(),
      input:{incoming_text:'这件事怎么安排？',intent:'先确认对方指的是哪件事。',scene:'合成更新审核'},scope:confirmed}),
  });
  const compared=await response.json();
  assert.equal(response.status,200,JSON.stringify(compared));
  assert.equal(originalSeen,true,'旧版侧必须实际加载冻结目标版本');
  assert.equal(updatedSeen,true,'草稿侧必须实际加载隔离草稿');
  assert.equal(compared.draft.comparison.before.version_id,imported.version_id);
  assert.equal(compared.draft.comparison.before.load_state,'loaded');
  assert.equal(compared.draft.comparison.after.version_id,compared.draft.comparison.comparison_id);
  assert.equal(compared.draft.comparison.after.load_state,'loaded');
});
