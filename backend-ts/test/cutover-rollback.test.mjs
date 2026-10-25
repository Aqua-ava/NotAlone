import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,rm,symlink,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {launchDsh} from '../src/launch.ts';
import {ExtractionTaskStore} from '../src/extraction-task-store.ts';
import {HostStorage} from '../src/host-storage.ts';

const root=new URL('../../',import.meta.url).pathname;
const migrations=join(root,'backend/database/migrations');
const python=process.env.NOTALONE_TEST_PYTHON||join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const sentinel='T24_SENSITIVE_SYNTHETIC_SENTINEL';
const env={...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:join(root,'backend/src')};
let hostSequence=0;

function migrate(database,directory){
  execFileSync(python,['-c',`import sys
from pathlib import Path
from notalone.database_migrations import migrate
migrate('host=/tmp dbname='+sys.argv[1],Path(sys.argv[2]))`,database,directory],{env,timeout:60000,stdio:'pipe'});
}
function admin(script,name){
  execFileSync(python,['-c',script,name],{env,timeout:20000,stdio:'pipe'});
}

/** 旧库只由随机 _test 数据库和合成行组成；113升级115前后均保留同一库和ID。 */
async function oldFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'notalone-t24-cutover-'));
  const database=`notalone_t24_cutover_${randomUUID().replaceAll('-','')}_test`;
  const oldMigrations=join(directory,'migrations-113');
  await mkdir(oldMigrations,{recursive:true,mode:0o700});
  admin(`import sys,psycopg
from psycopg import sql
with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
 c.execute(sql.SQL('CREATE DATABASE {} TEMPLATE template0').format(sql.Identifier(sys.argv[1])))`,database);
  for(const file of await readdir(migrations)){
    if(/^\d{3}_.*\.sql$/.test(file)&&Number(file.slice(0,3))<=113)await symlink(join(migrations,file),join(oldMigrations,file));
  }
  migrate(database,oldMigrations);
  const client=new pg.Client({host:'/tmp',database});
  await client.connect();
  const envFilePath=join(directory,'.env');
  const cli=join(directory,'synthetic-cli');
  await writeFile(cli,`#!${process.execPath}
const args=process.argv.slice(2),emit=data=>console.log(JSON.stringify({ok:true,data}));
if(args[0]==='--version')emit({version:'t24-synthetic-1'});
else if(args[0]==='status')emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'wxid_t24_owner'}}});
else if(args[0]==='sessions')emit({sessions:[]});
else process.exit(2);
`,{mode:0o700});
  await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\nNOTALONE_SKILLS_DIR=${join(directory,'skills')}\nNOTALONE_WECHAT_CLI=${cli}\n`,{mode:0o600});
  const hosts=[];
  const pools=[];
  t.after(async()=>{
    for(const host of hosts)await host.terminate().catch(()=>false);
    for(const pool of pools)await pool.end().catch(()=>{});
    await client.end().catch(()=>{});
    admin(`import sys,psycopg
from psycopg import sql
with psycopg.connect('host=/tmp dbname=postgres',autocommit=True) as c:
 c.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(sys.argv[1])))`,database);
    await rm(directory,{recursive:true,force:true});
  });
  return {
    directory,database,client,envFilePath,hosts,pools,
    async upgrade(){migrate(database,migrations);},
    async seed(){
      const ids={owner:randomUUID(),contact:randomUUID(),other:randomUUID(),binding:randomUUID(),
        source:randomUUID(),message:randomUUID(),candidate:randomUUID(),memory:randomUUID(),preference:randomUUID()};
      await client.query("INSERT INTO owner(id,display_name) VALUES($1,'Ticket24合成本人')",[ids.owner]);
      await client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','wxid_t24_owner','Ticket24合成本人')",[ids.owner]);
      await client.query("INSERT INTO contact(id,owner_id,display_name) VALUES($1,$2,'Ticket24合成联系人'),($3,$2,'Ticket24隔离联系人')",[ids.contact,ids.owner,ids.other]);
      await client.query("INSERT INTO channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','wxid_t24_contact','Ticket24合成联系人')",[ids.owner,ids.contact]);
      await client.query(`INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator,display_name)
        VALUES($1,$2,$3,'wechat','wxid_t24_owner','wxid_t24_contact','Ticket24合成联系人')`,[ids.binding,ids.owner,ids.contact]);
      await client.query("INSERT INTO wechat_sync_scope(owner_id,channel,account_scope,mode,granted_at) VALUES($1,'wechat','wxid_t24_owner','all_private',now())",[ids.owner]);
      await client.query("INSERT INTO wechat_history_sync_authorization(owner_id,channel,account_scope,version,decision,decided_at) VALUES($1,'wechat','wxid_t24_owner',1,'accepted',now())",[ids.owner]);
      await client.query(`INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count)
        VALUES($1,$2,$3,'wechat_jsonl','t24-old.jsonl',$4,1)`,[ids.source,ids.owner,ids.contact,'a'.repeat(64)]);
      await client.query(`INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at)
        VALUES($1,$2,$3,'contact','text',$4,'2026-10-20T01:00:00.123456Z')`,[ids.message,ids.owner,ids.contact,sentinel]);
      await client.query(`INSERT INTO message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload)
        VALUES($1,$2,$3,'source_document',$4,'line:1','{}')`,[ids.message,ids.owner,ids.contact,ids.source]);
      await client.query(`INSERT INTO memory_candidate(id,owner_id,contact_id,text_content,category,source_ids,status)
        VALUES($1,$2,$3,'旧库合成候选','common_fact',$4,'pending')`,[ids.candidate,ids.owner,ids.contact,[ids.message]]);
      await client.query(`INSERT INTO confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,source_candidate_id,adoption_method)
        VALUES($1,$2,$3,'旧库合成资料','common_fact',$4,$5,'manual')`,[ids.memory,ids.owner,ids.contact,[ids.message],ids.candidate]);
      await client.query(`INSERT INTO expression_preference(id,owner_id,contact_id,text_content,confirmed_operation_key,origin_kind)
        VALUES($1,$2,$3,'旧库合成表达偏好',$4,'manual')`,[ids.preference,ids.owner,ids.contact,randomUUID()]);
      return ids;
    },
  };
}

async function waitFor(check,message,attempts=150){
  for(let i=0;i<attempts;i++){
    try{const value=await check();if(value)return value;}catch{}
    await delay(50);
  }
  throw new Error(message);
}
async function call(app,path,{method='GET',body,token=app.token}={}){
  const response=await fetch(`${app.address}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  return {status:response.status,data:text?JSON.parse(text):undefined};
}
async function startHost(t,fixture,mode){
  const infoPath=join(fixture.directory,`backend-${++hostSequence}.info`);
  const host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,
    infoPath,businessHome:fixture.directory,pythonExecutable:python,
    environment:{NOTALONE_OWNER_ID:fixture.ids.owner,NOTALONE_REPLY_RUNTIME:mode,NOTALONE_EXTRACTION_RUNTIME:mode,
      NOTALONE_HISTORY_RUNTIME:mode,NOTALONE_MANAGED_USER_DATA:fixture.directory}},()=>true);
  fixture.hosts.push(host);
  const connection=await waitFor(async()=>{
    const fields=Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>line.split('=')));
    if(!fields.address||!fields.token)return;
    const app={host,address:`http://${fields.address}`,token:fields.token,infoPath};
    const health=await call(app,'/api/runtime/status');
    if(health.status===200&&health.data.state==='running')return app;
  },'Ticket24宿主未发布就绪握手');
  const lock=JSON.parse(await readFile(`${infoPath}.dsh-lock`,'utf8'));
  const legacy=readLegacyInfo(await readFile(join(lock.home,'legacy.info'),'utf8'));
  return {...connection,home:lock.home,legacy};
}
function readLegacyInfo(text){
  const fields=Object.fromEntries(text.trim().split('\n').map(line=>line.split('=')));
  return {address:`http://${fields.address}`,token:fields.token,pid:Number(fields.pid)};
}
async function shutdown(app){
  await call(app,'/api/runtime/shutdown',{method:'POST',body:{}});
  assert.equal(await app.host.waitForExit(15000),true);
}
async function scan(directory){
  let values='';
  for(const item of await readdir(directory,{recursive:true,withFileTypes:true})){
    if(!item.isFile())continue;
    const file=join(item.parentPath,item.name);
    try{values+=await readFile(file,'utf8');}catch{}
  }
  return values;
}

test('随机113旧库完成TS/DSH接管、崩溃租约收尾、兼容回退与不兼容停写',{timeout:120000},async t=>{
  const fixture=await oldFixture(t);
  fixture.ids=await fixture.seed();
  const beforeUpgrade=(await fixture.client.query(`SELECT
    (SELECT count(*)::int FROM owner) owners,
    (SELECT count(*)::int FROM message WHERE text_content=$1) sentinels`,[sentinel])).rows[0];
  assert.deepEqual(beforeUpgrade,{owners:1,sentinels:1});
  await fixture.upgrade();
  const storage=await HostStorage.open({envFilePath:fixture.envFilePath,migrationsDirectory:migrations});
  try{assert.deepEqual(await storage.compatibility(),{code:'ready'});}
  finally{await storage.close();}
  assert.deepEqual((await fixture.client.query(`SELECT
    (SELECT count(*)::int FROM owner) owners,
    (SELECT count(*)::int FROM contact WHERE id=$1) contact,
    (SELECT count(*)::int FROM message WHERE id=$2 AND text_content=$3) sentinel,
    (SELECT count(*)::int FROM notalone_schema_migration) ledger`,[fixture.ids.contact,fixture.ids.message,sentinel])).rows[0],
  {owners:1,contact:1,sentinel:1,ledger:115});
  assert.deepEqual((await fixture.client.query(`SELECT source_kind,lease_generation
    FROM cross_domain_deletion_operation LIMIT 0`)).rows,[]);

  let app=await startHost(t,fixture,'typescript');
  let health=(await call(app,'/api/runtime/status')).data;
  assert.equal(health.runtime,'dsh');
  assert.equal(health.ownership.replies,'typescript');
  assert.equal(health.ownership.tasks,'typescript');
  assert.equal(health.ownership.imports,'typescript');
  assert.equal(health.ownership.memory,'typescript');
  assert.equal(health.ownership.contactContext,'typescript');
  assert.equal(health.ownership.crossDomainDeletion,'typescript');
  assert.equal(health.ownership.wechatHistory,'typescript');

  // 具名交接先停收，再只启用一侧；回切到TS后继续从同一业务库读取。
  for(const control of ['contact-context','memory-management']){
    assert.equal((await call(app,`/api/runtime/${control}/handoff`,{method:'POST',body:{target:'python'}})).data.owner,'python');
    assert.equal((await call(app,`/api/runtime/${control}/handoff`,{method:'POST',body:{target:'typescript'}})).data.owner,'typescript');
  }
  assert.equal((await call(app,'/api/contacts')).status,200);

  const edited='Ticket24用户修改后的合成表达偏好';
  const preference=await call(app,`/api/expression-preferences/${fixture.ids.preference}?contact_id=${fixture.ids.contact}`,{method:'PATCH',body:{
    operation_key:randomUUID(),expected_revision:1,text:edited,
    scope:{contact_id:fixture.ids.contact,reply_mode:null},confirm_long_term:true,
  }});
  assert.equal(preference.status,200);
  assert.equal(preference.data.preference.text,edited);
  assert.equal(preference.data.preference.revision,2);

  const importPath=join(fixture.directory,'t24-new.jsonl');
  const rows=[
    {id:{local_id:101,server_id_str:'t24-server-101',talker:'wxid_t24_contact'},create_time:1792461600,is_from_me:false,
      kind:'text',sender:'Ticket24合成联系人',sender_wxid:'wxid_t24_contact',text:'Ticket24接管后新消息一',time:'2026-10-20 10:00:00',time_iso:'2026-10-20T10:00:00+08:00'},
    {id:{local_id:102,server_id_str:'t24-server-102',talker:'wxid_t24_contact'},create_time:1792461660,is_from_me:true,
      kind:'text',sender:'Ticket24合成本人',sender_wxid:'wxid_t24_owner',text:'Ticket24接管后新消息二',time:'2026-10-20 10:01:00',time_iso:'2026-10-20T10:01:00+08:00'},
  ];
  await writeFile(importPath,rows.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  const preview=await call(app,'/api/imports/preview',{method:'POST',body:{path:importPath,contact_id:fixture.ids.contact}});
  assert.equal(preview.status,200);
  const commitBody={path:importPath,contact_id:fixture.ids.contact,expected_content_sha256:preview.data.content_sha256};
  const first=await call(app,'/api/imports/commit',{method:'POST',body:commitBody});
  const replay=await call(app,'/api/imports/commit',{method:'POST',body:commitBody});
  assert.equal(first.status,200);assert.equal(replay.status,200);
  assert.deepEqual([first.data.imported_count,replay.data.imported_count].sort(),[0,2]);
  assert.equal(first.data.task_id,replay.data.task_id);
  assert.deepEqual((await fixture.client.query(`SELECT
    (SELECT count(*)::int FROM source_document WHERE file_name='t24-new.jsonl') sources,
    (SELECT count(*)::int FROM message WHERE text_content LIKE 'Ticket24接管后新消息%') messages,
    (SELECT count(*)::int FROM background_task WHERE source_document_id=
      (SELECT id FROM source_document WHERE file_name='t24-new.jsonl')) tasks`)).rows[0],
  {sources:1,messages:2,tasks:1});

  const revoked=await call(app,'/api/sync/cli-bindings/revoke',{method:'POST',body:{
    contact_id:fixture.ids.contact,binding_id:fixture.ids.binding,
  }});
  assert.equal(revoked.status,200);
  assert.equal(revoked.data.status,'revoked');
  assert.equal((await fixture.client.query(`SELECT count(*)::int n FROM wechat_sync_exclusion
    WHERE owner_id=$1 AND account_scope='wxid_t24_owner'`,[fixture.ids.owner])).rows[0].n,1);

  const removed=await call(app,`/api/contacts/${fixture.ids.contact}/sources/${fixture.ids.source}`,{method:'DELETE'});
  assert.equal(removed.status,202);
  await waitFor(async()=>{
    const row=(await call(app,`/api/deletions/${removed.data.task_id}`)).data;
    if(row.status==='failed')throw new Error(`删除失败 ${row.error_code}`);
    return row.status==='succeeded';
  },'来源删除未完成');
  assert.equal((await fixture.client.query('SELECT status FROM source_document WHERE id=$1',[fixture.ids.source])).rows[0].status,'deleted');
  assert.equal((await fixture.client.query('SELECT count(*)::int n FROM message WHERE text_content=$1',[sentinel])).rows[0].n,0);
  assert.equal((await fixture.client.query('SELECT count(*)::int n FROM confirmed_memory WHERE id=$1',[fixture.ids.memory])).rows[0].n,0);
  assert.equal((await fixture.client.query('SELECT count(*)::int n FROM memory_candidate WHERE id=$1',[fixture.ids.candidate])).rows[0].n,0);
  assert.doesNotMatch(await scan(fixture.directory),new RegExp(sentinel),'业务目录不得保留已删除正文副本');
  assert.doesNotMatch(await scan(app.home),new RegExp(sentinel),'DSH临时目录不得保存已删除正文');

  const pool=new pg.Pool({host:'/tmp',database:fixture.database,max:2});
  fixture.pools.push(pool);
  const store=new ExtractionTaskStore(pool);
  const claim=await store.claim({ownerId:fixture.ids.owner,contactId:fixture.ids.contact},{
    taskId:first.data.task_id,workerId:randomUUID(),leaseMs:60_000,supportedSteps:['parse'],
  });
  assert.ok(claim);
  const live=(await fixture.client.query(`SELECT t.status,t.current_step,s.status step_status,
    s.worker_id,s.lease_generation,s.lease_expires_at>clock_timestamp() live
    FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.id=$1 AND s.step_name='parse'`,[first.data.task_id])).rows[0];
  assert.deepEqual({...live,lease_generation:Number(live.lease_generation)},
    {status:'running',current_step:'parse',step_status:'running',worker_id:claim.workerId,lease_generation:claim.leaseGeneration,live:true});

  // 强杀只模拟宿主崩溃；重启后显式停止推进代次，旧claim不得提交。
  process.kill(app.host.pid,'SIGKILL');
  await waitFor(()=>!app.host.isRunning(),'崩溃宿主未退出');
  assert.equal((await fixture.client.query("SELECT status FROM background_task WHERE id=$1",[first.data.task_id])).rows[0].status,'running');
  app=await startHost(t,fixture,'typescript');
  const stopped=await call(app,'/api/tasks/stop',{method:'POST',body:{contact_id:fixture.ids.contact,task_id:first.data.task_id}});
  assert.equal(stopped.status,200);
  assert.deepEqual(stopped.data,{task_id:first.data.task_id,status:'stopped'});
  await assert.rejects(store.complete(claim,2,2),{code:'lease_stale'});
  assert.deepEqual((await fixture.client.query(`SELECT t.status,t.last_error_code,s.status step_status,
    s.worker_id,s.lease_expires_at
    FROM background_task t JOIN background_task_step s ON s.task_id=t.id
    WHERE t.id=$1 AND s.step_name='parse'`,[first.data.task_id])).rows[0],
  {status:'cancelled',last_error_code:'task_stopped',step_status:'cancelled',worker_id:null,lease_expires_at:null});
  const stable={messages:(await fixture.client.query("SELECT count(*)::int n FROM message")).rows[0].n,
    tasks:(await fixture.client.query("SELECT count(*)::int n FROM background_task")).rows[0].n,
    preferences:(await fixture.client.query("SELECT count(*)::int n FROM expression_preference")).rows[0].n};
  await shutdown(app);
  await assert.rejects(readFile(app.home),{code:'ENOENT'},'DSH临时home应在退出后清除');

  // 兼容回退到Python回复/提取责任方；旧HTTP直接从同一当前库读取新消息和用户修改。
  app=await startHost(t,fixture,'python');
  health=(await call(app,'/api/runtime/status')).data;
  assert.equal(health.ownership.replies,'python');
  assert.equal(health.ownership.tasks,'python');
  assert.equal(health.legacyPid,app.legacy.pid);
  assert.equal((await call(app,'/api/runtime/contact-context/handoff',{method:'POST',body:{target:'python'}})).data.owner,'python');
  assert.equal((await call(app,'/api/runtime/memory-management/handoff',{method:'POST',body:{target:'python'}})).data.owner,'python');
  const oldMessages=await fetch(`${app.legacy.address}/api/contacts/${fixture.ids.contact}/messages?limit=50`,{
    headers:{Authorization:`Bearer ${app.legacy.token}`}
  });
  assert.equal(oldMessages.status,200);
  const oldMessageBody=await oldMessages.json();
  assert.ok(oldMessageBody.messages.some(row=>row.text==='Ticket24接管后新消息一'));
  assert.ok(oldMessageBody.messages.some(row=>row.text==='Ticket24接管后新消息二'));
  assert.equal(JSON.stringify(oldMessageBody).includes(sentinel),false,'旧实现不得复活已删除正文');
  const oldPreferences=await fetch(`${app.legacy.address}/api/expression-preferences?contact_id=${fixture.ids.contact}`,{
    headers:{Authorization:`Bearer ${app.legacy.token}`}
  });
  assert.equal(oldPreferences.status,200);
  const oldPreferenceBody=await oldPreferences.json();
  assert.equal(oldPreferenceBody.preferences.find(row=>row.preference_id===fixture.ids.preference).text,edited);
  assert.deepEqual((await fixture.client.query(`SELECT b.status,e.locator_hash IS NOT NULL excluded
    FROM conversation_binding b JOIN wechat_sync_exclusion e
      ON e.owner_id=b.owner_id AND e.account_scope=b.account_scope
      AND e.locator_hash=sha256(convert_to(b.conversation_locator,'UTF8'))
    WHERE b.id=$1`,[fixture.ids.binding])).rows[0],{status:'revoked',excluded:true});
  assert.deepEqual({messages:(await fixture.client.query("SELECT count(*)::int n FROM message")).rows[0].n,
    tasks:(await fixture.client.query("SELECT count(*)::int n FROM background_task")).rows[0].n,
    preferences:(await fixture.client.query("SELECT count(*)::int n FROM expression_preference")).rows[0].n},stable,
  '兼容回退不得产生重复副作用');
  await shutdown(app);

  // 未知账本版本必须在启动前停写，既不发布握手也不创建新业务行。
  await fixture.client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('116_unknown.sql',$1)",['b'.repeat(64)]);
  const envBefore=await readFile(fixture.envFilePath,'utf8');
  const badInfoPath=join(fixture.directory,`backend-${++hostSequence}.info`);
  const bad=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath:fixture.envFilePath,
    infoPath:badInfoPath,businessHome:fixture.directory,pythonExecutable:python,
    environment:{NOTALONE_OWNER_ID:fixture.ids.owner,NOTALONE_REPLY_RUNTIME:'typescript',NOTALONE_EXTRACTION_RUNTIME:'typescript'}},()=>true);
  fixture.hosts.push(bad);
  assert.equal(await bad.waitForExit(15000),true);
  await assert.rejects(readFile(badInfoPath,'utf8'),{code:'ENOENT'});
  assert.equal(await readFile(fixture.envFilePath,'utf8'),envBefore);
  assert.deepEqual({messages:(await fixture.client.query("SELECT count(*)::int n FROM message")).rows[0].n,
    tasks:(await fixture.client.query("SELECT count(*)::int n FROM background_task")).rows[0].n,
    preferences:(await fixture.client.query("SELECT count(*)::int n FROM expression_preference")).rows[0].n},stable,
  '不兼容结构不得写入或自动降级');
});
