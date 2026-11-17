import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime,{defineTool} from '@deepseek-ai/dsh-tools';
import {createScope} from '@deepseek-ai/dsh-scope';
import {installRelationshipSearchTools,RELATIONSHIP_SEARCH_TOOLS} from '../src/reply/sqlite/search-tool.ts';
import {installReplySkillTools} from '../src/reply/sqlite/skill-loop.ts';
import {openSqliteSkillRun} from '../src/skills/sqlite/provider.ts';
import {fixture as candidateFixture} from './fixtures/sqlite-reply-candidates/support.mjs';

/** 直接使用官方scope与工具管线；搜索端口只返回合成资料，不启动模型或读取业务库。 */
async function scopedTools(t,{search,check=async()=>{},failed=()=>{},skillRun=null}={}){
 const root=new Context();await root.plugin(SystemPrompt);await root.plugin(ToolRuntime,{mode:'native'});
 // 本组只验证搜索错误分类；正式 Skill 加载由 profile/Skill loop 集成覆盖，此哨兵仅提供真实 restrict 所需的全局名称。
 if(skillRun)root.tools.register(defineTool({name:'skill',description:'合成Skill哨兵，不得实际执行',parameters:{name:{type:'string',required:true}},async execute(){assert.fail('搜索错误用例不应执行Skill加载');},output:{schema:{type:'object',additionalProperties:false,properties:{}},render:()=>[]}}));
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
 const schemas=f.ctx.tools.schemas(f.key);
 assert.match(schemas.find(tool=>tool.name==='search_relationship_memory').description,/身份.*偏好.*直接依据/);
 assert.match(schemas.find(tool=>tool.name==='search_relationship_history').description,/原话.*时间.*直接依据/);
 assert.deepEqual(f.ctx.tools.schemas(),[]);assert.deepEqual(f.ctx.tools.schemas(f.otherKey),[]);
 const result=await f.execute('search_relationship_memory',{query:' 合成夜班 '});
 assert.equal(result.isError,false);assert.match(result.content.map(block=>block.text).join(''),/已返回1条实际材料[\s\S]*实际输入材料\[7\] memory\n合成联系人本周轮夜班。/);
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

test('搜索超时回执明确尚未完成全部历史搜索，不冒充未命中',async t=>{
 const f=await scopedTools(t,{search:async()=>({status:'error',items:[],code:'reply_search_timeout'})});
 const result=await f.execute('search_relationship_history',{query:'合成约定'});
 assert.equal(result.isError,false);assert.match(result.content.map(block=>block.text).join(''),/超时.*未完成.*不能据此认定资料不存在/);
});

test('成功搜索保留已找到的事实，并把邻近语境与独立命中分开呈现',async t=>{
 const f=await scopedTools(t,{search:async()=>({status:'ok',items:[
  {itemNo:7,kind:'memory',text:'合成联系人从第三阶段开始研讨课。'},
  {itemNo:8,kind:'message',text:'对方：说的是工作室值班。',identity:{evidenceRole:'context',evidenceGroup:2,contextOf:'internal-message-id',contextPosition:'same_time'}},
 ]})});
 const result=await f.execute('search_relationship_history',{query:'研讨课安排'}),text=result.content.map(block=>block.text).join('');
 assert.match(text,/已返回2条实际材料/);
 assert.match(text,/已找到的事实.*仍缺失的信息/);
 assert.match(text,/只在basis引用.*不算完成核对/);
 assert.match(text,/实际输入材料\[7\] memory\n合成联系人从第三阶段开始研讨课。/);
 assert.match(text,/实际输入材料\[8\] message.*邻近语境/);
 assert.match(text,/本次工具返回的片段组2/);
 assert.match(text,/时间接近不代表同一话题/);assert.match(text,/先后顺序未核验/);
 assert.doesNotMatch(text,/internal-message-id/);
});

test('同组命中与语境按已知时间呈现，读取优先级不改变原引用编号',async t=>{
 const f=await scopedTools(t,{search:async()=>({status:'ok',items:[
  {itemNo:7,kind:'message',text:'对方：合成比例要求。',identity:{evidenceRole:'match',evidenceGroup:1,sentAt:2000n}},
  {itemNo:8,kind:'message',text:'对方：后续限定。',identity:{evidenceRole:'context',evidenceGroup:1,contextPosition:'after',sentAt:3000n}},
  {itemNo:9,kind:'message',text:'对方：前话所指的是工作室。',identity:{evidenceRole:'context',evidenceGroup:1,contextPosition:'before',sentAt:1000n}},
 ]})});
 const result=await f.execute('search_relationship_history',{query:'合成比例'}),text=result.content.map(block=>block.text).join('');
 assert.ok(text.indexOf('实际输入材料[9]')<text.indexOf('实际输入材料[7]'));
 assert.ok(text.indexOf('实际输入材料[7]')<text.indexOf('实际输入材料[8]'));
 assert.match(text,/有界取样不保证完整会话/);
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
 const skillRun=await openSqliteSkillRun(source.library,{contactId:source.ids[0],callId:randomUUID()},protection);
 t.after(()=>skillRun.close());
 const failure=Object.assign(new Error('合成来源失效'),{code:'reply_input_changed'}),failures=[];
 const f=await scopedTools(t,{skillRun,search:async()=>{throw failure;},failed:error=>failures.push(error)});
 const result=await f.execute('search_relationship_memory',{query:'合成查询'});
 assert.equal(result.isError,true);assert.deepEqual(failures,[failure]);assert.deepEqual(source.requests,[]);
});
