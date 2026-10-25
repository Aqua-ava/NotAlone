import {cleanupB5BackgroundFixture,prepareB5ArtifactDirectory} from './reply-background-cleanup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {captureSnapshot} from '../src/contact-overview-evidence.ts';
import {createInterface} from 'node:readline';
import {sendEvents,useTool} from './reply-service-runtime-support.mjs';
// 只复制Python源码/迁移到自有tmp；guard不是产品runtime文件。
async function copyVerified(source,target){
 const hashes=[];
 async function visit(from,to,prefix=''){
  await mkdir(to,{recursive:true});
  for(const item of await readdir(from,{withFileTypes:true})){
   if(item.name==='__pycache__'||item.name.endsWith('.pyc'))continue;
   const relative=prefix+item.name,a=join(from,item.name),b=join(to,item.name);
   if(item.isDirectory())await visit(a,b,relative+'/');
   else if(item.isFile()){const bytes=await readFile(a);await writeFile(b,bytes);assert.deepEqual(await readFile(b),bytes);hashes.push([relative,createHash('sha256').update(bytes).digest('hex')]);}
   else assert.fail('测试产品副本不接受符号链接');
  }
 }
 await visit(source,target);
 return {hashes,async verify(){for(const [name,hash] of hashes){assert.equal(createHash('sha256').update(await readFile(join(target,name))).digest('hex'),hash);assert.equal(createHash('sha256').update(await readFile(join(source,name))).digest('hex'),hash);}}};
}
function evidenceId(body){let id;const visit=v=>{if(Array.isArray(v))return v.forEach(visit);if(v&&typeof v==='object'){if(Array.isArray(v.evidence))id??=v.evidence.find(e=>e.kind==='user_draft')?.evidence_id??v.evidence[0]?.evidence_id;Object.values(v).forEach(visit);}if(typeof v==='string'){try{visit(JSON.parse(v));}catch{const a=v.indexOf('{'),b=v.lastIndexOf('}');if(a>=0&&b>a)try{visit(JSON.parse(v.slice(a,b+1)));}catch{}}}};visit(body);assert.ok(id);return id;}

test('B5-01真实主宿主公开session背景与来源失效晚结果',{timeout:process.env.NOTALONE_B5_INTERACTIVE==='1'?30*60*1000:90000},async t=>{
 const artifact=await prepareB5ArtifactDirectory(process.env.NOTALONE_B5_ARTIFACT_DIR);
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),other=randomUUID(),foreignOwner=randomUUID(),foreign=randomUUID(),binding=randomUUID();
 let child,exited,output='',connection,releaseLate,lateObserved,legacyPid,control;
 const seen=[],requests=[],checkpoints=[];let mode='normal';
 const source=randomUUID(),message=randomUUID(),memory=randomUUID(),candidate=randomUUID();
 const allowedText='B5合成甲喜欢清淡饮食，周六一起散步。',replyText='周六一起散步，吃点清淡的。';
 const sentinelContact='B5_CROSS_CONTACT_SENTINEL_7091',sentinelOwner='B5_CROSS_OWNER_SENTINEL_5834';
 const writeArtifact=async(name,value)=>writeFile(join(artifact,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
 const evidenceFrom=body=>{const rows=[];const visit=v=>{if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object'){if(Array.isArray(v.evidence))rows.push(...v.evidence);for(const[k,x]of Object.entries(v))if(k!=='evidence')visit(x);}else if(typeof v==='string'){try{visit(JSON.parse(v));}catch{const a=v.indexOf('{'),b=v.lastIndexOf('}');if(a>=0&&b>a)try{visit(JSON.parse(v.slice(a,b+1)));}catch{}}}};visit(body);return rows;};
 const provider=createServer(async(req,res)=>{try{
  let raw='';for await(const p of req)raw+=p;const body=JSON.parse(raw),evidence=evidenceFrom(body);seen.push({path:req.url,body,headers:req.headers,at:Date.now(),mode});
  const wireMessage=evidence.find(e=>e.kind==='message'&&e.text===allowedText),wireMemory=evidence.find(e=>e.kind==='confirmed_memory'&&e.text===allowedText);
  assert.ok(wireMessage&&wireMemory,'真实wire应有同联系人近期消息与关系资料');
  assert.match(wireMessage.evidence_id,/^c[1-9]\d*$/);assert.match(wireMemory.evidence_id,/^c[1-9]\d*$/);
  const wire=JSON.stringify(body);assert.ok(!wire.includes(sentinelContact)&&!wire.includes(sentinelOwner));assert.ok(!wire.includes(other)&&!wire.includes(foreign)&&!wire.includes(foreignOwner));
  assert.ok(!wire.includes(message)&&!wire.includes(memory));
  const events=[{type:'message_start',message:{id:'synthetic-b5',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];
  useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:replyText,basis:'同联系人来源中的清淡饮食与周六散步。',citation_ids:[wireMessage.evidence_id,wireMemory.evidence_id],risk_notes:[]}]});
  if(mode==='late'){let pending=true;const release=()=>{if(!pending)return;pending=false;if(releaseLate===release)releaseLate=undefined;if(res.writableEnded||res.destroyed)return;sendEvents(res,events);};releaseLate=release;lateObserved?.();return;}sendEvents(res,events);
 }catch(error){output+='\nPROVIDER_ASSERT '+error.stack;res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'synthetic_provider_assert'}));}});
 t.after(async()=>{
  await cleanupB5BackgroundFixture({
   host:child?{child,exited}:undefined,legacyPid,
   stageTimeoutMs:typeof cleanupStageTimeoutMs==='number'?cleanupStageTimeoutMs:9000,
   shutdown:()=>request('/api/runtime/shutdown',{}),releasePending:()=>releaseLate?.(),
   closeProvider:async()=>{const settled=await Promise.allSettled([provider,control].filter(Boolean).map(async server=>{server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}));const errors=settled.filter(x=>x.status==='rejected').map(x=>x.reason);if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'provider/control关闭失败',{cause:errors[0]});},
   checkClientConnections:async()=>{const n=Number((await f.client.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()')).rows[0].n);if(n!==0)throw new Error('B5-01仍有自有数据库连接，保留现场');},
   captureEvidence:()=>writeArtifact('execution-private.json',{seen,requests,checkpoints,host_output:output}),
   closeClient:()=>f.client.end(),
   disposeFixture:()=>f.close(),
   legacyGone:pid=>{try{process.kill(pid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},
   writeProof:proof=>writeArtifact('cleanup.json',{...proof,owned_database:f.client.database,host_pid:child?.pid??null,legacy_pid:legacyPid??null,directory:f.directory}),
  });
 });
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'B5合成本人'),($2,'B5另一合成本人')",[owner,foreignOwner]);
 for(const[id,own,name]of [[contact,owner,'B5合成联系人甲'],[other,owner,'B5合成联系人乙'],[foreign,foreignOwner,'B5另一个用户联系人']]){
  await f.client.query('INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,$3)',[id,own,name]);
  await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[id===contact?binding:randomUUID(),own,id]);
 }
 await f.client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status)VALUES($1,$2,'wechat','synthetic-b5','synthetic-b5-a','active'),($1,$3,'wechat','synthetic-b5','synthetic-b5-b','active')",[owner,contact,other]);
 const seed=async(own,ct,text,ids={})=>{
  const s=ids.source??randomUUID(),m=ids.message??randomUUID(),c=ids.candidate??randomUUID(),mem=ids.memory??randomUUID();
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)VALUES($1,$2,$3,'manual','B5合成来源',$4,1)",[s,own,ct,createHash('sha256').update(text).digest('hex')]);
  await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)VALUES($1,$2,$3,'contact','text',$4,'2026-10-24T01:02:03.123456Z')",[m,own,ct,text]);
  await f.client.query("INSERT INTO message_source_ref(id,message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)VALUES($1,$2,$3,$4,'source_document',$5,'b5:line:1','{}')",[randomUUID(),m,own,ct,s]);
  const frozen=await captureSnapshot(f.client,own,[m],[m],ct);
  await f.client.query("INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,topic,source_ids,status,correction_evidence)VALUES($1,$2,$3,$4,'common_fact','other',$5,'pending',$6)",[c,own,ct,text,[m],frozen]);
  await f.client.query("INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,topic,source_ids,source_candidate_id,adoption_method)VALUES($1,$2,$3,$4,'common_fact','other',$5,$6,'auto')",[mem,own,ct,text,[m],c]);
  return{source:s,message:m,memory:mem};
 };
 await seed(owner,contact,allowedText,{source,message,candidate,memory});await seed(owner,other,sentinelContact);await seed(foreignOwner,foreign,sentinelOwner);
 await writeFile(f.envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${f.client.database}\nNOTALONE_OWNER_ID=${owner}\nNOTALONE_REPLY_RUNTIME=typescript\nNOTALONE_DEEPSEEK_API_KEY=synthetic-only\nNOTALONE_EXTRACTION_BATCH_CONCURRENCY=2\nNOTALONE_SKILLS_DIR=${f.directory}/skills\n`,{mode:0o600});
 const project=join(f.directory,'project');const pythonCopy=await copyVerified(resolve('../backend/src'),join(project,'backend/src')),migrationCopy=await copyVerified(resolve('../backend/database'),join(project,'backend/database'));
 await copyFile(new URL('./main-host-reply-chain-network-guard.py',import.meta.url),join(project,'backend/src/sitecustomize.py'));
 const home=join(f.directory,'profile-home'),profile=join(home,'profiles/notalone'),info=join(f.directory,'backend.info');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));await writeFile(join(profile,'cordis.patch.yml'),(await readFile('profile/host.patch.yml','utf8')).replace('PLUGIN_PATH',JSON.stringify(resolve('src/host-plugin.ts'))));
 await writeFile(join(home,'host.json'),JSON.stringify({nodeExecutable:process.execPath,projectDirectory:project,envFilePath:f.envFilePath,infoPath:info,businessHome:f.directory,pythonExecutable:join(homedir(),'miniconda3/envs/NotAlone/bin/python'),home,parentPid:process.pid,lockNonce:randomUUID()}));
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 child=spawn(process.execPath,['--import',new URL('./main-host-reply-chain-preload.mjs',import.meta.url).pathname,resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:home,env:{PATH:process.env.PATH,USER:process.env.USER,HOME:home,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1',NOTALONE_HOST_CONFIG:join(home,'host.json'),NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}`},stdio:['pipe','pipe','pipe']});exited=once(child,'exit');child.stderr.on('data',v=>output+=v);child.stdout.on('data',v=>output+=v);
 for(let i=0;i<150&&child.exitCode===null;i++){try{connection=Object.fromEntries((await readFile(info,'utf8')).trim().split('\n').map(l=>l.split('=')));break;}catch{}await delay(100);}
 const safeOutput=()=>output.replaceAll(homedir(),'${HOME}').replaceAll(resolve('..'),'${REPO_ROOT}').replace(/token=[A-Za-z0-9_-]+/g,'token=<synthetic-redacted>');
 assert.ok(connection,'主宿主应发布握手 '+safeOutput());
 async function request(path,body,token=connection.token){const r=await fetch(`http://${connection.address}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(15000)});const result={status:r.status,data:await r.json()};requests.push({path,body,result,at:Date.now()});return result;}

 const status=await request('/api/runtime/status');legacyPid=status.data.legacyPid;assert.equal(status.data.ownership.replies,'typescript');assert.ok(legacyPid);
 const body=()=>({contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'workspace',workspace_action:'express',draft_text:'周六一起散步，想吃清淡的。',user_instruction:null,include_relationship_context:true},skill_disabled:true});
 const makeSession=async()=>{const x=await request(`/api/contacts/${contact}/assistant-session/default`,{});assert.equal(x.status,200,JSON.stringify(x));return x.data.session_id;};
 const prepared=async(path,command)=>{const initial=await fetch(`http://${connection.address}${path}/prepare`,{method:'POST',headers:{Authorization:`Bearer ${connection.token}`,'content-type':'application/json',Prefer:'respond-async'},body:JSON.stringify(command),signal:AbortSignal.timeout(15000)});let result={status:initial.status,data:await initial.json()};requests.push({path:path+'/prepare',body:command,result,at:Date.now()});if(result.status===202){const id=result.data.preparation_id;assert.ok(id);for(let i=0;i<100&&result.status===202;i++){await delay(50);result=await request(path+`/prepare/status/${id}`);}}assert.equal(result.status,200,JSON.stringify(result));return result.data;};
 if(process.env.NOTALONE_B5_INTERACTIVE==='1'){
  const session=await makeSession(),finish={};finish.promise=new Promise(r=>finish.resolve=r);const controlToken=randomUUID();
  control=createServer(async(req,res)=>{if(req.headers.authorization!==`Bearer ${controlToken}`){res.writeHead(401);res.end('{}');return;}if(req.url==='/finish'){res.end('{"finishing":true}');finish.resolve();return;}if(req.url==='/arm-late'){mode='late';res.end('{"armed":true}');return;}if(req.url==='/release'){releaseLate?.();mode='normal';res.end('{"released":true}');return;}res.end(JSON.stringify({mode,physical_http:seen.length,provider_late_started:!!releaseLate}));});control.listen(0,'127.0.0.1');await once(control,'listening');
  await writeArtifact('ready-private.json',{connection,owner_id:owner,contact_id:contact,other_contact_id:other,session_id:session,source_id:source,message_id:message,memory_id:memory,fixture_directory:f.directory,env_file:f.envFilePath,business_home:f.directory,profile_home:home,host_pid:child.pid,legacy_pid:legacyPid,control_url:`http://127.0.0.1:${control.address().port}`,control_token:controlToken,scope:'只限公开合成fixture；实际App复用后端，非App启动配置态验收'});
  console.log('B5_INTERACTIVE_READY');await finish.promise;control.closeAllConnections();await new Promise(r=>control.close(r));return;
 }
 const session=await makeSession(),path=`/api/contacts/${contact}/assistant-sessions/${session}/replies`,command=body();
 const receipt=await prepared(path,command);assert.equal(seen.length,0,'prepare不得物理出站');
 const result=await request(path,command);assert.equal(result.status,200,JSON.stringify({result,http:seen.length,output:safeOutput()}));assert.equal(result.data.state,'completed');assert.equal(result.data.input_version_id,receipt.input_version_id);assert.equal(result.data.turn_id,receipt.turn_id);assert.equal(seen.length,1);
 const rows=(await f.client.query('SELECT id,state,context_snapshot FROM reply_request WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows;assert.equal(rows.length,1);assert.equal(rows[0].state,'completed');
 const saved=(await f.client.query('SELECT c.id,c.candidate_text,c.basis,e.evidence_id,e.kind,e.evidence_text,e.source_ids FROM reply_candidate c JOIN reply_candidate_citation ce ON ce.candidate_id=c.id JOIN reply_context_evidence e ON e.reply_request_id=ce.reply_request_id AND e.evidence_id=ce.evidence_id WHERE c.reply_request_id=$1 ORDER BY e.evidence_id',[rows[0].id])).rows;
 assert.equal(saved.length,2);assert.ok(saved.every(x=>x.candidate_text===replyText));assert.deepEqual(new Set(saved.map(x=>x.evidence_id)),new Set([message,memory]));assert.ok(saved.every(x=>x.evidence_text===allowedText&&x.source_ids.length>0));
 const sessionRead=await request(`/api/contacts/${contact}/assistant-sessions/${session}`);assert.equal(sessionRead.status,200,JSON.stringify(sessionRead));assert.ok(JSON.stringify(sessionRead.data).includes(replyText));assert.ok(!JSON.stringify(sessionRead.data).includes(sentinelContact));
 const replay=await request(path,command);assert.equal(replay.status,200);assert.equal(seen.length,1,'同键重放不得增加HTTP');assert.deepEqual(replay.data,result.data);
 checkpoints.push({normal:{session_id:session,receipt,result:result.data,persisted_reply_request_id:rows[0].id,candidate_evidence:saved,public_session:sessionRead.data,physical_http:seen.length}});
 mode='late';const lateCommand=body(),lateReceipt=await prepared(path,lateCommand),entered=new Promise(r=>lateObserved=r);const lateResult=request(path,lateCommand);
 await Promise.race([entered,lateResult.then(r=>{throw Error('迟到分支未抵达provider: '+JSON.stringify(r));})]);assert.equal(seen.length,2);
 await f.client.query("UPDATE source_document SET status='deleting' WHERE id=$1 AND owner_id=$2 AND contact_id=$3",[source,owner,contact]);
 releaseLate();const rejected=await lateResult;assert.notEqual(rejected.status,200,'来源失效的迟到响应不得成功保存');
 const lateRows=(await f.client.query('SELECT id,state FROM reply_request WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[owner,contact,lateCommand.idempotency_key])).rows;assert.equal(lateRows.length,1);assert.notEqual(lateRows[0].state,'completed');
 assert.equal((await f.client.query('SELECT count(*)::int n FROM reply_candidate WHERE reply_request_id=$1',[lateRows[0].id])).rows[0].n,0);
 const allReceipts=(await f.client.query('SELECT * FROM model_call_receipt ORDER BY called_at,attempt_id')).rows;
 const ledger=(await f.client.query('SELECT * FROM outbound_ledger_entry ORDER BY called_at,id')).rows;
 await writeArtifact('receipt-diagnostic.json',{allReceipts,ledger,normal_request_id:rows[0].id,late_request_id:lateRows[0].id,physical_http:seen.length});
 const receipts=allReceipts.filter(x=>[rows[0].id,lateRows[0].id].includes(x.request_id));
 assert.equal(receipts.length,2,'两次实际回复各有一份物理receipt');assert.ok(receipts.every(x=>x.owner_id===owner&&x.contact_id===contact&&x.dispatch==='http_accepted'));assert.ok(receipts.every(x=>x.ledger_entry_id));assert.equal(receipts[1].request_id,lateRows[0].id);
 assert.equal(allReceipts.filter(x=>['http_accepted','response_observed'].includes(x.dispatch)).length,2,'不能把其他轨迹写成已观测物理HTTP');
 assert.equal(ledger.length,2);assert.deepEqual(new Set(ledger.map(x=>x.id)),new Set(receipts.map(x=>x.ledger_entry_id)));
 checkpoints.push({late:{receipt:lateReceipt,response:rejected,request:lateRows[0],receipts,ledger,physical_http:seen.length,source_state:'deleting',late_candidates:0}});
 await writeArtifact('result.json',{passed:true,normal_http:1,late_http:1,physical_http:seen.length,real_provider_http:0,scope_isolation:true,persisted_evidence_count:saved.length,late_candidate_count:0,late_response_status:rejected.status,late_response:rejected.data,receipts,allReceipts});
 assert.equal((await request('/api/runtime/shutdown',{})).data.state,'stopped');let timer;try{await Promise.race([exited,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('正常关闭超时')),7000))]);}finally{clearTimeout(timer);}assert.throws(()=>process.kill(legacyPid,0));await pythonCopy.verify();await migrationCopy.verify();
 t.diagnostic('正常背景1HTTP+来源失效晚结果1HTTP；prepare零出站/跨scope sentinel拒绝/公开及PG复读/实际记账/关闭通过');
});
