import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createExplorationHttp} from '../src/reply/exploration/exploration-http.ts';

test('探索私有HTTP先认证、固定owner、严格动作输入且不泄漏异常正文',async t=>{
 const owner=randomUUID(),contact=randomUUID(),session=randomUUID(),token='synthetic-exploration-private-token-'.repeat(2),calls=[];
 const service={execute:async(...args)=>{calls.push(args);return {kind:'directions',confirmed_intent:null};}};
 const handler=createExplorationHttp({ownerId:owner,token,service});
 const server=createServer((req,res)=>{void handler.handle(req,res).then(ok=>{if(!ok)res.writeHead(404).end();});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
 const body={owner_id:owner,contact_id:contact,session_id:session,action:'open',request:{content:{type:'purpose_exploration'},operation_key:randomUUID()}};
 const send=async(value=body,headers={})=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/internal/exploration`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:typeof value==='string'?value:JSON.stringify(value)});return {status:r.status,body:await r.json()};};
 assert.equal((await send('{',{Authorization:'Bearer wrong'})).status,401);
 assert.equal((await send(body,{Origin:'http://synthetic.invalid'})).status,401);
 for(const value of [{...body,owner_id:randomUUID()},{...body,action:'send'},{...body,request:{...body.request,confirmed_intent:'伪确认'}},{...body,request:{...body.request,content:{type:'purpose_exploration',confirmed_intent:'伪确认'}}}])assert.equal((await send(value)).status,400);
 assert.equal(calls.length,0);
 const result=await send();assert.equal(result.status,200);assert.equal(result.body.owner_id,owner);assert.equal(result.body.contact_id,contact);assert.equal(result.body.result.confirmed_intent,null);assert.equal(calls.length,1);
 service.execute=async()=>{throw new Error('synthetic-secret-body');};assert.deepEqual(await send(),{status:503,body:{error:'exploration_failed'}});
});
