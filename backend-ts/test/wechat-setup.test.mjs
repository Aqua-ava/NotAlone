import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WechatSetupService, PostgresWechatSetupStore, WechatSetupConflict, WechatProbeUnavailable } from '../src/wechat-setup.ts';
import { WechatSetupProbe, BoundedWechatCliRunner } from '../src/wechat-setup-probe.ts';
import { HostStorage, HostStorageError } from '../src/host-storage.ts';
import { createWechatScopeApi } from '../src/wechat-scope-api.ts';
import { createStorageFixture } from './host-storage-fixture.mjs';

function fixture(overrides = {}) {
  let account = 'wxid_synthetic'; let saved = null; const calls = [];
  const service = new WechatSetupService({ ownerId: randomUUID(), store: {read:async()=>saved, connect:async(...args)=>{calls.push(args);saved=args[1];}},
    probe:async()=>account, confirmProbe:async expected=>expected, ...overrides });
  return {service,calls,setAccount:value=>{account=value;}};
}
test('状态无渠道读取；确认默认selected、不隐式历史授权、重试不写入', async () => {
  const f=fixture();
  assert.equal((await f.service.status()).state,'needs_detection');
  const ready=await f.service.detect();
  assert.equal((await f.service.detect()).candidate_token,ready.candidate_token);
  assert.equal((await f.service.confirm({candidate_token:ready.candidate_token})).state,'restart_required');
  assert.deepEqual(f.calls[0][3],{mode:'selected',historyAuthorized:false});
  await f.service.confirm({candidate_token:'expired',mode:'all_private',historyAuthorized:true});
  assert.equal(f.calls.length,1);
  await f.service.close();
  await assert.rejects(f.service.status(),{code:'runtime_stopping'});
});
test('无owner或伪造token不探测；候选变化不执行可读性检查', async () => {
  const noOwner=fixture({ownerId:undefined,probe:async()=>assert.fail()});
  assert.equal((await noOwner.service.detect()).state,'needs_owner');
  const f=fixture({confirmProbe:async()=>assert.fail()});
  assert.equal((await f.service.confirm({candidate_token:'forged'})).failure_code,'wechat_candidate_expired');
  const ready=await f.service.detect(); f.setAccount('wxid_other');
  assert.equal((await f.service.confirm({candidate_token:ready.candidate_token})).failure_code,'wechat_account_changed');
  assert.equal(f.calls.length,0);
});
test('确认中关闭会阻止写入并排空；未知探测错误不泄露路径', async () => {
  let release; let entered;
  const started=new Promise(r=>{entered=r;});
  const f=fixture({confirmProbe:async account=>{entered();await new Promise(r=>{release=r;});return account;}});
  const ready=await f.service.detect();
  const confirm=f.service.confirm({candidate_token:ready.candidate_token});
  await started; const closed=f.service.close(); release();
  await assert.rejects(confirm,{code:'runtime_stopping'}); await closed;
  assert.equal(f.calls.length,0);
  const bad=fixture({probe:async()=>{throw new WechatProbeUnavailable('/private/synthetic-secret');}});
  assert.equal((await bad.service.detect()).failure_code,'wechat_probe_failed');
});
test('原PG四项授权原子提交、幂等保留后续关闭、跨owner冲突不扩大授权', async () => {
  const f=await createStorageFixture(); const storage=await HostStorage.open(f.options);
  try {
    const owner=randomUUID(),other=randomUUID(),account='wxid_'+randomUUID();
    await f.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成甲'),($2,'合成乙')",[owner,other]);
    const store=new PostgresWechatSetupStore(storage); const at=new Date('2026-10-23T00:00:00Z');
    await store.connect(owner,account,at,{mode:'all_private',historyAuthorized:true},()=>{},[]);
    assert.equal(await store.read(owner),account);
    assert.equal((await f.client.query('SELECT decision FROM public.wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows[0].decision,'accepted');
    await f.client.query("UPDATE public.wechat_sync_scope SET mode='selected' WHERE owner_id=$1",[owner]);
    await f.client.query('UPDATE public.front_sync_state SET enabled=false WHERE owner_id=$1',[owner]);
    await store.connect(owner,account,new Date(),{mode:'all_private',historyAuthorized:true},()=>{},[]);
    assert.equal((await f.client.query('SELECT mode,granted_at FROM public.wechat_sync_scope WHERE owner_id=$1',[owner])).rows[0].mode,'selected');
    assert.equal((await f.client.query('SELECT enabled FROM public.front_sync_state WHERE owner_id=$1',[owner])).rows[0].enabled,false);
    await assert.rejects(store.connect(other,account,at,{mode:'all_private',historyAuthorized:true}),WechatSetupConflict);
    assert.equal(await store.read(other),null);
    await f.client.query("UPDATE public.owner_channel_identity SET status='revoked' WHERE owner_id=$1",[owner]);
    await assert.rejects(store.read(owner),WechatSetupConflict);
    await assert.rejects(store.connect(owner,account,at,{mode:'selected',historyAuthorized:false}),WechatSetupConflict);
  } finally { await storage.close(); await f.close(); }
});
test('PG冲突回滚身份；默认仅所选不生成历史授权；并发账号唯一归属', async () => {
  const f=await createStorageFixture(); const storage=await HostStorage.open(f.options);
  try {
    const a=randomUUID(),b=randomUUID(),c=randomUUID(); const store=new PostgresWechatSetupStore(storage);
    for (const id of [a,b,c]) await f.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成')",[id]);
    await f.client.query("INSERT INTO public.wechat_sync_scope(owner_id,channel,account_scope,mode,granted_at) VALUES($1,'wechat','wxid_conflict','selected',now())",[c]);
    await assert.rejects(store.connect(c,'wxid_conflict',new Date(),{mode:'all_private',historyAuthorized:true}),WechatSetupConflict);
    assert.equal(await store.read(c),null);
    const outcomes=await Promise.allSettled([a,b].map(id=>store.connect(id,'wxid_race',new Date(),{mode:'selected',historyAuthorized:false})));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    assert.ok(outcomes.find(x=>x.status==='rejected').reason instanceof WechatSetupConflict);
    assert.equal((await f.client.query('SELECT count(*)::int AS n FROM public.wechat_history_sync_authorization')).rows[0].n,0);
  } finally { await storage.close(); await f.close(); }
});
const status=(account='wxid_synthetic')=>({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:account,private_path:'discard'}}});
test('探测只读状态，确认前后账号核验且丢弃摘要；物理预算5+1+5秒', async () => {
  const calls=[]; const probe=new WechatSetupProbe({executable:'unused',runner:{run:async(args,timeout)=>{calls.push([args,timeout]);return args[0]==='status'?status():{sessions:[{summary:'discard'}]};},close:async()=>{}}});
  assert.equal(await probe.detect(),'wxid_synthetic');
  assert.equal(calls.length,1);
  assert.equal(await probe.confirm('wxid_synthetic'),'wxid_synthetic');
  assert.deepEqual(calls.map(x=>x[1]),[5000,5000,1000,5000]);
  assert.ok(calls.every(([args])=>args.includes('--strict-read-only')));
});
test('确认前账号改变不读列表，确认后改变不授权', async () => {
  for (const mismatchAt of [0,2]) {
    let count=0; const commands=[];
    const probe=new WechatSetupProbe({executable:'unused',runner:{run:async args=>{commands.push(args[0]); const i=count++; return args[0]==='sessions'?{sessions:[]}:status(i===mismatchAt?'wxid_other':'wxid_synthetic');},close:async()=>{}}});
    await assert.rejects(probe.confirm('wxid_synthetic'),{code:'wechat_account_changed'});
    assert.equal(commands.length,mismatchAt===0?1:3);
  }
});
test('真实子进程适配拒绝缺失工具，不执行非只读命令', async () => {
  const runner=new BoundedWechatCliRunner({executable:'/nonexistent/notalone-synthetic-cli'});
  await assert.rejects(runner.run(['status','--strict-read-only'],50),{code:'wechat_tool_unavailable'});
  await assert.rejects(runner.run(['send','--strict-read-only'],50),{code:'wechat_probe_failed'});
  await runner.close();
});
test('合成真实CLI进程取消、超时、输出预算都等待退出且不泄露输出', async () => {
  const { mkdtemp,writeFile,rm }=await import('node:fs/promises');
  const { tmpdir }=await import('node:os'); const { join }=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'notalone-setup-probe-')); const file=join(dir,'cli');
  try {
    await writeFile(file,`#!${process.execPath}\nif(process.argv.includes('--flood'))process.stdout.write('x'.repeat(2*1024*1024));setInterval(()=>{},1000);`,{mode:0o700});
    const runner=new BoundedWechatCliRunner({executable:file});
    const controller=new AbortController();
    const pending=runner.run(['status','--strict-read-only'],5000,controller.signal);
    controller.abort(); await assert.rejects(pending,{code:'wechat_tool_not_ready'});
    await assert.rejects(runner.run(['status','--strict-read-only'],30),{code:'wechat_tool_not_ready'});
    await assert.rejects(runner.run(['status','--strict-read-only','--flood'],1000),{code:'wechat_tool_not_ready'});
    const closing=runner.run(['status','--strict-read-only'],5000);
    const rejected=assert.rejects(closing,{code:'wechat_tool_not_ready'});
    await runner.close(); await rejected;
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('真实PG最后写入后关闭或HTTP取消，提交前复验回滚全部授权', async () => {
  const f=await createStorageFixture(); const storage=await HostStorage.open(f.options);
  try {
    for (const mode of ['close','cancel']) {
      const owner=randomUUID();
      await f.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成取消')",[owner]);
      let entered,release;
      const started=new Promise(resolve=>{entered=resolve;});
      const blocked=new Promise(resolve=>{release=resolve;});
      const delayedStorage={businessTransaction:operation=>storage.businessTransaction(client=>operation(new Proxy(client,{get(target,key){
        if(key==='query')return async(...args)=>{const value=await target.query(...args);if(String(args[0]).startsWith('INSERT INTO public.front_sync_state')){entered();await blocked;}return value;};
        return Reflect.get(target,key);
      }})))};
      const service=new WechatSetupService({ownerId:owner,store:new PostgresWechatSetupStore(delayedStorage),probe:async()=>`wxid_${mode}`,confirmProbe:async a=>a,historySessions:async()=>[]});
      const ready=await service.detect(); let valid=true;
      const pending=service.confirm({candidate_token:ready.candidate_token,mode:'all_private',historyAuthorized:true},()=>{if(!valid)throw new HostStorageError('runtime_stopping');});
      const rejected=assert.rejects(pending,{name:'HostStorageError',code:'runtime_stopping'});
      await started;
      const closed=mode==='close'?service.close():Promise.resolve();
      if(mode==='cancel')valid=false;
      release(); await rejected; await closed;
      for(const table of ['owner_channel_identity','wechat_sync_scope','wechat_history_sync_authorization','front_sync_state']) {
        assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE owner_id=$1`,[owner])).rows[0].n,0);
      }
      await service.close();
    }
  } finally {await storage.close();await f.close();}
});

test('生产微信确认API在最后写入后取消或关闭，返回停止并回滚全部授权', async t => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const f = await createStorageFixture();
  const storage = await HostStorage.open(f.options);
  try {
    const { owner_id: owner } = await storage.initializeOwner('合成取消本人');
    const executable = join(f.directory, 'synthetic-wechat-cancel-cli');
    await writeFile(executable, `#!${process.execPath}\nconst status={status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-cancel-account'}}};console.log(JSON.stringify({ok:true,data:process.argv[2]==='status'?status:{sessions:[]}}));\n`, { mode: 0o700 });
    for (const mode of ['cancel', 'close']) await t.test(mode, async () => {
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const blocked = new Promise(resolve => { release = resolve; });
      const delayedStorage = new Proxy(storage, { get(target, key) {
        if (key === 'businessTransaction') return operation => target.businessTransaction(client => operation(
          new Proxy(client, { get(connection, property) {
            if (property === 'query') return async (...args) => {
              const value = await connection.query(...args);
              if (String(args[0]).startsWith('INSERT INTO public.front_sync_state')) { entered(); await blocked; }
              return value;
            };
            return Reflect.get(connection, property);
          } }),
        ));
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const api = await createWechatScopeApi({ storage: delayedStorage, executable, environment: {}, readSyncStatus: async () => ({}) });
      try {
        const detected = await api.handle('POST', '/api/setup/wechat/detect', {});
        assert.equal(detected.status, 200);
        assert.equal(detected.body.state, 'ready');
        const controller = new AbortController();
        const pending = api.handle('POST', '/api/setup/wechat/confirm', {
          candidate_token: detected.body.candidate_token, confirmed: true, mode: 'all_private', history_authorized: true,
        }, undefined, controller.signal);
        await Promise.race([started, pending.then(() => { throw new Error('确认未到达最后写入阻塞点'); })]);
        const closed = mode === 'close' ? api.close() : Promise.resolve();
        if (mode === 'cancel') controller.abort();
        release();
        const result = await pending;
        await closed;
        assert.equal(result.status, 503);
        assert.deepEqual(result.body, { error: 'runtime_stopping' });
        assert.equal(await new PostgresWechatSetupStore(storage).read(owner), null);
        for (const table of ['owner_channel_identity', 'wechat_sync_scope', 'wechat_history_sync_authorization', 'front_sync_state']) {
          assert.equal((await f.client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE owner_id=$1`, [owner])).rows[0].n, 0);
        }
      } finally { release(); await api.close(); }
    });
  } finally { await storage.close(); await f.close(); }
});

test('显式全部历史读取当前快照后复验账号；selected不读取或提前授权',async()=>{
  const calls=[];let account='wxid_synthetic';
  const f=fixture({probe:async()=>account,historySessions:async(a,signal)=>{calls.push(a);account='wxid_other';return [];}});
  const ready=await f.service.detect();
  assert.equal((await f.service.confirm({candidate_token:ready.candidate_token,mode:'all_private',historyAuthorized:true})).failure_code,'wechat_account_changed');
  assert.equal(f.calls.length,0);assert.deepEqual(calls,['wxid_synthetic']);
  const selected=fixture({historySessions:async()=>assert.fail()});const r=await selected.service.detect();
  assert.equal((await selected.service.confirm({candidate_token:r.candidate_token,mode:'selected',historyAuthorized:true})).state,'restart_required');
});
test('首连历史快照复用稳定身份并保留排除；绕开运行时建联的直接插入不扩权',async()=>{
  const f=await createStorageFixture();const storage=await HostStorage.open(f.options);
  try {
    const owner=randomUUID(),contact=randomUUID(),account='wxid_snapshot';
    await f.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成')",[owner]);
    await f.client.query("INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,'合成')",[contact,owner]);
    await f.client.query("INSERT INTO public.channel_identity(owner_id,contact_id,channel,external_id,observed_name) VALUES($1,$2,'wechat','existing','合成')",[owner,contact]);
    await f.client.query("INSERT INTO public.wechat_sync_exclusion(owner_id,channel,account_scope,locator_hash) VALUES($1,'wechat',$2,sha256(convert_to('excluded','UTF8')))",[owner,account]);
    const store=new PostgresWechatSetupStore(storage);
    await store.connect(owner,account,new Date(),{mode:'all_private',historyAuthorized:true},()=>{},['existing','new','excluded'].map(username=>({username,display_name:'合成',chat_type:'private'})));
    const bindings=(await f.client.query('SELECT id,contact_id,conversation_locator FROM public.conversation_binding WHERE owner_id=$1',[owner])).rows;
    assert.equal(bindings.length,2);assert.equal(bindings.find(r=>r.conversation_locator==='existing').contact_id,contact);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization WHERE owner_id=$1',[owner])).rows[0].n,2);
    await f.client.query("INSERT INTO public.conversation_binding(owner_id,contact_id,channel,account_scope,conversation_locator) VALUES($1,$2,'wechat',$3,'future')",[owner,contact,account]);
    assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_binding_history_authorization WHERE owner_id=$1',[owner])).rows[0].n,2);
  } finally {await storage.close();await f.close();}
});

test('selected首连不提前授予历史；快照缺失或取消回滚整个连接',async()=>{
  const f=await createStorageFixture();const storage=await HostStorage.open(f.options);
  try {
    const store=new PostgresWechatSetupStore(storage);
    for (const mode of ['selected','missing','cancel']) {
      const owner=randomUUID();await f.client.query("INSERT INTO public.owner(id,display_name) VALUES($1,'合成')",[owner]);
      if(mode==='selected'){
        await store.connect(owner,'wxid_'+mode,new Date(),{mode:'selected',historyAuthorized:true});
        assert.equal((await f.client.query('SELECT count(*)::int n FROM public.wechat_history_sync_authorization WHERE owner_id=$1',[owner])).rows[0].n,0);
        continue;
      }
      let valid=true;
      const delayed={businessTransaction:operation=>storage.businessTransaction(client=>operation(new Proxy(client,{get(target,key){
        if(key==='query')return async(...args)=>{const value=await target.query(...args);if(String(args[0]).startsWith('INSERT INTO public.wechat_binding_history_authorization'))valid=false;return value;};
        return Reflect.get(target,key);
      }})))};
      await assert.rejects(new PostgresWechatSetupStore(delayed).connect(owner,'wxid_'+mode,new Date(),{mode:'all_private',historyAuthorized:true},()=>{if(!valid)throw new Error('cancelled');},mode==='missing'?undefined:[{username:'snapshot',display_name:'合成',chat_type:'private'}]));
      for(const table of ['owner_channel_identity','wechat_sync_scope','wechat_history_sync_authorization','front_sync_state','conversation_binding','wechat_binding_history_authorization','contact'])assert.equal((await f.client.query(`SELECT count(*)::int n FROM public.${table} WHERE owner_id=$1`,[owner])).rows[0].n,0);
    }
  } finally {await storage.close();await f.close();}
});
