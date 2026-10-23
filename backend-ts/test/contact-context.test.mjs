import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { start } from './contact-context-support.mjs';

export async function contextFixture(t) {
  const fixture=await createStorageFixture();
  t.after(async()=>{for(const host of fixture.hosts??[])assert.equal(await host.terminate(),true);await fixture.close();});
  const owner=randomUUID(), contact=randomUUID(), empty=randomUUID(), foreign=randomUUID(), otherOwner=randomUUID();
  await fixture.client.query('INSERT INTO owner(id,display_name) VALUES($1,$3),($2,$3)',[owner,otherOwner,'合成本人']);
  await fixture.client.query('INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,$6),($1,$3,$6),($4,$5,$6)',[owner,contact,empty,otherOwner,foreign,'同名合成联系人']);
  await appendFile(fixture.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);
  return {...fixture,owner,contact,empty,foreign,otherOwner, app:await start(t,fixture)};
}

test('来源读取区分合法空联系人与未知或跨owner身份',async t=>{
  const f=await contextFixture(t);
  assert.deepEqual(await f.app.request(`/api/contacts/${f.empty}/sources`),{status:200,data:{sources:[]}});
  for(const id of [f.foreign,randomUUID(),'同名合成联系人']) {
    const result=await f.app.request(`/api/contacts/${id}/sources`);
    assert.equal(result.status,404);
    assert.equal(result.data.error,'contact_not_found');
  }
});

test('原消息UUID、微秒顺序和分页保留，跨联系人游标明确拒绝',async t=>{
  const f=await contextFixture(t), source=randomUUID();
  await f.client.query("INSERT INTO source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'wechat_jsonl','合成.jsonl',$4,2)",[source,f.owner,f.contact,'a'.repeat(64)]);
  const ids=[randomUUID(),randomUUID()];
  for(let i=0;i<2;i++) {
    await f.client.query("INSERT INTO message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,$5)",[ids[i],f.owner,f.contact,`合成消息${i}`,`2026-10-20T01:02:03.12345${i}Z`]);
    await f.client.query("INSERT INTO message_source_ref(owner_id,contact_id,message_id,source_document_id,source_kind,source_locator,raw_payload) VALUES($1,$2,$3,$4,'source_document',$5,'{}')",[f.owner,f.contact,ids[i],source,`line:${i}`]);
  }
  const page=await f.app.request(`/api/contacts/${f.contact}/messages?limit=1`);
  assert.equal(page.status,200);
  assert.equal(page.data.messages[0].message_id,ids[1]);
  assert.equal(page.data.messages[0].occurred_at,'2026-10-20T01:02:03.123451Z');
  assert.equal(page.data.next_cursor,ids[1]);
  const next=await f.app.request(`/api/contacts/${f.contact}/messages?limit=1&before=${ids[1]}`);
  assert.equal(next.data.messages[0].message_id,ids[0]);
  assert.equal(next.data.next_cursor,null);
  assert.equal((await f.app.request(`/api/contacts/${f.empty}/messages?before=${ids[0]}`)).status,400);
});

test('公开控制面拒绝单独恢复旧实现，显式回退保留原ID与修改',async t=>{
  const f=await contextFixture(t);
  assert.equal((await f.app.request('/api/runtime/contact-context/start',{})).status,404);
  assert.equal((await f.app.request('/api/runtime/contact-context/status')).data.owner,'typescript');
  const returned=await f.app.request('/api/runtime/contact-context/handoff',{target:'python'});
  assert.equal(returned.status,200);
  assert.equal(returned.data.owner,'python');
  await f.client.query('UPDATE contact SET display_name=$1 WHERE owner_id=$2 AND id=$3',['回退期间修改',f.owner,f.contact]);
  const listed=await f.app.request('/api/contacts');
  assert.equal(listed.data.contacts.find(c=>c.contact_id===f.contact).display_name,'回退期间修改');
  const resumed=await f.app.request('/api/runtime/contact-context/handoff',{target:'typescript'});
  assert.equal(resumed.status,200);
  assert.equal(resumed.data.owner,'typescript');
  assert.equal((await f.app.request('/api/contacts')).data.contacts.find(c=>c.contact_id===f.contact).display_name,'回退期间修改');
});

test('已有联系人手动确认只写原范围，重复确认不建立渠道身份',async t=>{
  const f=await contextFixture(t);
  assert.deepEqual(await f.app.request(`/api/contacts/${f.contact}/manual-confirmation`,{}),{status:200,data:{confirmed:true}});
  assert.equal((await f.app.request(`/api/contacts/${f.contact}/manual-confirmation`,{display_name:'不能猜选'})).status,400);
  assert.equal((await f.app.request(`/api/contacts/${f.foreign}/manual-confirmation`,{})).status,404);
  await f.app.request(`/api/contacts/${f.contact}/manual-confirmation`,{});
  assert.deepEqual((await f.client.query('SELECT owner_id,contact_id FROM manual_contact_confirmation')).rows,[{owner_id:f.owner,contact_id:f.contact}]);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,0);
});

async function waitForScopeReader(f) {
  for(let i=0;i<100;i++) {
    await f.client.query("SELECT pg_stat_clear_snapshot()");
    const {rows}=await f.client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event='advisory'");
    if(rows[0].n)return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('合成读取未到达数据库范围锁');
}

test('没有binding行的授权撤销再恢复使在途读取失效，新读取仍允许手动资料',async t=>{
  const f=await contextFixture(t);
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,true)',[f.owner]);
  await f.client.query('BEGIN');
  await f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${f.owner}:${f.contact}`]);
  const pending=f.app.request(`/api/contacts/${f.contact}/sources`);
  await waitForScopeReader(f);
  await f.client.query('UPDATE front_sync_state SET enabled=false WHERE owner_id=$1',[f.owner]);
  await f.client.query('UPDATE front_sync_state SET enabled=true WHERE owner_id=$1',[f.owner]);
  await f.client.query('COMMIT');
  assert.deepEqual(await pending,{status:409,data:{error:'contact_context_changed'}});
  assert.equal((await f.app.request(`/api/contacts/${f.contact}/sources`)).status,200);
});

test('联系人删除使在途手动确认失败且不恢复旧资料',async t=>{
  const f=await contextFixture(t);
  await f.client.query('BEGIN');
  await f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${f.owner}:${f.contact}`]);
  const pending=f.app.request(`/api/contacts/${f.contact}/manual-confirmation`,{});
  await waitForScopeReader(f);
  await f.client.query('DELETE FROM contact WHERE owner_id=$1 AND id=$2',[f.owner,f.contact]);
  await f.client.query('COMMIT');
  assert.equal((await pending).status,404);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM manual_contact_confirmation')).rows[0].n,0);
  assert.equal((await f.app.request('/api/contacts')).data.contacts.length,1);
});

test('移交先拒收并使在途TS请求失效，未排空不启用旧方',async t=>{
  const f=await contextFixture(t);
  await f.client.query('BEGIN');
  await f.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${f.owner}:${f.contact}`]);
  const pending=f.app.request(`/api/contacts/${f.contact}/sources`);
  await waitForScopeReader(f);
  const transfer=f.app.request('/api/runtime/contact-context/handoff',{target:'python'});
  for(let i=0;i<100;i++) {
    if((await f.app.request('/api/runtime/contact-context/status')).data.state==='transferring')break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal((await f.app.request('/api/contacts')).status,503);
  assert.equal((await f.app.request('/api/runtime/contact-context/status')).data.owner,'typescript');
  await f.client.query('COMMIT');
  assert.equal((await pending).status,409);
  assert.equal((await transfer).data.owner,'python');
  assert.equal((await f.app.request('/api/contacts')).status,200);
});

test('结构未知时显式回退失败关闭，绝不逐请求转交旧实现',async t=>{
  const f=await contextFixture(t);
  await f.client.query("INSERT INTO notalone_schema_migration(name,checksum) VALUES('108_unknown.sql','unknown')");
  assert.notEqual((await f.app.request('/api/runtime/contact-context/handoff',{target:'python'})).status,200);
  const status=(await f.app.request('/api/runtime/contact-context/status')).data;
  assert.equal(status.owner,'typescript');assert.equal(status.state,'stopped');
  assert.equal((await f.app.request('/api/contacts')).status,503);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM contact')).rows[0].n,3);
});

test('数据库结构失效返回可识别读取失败而不是伪装空结果',async t=>{
  const f=await contextFixture(t);
  await f.client.query('ALTER TABLE source_document RENAME TO synthetic_removed_source');
  const result=await f.app.request(`/api/contacts/${f.contact}/sources`);
  assert.equal(result.status,503);
  assert.equal(result.data.error,'sources_unavailable');
});

test('关系概览经公开HTTP写入一次投影，旧入口停收且重读保留版本',async t=>{
  const f=await contextFixture(t);
  const first=await f.app.request(`/api/contacts/${f.contact}/relationship-overview`);
  assert.equal(first.status,200);
  assert.equal(first.data.overview.contact_id,f.contact);
  assert.deepEqual(first.data.overview.entries,[]);
  const second=await f.app.request(`/api/contacts/${f.contact}/relationship-overview`);
  assert.deepEqual(second,first);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM relationship_overview_projection')).rows[0].n,1);
});

test('概览派生写入在授权改变后回滚，迟到投影不得提交',async t=>{
  const f=await contextFixture(t);
  await f.client.query('INSERT INTO front_sync_state(owner_id,enabled) VALUES($1,true)',[f.owner]);
  await f.client.query(`CREATE FUNCTION synthetic_pause_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(4321234); RETURN NEW; END $$;
    CREATE TRIGGER synthetic_pause_projection BEFORE INSERT ON relationship_overview_projection FOR EACH ROW EXECUTE FUNCTION synthetic_pause_projection()`);
  await f.client.query('SELECT pg_advisory_lock(4321234)');
  const pending=f.app.request(`/api/contacts/${f.contact}/relationship-overview`);
  await waitForScopeReader(f);
  await f.client.query('UPDATE front_sync_state SET enabled=false WHERE owner_id=$1',[f.owner]);
  await f.client.query('SELECT pg_advisory_unlock(4321234)');
  assert.deepEqual(await pending,{status:409,data:{error:'contact_context_changed'}});
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM relationship_overview_projection')).rows[0].n,0);
  assert.equal((await f.app.request(`/api/contacts/${f.contact}/relationship-overview`)).status,200);
});

test('真实宿主内部概览令牌必须绑定原owner，不能把返回记忆重标范围',async t=>{
  const {mkdir,symlink,writeFile,readFile}=await import('node:fs/promises');
  const {join,resolve}=await import('node:path');
  const f=await createStorageFixture();
  t.after(async()=>{for(const host of f.hosts??[])assert.equal(await host.terminate(),true);await f.close();});
  const owner=randomUUID(),contact=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成令牌本人')",[owner]);
  await f.client.query("INSERT INTO contact(owner_id,id,display_name) VALUES($1,$2,'合成令牌联系人')",[owner,contact]);
  await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\n`);
  const project=join(f.directory,'synthetic-project'),src=join(project,'backend/src'),captured=join(f.directory,'internal.json');
  await mkdir(src,{recursive:true});
  await symlink(resolve('..','backend-ts'),join(project,'backend-ts'));
  await symlink(resolve('..','backend/database'),join(project,'backend/database'));
  // 仅测试启动适配器记录合成宿主交给它的内部连接；生产没有调试令牌导出接口。
  const bootstrap=`import sys,json,os\nsys.path.insert(0,${JSON.stringify(resolve('..','backend/src'))})\nfrom notalone.server.contact_context_handoff import ContactContextHandoff\noriginal=ContactContextHandoff.configure\ndef capture(self,payload):\n original(self,payload)\n with open(${JSON.stringify(captured)},'w',opener=lambda p,f:os.open(p,f,0o600)) as out: json.dump(payload,out)\nContactContextHandoff.configure=capture\n`;
  await writeFile(join(src,'sitecustomize.py'),bootstrap);
  const app=await start(t,f,{},project),internal=JSON.parse(await readFile(captured,'utf8'));
  for(const scope of [undefined,randomUUID()]) {
    const response=await fetch(`http://${internal.address}/api/contacts/${contact}/relationship-overview`,{headers:{Authorization:`Bearer ${internal.token}`,...(scope?{'X-NotAlone-Owner-ID':scope}:{})}});
    assert.equal(response.status,401);
  }
  const allowed=await fetch(`http://${internal.address}/api/contacts/${contact}/relationship-overview`,{headers:{Authorization:`Bearer ${internal.token}`,'X-NotAlone-Owner-ID':owner}});
  assert.equal(allowed.status,200);
  const forbidden=await fetch(`http://${internal.address}/api/runtime/contact-context/handoff`,{method:'POST',headers:{Authorization:`Bearer ${internal.token}`,'X-NotAlone-Owner-ID':owner,'Content-Type':'application/json'},body:JSON.stringify({target:'python'})});
  assert.equal(forbidden.status,401);
  assert.equal((await app.request('/api/runtime/contact-context/status')).data.owner,'typescript');
});
