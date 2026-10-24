import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

test('真实官方裁剪profile经过公开adapter：成功接受、超预算、未授权session与发送前取消', {timeout:20000}, async t=>{
 const directory=await mkdtemp(join(tmpdir(),'na-model-provider-'));
 const requests=[];
 const provider=createServer(async(req,res)=>{
  let raw='';for await(const part of req)raw+=part;requests.push(JSON.parse(raw));
  const events=[{type:'message_start',message:{id:'synthetic',model:'synthetic-model',usage:{input_tokens:3,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'合成'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];
  res.setHeader('content-type','text/event-stream');res.end(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
 });
 provider.listen(0,'127.0.0.1');await once(provider,'listening');
 const profile=join(directory,'profiles','notalone');await mkdir(profile,{recursive:true});
 await writeFile(join(profile,'package.json'),JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}));
 await writeFile(join(profile,'cordis.patch.yml'),`- insert:\n    - name: '@deepseek-ai/dsh-llm'\n    - name: ${JSON.stringify(resolve('test/model-provider-fixture.ts'))}\n`);
 const child=spawn(process.execPath,[resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'],{cwd:directory,env:{PATH:process.env.PATH,HOME:directory,DSH_HOME:directory,DSH_TELEMETRY_DISABLED:'1',NOTALONE_SYNTHETIC_PROVIDER_URL:`http://127.0.0.1:${provider.address().port}/anthropic`},stdio:['ignore','pipe','pipe']});
 const exited=once(child,'exit');let log='';child.stderr.on('data',value=>log+=value);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await rm(directory,{recursive:true,force:true});});
 const url=await new Promise((resolveReady,reject)=>{
  const timer=setTimeout(()=>reject(new Error(`官方profile启动失败: ${log.slice(-1000)}`)),10000);
  child.stdout.on('data',value=>{log+=value;const match=log.match(/MODEL_PROVIDER_READY (http:\/\/127\.0\.0\.1:\d+)/);if(match){clearTimeout(timer);resolveReady(match[1]);}});
  child.once('exit',()=>{clearTimeout(timer);reject(new Error(log.slice(-1000)));});
 });
 const call=async(body)=>await(await fetch(url,{method:'POST',body:JSON.stringify(body)})).json();
 const success=await call({text:'合成消息'});assert.equal(success.failure,false);assert.equal(success.reserved,1);assert.equal(success.observation.dispatch,'http_accepted');assert.equal(requests.length,1);
 const denied=await call({text:'超预算'.repeat(10000)});assert.equal(denied.failure,true);assert.equal(denied.reserved,0);assert.equal(requests.length,1);
 const unregistered=await call({unregistered:true});assert.equal(unregistered.failure,true);assert.equal(unregistered.reserved,0);assert.equal(requests.length,1);
 const aborted=await call({cancelBeforeDispatch:true});assert.equal(aborted.failure,true);assert.equal(aborted.reserved,1);assert.equal(aborted.observation.dispatch,'authorized_unconfirmed');assert.equal(requests.length,1);
 assert.ok(requests.every(body=>!('dsh_session_log'in body)&&!('dsh_plugin_packages'in body)));
});
