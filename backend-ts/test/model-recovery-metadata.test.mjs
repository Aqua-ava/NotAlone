import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {homedir} from 'node:os';
import pg from 'pg';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {connect} from 'node:net';
import {createHostModelAccounting} from '../src/host-model-accounting.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';
import {ModelPermitArbiter} from '../src/model-permits.ts';
const root=resolve(new URL('../..',import.meta.url).pathname);
// 此库只覆盖新增metadata SELECT，故最小表不声称完整schema/migrator验收。
test('真实PG metadata owner/contact NULL隔离，已持scope锁仍只读返回',async()=>{
 const name='notalone_ack_review_'+randomUUID().replaceAll('-','')+'_test';
 const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();let client,locker;
 try{
  await admin.query(`CREATE DATABASE ${name} TEMPLATE template0`);
  client=new pg.Client({host:'/tmp',database:name});locker=new pg.Client({host:'/tmp',database:name});await client.connect();await locker.connect();
  await client.query('CREATE TABLE model_call_receipt(owner_id uuid,contact_id uuid,request_id uuid,permit_id uuid)');
  const owner=randomUUID(),other=randomUUID(),contact=randomUUID(),permit=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()];
  for(const [i,o,c] of [[0,owner,contact],[1,owner,null],[2,other,contact]])await client.query('INSERT INTO model_call_receipt VALUES($1,$2,$3,$4)',[o,c,ids[i],permit]);
  const transaction=async f=>{await client.query('BEGIN');try{await client.query("SET LOCAL statement_timeout='500ms'");const out=await f(client);await client.query('COMMIT');return out;}catch(e){await client.query('ROLLBACK');throw e;}};
  const a=createHostModelAccounting({transaction,provider:'deepseek',model:'synthetic',unconfirmedPermitIds:()=>[permit]});
  await locker.query('BEGIN');for(const key of [`contact:${owner}:${contact}`,`owner:${owner}`])await locker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  assert.deepEqual(await a.unconfirmedRequests({owner_id:owner,contact_id:contact}),[ids[0]]);
  assert.deepEqual(await a.unconfirmedRequests({owner_id:owner,contact_id:null}),[ids[1]]);
  assert.deepEqual(await a.unconfirmedRequests({owner_id:other,contact_id:contact}),[ids[2]]);
  assert.deepEqual(await a.unconfirmedRequests({owner_id:other,contact_id:null}),[]);
  await assert.rejects(a.unconfirmedRequests({owner_id:owner,contact_id:undefined}));
  const bad=createHostModelAccounting({transaction,provider:'deepseek',model:'synthetic',unconfirmedPermitIds:()=>{throw Error('not_ready');}});
  await assert.rejects(bad.unconfirmedRequests({owner_id:owner,contact_id:null}));
  assert.equal((await client.query('SELECT count(*) FROM model_call_receipt')).rows[0].count,'3');
 }finally{if(locker){await locker.query('ROLLBACK');await locker.end();}await client?.end();await admin.query(`DROP DATABASE IF EXISTS ${name}`);await admin.end();}
});
test('metadata认证失败不调用可信callback',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'na-ack-review-'));let server;let called=0;
 try{
  const path=join(dir,'p.sock');server=await startModelPermitServer({path,token:'x'.repeat(40),arbiter:new ModelPermitArbiter(1),accounting:{reserve:async()=>assert.fail(),recordReserved:async()=>assert.fail(),unconfirmedRequests:async()=>{called++;return [];}}});
  const response=await new Promise((resolve,reject)=>{const c=connect(path);let data='';c.setTimeout(1500,()=>{c.destroy();reject(Error('timeout'));});c.on('error',reject);c.on('data',x=>data+=x);c.on('close',()=>resolve(data));c.on('connect',()=>c.write(JSON.stringify({op:'unconfirmed_requests',token:'wrong',owner_id:randomUUID(),contact_id:null})+'\n'));});
  assert.equal(response,'');assert.equal(called,0);
 }finally{await server?.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('只读orphan副本不包含活跃许可',async()=>{const a=new ModelPermitArbiter(1),p=await a.acquire('background');assert.deepEqual(a.orphanedPermitIds(),[]);p.orphan();const copy=a.orphanedPermitIds();assert.deepEqual(copy,[p.id]);copy.length=0;assert.deepEqual(a.orphanedPermitIds(),[p.id]);});
test('已认证恢复元数据超过单帧时分页完整返回且不领取许可',async t=>{
 const temp=await mkdtemp(join(tmpdir(),'notalone-meta-pages-'));let server,child;
 t.after(async()=>{if(child&&child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}await server?.shutdown();await rm(temp,{recursive:true,force:true});});
 const ids=Array.from({length:130},()=>randomUUID()).sort(),a=new ModelPermitArbiter(1),path=join(temp,'permit.sock'),token='synthetic'.repeat(5);
 // 仅验证私有RPC分帧与身份协议；恢复事实的PG/journal来源由真实学习纵切证明。
 server=await startModelPermitServer({path,token,arbiter:a,accounting:{reserve:async()=>assert.fail('只读RPC不可预约'),recordReserved:async()=>assert.fail('只读RPC不可记账'),unconfirmedRequests:async()=>ids.slice()}});
 const script="import sys,json\nfrom uuid import UUID\nfrom notalone.application.model_permit_client import SharedModelPriorityControl\nc=SharedModelPriorityControl(socket_path=sys.argv[1],token=sys.argv[2])\nprint(json.dumps([str(x) for x in c.unconfirmed_requests(UUID(sys.argv[3]),None)]))";
 child=spawn(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',script,path,token,randomUUID()],{env:{PATH:'/usr/bin:/bin',HOME:homedir(),PYTHONPATH:join(root,'backend/src'),NOTALONE_DISABLE_DOTENV:'1'},stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);assert.equal((await once(child,'exit'))[0],0,err);assert.deepEqual(JSON.parse(out),ids);assert.equal(a.snapshot().backgroundActive,0);
});
