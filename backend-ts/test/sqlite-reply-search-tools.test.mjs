import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import {createScope} from '@deepseek-ai/dsh-scope';
import {installRelationshipSearchTools,RELATIONSHIP_SEARCH_TOOLS} from '../src/reply/sqlite/search-tool.ts';
import {installReplySkillTools} from '../src/reply/sqlite/skill-loop.ts';
import {openSqliteSkillRun} from '../src/skills/sqlite/provider.ts';
import {fixture as candidateFixture} from './fixtures/sqlite-reply-candidates/support.mjs';

/** 直接使用官方scope与工具管线；搜索端口只返回合成资料，不启动模型或读取业务库。 */
async function scopedTools(t,{search,check=async()=>{},failed=()=>{},skillRun=null}={}){
 const root=new Context();await root.plugin(SystemPrompt);await root.plugin(ToolRuntime,{mode:'native'});
 let ctx;await root.plugin({name:'synthetic-search-tools',inject:['tools'],apply(current){ctx=current;}});
 const key={},scope=createScope(ctx,key),otherKey={},other=createScope(ctx,otherKey);
 t.after(async()=>{await other.dispose();await scope.dispose();await root.fiber.dispose();});
 installReplySkillTools(scope.ctx,skillRun,check,failed,false,RELATIONSHIP_SEARCH_TOOLS);
 installRelationshipSearchTools(scope.ctx,search,check,failed);
 return {ctx,key,scope,otherKey,execute:(name,args,signal=new AbortController().signal,agent=key)=>ctx.tools.execute({callId:randomUUID(),name,arguments:args,agent,signal})};
}

test('按需检索工具只在当前官方scope可见，返回可引用的真实材料编号',async t=>{
 const f=await scopedTools(t,{search:async(kind,query,signal)=>{
  assert.equal(kind,'memory');assert.equal(query,'合成夜班');assert.ok(signal instanceof AbortSignal);
  return {status:'ok',items:[{itemNo:7,kind:'memory',text:'合成联系人本周轮夜班。'}]};
 }});
 assert.deepEqual(f.ctx.tools.schemas(f.key).map(tool=>tool.name).sort(),['search_relationship_history','search_relationship_memory']);
 assert.deepEqual(f.ctx.tools.schemas(),[]);assert.deepEqual(f.ctx.tools.schemas(f.otherKey),[]);
 const result=await f.execute('search_relationship_memory',{query:' 合成夜班 '});
 assert.equal(result.isError,false);assert.deepEqual(result.content,[{type:'text',text:'实际输入材料[7] memory\n合成联系人本周轮夜班。'}]);
 assert.equal((await f.execute('search_relationship_memory',{query:'合成夜班'},undefined,f.otherKey)).isError,true);
 await f.scope.dispose();assert.deepEqual(f.ctx.tools.schemas(f.key),[]);
});

test('未命中、拒绝、耗尽和能力错误返回区分的无正文回执，未命中保持未知',async t=>{
 let status='empty';const failures=[];
 const f=await scopedTools(t,{failed:error=>failures.push(error),search:async kind=>{
  assert.equal(kind,'history');return {status,items:[],code:'synthetic-private-code',scope:'synthetic-private-scope'};
 }});
 const receipts=[];
 for(const [state,expected] of [['empty',/未命中.*不代表.*不存在/],['rejected',/拒绝/],['exhausted',/预算.*耗尽/],['error',/能力.*不可用/]]){
  status=state;const result=await f.execute('search_relationship_history',{query:'合成查询'});
  assert.equal(result.isError,false);const text=result.content.map(block=>block.text).join('');receipts.push(text);
  assert.match(text,expected);assert.doesNotMatch(text,/synthetic-private|实际输入材料\[/);
 }
 assert.equal(new Set(receipts).size,4);assert.deepEqual(failures,[]);
});

test('查询只接受非空且最多400个Unicode字符的query，不接收身份或范围参数',async t=>{
 const searches=[],failures=[];
 const f=await scopedTools(t,{failed:error=>failures.push(error),search:async(_kind,query)=>{searches.push(query);return {status:'empty',items:[]};}});
 for(const args of [{query:' \n '},{query:'🙂'.repeat(401)},{query:'合成查询',contactId:'other-contact'}]){
  const result=await f.execute('search_relationship_memory',args);
  assert.ok(result.isError||result.content.some(block=>/拒绝/.test(block.text)));
 }
 assert.deepEqual(searches,[]);assert.deepEqual(failures,[]);
 assert.equal((await f.execute('search_relationship_memory',{query:'🙂'.repeat(400)})).isError,false);
 assert.equal(searches.length,1);assert.equal([...searches[0]].length,400);
});

test('资格检查期间取消后不开始搜索，也不返回迟到材料',async t=>{
 const controller=new AbortController(),reason=new Error('合成取消'),failures=[];let searched=false;
 const f=await scopedTools(t,{check:async()=>{controller.abort(reason);},failed:error=>failures.push(error),search:async()=>{
  searched=true;return {status:'ok',items:[{itemNo:8,kind:'message',text:'取消后不得出现的合成正文'}]};
 }});
 const result=await f.execute('search_relationship_history',{query:'合成查询'},controller.signal);
 assert.equal(result.isError,true);assert.equal(searched,false);assert.deepEqual(failures,[reason]);
 assert.doesNotMatch(JSON.stringify(result.content),/取消后不得出现的合成正文/);
});

test('搜索中取消会等待工具排空并丢弃迟到正文',async t=>{
 const entered=Promise.withResolvers(),released=Promise.withResolvers(),controller=new AbortController(),reason=new Error('合成在途取消'),failures=[];
 const f=await scopedTools(t,{failed:error=>failures.push(error),search:async(_kind,_query,signal)=>{
  entered.resolve(signal);await released.promise;return {status:'ok',items:[{itemNo:9,kind:'message',text:'在途取消后的合成正文'}]};
 }});
 const pending=f.execute('search_relationship_history',{query:'合成查询'},controller.signal);
 const signal=await entered.promise;controller.abort(reason);assert.equal(signal.aborted,true);
 released.resolve();const result=await pending;
 assert.equal(result.isError,true);assert.deepEqual(failures,[reason]);assert.doesNotMatch(JSON.stringify(result.content),/在途取消后的合成正文/);
});

test('返回前来源资格改变时拒绝检索正文并报告原始致命失败',async t=>{
 let checks=0;const reason=Object.assign(new Error('合成来源已删除'),{code:'reply_input_changed'}),failures=[];
 const f=await scopedTools(t,{check:async()=>{if(++checks===2)throw reason;},failed:error=>failures.push(error),search:async()=>({status:'ok',items:[{itemNo:10,kind:'memory',text:'失效来源的合成正文'}]})});
 const result=await f.execute('search_relationship_memory',{query:'合成查询'});
 assert.equal(result.isError,true);assert.deepEqual(failures,[reason]);assert.doesNotMatch(JSON.stringify(result.content),/失效来源的合成正文/);
});

test('存储返回预算拒绝时保留耗尽回执',async t=>{
 const f=await scopedTools(t,{search:async()=>({status:'rejected',items:[],code:'reply_search_budget_exceeded'})});
 const result=await f.execute('search_relationship_history',{query:'合成查询'});
 assert.equal(result.isError,false);assert.match(result.content[0].text,/预算.*耗尽/);
});

test('检索来源失败保持致命错误，启用Skill时不误报Skill失败或触发降级',async t=>{
 const source=await candidateFixture(t,{providerTransport:'in-process',synchronizeHistory:false});
 await mkdir(join(source.skillRoot,'gentle'));
 await writeFile(join(source.skillRoot,'gentle/SKILL.md'),'---\nname: gentle\ndescription: 合成策略\n---\n保持原意。\n');
 let item=await source.library.discover('gentle');item=await source.library.setEnabled(item.id,item.headRevision,'enabled');
 const protection={assertCurrent:async()=>{},recordSelection:async()=>{},recordInput:async()=>{}};
 const skillRun=await openSqliteSkillRun(source.library,{contactId:source.ids[0],callId:randomUUID()},protection,{selectedPackageId:item.id});
 t.after(()=>skillRun.close());
 const failure=Object.assign(new Error('合成来源失效'),{code:'reply_input_changed'}),failures=[];
 const f=await scopedTools(t,{skillRun,search:async()=>{throw failure;},failed:error=>failures.push(error)});
 const result=await f.execute('search_relationship_memory',{query:'合成查询'});
 assert.equal(result.isError,true);assert.deepEqual(failures,[failure]);assert.deepEqual(source.requests,[]);
});
