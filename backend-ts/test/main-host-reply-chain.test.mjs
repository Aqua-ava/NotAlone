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
test('真实主宿主public→Python→私有TS→官方provider本机SSE',{timeout:60000},async t=>{
 const f=await createStorageFixture(),owner=randomUUID(),contact=randomUUID(),other=randomUUID(),binding=randomUUID();let child,exited,output='',connection;const seen=[];let rejectProvider=false;
 const provider=createServer(async(req,res)=>{let raw='';for await(const p of req)raw+=p;const body=JSON.parse(raw);seen.push({path:req.url,body,headers:req.headers});if(rejectProvider){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'synthetic rejection'}}));return;}const events=[{type:'message_start',message:{id:'synthetic',model:'deepseek-flash',usage:{input_tokens:12,output_tokens:0}}},{},{},{},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:9}},{type:'message_stop'}];useTool(events,'ReplyRuntimeOutput',{used_skill_version_id:null,candidates:[{text:'明天见',basis:'合成草稿',citation_ids:[evidenceId(body)],risk_notes:[]}]});sendEvents(res,events);});
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),7000);await exited;clearTimeout(timer);}provider.closeAllConnections();if(provider.listening)await new Promise(r=>provider.close(r));await f.close();});
 await f.client.query("INSERT INTO owner(id,display_name)VALUES($1,'合成本人')",[owner]);
 for(const id of [contact,other])await f.client.query("INSERT INTO contact(id,owner_id,display_name)VALUES($1,$2,'合成联系人')",[id,owner]);
 await f.client.query('INSERT INTO manual_contact_confirmation(id,owner_id,contact_id)VALUES($1,$2,$3)',[binding,owner,contact]);
 await f.client.query("INSERT INTO conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator,status)VALUES($1,$2,'wechat','synthetic','synthetic','active')",[owner,contact]);
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
 async function request(path,body,token=connection.token){const r=await fetch(`http://${connection.address}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'content-type':'application/json'},body:body&&JSON.stringify(body),signal:AbortSignal.timeout(15000)});return{status:r.status,data:await r.json()};}
 const status=await request('/api/runtime/status');assert.equal(status.data.ownership.replies,'typescript');assert.ok(status.data.legacyPid);t.diagnostic('真实主宿主及唯一Legacy已启动');
 assert.equal((await request('/internal/reply/generate',{})).status,401);assert.equal(seen.length,0);
 const body={contact_id:contact,idempotency_key:randomUUID(),content:{type:'rewrite_draft',input_kind:'draft',draft_text:'明天见',include_relationship_context:false},skill_disabled:true};
 const result=await request('/api/reply/generate',body);assert.equal(result.status,200,JSON.stringify({result,http:seen.length,output:safeOutput()}));assert.equal(result.data.candidates[0].text,'明天见');assert.equal(seen.length,1);
 assert.deepEqual(await request('/api/reply/generate',body),result);assert.equal(seen.length,1);
 const receipts=(await f.client.query('SELECT owner_id,contact_id,request_id,outcome,provider,ledger_entry_id FROM model_call_receipt')).rows;assert.equal(receipts.length,1);assert.equal(receipts[0].owner_id,owner);assert.equal(receipts[0].contact_id,contact);assert.equal(receipts[0].request_id,result.data.reply_request_id);assert.equal(receipts[0].outcome,'succeeded');assert.equal((await f.client.query('SELECT id FROM outbound_ledger_entry')).rows[0].id,receipts[0].ledger_entry_id);assert.ok(seen[0].headers['x-deepseek-harness-user-id']);
 const denied=await request('/api/reply/generate',{...body,contact_id:other,idempotency_key:randomUUID()});assert.notEqual(denied.status,200);assert.equal(seen.length,1);
 rejectProvider=true;const failed=await request('/api/reply/generate',{...body,idempotency_key:randomUUID()});assert.notEqual(failed.status,200);assert.equal(seen.length,2,'完整400不得hidden retry或回退Python');assert.deepEqual((await f.client.query('SELECT outcome FROM model_call_receipt ORDER BY called_at')).rows.map(r=>r.outcome),['succeeded','failed']);
 assert.equal((await request('/api/runtime/shutdown',{})).data.state,'stopped');let exitTimer;try{const termination=await Promise.race([exited,new Promise((_,reject)=>exitTimer=setTimeout(()=>reject(Error('正常关闭超时')),7000))]);assert.notEqual(termination[1],'SIGKILL');}finally{clearTimeout(exitTimer);}assert.throws(()=>process.kill(status.data.legacyPid,0));await pythonCopy.verify();await migrationCopy.verify();t.diagnostic('Python/迁移复制及运行后SHA核对：'+(pythonCopy.hashes.length+migrationCopy.hashes.length)+'份原文件一致');assert.equal(seen.length,2);
 t.diagnostic('成功1次SSE+完整400一次HTTP；UUID/联系人隔离/公开token拒私有/无重试回退/关闭通过');
});
