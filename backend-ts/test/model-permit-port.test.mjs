import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {createModelPermitPort} from '../src/platform/models/model-permit-port.ts';
const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('同进程端口将原领取凭证交给权威账本，独立迟到回执仍可记录',async()=>{
 const arbiter=new ModelPermitArbiter(1),reserved=[],recorded=[];
 const port=createModelPermitPort(arbiter,{reserve:async(...args)=>{reserved.push(args);},recordReserved:async r=>{recorded.push(r);},unconfirmedRequests:async()=>[]});
 const attempt=randomUUID(),lease=await port.acquire(new AbortController().signal,attempt);
 const receipt={attempt_id:attempt,permit_id:lease.id},claim={task_id:randomUUID()};
 await lease.reserve(receipt,claim);assert.deepEqual(reserved,[[receipt,claim]]);
 await assert.rejects(lease.reserve({...receipt,permit_id:randomUUID()},claim),/accounting_invalid/);
 lease.settle();await port.recordReserved(receipt);assert.deepEqual(recorded,[receipt]);
 assert.deepEqual(await port.unconfirmedRequests({owner_id:randomUUID(),contact_id:null}),[]);
});
test('同进程调用失联仍保留后台容量并冻结同类，前台继续派发',async()=>{
 const arbiter=new ModelPermitArbiter(3),port=createModelPermitPort(arbiter);
 const lease=await port.acquire(new AbortController().signal,randomUUID());lease.orphan();
 const controller=new AbortController();let acquired=false;
 const waiting=port.acquire(controller.signal,randomUUID()).then(()=>{acquired=true;},()=>{});
 const foreground=await arbiter.acquire('foreground');await turn();assert.equal(acquired,false);
 assert.equal(arbiter.snapshot().orphaned,1);controller.abort();await waiting;
 foreground.settle();lease.settle();assert.equal(arbiter.snapshot().orphaned,0);
});

test('恢复查询只把owner/contact投影交给账本，不传模型调用的闭包或其他字段',async()=>{
 let received;const port=createModelPermitPort(new ModelPermitArbiter(1),{reserve:async()=>{},recordReserved:async()=>{},unconfirmedRequests:async scope=>{received=scope;return [];}});
 const owner_id=randomUUID();await port.unconfirmedRequests({owner_id,contact_id:null,requireCurrent:async()=>{},binding:{private:'synthetic'}});
 assert.deepEqual(received,{owner_id,contact_id:null});
});
