import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteMemoryExtractionHttp} from '../src/memory/sqlite/http.ts';
const runId='11111111-1111-4111-8111-111111111111',operationId='22222222-2222-4222-8222-222222222222';

test('隔离图片重试使用具名运行控制路由，只接受版本与操作标识',async t=>{
 const calls=[],snapshot={runId,isolated:0};
 const handler=new SqliteMemoryExtractionHttp({retryImages:async(...args)=>{calls.push(args);return snapshot;}},req=>req.headers['x-synthetic-authorized']==='1');
 const server=createServer((req,res)=>{void handler.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const url=`http://127.0.0.1:${server.address().port}/api/memory-processing/runs/${runId}/retry-images`;
 const request=(body,headers={'x-synthetic-authorized':'1'})=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
 const response=await request({action_version:3,operation_id:operationId});assert.equal(response.status,200);assert.deepEqual(await response.json(),snapshot);
 assert.deepEqual(calls,[[runId,3,operationId]]);
 for(const body of [{},{action_version:-1,operation_id:operationId},{action_version:3,operation_id:'bad'},
  {action_version:3,operation_id:operationId,contact_id:operationId},{action_version:3,operation_id:operationId,image_ids:[]}]){
  assert.equal((await request(body)).status,400);
 }
 assert.equal((await request({action_version:3,operation_id:operationId},{})).status,401);
 assert.equal((await request({action_version:3,operation_id:operationId},{'x-synthetic-authorized':'1',origin:'https://example.invalid'})).status,401);
 assert.equal(calls.length,1);
});
