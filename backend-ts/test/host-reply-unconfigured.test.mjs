/** 已认证的未配置回复不能挂起、读资料或安装模型。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHostReplyRuntime} from '../src/host/host-reply.ts';

test('无owner或无模型的私有候选入口认证后稳定unavailable，公开token不可调用',{timeout:10000},async t=>{
 for(const owner of [undefined,'11111111-1111-4111-8111-111111111111']){
  const token='synthetic-private-token-'.repeat(3);
  const runtime=await createHostReplyRuntime({ctx:new Proxy({},{get(){throw Error('不应安装模型');}}),
   storage:{runtimeOwnerId:owner,businessReadTransaction(){throw Error('未配置不应读业务资料');},runtimeEnvironment(){return {};}},
   arbiter:{acquire(){throw Error('未配置不应领取许可');}},ledger:{reserve(){throw Error('未配置不应写预算');}},
   token,configuration:null,discussionSkillsRoot:'/tmp/notalone-synthetic-unconfigured-skills'});
  const server=createServer((req,res)=>void runtime.handle(req,res).then(handled=>{if(!handled)res.writeHead(404).end('{}');}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
   for(const endpoint of ['prepare','generate']){
    const url=`http://127.0.0.1:${server.address().port}/internal/reply/${endpoint}`;
    const denied=await fetch(url,{method:'POST',headers:{Authorization:'Bearer synthetic-public-token'},body:'{'});
    assert.equal(denied.status,401);assert.deepEqual(await denied.json(),{error:'unauthorized'});
    const unavailable=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:'{'});
    assert.equal(unavailable.status,503);assert.deepEqual(await unavailable.json(),{error:'reply_remote_unavailable'});
   }
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await runtime.close();}
 }
});
