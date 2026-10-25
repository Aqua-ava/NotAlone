import test from 'node:test';
import assert from 'node:assert/strict';
import {FormalExecutor} from './formal-executor.mjs';
import {budgetFixture,executorPorts} from './test-fixture.mjs';
import {bindExistingProblemBudget} from './problem-budget-port.mjs';

test('缺根许可及持久问题预算时在业务与供应商端口前拒绝', async()=>{
  let opened=0,sent=0;
  const executor=new FormalExecutor({business:{open(){opened++;}},supplier:{send(){sent++;}}});
  await assert.rejects(executor.preflight(),/root_permission_required/);
  assert.equal(opened,0);assert.equal(sent,0);
});

test('许可撤回、租约取消和实际字节改写均在外写前拒绝且预留不退款',async t=>{
  for(const kind of ['permission','cancel','bytes'])await t.test(kind,async()=>{
    const fixture=await budgetFixture(),controller=new AbortController();
    try{
      const f=await executorPorts(fixture.port,{beforeWrite:async(_input,state)=>{
        if(kind==='permission')state.permission=false;if(kind==='cancel')controller.abort();}});
      if(kind==='bytes')f.ports.supplier={validate:async()=>true,async send(input){await input.beforeWrite(input.request.raw+' ');throw Error('unreachable');}};
      const report=await new FormalExecutor(f.ports).executePair(f.runIds,{signal:controller.signal});
      assert.equal(f.state.sends,0);assert.ok(fixture.read().used>=1);
      assert.ok(report.records.every(r=>['failed','cancelled'].includes(r.terminal_status)));
    }finally{await fixture.close();}
  });
});

test('首个供应商失败后内部再到达不再reserve或发送，不靠额度耗尽停止',async()=>{
  const fixture=await budgetFixture({limit:20});try{
    const f=await executorPorts(fixture.port,{send:async(_input,send_ack)=>({send_ack,physical_attempted:true,terminal_status:'failed'})});
    const open=f.ports.business.open;
    f.ports.business={async open(run){const session=await open(run);session.run=async dispatch=>{
      const raw=JSON.stringify({model:'deepseek-flash',temperature:0,thinking:{type:'disabled'},messages:[],tools:[]});
      for(let i=0;i<3;i++)try{await dispatch({raw,path:'/v1/chat/completions',route:'chat'});}catch{}
      return {terminal_status:'failed',audit:{persisted_physical_count:1}};
    };return session;}};
    const report=await new FormalExecutor(f.ports).executePair(f.runIds);
    assert.equal(fixture.read().used,2);assert.equal(f.state.sends,2);
    assert.ok(report.records.every(r=>r.attempts.length===3&&r.attempts[1].error_code==='physical_attempt_after_terminal_failure'&&!r.attempts[1].reservation));
  }finally{await fixture.close();}
});

test('不足额度与过期拒绝，不重置同问题或另建预算',async t=>{
  await t.test('exhausted',async()=>{
    const fixture=await budgetFixture({limit:1});try{
      const f=await executorPorts(fixture.port),report=await new FormalExecutor(f.ports).executePair(f.runIds);
      assert.equal(fixture.read().used,1);assert.equal(f.state.sends,1);
      assert.ok(report.records.every(r=>r.terminal_status==='failed'));assert.equal(report.population.not_run,1054);
    }finally{await fixture.close();}
  });
  await t.test('expired',async()=>{
    const fixture=await budgetFixture();try{
      const f=await executorPorts(fixture.port);fixture.expire();
      await assert.rejects(new FormalExecutor(f.ports).executePair(f.runIds),/budget_bridge_rejected/);
      assert.equal(f.state.opens,0);assert.equal(f.state.sends,0);assert.equal(fixture.read().used,0);
    }finally{await fixture.close();}
  });
});

test('两个独立绑定竞争末笔额度时 SQLite 原子预留只成功一次',async()=>{
  const fixture=await budgetFixture({limit:1});try{
    const second=await bindExistingProblemBudget({configuration:fixture.configuration,expected:fixture.expected});
    const outcomes=await Promise.allSettled([fixture.port.reserve({attempt_id:'a'}),second.reserve({attempt_id:'b'})]);
    assert.equal(outcomes.filter(v=>v.status==='fulfilled').length,1);assert.equal(fixture.read().used,1);
  }finally{await fixture.close();}
});

test('供应商物理失败和unknown保留额度及失败分母',async t=>{
  for(const kind of ['failed','unknown','exception'])await t.test(kind,async()=>{
    const fixture=await budgetFixture();try{
      const f=await executorPorts(fixture.port,{send:async(_input,send_ack)=>{
        if(kind==='exception')throw Error('synthetic_after_reservation_exception');
        return {send_ack,physical_attempted:true,terminal_status:kind};}});
      const report=await new FormalExecutor(f.ports).executePair(f.runIds);
      assert.equal(fixture.read().used,2);assert.equal(f.state.sends,2);
      assert.ok(report.records.every(r=>r.terminal_status==='failed'&&r.attempts[0].status==='unknown'));
      assert.equal(report.population.observed,2);assert.equal(report.formal_quality_runs,0);
    }finally{await fixture.close();}
  });
});

test('内层已绑定问题总账时拒绝双扣，短pin和未获时间资格均拒绝',async()=>{
  const fixture=await budgetFixture();try{
    const f=await executorPorts(fixture.port),original=f.ports.business.open;
    f.ports.business={async open(run){const session=await original(run);session.evidence.inner_problem_budget_bound=true;return session;}};
    const report=await new FormalExecutor(f.ports).executePair(f.runIds);
    assert.equal(f.state.sends,0);assert.equal(fixture.read().used,0);
    assert.ok(report.records.every(r=>r.error_code==='inner_problem_budget_would_double_reserve'));
    const short={...f.ports,plan:{...f.plan,new_commit:'4f89bb97'}};
    await assert.rejects(new FormalExecutor(short).preflight(),/full_candidate_commit_required/);
    await assert.rejects(new FormalExecutor(f.ports).preflight({qualityMode:'formal'}),/formal_time_and_semantic_qualification_missing/);
    await assert.rejects(new FormalExecutor({...f.ports,qualification:{approved:true}}).preflight({qualityMode:'formal'}),/formal_time_and_semantic_qualification_missing/);
  }finally{await fixture.close();}
});

test('header预校验失败在reserve前拒绝，冻结材料漂移也拒绝',async()=>{
  const fixture=await budgetFixture();try{
    const f=await executorPorts(fixture.port);f.ports.supplier.validate=async()=>{throw Error('synthetic_header_invalid');};
    const report=await new FormalExecutor(f.ports).executePair(f.runIds);
    assert.equal(fixture.read().used,0);assert.equal(f.state.sends,0);
    assert.ok(report.records.every(r=>r.attempts[0].error_code==='synthetic_header_invalid'));
    const plan=structuredClone(f.plan);plan.runs[0].case_sha256='0'.repeat(64);
    await assert.rejects(new FormalExecutor({...f.ports,plan}).preflight(),/frozen_plan_bytes_changed/);
  }finally{await fixture.close();}
});

test('输出额度及费用不作接缝门槛，保留实际控制与费用unknown',async()=>{
  const fixture=await budgetFixture();try{
    const f=await executorPorts(fixture.port),open=f.ports.business.open;
    f.ports.business={async open(run){const s=await open(run),invoke=s.run;s.run=(dispatch,signal)=>invoke(input=>{
      const body=JSON.parse(input.raw);body.max_tokens=393216;return dispatch({...input,raw:JSON.stringify(body)});
    },signal);return s;}};
    const report=await new FormalExecutor(f.ports).executePair(f.runIds);
    assert.ok(report.records.every(r=>r.terminal_status==='succeeded'&&r.attempts.every(a=>a.controls.max_tokens===393216&&a.cost===null)));
    assert.equal(fixture.read().used,4);
  }finally{await fixture.close();}
});

test('预留后来源漂移拒绝实际写入且不退额度',async()=>{
  const fixture=await budgetFixture();
  try{
    const f=await executorPorts(fixture.port,{beforeWrite:async(_input,state)=>{state.sourceValue.source_sha256='e'.repeat(64);}});
    const report=await new FormalExecutor(f.ports).executePair(f.runIds);
    assert.equal(f.state.sends,0);assert.equal(fixture.read().used,1);
    assert.match(report.records[0].attempts[0].error_code,/source_snapshot_drift/);
  }finally{await fixture.close();}
});

test('一对双臂全部物理尝试共用一个持久预算，绑定实际请求与单次发送ACK', async()=>{
  const fixture=await budgetFixture();
  try{
    const f=await executorPorts(fixture.port),executor=new FormalExecutor(f.ports);
    const result=await executor.executePair(f.runIds);
    assert.equal(fixture.read().used,4);assert.equal(f.state.sends,4);
    assert.equal(result.records.length,2);assert.equal(result.population.nonreply_planned,1056);
    assert.equal(result.population.unified_planned,1152);assert.equal(result.population.not_run,1054);
    assert.ok(result.records.every(r=>r.attempts.length===2&&r.attempts.every(a=>a.reservation.ordinal&&a.request_sha256)));
    assert.ok(result.records.every(r=>r.response_model==='unknown'&&r.response_fingerprint==='unknown'));
  }finally{await fixture.close();}
});

test('已有问题预算跨端口共享且耗尽拒绝，ACK不再扣账', async()=>{
  const fixture=await budgetFixture({limit:1});
  try{
    const binding={attempt_id:'synthetic-a',request_sha256:'1'.repeat(64)};
    const reservation=await fixture.port.reserve(binding);
    assert.equal(fixture.read().used,1);
    assert.equal((await fixture.port.ack(reservation)).ordinal,1);
    assert.equal(fixture.read().used,1);
    await assert.rejects(fixture.port.reserve({...binding,attempt_id:'synthetic-b'}),/budget_bridge_rejected/);
    assert.equal(fixture.read().used,1);
  }finally{await fixture.close();}
});
