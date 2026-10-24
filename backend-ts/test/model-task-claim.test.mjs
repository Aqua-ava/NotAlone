import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {connect} from 'node:net';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {ModelPermitArbiter} from '../src/model-permits.ts';
import {startModelPermitServer} from '../src/model-permit-server.ts';

test('真实Unix预约把原TaskClaim交给宿主策略，迟到结算不要求当前claim',{timeout:10000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-model-claim-')),path=join(directory,'p.sock'),token='synthetic-claim-token-'.repeat(3),reserved=[],recorded=[];
 const server=await startModelPermitServer({path,token,arbiter:new ModelPermitArbiter(1),accounting:{reserve:async(...args)=>{reserved.push(args);},recordReserved:async receipt=>{recorded.push(receipt);}}});
 t.after(async()=>{await server.shutdown();await rm(directory,{recursive:true,force:true});});
 async function channel(){const socket=connect(path),lines=createInterface({input:socket})[Symbol.asyncIterator]();t.after(()=>socket.destroy());await once(socket,'connect');return {socket,send:value=>socket.write(JSON.stringify(value)+'\n'),read:async()=>JSON.parse((await lines.next()).value)};}
 const worker=await channel();worker.send({op:'acquire',token,kind:'background',attempt_id:randomUUID(),worker:{pid:process.pid,parentPid:process.ppid,executable:process.execPath}});
 const grant=await worker.read();assert.equal(grant.state,'granted');
 const receipt={attempt_id:randomUUID(),permit_id:grant.permit_id,request_id:randomUUID(),owner_id:randomUUID(),contact_id:randomUUID(),provider:'synthetic',model:'synthetic',called_at:'2026-10-24T00:00:00Z',latency_ms:null,dispatch:'authorized_unconfirmed',outcome:'pending',usage:null,cost:{status:'unknown',amount:null,currency:null,pricing_version:null}};
 const claim={task_id:receipt.request_id,step_id:randomUUID(),step_name:'extract_memory',worker_id:randomUUID(),lease_generation:3};
 worker.send({op:'reserve',receipt,claim});assert.equal((await worker.read()).state,'reserved');
 assert.deepEqual(reserved,[[receipt,claim]]);assert.equal(Object.hasOwn(reserved[0][0],'claim'),false);
 worker.send({op:'reserve',receipt});assert.equal((await worker.read()).state,'reserved');assert.equal(reserved[1][1],undefined);
 worker.send({op:'settled'});assert.equal((await worker.read()).state,'settled');
 const late=await channel();late.send({op:'record',token,receipt:{...receipt,outcome:'unknown'}});assert.equal((await late.read()).state,'recorded');
 assert.deepEqual(recorded,[{...receipt,outcome:'unknown'}]);
});
