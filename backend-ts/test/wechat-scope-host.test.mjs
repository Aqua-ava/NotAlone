import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile,appendFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {watch} from 'node:fs';
import {request} from 'node:http';
import {createStorageFixture} from './host-storage-fixture.mjs';
import {start} from './contact-context-support.mjs';

async function fixture(t) {
  const f=await createStorageFixture();
  t.after(async()=>{for(const host of f.hosts??[])await host.terminate();await f.close();});
  const owner=randomUUID();
  await f.client.query("INSERT INTO owner(id,display_name) VALUES($1,'合成本人')",[owner]);
  await f.client.query("INSERT INTO owner_channel_identity(owner_id,channel,external_id,observed_name) VALUES($1,'wechat','synthetic-account','合成账号')",[owner]);
  const executable=join(f.directory,'synthetic-wechat');
  await writeFile(executable,`#!${process.execPath}\nconst fs=await import('node:fs');if(fs.existsSync(${JSON.stringify(join(f.directory,'hang'))})){fs.writeFileSync(${JSON.stringify(join(f.directory,'started'))},'started');setTimeout(()=>{},30000);}else {const command=process.argv[2];if(command==='status')console.log(JSON.stringify({ok:true,data:{status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'synthetic-account'}}}}));else if(command==='sessions')console.log(JSON.stringify({ok:true,data:{sessions:[{username:'friend-a',display_name:'合成同名',chat_type:'private',last_timestamp:1,summary:'MUST_NOT_LEAK_SUMMARY'},{username:'friend-b',display_name:'合成同名',chat_type:'private',last_timestamp:2,summary:'MUST_NOT_LEAK_SUMMARY'}]}}));else process.exit(2);}`);
  await chmod(executable,0o700);
  await appendFile(f.envFilePath,`NOTALONE_OWNER_ID=${owner}\nNOTALONE_WECHAT_CLI=${executable}\n`);
  const app=await start(t,f);
  return {...f,owner,app};
}

test('官方profile公开微信入口：默认范围、摘要丢弃、单联系人历史快照与撤销排除',async t=>{
  const f=await fixture(t);
  const setup=await f.app.request('/api/setup/wechat');
  assert.equal(setup.status,200);assert.equal(setup.data.state,'connected');
  const listed=await f.app.request('/api/sync/cli-sessions');
  assert.equal(listed.status,200);assert.equal(listed.data.sessions.length,2);
  assert.ok(!JSON.stringify(listed.data).includes('MUST_NOT_LEAK_SUMMARY'));
  const bound=await f.app.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a',observed_display_name:'合成同名'}],history_authorized:true});
  assert.equal(bound.status,200);assert.equal(bound.data.sync_scope,'selected');
  const bindings=await f.app.request('/api/sync/cli-bindings');
  assert.equal(bindings.data.bindings.length,1);
  const binding=bindings.data.bindings[0];
  assert.equal((await f.client.query('SELECT binding_id FROM wechat_binding_history_authorization')).rows[0].binding_id,binding.binding_id);
  assert.equal((await f.app.request('/api/sync/scope',{mode:'all_private',confirmed:false})).status,400);
  assert.equal((await f.app.request('/api/sync/scope',{mode:'all_private',confirmed:true})).status,200);
  assert.equal((await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:'invalid',binding_id:'invalid'})).status,400);
  assert.equal((await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:randomUUID(),binding_id:randomUUID()})).status,404);
  const revoked=await f.app.request('/api/sync/cli-bindings/revoke',{contact_id:binding.contact_id,binding_id:binding.binding_id});
  assert.equal(revoked.status,200);assert.equal(revoked.data.status,'revoked');
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM wechat_sync_exclusion WHERE owner_id=$1',[f.owner])).rows[0].n,1);
  for(const operation of ['state','discover','history-state','history-bindings','revoke']) {
    const internal=await f.app.request(`/api/runtime/wechat-scope/${operation}`,{owner_id:f.owner,channel:'wechat',account_scope:'synthetic-account'});
    assert.equal(internal.status,401,'公开token不能调用内部scope端口');
  }
});


test('内部scope拒绝随机token及公开token，无scope副作用',async t=>{
  const f=await fixture(t);
  const scope={owner_id:randomUUID(),channel:'wechat',account_scope:'other'};
  for(const operation of ['state','discover','history-state','history-bindings','revoke']) {
    assert.equal((await f.app.request(`/api/runtime/wechat-scope/${operation}`,scope,'synthetic-wrong-token')).status,401);
    assert.equal((await f.app.request(`/api/runtime/wechat-scope/${operation}`,scope)).status,401);
  }
  const traversal=await new Promise((resolve,reject)=>{
    const req=request(`http://${f.app.connection.address}`,{method:'POST',path:'/api/sync/../runtime/wechat-scope/discover',headers:{Authorization:`Bearer ${f.app.connection.token}`,'Content-Type':'application/json'}},res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});
    req.once('error',reject);req.end(JSON.stringify(scope));
  });
  assert.equal(traversal,401);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,0);
});

test('宿主关停取消真实合成CLI在途读取后排空，不留下绑定',async t=>{
  const f=await fixture(t);
  await writeFile(join(f.directory,'hang'),'1');
  let watcher;
  let timer;
  const started=new Promise((resolve,reject)=>{
    watcher=watch(f.directory,(_event,name)=>{if(String(name)==='started'){clearTimeout(timer);watcher.close();resolve();}});
    timer=setTimeout(()=>{watcher.close();reject(new Error('合成CLI未启动'));},5000);
  });
  t.after(()=>{clearTimeout(timer);watcher.close();});
  const pending=f.app.request('/api/sync/cli-bindings/confirm',{selections:[{locator:'friend-a'}]});
  await started;
  const stopped=await f.app.request('/api/runtime/shutdown',{});
  assert.equal(stopped.status,200);
  assert.equal((await pending).status,503);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,0);
});

async function rawBody(app, length, body = '', end = false) {
  const {createConnection}=await import('node:net');
  return new Promise((resolve,reject)=>{
    const [host,port]=app.connection.address.split(':');
    const socket=createConnection({host,port:Number(port)});
    let received='';
    const timer=setTimeout(()=>{socket.destroy();reject(new Error('正文读取未在预算内回应'));},13_000);
    socket.on('data',chunk=>{received+=chunk.toString();});
    socket.once('error',error=>{clearTimeout(timer);if(!received)reject(error);});
    socket.once('close',()=>{clearTimeout(timer);resolve(received);});
    socket.once('connect',()=>{
      socket.write(`POST /api/sync/cli-bindings/confirm HTTP/1.1\r\nHost: ${app.connection.address}\r\nAuthorization: Bearer ${app.connection.token}\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n${body}`);
      if(end)socket.end();
    });
  });
}

test('真实socket声明超限立即413，非法长度及提前半关闭稳定400',async t=>{
  const f=await fixture(t);
  const before=performance.now();
  const oversized=await rawBody(f.app,1024*1024+1);
  assert.match(oversized,/HTTP\/1.1 413/);assert.match(oversized,/request_body_too_large/);
  assert.ok(performance.now()-before<3000);
  const invalid=await rawBody(f.app,'-1');
  assert.match(invalid,/HTTP\/1.1 400/);assert.match(invalid,/request_length_invalid/);
  const incomplete=await rawBody(f.app,100,'{',true);
  assert.match(incomplete,/HTTP\/1.1 400/);assert.match(incomplete,/request_body_incomplete/);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,0);
});

test('真实socket正文迟缓超过10秒总预算返回408且无写入',async t=>{
  const f=await fixture(t);
  const result=await rawBody(f.app,100,'{');
  assert.match(result,/HTTP\/1.1 408/);assert.match(result,/request_body_timeout/);
  assert.equal((await f.client.query('SELECT count(*)::int AS n FROM conversation_binding')).rows[0].n,0);
});
