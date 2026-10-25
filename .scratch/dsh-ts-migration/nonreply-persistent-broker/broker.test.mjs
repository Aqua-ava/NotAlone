import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,chmod,rm,readFile,copyFile,writeFile,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPersistentBroker} from './broker.mjs';
import {createSyntheticBudget} from './synthetic-budget.mjs';
import {createLoopbackTransport} from './transport.mjs';
import {sha} from './attempt-journal.mjs';
const snapshot={candidate_commit:'e60074b5946b8d1c990fcb75ba13bd58f789b2fb',source_sha256:'c'.repeat(64)};
async function fixture({status=200,partial=false,ackLost=false}={}){
  const directory=await mkdtemp(join(tmpdir(),'na-broker-test-'));await chmod(directory,0o700);
  const wire=[],server=createServer(async(req,res)=>{let raw='';for await(const p of req)raw+=p;wire.push({path:req.url,raw});
    if(status!==200){res.writeHead(status,{'content-type':'application/json'});res.end('{"error":"synthetic"}');return;}
    const events=[{type:'message_start',message:{model:'synthetic-model',usage:{input_tokens:12,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
      {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:4}},{type:'message_stop'}];
    res.writeHead(200,{'content-type':'text/event-stream'});res.end(events.slice(0,partial?2:3).map(v=>'data: '+JSON.stringify(v)+'\n\n').join(''));
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  const bdir=join(directory,'budget'),jdir=join(directory,'journal');await mkdir(bdir,{mode:0o700});await mkdir(jdir,{mode:0o700});
  const fixture=await createSyntheticBudget({directory:bdir,limit:1000}),root=ackLost?{...fixture.port,async ack(r){await fixture.port.ack(r);throw Error('synthetic_ack_lost');}}:fixture.port;
  const state={permission:true,current:true,source:snapshot},config={directory:jdir,budget:root,source:{async assertCurrent(){return state.source;}},
    permission:{async assertAllowed(){return state.permission;}},assertCurrent:async()=>{if(state.hold)await state.hold;assert.equal(state.current,true,'synthetic_lease_stale');},
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},transport:createLoopbackTransport({origin:'http://127.0.0.1:'+server.address().port})};
  const broker=await createPersistentBroker(config);
  function input(id='synthetic-1',run='synthetic-run'){
    const body={model:'deepseek-flash',temperature:0,thinking:{type:'disabled'},max_tokens:393216,stream:true,messages:[{role:'user',content:'合成'}]},raw=JSON.stringify(body);
    return {request:{raw,body,path:'/anthropic/v1/messages',route:'messages'},binding:{problem_id:root.problemId,attempt_id:id,run_id:run,path:'/anthropic/v1/messages',route:'messages',request_sha256:sha(raw),source_snapshot_sha256:sha(snapshot)}};
  }
  async function prepare(i=input()){await broker.supplier.validate(i);const reservation=await broker.budget.reserve(i.binding);return {...i,reservation};}
  async function send(i,signal=new AbortController().signal){return broker.supplier.send({...i,signal,beforeWrite:async raw=>{
    assert.equal(raw,i.request.raw);await broker.budget.ack(i.reservation);return Object.freeze({attempt_id:i.binding.attempt_id,request_sha256:i.binding.request_sha256});}});}
  return {broker,fixture,wire,state,input,prepare,send,config,jdir,async close(){await broker.close();await fixture.close();
    const evidence=process.env.NA_BROKER_TEST_EVIDENCE;
    if(evidence){assert.equal((await lstat(evidence)).mode&0o777,0o700);const saved=await mkdtemp(join(evidence,'case-'));await chmod(saved,0o700);
      for(const [from,to]of [[join(jdir,'attempts.sqlite'),'journal.sqlite'],[join(bdir,'synthetic-budget.sqlite'),'budget.sqlite']]){await copyFile(from,join(saved,to));await chmod(join(saved,to),0o600);}
      await writeFile(join(saved,'wire.json'),JSON.stringify(wire),{mode:0o600});}
    server.closeAllConnections();await new Promise(done=>server.close(done));await rm(directory,{recursive:true,force:true});}};
}
test('每次HTTP只扣一次外层额度，实际输出和费用未知均不作门槛',async()=>{
  const f=await fixture();try{
    const i=await f.prepare(),result=await f.send(i);assert.equal(result.terminal_status,'complete');
    assert.equal(f.wire.length,1);assert.equal(f.fixture.read().used,1);assert.equal(f.broker.journal.list().length,1);
    assert.equal(f.broker.journal.get(i.binding.attempt_id).state,'responded');assert.equal(result.cost,null);
    assert.equal((await f.broker.summary()).five_phase_evidence.complete,false);
    const j=f.input('synthetic-output-difference','synthetic-run-2');j.request.body.max_tokens=8192;j.request.raw=JSON.stringify(j.request.body);j.binding.request_sha256=sha(j.request.raw);
    const r=await f.send(await f.prepare(j));assert.equal(r.terminal_status,'complete');assert.equal(f.fixture.read().used,2);
    assert.equal(f.broker.journal.get(j.binding.attempt_id).actual_controls.output_configuration_matches,false);
  }finally{await f.close();}
});
test('503无自动重试，未耗尽额度且失败留账',async()=>{
  const f=await fixture({status:503});try{const i=await f.prepare(),r=await f.send(i);assert.equal(r.terminal_status,'failed');
    assert.equal(f.wire.length,1);assert.equal(f.fixture.read().used,1);assert.equal((await f.broker.budget.inspect()).remaining,999);
    assert.equal(f.broker.journal.get(i.binding.attempt_id).state,'failed');
  }finally{await f.close();}
});
test('不完整HTTP保持unknown并阻止换ID或换字节自动恢复',async()=>{
  const f=await fixture({partial:true});try{const i=await f.prepare();assert.equal((await f.send(i)).terminal_status,'unknown');
    await f.broker.close();const resumed=await createPersistentBroker(f.config);
    await assert.rejects(resumed.supplier.validate(f.input('synthetic-replay')),/journal_run_unresolved/);
    assert.equal((await resumed.summary()).new_reservations,1);
    assert.equal(f.fixture.read().used,1);assert.equal(f.wire.length,1);await resumed.close();
  }finally{await f.close();}
});
test('失去ACK保留已扣额度和unknown但零HTTP，ACK从不reserve',async()=>{
  const f=await fixture({ackLost:true});try{const i=await f.prepare();await assert.rejects(f.send(i),/synthetic_ack_lost/);
    assert.equal(f.wire.length,0);assert.equal(f.fixture.read().used,1);assert.equal(f.broker.journal.get(i.binding.attempt_id).state,'unknown');
  }finally{await f.close();}
});
test('并发尝试不能二次reserve，完成后旧reservation也不能二发',async()=>{
  const f=await fixture();try{const a=await f.prepare(f.input('a','run-a')),b=f.input('b','run-b');await f.broker.supplier.validate(b);
    await assert.rejects(f.broker.budget.reserve(b.binding),/broker_concurrent_dispatch_rejected/);await f.send(a);
    await assert.rejects(f.send(a),/broker_dispatch_without_reservation/);assert.equal(f.fixture.read().used,1);assert.equal(f.wire.length,1);
  }finally{await f.close();}
});
test('同attempt的并发reserve/send不能释放首个在途请求的占用',{timeout:2000},async()=>{
  const f=await fixture();try{
    const a=await f.prepare(f.input('a','run-a'));let release;f.state.hold=new Promise(done=>{release=done;});
    const first=f.send(a);
    await assert.rejects(f.send(a),/broker_concurrent_send_rejected/);
    await assert.rejects(f.broker.budget.reserve(a.binding),/broker_concurrent_dispatch_rejected/);
    const b=f.input('b','run-b');await f.broker.supplier.validate(b);
    await assert.rejects(f.broker.budget.reserve(b.binding),/broker_concurrent_dispatch_rejected/);
    release();assert.equal((await first).terminal_status,'complete');assert.equal(f.wire.length,1);assert.equal(f.fixture.read().used,1);
    assert.equal(f.broker.journal.get(a.binding.attempt_id).state,'responded');
  }finally{await f.close();}
});
for(const mode of ['cancel','source','permission','lease','bytes'])test('发送前复核阻止'+mode+'，已预留不退款',async()=>{
  const f=await fixture();try{const i=await f.prepare(),controller=new AbortController();
    if(mode==='cancel')controller.abort();if(mode==='source')f.state.source={...snapshot,source_sha256:'d'.repeat(64)};
    if(mode==='permission')f.state.permission=false;if(mode==='lease')f.state.current=false;
    if(mode==='bytes')i.request.raw+=' ';
    await assert.rejects(f.send(i,controller.signal));assert.equal(f.wire.length,0);assert.equal(f.fixture.read().used,1);
  }finally{await f.close();}
});
