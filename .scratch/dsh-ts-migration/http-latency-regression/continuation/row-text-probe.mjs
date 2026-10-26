// 只在自有合成副本运行：检查版本串语义并测量同一 pg Adapter 的编解码成本。
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';

process.umask(0o077);
const project=process.env.NOTALONE_PERF_PROJECT;
const database=process.env.NOTALONE_ROW_PROBE_DATABASE;
assert.match(database??'',/^na_hostperf_[a-f0-9]+_test$/);
const load=name=>import(pathToFileURL(join(project,'backend-ts/src',name)).href);
const modules={original:await load('contact-context.row-original.ts'),text:await load('contact-context.ts')};
const {HostStorage}=await load('host-storage.ts');
const require=createRequire(join(project,'backend-ts/package.json'));
const {Client}=require('pg');
const control=new Client({host:'/tmp',database,user:userInfo().username,application_name:'notalone-row-text-synthetic'});
const owner=randomUUID(),contact=randomUUID();
const storage=await HostStorage.open({envFilePath:process.env.NOTALONE_ENV_FILE,migrationsDirectory:join(project,'backend/database/migrations'),environment:{...process.env,NOTALONE_OWNER_ID:owner}});
const contexts=Object.fromEntries(Object.entries(modules).map(([arm,m])=>[arm,new m.ContactContext(storage)]));
const output={diagnostic_only:true,formal_performance_qualified:false,http_requests:0,physical_model_requests:0,safety:[],rows:[],cleanup:{},terminal_status:'failed'};
const url=(id,operation='sources')=>new URL(`http://synthetic.invalid/api/contacts/${id}/${operation}`);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function call(arm,id,operation='sources',assertCurrent) {
  try {return {status:200,data:await contexts[arm].handle(operation==='manual-confirmation'?'POST':'GET',url(id,operation),operation==='manual-confirmation'?{}:undefined,assertCurrent)};}
  catch(error){return {status:error.status??500,error:error.code??error.message};}
}
async function versions(id=contact) {
  const values={};
  for(const arm of Object.keys(modules))values[arm]=await modules[arm].syntheticScopeRevision(control,owner,id);
  assert.deepEqual(JSON.parse(values.original),JSON.parse(values.text));
  return values;
}
async function waitForReader() {
  for(let i=0;i<100;i++) {
    await control.query('SELECT pg_stat_clear_snapshot()');
    const {rows}=await control.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'");
    if(rows[0].n)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('合成请求没有到达范围锁');
}
async function lockContact(id) {
  await control.query('BEGIN');
  await control.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${id}`]);
}
async function caseRun(id,run) {await run();output.safety.push({id,passed:true});}
try {
  await control.connect();
  assert.equal(storage.runtimeOwnerId,owner);
  await control.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[owner,'合成本人']);
  await control.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$3)',[owner,contact,'合成联系人']);
  await caseRun('空集合及NULL结构相等',async()=>{
    const v=await versions();
    assert.equal(JSON.parse(v.original).sync_switch,null);
    assert.deepEqual(JSON.parse(v.original).bindings,[]);
    for(const arm of Object.keys(modules))assert.deepEqual(await call(arm,contact),{status:200,data:{sources:[]}});
  });
  await caseRun('未知及跨owner联系人仍404',async()=>{
    const other=randomUUID(),foreign=randomUUID();
    await control.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[other,'合成额外本人']);
    await control.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$3)',[other,foreign,'合成额外联系人']);
    for(const arm of Object.keys(modules))for(const id of [foreign,randomUUID(),'同名合成联系人'])assert.deepEqual(await call(arm,id),{status:404,error:'contact_not_found'});
  });
  await caseRun('非空绑定及更新参与版本串',async()=>{
    const binding=randomUUID(),before=await versions();
    await control.query("INSERT INTO conversation_binding(id,owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,$3,'wechat','synthetic-row-text','synthetic-row-locator')",[binding,owner,contact]);
    const populated=await versions();
    for(const arm of Object.keys(modules))assert.notEqual(before[arm],populated[arm]);
    await control.query("UPDATE conversation_binding SET conversation_locator='synthetic-row-locator-updated' WHERE id=$1",[binding]);
    const changed=await versions();
    for(const arm of Object.keys(modules))assert.notEqual(populated[arm],changed[arm]);
    await control.query('DELETE FROM conversation_binding WHERE id=$1',[binding]);
  });
  await control.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,true) ON CONFLICT(owner_id) DO UPDATE SET enabled=true',[owner]);
  for(const arm of Object.keys(modules)) {
    await caseRun(`${arm}:无binding授权关闭再开启拒绝在途读取`,async()=>{
      await lockContact(contact);
      const pending=call(arm,contact);
      try {
        await waitForReader();
        await control.query('UPDATE front_sync_state SET enabled=false WHERE owner_id=$1',[owner]);
        await control.query('UPDATE front_sync_state SET enabled=true WHERE owner_id=$1',[owner]);
        await control.query('COMMIT');
      } finally {await control.query('ROLLBACK');}
      assert.deepEqual(await pending,{status:409,error:'contact_context_changed'});
      assert.equal((await call(arm,contact)).status,200);
    });
    await caseRun(`${arm}:删除联系人使在途确认404且不恢复资料`,async()=>{
      const deleted=randomUUID();
      await control.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$3)',[owner,deleted,'合成待删联系人']);
      await lockContact(deleted);
      const pending=call(arm,deleted,'manual-confirmation');
      try {
        await waitForReader();
        await control.query('DELETE FROM contact WHERE owner_id=$1 AND id=$2',[owner,deleted]);
        await control.query('COMMIT');
      } finally {await control.query('ROLLBACK');}
      assert.deepEqual(await pending,{status:404,error:'contact_not_found'});
      assert.equal((await control.query('SELECT count(*)::int AS n FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2',[owner,deleted])).rows[0].n,0);
    });
    await caseRun(`${arm}:最后assertCurrent拒绝使确认回滚`,async()=>{
      await control.query('DELETE FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2',[owner,contact]);
      let calls=0;
      const result=await call(arm,contact,'manual-confirmation',()=>{if(++calls===2)throw new modules[arm].ContactContextError('contact_context_changed');});
      assert.deepEqual(result,{status:409,error:'contact_context_changed'});
      assert.equal(calls,2);
      assert.equal((await control.query('SELECT count(*)::int AS n FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows[0].n,0);
    });
  }
  await control.query(`CREATE FUNCTION synthetic_row_text_scope_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE public.front_sync_state SET enabled=false WHERE owner_id=NEW.owner_id; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_row_text_scope_change AFTER INSERT ON public.manual_contact_confirmation FOR EACH ROW EXECUTE FUNCTION synthetic_row_text_scope_change()`);
  for(const arm of Object.keys(modules))await caseRun(`${arm}:写入后授权变化的409回滚`,async()=>{
    assert.deepEqual(await call(arm,contact,'manual-confirmation'),{status:409,error:'contact_context_changed'});
    assert.equal((await control.query('SELECT count(*)::int AS n FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2',[owner,contact])).rows[0].n,0);
    assert.equal((await control.query('SELECT enabled FROM front_sync_state WHERE owner_id=$1',[owner])).rows[0].enabled,true);
  });
  await control.query('DROP TRIGGER synthetic_row_text_scope_change ON public.manual_contact_confirmation; DROP FUNCTION synthetic_row_text_scope_change()');
  const canonical=JSON.parse((await versions()).original);
  for(const kind of ['scope_sql_three_reads','contact_context_sources']) {
    if(kind==='scope_sql_three_reads')await control.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {for(let i=-10;i<30;i++)for(const arm of i%2===0?['original','text']:['text','original']) {
      const start=performance.now();let value;
      if(kind==='scope_sql_three_reads')for(let j=0;j<3;j++)value=await modules[arm].syntheticScopeRevision(control,owner,contact);
      else value=await contexts[arm].handle('GET',url(contact));
      const milliseconds=performance.now()-start;
      if(kind==='scope_sql_three_reads')assert.deepEqual(JSON.parse(value),canonical);
      else assert.deepEqual(value,{sources:[]});
      output.rows.push({case_id:kind,arm,i,warmup:i<0,milliseconds,response_sha256:hash(kind==='scope_sql_three_reads'?JSON.parse(value):value),terminal_status:'succeeded'});
    }} finally {if(kind==='scope_sql_three_reads')await control.query('COMMIT');}
  }
  output.terminal_status='succeeded';
} catch(error) {output.error={name:error.name,message:error.message,stack:error.stack};process.exitCode=1;}
finally {
  const cleanup=await Promise.allSettled([storage.close(),control.end()]);
  output.cleanup.connections_closed=cleanup.every(r=>r.status==='fulfilled');
  if(!output.cleanup.connections_closed)process.exitCode=1;
  await writeFile(process.env.NOTALONE_ROW_PROBE_OUTPUT,JSON.stringify(output,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({terminal_status:output.terminal_status,safety_passed:output.safety.length,rows:output.rows.length,cleanup:output.cleanup}));
}
