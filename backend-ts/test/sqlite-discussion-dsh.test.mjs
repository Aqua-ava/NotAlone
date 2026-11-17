import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, realpath, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import {SessionId} from '@deepseek-ai/dsh-session';
import Llm,{createUserMessage} from '@deepseek-ai/dsh-llm';
import {createDshRuntime} from '../src/reply/sqlite/dsh-runtime.ts';

test('真实官方非空会话flush和close后可重开核验事件边界，无模型调用',async t=>{
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-dsh-')));
 let shutdown=async()=>{};t.after(async()=>{await shutdown();await rm(home,{recursive:true,force:true});});
 const root=path.join(home,'copy');await mkdir(root,{mode:0o700});
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);
 let driver=await createDshRuntime(ctx,{root});shutdown=async()=>{await driver.close();await ctx.fiber.dispose();};
 const id=SessionId('synthetic-copy-a');
 const owned=await driver.createAgent({sessionId:id,agentOptions:{provider:'synthetic',model:'synthetic'}});
 owned.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'仅合成的助手讨论'}]}),{surfaceOp:'append'});
 await owned.dispose();
 const {boundary}=await driver.readHistory(id);
 assert.equal(boundary.formatVersion,4);assert.ok(boundary.eventCount>0);assert.match(boundary.eventSha256,/^[a-f0-9]{64}$/);
 await driver.close();
 driver=await createDshRuntime(ctx,{root});
 const history=await driver.readHistory(id);
 assert.deepEqual(history.boundary,boundary);
 assert.equal(history.events.find(event=>event.type==='user/message').data.content[0].text,'仅合成的助手讨论');
 await assert.rejects(driver.createAgent({sessionId:id,agentOptions:{provider:'synthetic',model:'synthetic'}}));
});

test('官方Agent真实dispose排空非空会话并可resume，恢复本身不发模型请求',async t=>{
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-agent-')));let shutdown=async()=>{};t.after(async()=>{await shutdown();await rm(home,{recursive:true,force:true});});
 const root=path.join(home,'copy');await mkdir(root,{mode:0o700});
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);
 const driver=await createDshRuntime(ctx,{root});shutdown=async()=>{await driver.close();await ctx.fiber.dispose();};
 const id=SessionId('synthetic-agent-a');let calls=0;
 ctx.on('llm/stream',()=>{calls++;throw new Error('禁止调用模型');});
 const first=await driver.createAgent({sessionId:id,agentOptions:{provider:'synthetic',model:'synthetic'}});
 first.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'只有本地合成发言'}]}),{surfaceOp:'append'});
 await first.dispose();
 const saved=await driver.readHistory(id);assert.ok(saved.boundary.eventCount>0);
 const resumed=await driver.resumeAgent({resumeSessionId:id,agentOptions:{provider:'synthetic',model:'synthetic'}});
 await resumed.dispose();assert.equal(calls,0);
 const restored=await driver.readHistory(id);
 assert.deepEqual(restored.events.slice(0,saved.events.length),saved.events);
 assert.ok(restored.boundary.eventCount>=saved.boundary.eventCount);
});

test('close等待真实末写并收紧本副本模式，关闭后拒绝迟到新操作',async t=>{
 const {lstat,readdir}=await import('node:fs/promises');
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-drain-')));let shutdown=async()=>{};t.after(async()=>{await shutdown();await rm(home,{recursive:true,force:true});});
 const root=path.join(home,'copy');await mkdir(root,{mode:0o700});
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);
 const driver=await createDshRuntime(ctx,{root});shutdown=async()=>{await driver.close();await ctx.fiber.dispose();};const id=SessionId('synthetic-last-write');
 const entered=Promise.withResolvers(),release=Promise.withResolvers();let closed=false;
 const pending=driver.createAgent({sessionId:id,agentOptions:{provider:'synthetic',model:'synthetic'},async setup(scope,agent){
  scope.effect(()=>()=>{agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'关闭过程中排空的最后合成发言'}]}),{surfaceOp:'append'});});
  entered.resolve();await release.promise;
 }});
 await entered.promise;const closing=driver.close().then(()=>{closed=true;});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
 release.resolve();await pending;await closing;
 await assert.rejects(driver.readHistory(id),{code:'discussion_runtime_unavailable'});
 async function verify(location){
  const info=await lstat(location);assert.equal(info.mode&0o777,info.isDirectory()?0o700:0o600);
  if(info.isDirectory())for(const entry of await readdir(location))await verify(path.join(location,entry));
 }
 await verify(root);
 const reopened=await createDshRuntime(ctx,{root});shutdown=async()=>{await reopened.close();await ctx.fiber.dispose();};const history=await reopened.readHistory(id);assert.equal(history.events.find(event=>event.type==='user/message').data.content[0].text,'关闭过程中排空的最后合成发言');
});

test('同定位根换身份后拒绝创建及关闭证明，不写入新目录',async t=>{
 const {rename,readdir}=await import('node:fs/promises');
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-identity-')));
 const root=path.join(home,'copy');await mkdir(root,{mode:0o700});
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);
 const driver=await createDshRuntime(ctx,{root});
 t.after(async()=>{await ctx.fiber.dispose();await rm(home,{recursive:true,force:true});});
 await rename(root,path.join(home,'old-copy'));await mkdir(root,{mode:0o700});
 await assert.rejects(driver.createAgent({sessionId:SessionId('replaced-root'),agentOptions:{provider:'synthetic',model:'synthetic'}}),{code:'discussion_runtime_unavailable'});
 assert.deepEqual(await readdir(root),[]);
 await assert.rejects(driver.close(),{code:'discussion_runtime_unavailable'});
});

test('driver关闭真实活动Agent，官方scope释放失败保持不可作为删除完成证明',async t=>{
 const home=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-discussion-dispose-failure-')));
 const root=path.join(home,'copy');await mkdir(root,{mode:0o700});
 const ctx=new Context();await ctx.plugin(Loader);await ctx.plugin(Llm);
 const driver=await createDshRuntime(ctx,{root});
 t.after(async()=>{await ctx.fiber.dispose().catch(()=>{});await rm(home,{recursive:true,force:true});});
 const owned=await driver.createAgent({sessionId:SessionId('synthetic-dispose-failure'),agentOptions:{provider:'synthetic',model:'synthetic'},setup(scope){
  scope.effect(()=>()=>{throw new Error('合成释放故障');});
 }});
 owned.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'有真实关闭所有者的合成记录'}]}),{surfaceOp:'append'});
 await assert.rejects(driver.close(),{code:'discussion_runtime_unavailable'});
 await assert.rejects(driver.close(),{code:'discussion_runtime_unavailable'});
});
