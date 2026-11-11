import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {ModelPermitArbiter} from '../src/platform/models/model-permits.ts';
import {createModelPermitPort} from '../src/platform/models/model-permit-port.ts';
test('进程内预约把原TaskClaim交给宿主策略，迟到结算不要求当前claim',async()=>{
 const reserved=[],recorded=[],port=createModelPermitPort(new ModelPermitArbiter(1),{reserve:async(...args)=>{reserved.push(args);},recordReserved:async receipt=>{recorded.push(receipt);}});
 const attempt=randomUUID(),permit=await port.acquire(new AbortController().signal,attempt);
 const receipt={attempt_id:attempt,permit_id:permit.id},claim={task_id:randomUUID(),step_id:randomUUID(),step_name:'extract_memory',worker_id:randomUUID(),lease_generation:3};
 await permit.reserve(receipt,claim);assert.deepEqual(reserved,[[receipt,claim]]);assert.equal(Object.hasOwn(receipt,'claim'),false);
 permit.settle();await port.recordReserved({...receipt,outcome:'unknown'});assert.deepEqual(recorded,[{...receipt,outcome:'unknown'}]);
});
