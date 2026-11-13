import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

const ids={contact:'11111111-1111-4111-8111-111111111111',other:'22222222-2222-4222-8222-222222222222',session:'33333333-3333-4333-8333-333333333333',otherSession:'44444444-4444-4444-8444-444444444444',candidate:'55555555-5555-4555-8555-555555555555',request:'66666666-6666-4666-8666-666666666666',selection:'77777777-7777-4777-8777-777777777777',skill:'88888888-8888-4888-8888-888888888888',otherSkill:'99999999-9999-4999-8999-999999999999'};
const original=()=>({candidateId:ids.candidate,versionNo:1,origin:'model',parentVersionNo:null,parts:['合成候选第一条','合成候选第二条'],basis:[{itemNo:1,kind:'message',text:'同联系人实际输入依据',verification:'actual_input'}]});
const pageData=(version=original(),phase='complete')=>({requests:[{requestId:ids.request,coverageWarning:null,sourceState:'available',candidates:[version],selections:[],loadedSkills:[{packageId:ids.skill,revisionNo:1,relativePath:'SKILL.md',text:'本次实际加载的合成Skill正文'}]}],coverage:{phase}});
const receipt=(request,replayed=false)=>({session_id:request.sessionId,request_key:request.requestKey,segmented:false,replayed});

test('SQLite恢复原表达工作区，两种动作及背景和语气设置真实传给生成',{timeout:30000},async t=>{
 const f=await panel(t,async operation=>operation.action==='generate'?receipt(operation):pageData());
 const region=f.page.getByRole('region',{name:'表达工作区'});
 const draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('heading',{name:'有什么想说的？',exact:true})).toBeVisible();
 const express=region.getByRole('button',{name:'帮我表达',exact:true}),suggest=region.getByRole('button',{name:'帮我想想',exact:true});
 await expect(express).toBeDisabled();await expect(suggest).toBeEnabled();await suggest.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(1);
 assert.equal(f.commands.find(c=>c.action==='generate').workspace.action,'suggest');
 assert.equal(f.commands.find(c=>c.action==='generate').workspace.draftText,'');
 await region.getByText('最近聊天 · 查看／补充',{exact:true}).click();
 await region.getByRole('checkbox',{name:'参考最近聊天和相关关系资料',exact:true}).uncheck();
 await region.getByRole('textbox',{name:'补充聊天上下文',exact:true}).fill('对方：今天有些忙');
 await region.getByText('语气和本次要求',{exact:true}).click();
 await region.getByRole('combobox',{name:'本次语气',exact:true}).selectOption('concise');
 await region.getByRole('textbox',{name:'本次要求',exact:true}).fill('简短一些');
 await draft.fill('想问问下班了吗');await express.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(2);
 assert.deepEqual(f.commands.filter(c=>c.action==='generate')[1].workspace,{action:'express',draftText:'想问问下班了吗',tone:'concise',instruction:'简短一些',contextText:'对方：今天有些忙',includeRelationshipContext:false});
 await expect(draft).toHaveValue('');
});

test('最近聊天只读展示，刷新保留编辑且生成请求不再携带排除字段',{timeout:30000},async t=>{
 const message='99999999-9999-4999-8999-999999999999';
 const f=await panel(t,async operation=>operation.action==='generate'?receipt(operation):{...pageData(),recentMessages:[{messageId:message,sender:'contact',text:'本次可用的合成聊天',occurredAt:null,timePrecision:null,displayPosition:'1',ordering:'unknown'}]});
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('textbox',{name:'候选第1条',exact:true}).fill('尚未保存的候选编辑');
 await region.getByText('最近聊天 · 查看／补充',{exact:true}).click();
 await expect(region.getByRole('checkbox',{name:'使用消息：本次可用的合成聊天',exact:true})).toHaveCount(0);
 await expect(region.getByText(/取消勾选|已排除 \d+ 条消息/)).toHaveCount(0);
 await expect(region.getByText('本次可用的合成聊天',{exact:true})).toBeVisible();
 await expect(region.getByRole('button',{name:'以这个说法继续',exact:true})).toBeEnabled();
 await region.getByRole('button',{name:'刷新最近聊天',exact:true}).click();
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('尚未保存的候选编辑');
 await expect(region.getByText('本次可用的合成聊天',{exact:true})).toBeVisible();
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(1);
 assert.deepEqual(f.commands.find(c=>c.action==='generate').workspace,{action:'suggest',draftText:'',tone:'original',instruction:'',contextText:'',includeRelationshipContext:true});
 assert.equal(Object.hasOwn(f.commands.find(c=>c.action==='generate').workspace,'excludedMessageIds'),false);
});

test('关闭关系背景后撤销旧候选携入，生成不提交被后端禁止的组合',{timeout:30000},async t=>{
 const f=await panel(t,async operation=>operation.action==='generate'?receipt(operation):operation.action==='select'?{id:ids.selection}:pageData());
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();
 await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await region.getByText('最近聊天 · 查看／补充',{exact:true}).click();
 await region.getByRole('checkbox',{name:'参考最近聊天和相关关系资料',exact:true}).uncheck();
 await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
 await expect(region.getByRole('button',{name:'以这个说法继续',exact:true})).toBeDisabled();
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(1);
 assert.equal(f.commands.find(c=>c.action==='generate').carriedSelectionId,undefined);
 assert.equal(f.commands.find(c=>c.action==='generate').workspace.includeRelationshipContext,false);
});

test('暂时失去生成资格保留想法，结果未知只核对原请求且保留后来编辑',{timeout:30000},async t=>{
 let checks=0;
 const f=await panel(t,async operation=>{if(operation.action==='read')return pageData();if(operation.action==='status')return {requestKey:operation.requestKey,phase:++checks===1?'unknown':'committed',sent:true,errorCode:null,retryable:false,startedAt:1000,finishedAt:2000};throw new Error('候选结果尚未确认，请保留原请求重试核对。');});
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await draft.fill('原请求的想法');
 await f.page.evaluate(()=>window.__setDisabled(true));await expect(draft).toBeDisabled();
 await f.page.evaluate(()=>window.__setDisabled(false));await expect(draft).toBeEnabled();await expect(draft).toHaveValue('原请求的想法');
 await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toContainText('结果暂未确认');
 await expect(region.getByRole('button',{name:'帮我想想',exact:true})).toBeDisabled();
 await draft.fill('后来改写的新想法');await region.getByRole('button',{name:'核对原请求',exact:true}).click();
 await expect(region.getByText('已找到原请求保存的候选。',{exact:true})).toBeVisible();
 const generated=f.commands.filter(c=>c.action==='generate'),checked=f.commands.filter(c=>c.action==='status');assert.equal(generated.length,1);assert.equal(checked.length,2);assert.ok(checked.every(c=>c.requestKey===generated[0].requestKey));
 await expect(draft).toHaveValue('后来改写的新想法');
});

test('生成被拒且请求未落库时保留真实原因，重复核对不覆盖原错',{timeout:30000},async t=>{
 const reason='现有模型配置尚未就绪。';
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'not_found',sent:false,errorCode:null,retryable:false,startedAt:null,finishedAt:null};
  throw new Error(reason);
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText(reason);
 await region.getByRole('button',{name:'核对原请求',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText(reason);
 assert.equal(f.commands.filter(command=>command.action==='generate').length,1);
});

test('来源待核验错误保留中文原因并提供处理同步问题入口',{timeout:30000},async t=>{
 const reason='聊天来源待重新核验，请到联系人页处理同步问题。';
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'not_found',sent:false,errorCode:null,retryable:false,startedAt:null,finishedAt:null};
  throw new Error(reason);
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('textbox',{name:'有什么想说的',exact:true}).fill('来源失效时应撤下的合成草稿');
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText(reason);
 await expect(region.getByRole('textbox',{name:'有什么想说的',exact:true})).toHaveValue('');
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 await f.page.evaluate(()=>{window.__managerNextFails=true;});
 await region.getByRole('button',{name:'处理同步问题',exact:true}).click();
 await expect(region.getByText('同步设置暂未打开，请重试。',{exact:true})).toBeVisible();
 await expect(region.getByRole('alert')).toHaveText(reason);
 await region.getByRole('button',{name:'处理同步问题',exact:true}).click();
 assert.equal(await f.page.evaluate(()=>window.__managerOpened),1);
 assert.equal(f.commands.filter(command=>command.action==='generate').length,1);
 await f.page.evaluate(()=>window.__switch());
 await expect(region.getByRole('button',{name:'处理同步问题',exact:true})).toHaveCount(0);
});

test('已落库来源核验失败同样提供处理同步问题入口',{timeout:30000},async t=>{
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'discussion_source_unavailable',retryable:false,startedAt:1000,finishedAt:2000};
  throw new Error('聊天来源待重新核验，请到联系人页处理同步问题。');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText('聊天来源待重新核验，请到联系人页处理同步问题。');
 await expect(region.getByRole('button',{name:'处理同步问题',exact:true})).toBeVisible();
});

test('生成报错后已受理与结果未知状态仍显示原核对文案',{timeout:30000},async t=>{
 for(const [phase,sent,expected] of [['preparing',false,'原请求仍在处理，请稍后核对。'],['unknown',true,'模型请求已发出，结果暂未确认。请核对原请求。']]){
  const f=await panel(t,async operation=>{
   if(operation.action==='read')return pageData();
   if(operation.action==='status')return {requestKey:operation.requestKey,phase,sent,errorCode:null,retryable:false,startedAt:1000,finishedAt:null};
   throw new Error('候选结果尚未确认，请保留原请求重试核对。');
  });
  const region=f.page.getByRole('region',{name:'表达工作区'});
  await region.getByRole('button',{name:'帮我想想',exact:true}).click();
  await expect(region.getByRole('alert')).toHaveText(expected);
  await expect(region.getByRole('button',{name:'核对原请求',exact:true})).toBeVisible();
  assert.equal(f.commands.filter(command=>command.action==='generate').length,1);
 }
});

test('临时禁用再恢复保留候选编辑和展开依据，不重复读取候选',{timeout:30000},async t=>{
 const f=await panel(t,async()=>pageData()),region=f.page.getByRole('region',{name:'表达工作区'});
 const candidate=region.getByRole('textbox',{name:'候选第1条',exact:true});
 await expect(candidate).toHaveValue('合成候选第一条');await candidate.fill('尚未保存的合成编辑');
 await region.getByText('依据',{exact:true}).click();
 await f.page.evaluate(()=>window.__setDisabled(true));await expect(candidate).toBeDisabled();
 await expect(candidate).toHaveValue('尚未保存的合成编辑');
 await f.page.evaluate(()=>window.__setDisabled(false));await expect(candidate).toBeEnabled();
 await expect(candidate).toHaveValue('尚未保存的合成编辑');
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(c=>c.action==='read').length,1);
 assert.equal(f.commands.filter(c=>c.action==='edit').length,0);
});

test('助手面板取消删除确认与刷新目录不丢候选编辑，也不重读候选',{timeout:30000},async t=>{
 const f=await panel(t,async()=>pageData(),'',true),candidate=f.page.getByRole('textbox',{name:'候选第1条',exact:true});
 await expect(candidate).toHaveValue('合成候选第一条');await candidate.fill('取消确认后仍保留的编辑');
 await f.page.getByText('历史讨论',{exact:true}).click();
 await f.page.getByRole('button',{name:'删除正在查看的讨论',exact:true}).click();
 await expect(f.page.getByRole('group',{name:'确认删除助手讨论'})).toBeVisible();
 await expect(candidate).toBeDisabled();await expect(candidate).toHaveValue('取消确认后仍保留的编辑');
 await f.page.getByRole('button',{name:'取消删除',exact:true}).click();
 await expect(candidate).toBeEnabled();await expect(candidate).toHaveValue('取消确认后仍保留的编辑');
 await f.page.getByRole('button',{name:'刷新讨论列表',exact:true}).click();
 await expect(candidate).toBeDisabled();await expect(candidate).toHaveValue('取消确认后仍保留的编辑');
 await f.page.evaluate(()=>window.__finishCatalog());await expect(candidate).toBeEnabled();
 await expect(candidate).toHaveValue('取消确认后仍保留的编辑');
 assert.equal(f.commands.filter(c=>c.action==='read').length,1);
 assert.equal(f.commands.filter(c=>c.action==='edit').length,0);
});

test('候选首读在临时禁用中完成，恢复后可继续操作且不重复读取',{timeout:30000},async t=>{
 const release=Promise.withResolvers();t.after(()=>release.resolve(pageData()));
 const f=await panel(t,async operation=>operation.action==='read'?release.promise:original());
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await expect.poll(()=>f.commands.length).toBe(1);
 await f.page.evaluate(()=>window.__setDisabled(true));await expect(region.getByRole('button',{name:'刷新候选',exact:true})).toBeDisabled();
 release.resolve(pageData());await expect.poll(()=>f.page.evaluate(()=>window.__settled)).toBe(1);
 await f.page.evaluate(()=>window.__setDisabled(false));
 const candidate=region.getByRole('textbox',{name:'候选第1条',exact:true});await expect(candidate).toBeEnabled();
 await candidate.fill('首读完成后继续编辑');await expect(region.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
 assert.equal(f.commands.filter(c=>c.action==='read').length,1);
});

test('临时禁用期间真实来源失效仍立即撤下编辑及依据',{timeout:30000},async t=>{
 const f=await panel(t,async()=>pageData()),region=f.page.getByRole('region',{name:'表达工作区'});
 const candidate=region.getByRole('textbox',{name:'候选第1条',exact:true});
 await expect(candidate).toHaveValue('合成候选第一条');await candidate.fill('已失效的合成编辑');
 await f.page.evaluate(()=>window.__setDisabled(true));
 await expect(region.getByRole('button',{name:'刷新候选',exact:true})).toBeDisabled();
 await f.page.evaluate(()=>window.__invalidate());
 await expect(candidate).toHaveCount(0);assert.doesNotMatch(await region.textContent(),/已失效的合成编辑|同联系人实际输入依据/);
 assert.equal(f.commands.filter(c=>c.action==='read').length,1);
});

test('候选默认只展示本次载入的Skill名称及来源，正文按需展开且不混入候选依据',{timeout:30000},async t=>{
 let data={...pageData()};
 data.requests[0].coverageWarning='历史覆盖不完整：本次使用当前可用资料，可能缺少重要语境。';
 data.requests[0].loadedSkills=[
  {packageId:ids.skill,name:'合成安慰策略',title:'合成安慰场景标题',revisionNo:1,relativePath:'SKILL.md',text:'先回应感受。'},
  {packageId:ids.otherSkill,name:'合成边界策略',revisionNo:2,relativePath:'SKILL.md',text:'再说明边界。'},
  {packageId:ids.skill,name:'合成安慰策略',revisionNo:1,relativePath:'references/example.md',text:'辅助案例。'},
 ];
 data.requests[0].preloadedSkills=[
  {packageId:ids.skill,name:'合成安慰策略',revisionNo:1,origin:'auto_preload',catalogRevision:'[["skill","1"]]'},
  {packageId:ids.otherSkill,name:'合成边界策略',revisionNo:2,origin:'auto_preload',catalogRevision:'[["skill","1"]]'},
 ];
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toBeVisible();
 await expect(region.getByRole('combobox')).toHaveCount(0);
 await expect(region.getByText(/本次预加载的 Skill/)).toHaveCount(0);
 await expect(region.getByText(/历史覆盖不完整/)).toHaveCount(0);
 await expect(region.getByText('实际进入模型输入的 Skill 内容',{exact:true})).toHaveCount(0);
 await expect(region.getByText(/先回应感受。|再说明边界。|辅助案例。/)).toHaveCount(0);
 // 同一 Skill 的多个文件只显示一次，不显示修订号；有中文标题时优先显示标题，没有则回退包名。
 await expect(region.getByText('本次载入的 Skill：合成安慰场景标题（模型调用）、合成边界策略（模型调用）',{exact:true})).toBeVisible();
 data={...data,requests:[{...data.requests[0],loadedSkills:[],preloadedSkills:[],skillWarning:'回复策略暂不可用'}]};
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();
 await expect(region.getByText('回复策略暂不可用',{exact:true})).toBeVisible();
 await expect(region.getByText('本次未载入 Skill',{exact:true})).toBeVisible();
 await expect(region.getByText(/本次预加载的 Skill/)).toHaveCount(0);
 await expect(region.getByRole('group',{name:'实际进入模型输入的 Skill 内容'})).toHaveCount(0);
 await region.getByRole('textbox',{name:'候选第1条',exact:true}).fill('失效策略后的候选仍可编辑');
 await expect(region.getByRole('button',{name:'保存修改',exact:true})).toBeEnabled();
});

test('候选保留请求分页提示，刷新时不读取Skill正文',{timeout:30000},async t=>{
 const base=pageData(),metadata={packageId:ids.skill,name:'合成安慰策略',revisionNo:1,relativePath:'SKILL.md',origin:'auto_preload'};
 const data={...base,hasMoreRequests:true,requests:[{...base.requests[0],loadedSkills:[metadata]}]};
 const f=await panel(t,async operation=>{
  assert.equal(operation.action,'read');
  return data;
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(region.getByText('仅显示最近20次候选请求；更早记录未加载。',{exact:true})).toBeVisible();
 await expect(region.getByText('实际进入模型输入的 Skill 内容',{exact:true})).toHaveCount(0);
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();
 await expect.poll(()=>f.commands.filter(command=>command.action==='read').length).toBe(2);
 assert.equal(f.commands.filter(command=>command.action==='skills').length,0);
});

// 共享参考只读取其他资料与 Skill；聊天原文仅保留候选实际引用的部分。
const inputPage=(items,extra={})=>({items,nextOffset:null,total:items.length,recorded:true,...extra});
const referenceSummary=region=>region.locator('summary').filter({hasText:/^本次参考/});
async function openReferenceGroup(region,label){
 const summary=referenceSummary(region).locator('..').locator('summary').filter({hasText:new RegExp(`^${label}`)});
 await expect(summary).toBeVisible();
 if(!await summary.evaluate(element=>element.parentElement.open))await summary.click();
}

test('本次参考只展示其他资料与Skill，旧host消息也不重复为聊天列表',{timeout:30000},async t=>{
 const cited='（2026-11-07 13:38）对方：合成引用原文\n第二行原文';
 const other='（2026-11-07 13:39）我：未被这条候选引用的完整合成原文';
 const relation='合成关系资料正文',owner='合成本人资料正文',draft='本次想法/草稿：合成输入',document='合成已发布场景资料';
 const version={...original(),basis:[{itemNo:1,kind:'message',text:cited,verification:'actual_input'}]};
 const items=[{itemNo:1,kind:'message',text:cited},{itemNo:2,kind:'message',text:other},
  {itemNo:3,kind:'memory',scopeKind:'contact',qualification:'confirmed',text:relation},
  {itemNo:4,kind:'memory',scopeKind:'owner',qualification:'auto',text:owner},
  {itemNo:5,kind:'entry',workspaceItem:'draft',text:draft},{itemNo:6,kind:'document',scopeKind:'contact',qualification:'published',text:document}];
 const f=await panel(t,async operation=>operation.action==='inputs'?inputPage(items):pageData(version));
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(referenceSummary(region)).toHaveText('本次参考 · 资料与 Skill');
 assert.equal(f.commands.filter(command=>command.action==='inputs').length,0);
 await expect(region.getByText(other,{exact:true})).toHaveCount(0);
 await region.getByText('依据',{exact:true}).click();
 await expect(region.getByText(cited,{exact:true})).toBeVisible();
 await expect(region.getByText(/产生此模型版本的实际输入/)).toHaveCount(0);
 await expect(region.getByText(other,{exact:true})).toHaveCount(0);
 await referenceSummary(region).click();
 await expect.poll(()=>f.commands.filter(command=>command.action==='inputs').length).toBe(1);
 assert.deepEqual(f.commands.find(command=>command.action==='inputs'),{contactId:ids.contact,scopeRevision:1,sessionId:ids.session,action:'inputs',requestId:ids.request,offset:0});
 const shared=referenceSummary(region).locator('..');
 await expect(shared.locator('summary').filter({hasText:/^聊天原文/})).toHaveCount(0);
 await expect(shared.getByText(other,{exact:true})).toHaveCount(0);await expect(shared.getByText(cited,{exact:true})).toHaveCount(0);
 await expect(region.getByText(cited,{exact:true})).toHaveCount(1);
 await expect(shared.getByText('已显示 4 项参考资料',{exact:true})).toBeVisible();
 await openReferenceGroup(region,'关系资料');await expect(region.getByText(relation,{exact:true})).toBeVisible();await expect(region.getByText(document,{exact:true})).toBeVisible();
 await openReferenceGroup(region,'本人资料');await expect(region.getByText(owner,{exact:true})).toBeVisible();
 await openReferenceGroup(region,'本次输入与讨论');await expect(region.getByText(draft,{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(command=>command.action==='skills').length,0);
});

test('手改候选的继承依据只提示一次，聊天原文保留完整且不混Skill',{timeout:30000},async t=>{
 const version={...original(),versionNo:2,parentVersionNo:1,origin:'manual',basis:[
  {itemNo:1,kind:'message',text:'合成我方原文',verification:'inherited_unverified'},
  {itemNo:2,kind:'message',text:'合成对方原文',verification:'inherited_unverified'},
  {itemNo:3,kind:'memory',text:'合成继承的关系记忆',verification:'inherited_unverified'},
 ]};
 const f=await panel(t,async()=>pageData(version)),region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByText('依据',{exact:true}).click();
 await expect(region.getByText('继承原依据，手工修改尚未重新核验',{exact:true})).toHaveCount(1);
 await expect(region.getByText('合成我方原文',{exact:true})).toBeVisible();await expect(region.getByText('合成对方原文',{exact:true})).toBeVisible();
 await expect(region.getByText(/产生此模型版本的实际输入/)).toHaveCount(0);
 await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 assert.equal(f.commands.filter(command=>command.action==='inputs'||command.action==='skills').length,0);
});

test('Skill实际读取单独按需分页，输入翻页保留原文且重开重新核验',{timeout:30000},async t=>{
 const input1={itemNo:1,kind:'memory',scopeKind:'contact',text:'第一页的合成关系资料'},input2={itemNo:2,kind:'memory',scopeKind:'contact',text:'第二页的合成关系资料'};
 const skills=[{packageId:ids.skill,name:'合成方法',revisionNo:1,relativePath:'SKILL.md',text:'合成 Skill 正文'},
  {packageId:ids.skill,name:'合成方法',revisionNo:1,relativePath:'references/example.md',text:'合成 Skill 参考原文'}];
 const data=pageData();data.requests[0].loadedSkills=skills.map(({text,...metadata})=>metadata);
 const f=await panel(t,async operation=>{
  if(operation.action==='inputs')return operation.offset===0?inputPage([input1],{nextOffset:1,total:2}):inputPage([input2],{total:2});
  if(operation.action==='skills')return {items:[skills[operation.offset]],nextOffset:operation.offset===0?1:null,total:2};
  return data;
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await referenceSummary(region).click();await openReferenceGroup(region,'关系资料');
 await expect(region.getByText(input1.text,{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(command=>command.action==='skills').length,0);
 await region.getByRole('button',{name:'加载更多输入',exact:true}).click();
 await expect(region.getByText(input2.text,{exact:true})).toBeVisible();await expect(region.getByText(input1.text,{exact:true})).toBeVisible();
 await openReferenceGroup(region,'Skill · 实际读取');
 await region.locator('summary').filter({hasText:/^合成方法 · 第 1 版 · SKILL.md$/}).click();await expect(region.getByText(skills[0].text,{exact:true})).toBeVisible();
 await region.getByRole('button',{name:'加载更多 Skill',exact:true}).click();
 await region.locator('summary').filter({hasText:/^合成方法 · 第 1 版 · references\/example.md$/}).click();await expect(region.getByText(skills[1].text,{exact:true})).toBeVisible();
 assert.deepEqual(f.commands.filter(command=>command.action==='inputs').map(command=>command.offset),[0,1]);
 assert.deepEqual(f.commands.filter(command=>command.action==='skills').map(command=>command.offset),[0,1]);
 await referenceSummary(region).click();await expect(region.getByText(input1.text,{exact:true})).toHaveCount(0);
 await referenceSummary(region).click();await expect.poll(()=>f.commands.filter(command=>command.action==='inputs').length).toBe(3);
 assert.equal(f.commands.filter(command=>command.action==='skills').length,2);
});

test('权威快照刷新重置展开资料，临时禁用保留已核验参考且不重取',{timeout:30000},async t=>{
 const input={itemNo:1,kind:'memory',scopeKind:'contact',text:'刷新前已展开的合成关系资料'};
 const f=await panel(t,async operation=>operation.action==='inputs'?inputPage([input]):pageData());
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await referenceSummary(region).click();await openReferenceGroup(region,'关系资料');await expect(region.getByText(input.text,{exact:true})).toBeVisible();
 await f.page.evaluate(()=>window.__setDisabled(true));await expect(region.getByText(input.text,{exact:true})).toBeVisible();
 await f.page.evaluate(()=>window.__setDisabled(false));await expect(region.getByText(input.text,{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(command=>command.action==='inputs').length,1);
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();
 await expect(region.getByText(input.text,{exact:true})).toHaveCount(0);
 await expect(referenceSummary(region)).toBeVisible();
 assert.equal(await referenceSummary(region).evaluate(element=>element.parentElement.open),false);
 await referenceSummary(region).click();await openReferenceGroup(region,'关系资料');await expect(region.getByText(input.text,{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(command=>command.action==='inputs').length,2);
});

test('来源失效或换联系人后迟到实际输入不能恢复旧参考',{timeout:30000},async t=>{
 for(const boundary of ['invalidated','contact']){
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const input={itemNo:1,kind:'memory',scopeKind:'contact',text:`${boundary}之后不可恢复的合成关系资料`};
  const f=await panel(t,async operation=>{
   if(operation.action==='inputs'){entered.resolve();return release.promise;}
   if(operation.action==='read')return operation.contactId===ids.other?{requests:[],coverage:{phase:'complete'}}:pageData();
   throw new Error('未授权的合成参考操作');
  });
  const region=f.page.getByRole('region',{name:'表达工作区'});
  await referenceSummary(region).click();await entered.promise;
  await f.page.evaluate(value=>value==='invalidated'?window.__invalidate():window.__switch(),boundary);
  release.resolve(inputPage([input]));await f.page.waitForFunction(()=>window.__settled>=2);
  await expect(region.getByText(input.text,{exact:true})).toHaveCount(0);
  await expect(referenceSummary(region)).toHaveCount(0);
 }
});

test('来源失效后迟到Skill正文不能恢复，缺失实际输入记录保持未知',{timeout:30000},async t=>{
 const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const skill={packageId:ids.skill,name:'合成回复方法',revisionNo:1,relativePath:'SKILL.md',text:'失效后不可恢复的合成 Skill 正文'};
 const f=await panel(t,async operation=>{
  if(operation.action==='inputs')return inputPage([],{recorded:false});
  if(operation.action==='skills'){entered.resolve();return release.promise;}
  return pageData();
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await referenceSummary(region).click();
 await expect(region.getByText('这次实际输入记录缺失，无法还原参考资料。',{exact:true})).toBeVisible();
 await openReferenceGroup(region,'Skill · 实际读取');await entered.promise;
 await f.page.evaluate(()=>window.__invalidate());release.resolve({items:[skill],nextOffset:null,total:1});
 await f.page.waitForFunction(()=>window.__settled>=3);
 await expect(region.getByText(skill.text,{exact:true})).toHaveCount(0);await expect(referenceSummary(region)).toHaveCount(0);
});

test('实际输入报来源失效会撤下候选，并拒绝并行刷新候选的迟到旧快照',{timeout:30000},async t=>{
 const inputEntered=Promise.withResolvers(),inputResult=Promise.withResolvers(),readEntered=Promise.withResolvers(),readResult=Promise.withResolvers();
 let reads=0;
 const f=await panel(t,async operation=>{
  if(operation.action==='inputs'){inputEntered.resolve();return inputResult.promise;}
  if(operation.action==='read'){if(++reads===1)return pageData();readEntered.resolve();return readResult.promise;}
  throw new Error('未授权的合成并行操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),candidate=region.getByRole('textbox',{name:'候选第1条',exact:true});
 await expect(candidate).toHaveValue('合成候选第一条');
 await referenceSummary(region).click();await inputEntered.promise;
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();await readEntered.promise;
 inputResult.reject(new Error('来源已失效，请重新核验。'));
 await expect(candidate).toHaveCount(0);await expect(referenceSummary(region)).toHaveCount(0);
 readResult.resolve(pageData());await f.page.waitForFunction(()=>window.__settled>=3);
 await expect(candidate).toHaveCount(0);await expect(referenceSummary(region)).toHaveCount(0);
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);
});

test('真实样式下本次参考在窄宽窗口紧凑收起，资料区域限高且不重复聊天',{timeout:30000},async t=>{
 const items=Array.from({length:50},(_,index)=>({itemNo:index+1,kind:'memory',scopeKind:'contact',qualification:'auto',text:`第${index+1}项合成关系资料\n第二行保留资料原来的换行。https://example.invalid/${'long-synthetic-path-'.repeat(9)}`}));
 const version={...original(),parts:['这是用于布局验收的合成候选。']};
 const f=await panel(t,async operation=>operation.action==='inputs'?inputPage(items):pageData(version),'',false,true);
 const region=f.page.getByRole('region',{name:'表达工作区'}),summary=referenceSummary(region),reference=summary.locator('..');
 for(const width of [420,760]){
  await f.page.setViewportSize({width,height:960});
  await expect(summary).toBeVisible();
  const compact=await reference.boundingBox();assert.ok(compact.height<=56,`宽${width}时收起的本次参考高度为${compact.height}`);
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await summary.focus();await f.page.keyboard.press('Enter');await openReferenceGroup(region,'关系资料');
  await expect(reference.locator('summary').filter({hasText:/^聊天原文/})).toHaveCount(0);
  await expect(reference.locator('.candidate-reference-scroll').first()).toBeVisible();
  const scroll=await reference.locator('.candidate-reference-scroll').first().evaluate(element=>({height:element.getBoundingClientRect().height,scrollHeight:element.scrollHeight,clientHeight:element.clientHeight,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}));
  assert.ok(scroll.height<=260,`宽${width}时资料区域高度为${scroll.height}`);assert.ok(scroll.scrollHeight>scroll.clientHeight);assert.ok(scroll.scrollWidth<=scroll.clientWidth);
  t.diagnostic(`${width}px：收起 ${compact.height}px，资料区域 ${scroll.height}px，页面与资料区无横向溢出`);
  assert.equal(await f.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await summary.click();await expect(reference.locator('.candidate-reference-scroll')).toHaveCount(0);
 }
});

/** 仅IPC业务边界为显式替身；实际React、浏览器事件及渲染均执行。 */
async function panel(t,execute,initialDraft='',assistant=false,styled=false){
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SqliteReplyCandidatesPanel}from'./src/renderer/SqliteReplyCandidatesPanel';import{AssistantSessionPanel}from'./src/renderer/AssistantSessionPanel';
  const listeners=new Set();const bridge={candidates:{execute:request=>window.__execute(request).finally(()=>{window.__settled=(window.__settled||0)+1;})},onInvalidated:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const root=createRoot(document.getElementById('root'));let props={bridge,contactId:${JSON.stringify(ids.contact)},scopeRevision:1,sessionId:${JSON.stringify(ids.session)},initialDraft:${JSON.stringify(initialDraft)},onSubmitted:receipt=>window.__submitted(receipt)};
  window.notalone={sqliteDiscussion:bridge,openManager:async()=>{if(window.__managerNextFails){window.__managerNextFails=false;throw new Error('合成窗口失败');}window.__managerOpened=(window.__managerOpened||0)+1;}};
  let state={contactId:props.contactId,scopeRevision:props.scopeRevision,phase:'idle',generationBlock:null,generationJobs:[],exploration:{phase:'idle'},
    savedSession:{phase:'ready',sessionId:props.sessionId,turns:[],inputs:[],currentInputVersionId:null,discussionEntries:[],runtimeRecovery:'ready'},
    sessionCatalog:{phase:'ready',items:[{sessionId:props.sessionId,isCurrent:true}],currentSessionId:props.sessionId}};
  const replies={listSavedSessions:async()=>{state={...state,sessionCatalog:{...state.sessionCatalog,phase:'loading'}};render();await new Promise(resolve=>window.__finishCatalog=resolve);state={...state,sessionCatalog:{...state.sessionCatalog,phase:'ready'}};render();},
    readSavedSession:async()=>{},newSavedSession:async()=>{},deleteSavedSession:async()=>{},viewSavedSession:async()=>{},resumeSavedSession:async()=>{}};
  const render=()=>root.render(${assistant}?React.createElement(AssistantSessionPanel,{replies:{...replies,state}}):React.createElement(SqliteReplyCandidatesPanel,props));window.__invalidate=()=>{for(const listener of listeners)listener({revision:2,contactId:props.contactId,scopeRevision:props.scopeRevision});};
  window.__setDisabled=disabled=>{props={...props,disabled};render();};window.__switch=()=>{props={...props,contactId:${JSON.stringify(ids.other)},scopeRevision:2,sessionId:${JSON.stringify(ids.otherSession)}};render();};render();`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(styled?'<meta name="viewport" content="width=device-width, initial-scale=1"><div class="ime-pane"><main class="ime-workspace"><div id="root"></div></main></div>':'<div id="root"></div>');});server.listen(0,'127.0.0.1');await once(server,'listening');
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const page=await browser.newPage();page.setDefaultTimeout(5000);const commands=[],submitted=[];
 await page.exposeFunction('__execute',async request=>{commands.push(request);return execute(request,commands);});await page.exposeFunction('__submitted',value=>submitted.push(value));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 if(styled)for(const path of ['style.css','rewrite.css','helper-layout.css'])await page.addStyleTag({content:await readFile(new URL(`../src/renderer/${path}`,import.meta.url),'utf8')});
 await page.addScriptTag({content:compiled.outputFiles[0].text});
 return {page,commands,submitted};
}

test('候选页面读取真实版本结构、保存多条编辑稿并选择具体版本',{timeout:30000},async t=>{
 let version=original();const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData(version);
  if(operation.action==='edit'){version={...version,versionNo:2,parentVersionNo:1,origin:'manual',parts:operation.parts,basis:version.basis.map(b=>({...b,verification:'inherited_unverified'}))};return version;}
  if(operation.action==='version')return original();
  if(operation.action==='select')return {id:ids.selection,candidateId:operation.candidateId,versionNo:operation.versionNo,selectionNo:1};
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),first=region.getByRole('textbox',{name:'候选第1条',exact:true}),second=region.getByRole('textbox',{name:'候选第2条',exact:true});
 await expect(first).toHaveValue('合成候选第一条');await expect(second).toHaveValue('合成候选第二条');
 await expect(region.getByText('共2条，按顺序分别发送，不是备选',{exact:true})).toBeVisible();
 await expect(region.getByText('第1条（先发）')).toBeVisible();await expect(region.getByText('第2条（接着发）')).toBeVisible();
 await expect(region.getByText('本次载入的 Skill：未命名 Skill（模型调用）',{exact:true})).toBeVisible();
 await region.getByText('依据',{exact:true}).click();await expect(region.getByText('同联系人实际输入依据',{exact:true})).toBeVisible();await expect(region.getByText('实际进入模型输入的 Skill 内容',{exact:true})).toHaveCount(0);
 await first.fill('手工修改后的第一条');await second.fill('手工修改后的第二条');await region.getByRole('button',{name:'保存修改',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='edit').length).toBe(1);
 const edit=f.commands.find(c=>c.action==='edit');assert.equal(edit.candidateId,ids.candidate);assert.equal(edit.versionNo,1);assert.deepEqual(edit.parts,['手工修改后的第一条','手工修改后的第二条']);
 await expect(region.getByRole('status')).toContainText('未重新核验');
 await region.getByRole('button',{name:'选用这个说法',exact:true}).click();await expect.poll(()=>f.commands.filter(c=>c.action==='select').length).toBe(1);
 assert.equal(f.commands.find(c=>c.action==='select').versionNo,2);
 await region.getByRole('button',{name:'查看上一版',exact:true}).click();await expect(first).toHaveValue('合成候选第一条');await expect(second).toHaveValue('合成候选第二条');
 await region.getByRole('button',{name:'回到最新版本',exact:true}).click();await expect(first).toHaveValue('手工修改后的第一条');await expect(second).toHaveValue('手工修改后的第二条');
});

test('覆盖不完整可直接使用，明确未发送失败的新请求保留显式选稿',{timeout:30000},async t=>{
 let generated=0;const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData(original(),'incomplete');
  if(operation.action==='select')return {id:ids.selection,candidateId:operation.candidateId,versionNo:operation.versionNo,selectionNo:1};
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'discussion_generation_failed',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('候选结果尚未确认，请保留原请求重试核对。');return receipt(operation,true);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true}),generate=region.getByRole('button',{name:'帮我表达',exact:true});
 await expect(region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true})).toHaveCount(0);await draft.fill('合成本次表达要求');await expect(generate).toBeEnabled();assert.equal(generated,0);
 await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();await expect(region.getByRole('status')).toContainText('下一次明确请求');assert.equal(generated,0);
 await generate.click();await expect(region.getByRole('alert')).toContainText('尚未发给模型');await expect(draft).toHaveValue('合成本次表达要求');
 await region.getByRole('button',{name:'重新生成',exact:true}).click();await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests.length,2);assert.equal(requests[0].acceptIncomplete,false);assert.equal(requests[0].selectedPackageId,undefined);assert.equal(requests[1].selectedPackageId,undefined);assert.equal(requests[0].carriedSelectionId,ids.selection);assert.notEqual(requests[1].requestKey,requests[0].requestKey);assert.equal(requests[1].text,requests[0].text);assert.equal(requests[1].carriedSelectionId,ids.selection);
 await expect(draft).toHaveValue('');await expect(region.getByRole('checkbox',{name:'使用已同步部分继续',exact:true})).toHaveCount(0);
});

test('聊天读取恢复失败保留独立想法，撤下旧候选后可明确重试生成',{timeout:30000},async t=>{
 let generated=0;
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'reply_sources_not_ready',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('聊天读取暂未恢复，请重试生成。');return receipt(operation);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toBeVisible();
 await draft.fill('我自己写下的独立想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText('聊天读取暂未恢复，请重试生成。');
 await expect(draft).toHaveValue('我自己写下的独立想法');
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);
 await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 const retry=region.getByRole('button',{name:'重试生成',exact:true});await expect(retry).toBeEnabled();
 assert.equal(generated,1,'准备失败后不能自动另发生成请求');
 await retry.click();await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests.length,2);assert.notEqual(requests[0].requestKey,requests[1].requestKey);assert.equal(requests[1].text,'我自己写下的独立想法');assert.equal(requests[1].carriedSelectionId,undefined);
});

test('聊天读取恢复失败不保留旧选稿及其派生草稿，新生成不再携入旧稿',{timeout:30000},async t=>{
 let generated=0;
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='select')return {id:ids.selection};
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:false,errorCode:'reply_sources_not_ready',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('聊天读取暂未恢复，请重试生成。');return receipt(operation);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();
 await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await draft.fill('从旧选稿继续修改的想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText('聊天读取暂未恢复，请重试生成。');
 await expect(draft).toHaveValue('');await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
 await expect(region.getByRole('button',{name:'重试生成',exact:true})).toHaveCount(0);
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 await draft.fill('重新写下的独立想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests[0].carriedSelectionId,ids.selection);assert.equal(requests[1].carriedSelectionId,undefined);assert.equal(requests[1].text,'重新写下的独立想法');
});

test('模型请求已自动放弃时说明费用风险，重新生成使用新请求身份',{timeout:30000},async t=>{
 let generated=0;
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='status')return {requestKey:operation.requestKey,phase:'failed',sent:true,errorCode:'discussion_generation_timeout',retryable:true,startedAt:1000,finishedAt:2000};
  if(operation.action==='generate'){if(++generated===1)throw new Error('本次生成未完成。');return receipt(operation);}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await region.getByRole('textbox',{name:'有什么想说的',exact:true}).fill('放弃后仍保留的合成想法');
 await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect(region.getByRole('alert')).toHaveText('已发出但没有收到结果，已自动放弃；可重新生成，旧请求可能已产生费用。');
 const retry=region.getByRole('button',{name:'重新生成',exact:true});await expect(retry).toBeEnabled();
 await expect(region.getByRole('button',{name:'核对原请求',exact:true})).toHaveCount(0);
 assert.equal(generated,1,'自动放弃不能自动另发模型请求');
 await retry.click();await expect.poll(()=>f.submitted.length).toBe(1);
 const requests=f.commands.filter(c=>c.action==='generate');assert.equal(requests.length,2);assert.notEqual(requests[1].requestKey,requests[0].requestKey);
 assert.equal(requests[1].text,requests[0].text);assert.deepEqual(requests[1].workspace,requests[0].workspace);
 assert.equal(requests[1].contactId,ids.contact);assert.equal(requests[1].sessionId,ids.session);
});

test('已确认联系人在历史未开始或后台读取中均能直接生成',{timeout:30000},async t=>{
 let phase='not_started';
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData(original(),phase);
  if(operation.action==='generate')return receipt(operation);
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 for(const next of ['not_started','running','incomplete']){
  phase=next;await region.getByRole('button',{name:'刷新候选',exact:true}).click();
  await region.getByRole('textbox',{name:'有什么想说的',exact:true}).fill('合成本次表达');
  const generate=region.getByRole('button',{name:'帮我表达',exact:true});
  await expect(generate).toBeEnabled();await generate.click();
  await expect(region.getByRole('textbox',{name:'有什么想说的',exact:true})).toHaveValue('');
 }
 assert.equal(f.commands.filter(c=>c.action==='generate').length,3);
 assert.ok(f.commands.filter(c=>c.action==='generate').every(c=>c.acceptIncomplete===false));
 await expect(region.getByText(/完成后才能生成|使用已同步部分继续/)).toHaveCount(0);
});

test('来源失效立即移除草稿、候选、依据及Skill，迟到读取和生成均不能恢复旧快照',{timeout:30000},async t=>{
 let mode='ready';const readEntered=Promise.withResolvers(),lateRead=Promise.withResolvers(),generateEntered=Promise.withResolvers(),lateGenerate=Promise.withResolvers();
 const f=await panel(t,async operation=>{
  if(operation.action==='read'){if(mode==='late-read'){readEntered.resolve();return lateRead.promise;}return pageData();}
  if(operation.action==='generate'){generateEntered.resolve(operation);return lateGenerate.promise;}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 const assertCleared=async()=>{
  await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
  await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 };
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');await draft.fill('来源失效前的草稿');
 mode='late-read';await region.getByRole('button',{name:'刷新候选',exact:true}).click();await readEntered.promise;
 await f.page.evaluate(()=>window.__invalidate());await assertCleared();lateRead.resolve(pageData());await f.page.waitForFunction(()=>window.__settled===2);await assertCleared();
 mode='ready';await region.getByRole('button',{name:'刷新候选',exact:true}).click();await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');
 await draft.fill('生成期间失效的草稿');await region.getByRole('button',{name:'帮我表达',exact:true}).click();const pending=await generateEntered.promise;
 await f.page.evaluate(()=>window.__invalidate());await assertCleared();lateGenerate.resolve(receipt(pending));await f.page.waitForFunction(()=>window.__settled===4);await assertCleared();assert.equal(f.submitted.length,0);
 await expect(region.getByText('候选已保存，最终消息请自行发送。',{exact:true})).toHaveCount(0);
});

test('切换联系人撤下旧草稿与快照，旧读取迟到不能跨范围恢复',{timeout:30000},async t=>{
 let deferOld=false;const entered=Promise.withResolvers(),release=Promise.withResolvers();
 const f=await panel(t,async operation=>{
  if(operation.action==='read'){
   if(operation.contactId===ids.other)return {requests:[],coverage:{phase:'complete'}};
   if(deferOld){entered.resolve();return release.promise;}return pageData();
  }
  if(operation.action==='generate')return receipt(operation);
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveValue('合成候选第一条');await draft.fill('甲联系人草稿');
 deferOld=true;await region.getByRole('button',{name:'刷新候选',exact:true}).click();await entered.promise;await f.page.evaluate(()=>window.__switch());
 await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
 release.resolve(pageData());await f.page.waitForFunction(()=>window.__settled===3);
 await expect(region.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);await expect(region.getByText('本次实际加载的合成Skill正文',{exact:true})).toHaveCount(0);
 await draft.fill('乙联系人的本次想法');await region.getByRole('button',{name:'帮我表达',exact:true}).click();await expect.poll(()=>f.submitted.length).toBe(1);
 const generated=f.commands.find(c=>c.action==='generate');assert.equal(generated.contactId,ids.other);assert.equal(generated.scopeRevision,2);assert.equal(generated.sessionId,ids.otherSession);assert.equal(generated.text,'乙联系人的本次想法');assert.equal(generated.acceptIncomplete,false);assert.equal(generated.carriedSelectionId,undefined);
});

test('候选继续被后端判定失效时同时清草稿、旧携入及实际Skill快照',{timeout:30000},async t=>{
 let selected=0;const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData();
  if(operation.action==='select'){if(++selected===1)return {id:ids.selection};throw new Error('本次候选来源已失效，请重新读取。');}
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('button',{name:'以这个说法继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();
 await draft.fill('资格失效时必须清掉的合成草稿');await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();
 await expect(region.getByRole('alert')).toContainText('已失效');await expect(draft).toHaveValue('');await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);await expect(region.getByRole('combobox',{name:'本次回复Skill',exact:true})).toHaveCount(0);await expect(region.getByText('本次实际载入的 Skill',{exact:true})).toHaveCount(0);
});

test('权威读取发现已展示候选资格失效时清草稿与旧携入，不只移除候选列表',{timeout:30000},async t=>{
 let invalid=false;const f=await panel(t,async op=>{
  if(op.action==='select')return {id:ids.selection};
  if(op.action==='read')return invalid?{...pageData(),requests:[{...pageData().requests[0],sourceState:'unavailable',candidates:[],loadedSkills:[],selections:[]}]}:pageData();
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(region.getByRole('button',{name:'以这个说法继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();await draft.fill('后端已判失效时不应残留的草稿');invalid=true;
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();await expect(draft).toHaveValue('');await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);await expect(region.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);
});

test('短暂读取失败后权威读取确认来源失效，仍撤下旧选稿草稿与携入',{timeout:30000},async t=>{
 let reads=0;const f=await panel(t,async op=>{
  if(op.action==='select')return {id:ids.selection};
  if(op.action==='read'){
   if(++reads===1)return pageData();
   if(reads===2)throw new Error('候选结果尚未确认，请重新读取。');
   return {...pageData(),requests:[{...pageData().requests[0],sourceState:'unavailable',candidates:[],loadedSkills:[],selections:[]}]};
  }
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),draft=region.getByRole('textbox',{name:'有什么想说的',exact:true}),read=region.getByRole('button',{name:'刷新候选',exact:true});
 await expect(region.getByRole('button',{name:'以这个说法继续',exact:true})).toBeVisible();await region.getByRole('button',{name:'以这个说法继续',exact:true}).click();await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toBeVisible();await draft.fill('短暂读失败后仍挂旧选稿的合成草稿');
 await read.click();await expect(region.getByRole('alert')).toContainText('尚未确认');await expect(draft).toHaveValue('短暂读失败后仍挂旧选稿的合成草稿');
 await read.click();await expect(region.getByText('这次候选的来源已失效，正文与依据已撤下。',{exact:true})).toBeVisible();await expect(draft).toHaveValue('');await expect(region.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
});


test('首次会话带入已有想法并通过 SQLite 候选接口提交', {timeout:30000}, async t => {
 const f=await panel(t,async operation=>operation.action==='read'?pageData():receipt(operation),'合成的首次表达想法');
 const region=f.page.getByRole('region',{name:'表达工作区'}), draft=region.getByRole('textbox',{name:'有什么想说的',exact:true});
 await expect(draft).toHaveValue('合成的首次表达想法');
 await region.getByRole('button',{name:'帮我表达',exact:true}).click();
 await expect.poll(()=>f.submitted.length).toBe(1);
 const request=f.commands.find(command=>command.action==='generate');
 assert.equal(request.text,'合成的首次表达想法');assert.equal(request.contactId,ids.contact);assert.equal(request.sessionId,ids.session);
});


test('重读历史失败显示准备超时、资料服务中断与应用中断的具体原因',{timeout:30000},async t=>{
 const cases=[
  ['discussion_preparation_timeout',false,'整理资料超时，尚未发给模型。'],
  ['discussion_storage_interrupted',false,'本机资料服务在准备时中断，尚未发给模型。'],
  ['runtime_interrupted',false,'应用在整理资料时中断，尚未发给模型。'],
  ['runtime_interrupted',true,'已发出但没有收到结果，已自动放弃；可重新生成，旧请求可能已产生费用。'],
 ];
 const data={coverage:{phase:'complete'},requests:cases.map(([generationErrorCode,generationSent],index)=>({requestId:`${index+1}1111111-1111-4111-8111-111111111111`,generationState:'failed',generationErrorCode,generationSent,coverageWarning:null,sourceState:'unavailable',candidates:[],selections:[],loadedSkills:[]}))};
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(region.locator('details.sqlite-candidate-request')).toHaveCount(cases.length);
 for(let index=0;index<cases.length;index++){
  const request=region.locator('details.sqlite-candidate-request').nth(index);
  if(index<cases.length-1)await request.locator('summary').click();
  await expect(request.getByRole('status')).toHaveText(cases[index][2]);
 }
 await region.getByRole('button',{name:'刷新候选',exact:true}).click();
 await expect(region.locator('details.sqlite-candidate-request').last().getByRole('status')).toHaveText(cases.at(-1)[2]);
});

test('本轮进度独立于历史失败，轻量状态显示真实阶段且未发送失败可新请求重试',{timeout:30000},async t=>{
 let phase='preparing',calls=0;const gate=Promise.withResolvers();
 const f=await panel(t,async op=>{
  if(op.action==='read')return {requests:[{requestId:ids.request,generationState:'failed',coverageWarning:null,sourceState:'unavailable',candidates:[],selections:[],loadedSkills:[]}],coverage:{phase:'complete'}};
  if(op.action==='status')return {requestKey:op.requestKey,phase,sent:phase==='generating',errorCode:phase==='failed'?'discussion_preparation_timeout':null,retryable:phase==='failed',startedAt:1000,finishedAt:phase==='failed'?2000:null};
  if(op.action==='generate'){if(++calls===1)return gate.promise;return receipt(op);}
  throw new Error('未授权操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'});
 await expect(region.getByText('本次候选生成失败，没有可选正文。',{exact:true})).toBeVisible();
 await region.getByRole('button',{name:'帮我想想',exact:true}).click();
 await expect(region.getByText('正在整理本次资料…',{exact:true})).toBeVisible();
 await expect(region.getByText('本次候选生成失败，没有可选正文。',{exact:true})).toHaveCount(0);
 phase='generating';await expect(region.getByText('正在等待模型回复…',{exact:true})).toBeVisible();
 assert.equal(f.commands.filter(c=>c.action==='read').length,1,'进度核对不拉整页聊天与历史');
 phase='failed';gate.reject(new Error('合成运输失败'));
 await expect(region.getByRole('alert')).toContainText('尚未发给模型');
 await region.getByRole('button',{name:'重新生成',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='generate').length).toBe(2);
 const requests=f.commands.filter(c=>c.action==='generate');assert.notEqual(requests[0].requestKey,requests[1].requestKey);
});

test('状态核对失败不继续宣称正在整理，恢复后显示真实阶段且未知结果不能新请求重发',{timeout:30000},async t=>{
 let readable=false,phase='generating';const gate=Promise.withResolvers();
 const f=await panel(t,async op=>{
  if(op.action==='read')return pageData();
  if(op.action==='generate')return gate.promise;
  if(op.action==='status'){
   if(!readable)throw new Error('合成状态读取失败');
   return {requestKey:op.requestKey,phase,sent:true,errorCode:null,retryable:false,startedAt:1000,finishedAt:null};
  }
  throw new Error('未授权操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),generate=region.getByRole('button',{name:'帮我想想',exact:true});
 await generate.click();
 await expect(region.getByText('暂时无法核对本次进度，请保留原请求，勿重复生成。',{exact:true})).toBeVisible();
 await expect(region.getByText('正在整理本次资料…',{exact:true})).toHaveCount(0);await expect(generate).toBeDisabled();
 readable=true;await expect(region.getByText('正在等待模型回复…',{exact:true})).toBeVisible();
 phase='unknown';gate.reject(new Error('合成传输中断'));
 await expect(region.getByRole('alert')).toHaveText('模型请求已发出，结果暂未确认。请核对原请求。');
 await expect(generate).toBeDisabled();await region.getByRole('button',{name:'核对原请求',exact:true}).click();
 assert.equal(f.commands.filter(c=>c.action==='generate').length,1);
 const requestKey=f.commands.find(c=>c.action==='generate').requestKey;assert.ok(f.commands.filter(c=>c.action==='status').every(c=>c.requestKey===requestKey));
});

// —— 请求分段、说法命名与版本降噪（spec §6）——
const uid=n=>`${n.toString(16).padStart(8,'0')}-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const versionOf=(candidateId,parts=['合成说法正文'],extra={})=>({candidateId,versionNo:1,origin:'model',parentVersionNo:null,parts,basis:[{itemNo:1,kind:'message',text:'同联系人实际输入依据',verification:'actual_input'}],...extra});
const requestOf=(requestId,candidates=[],extra={})=>({requestId,coverageWarning:null,sourceState:'available',candidates,selections:[],loadedSkills:[],...extra});
const pageOf=(requests,extra={})=>({requests,coverage:{phase:'complete'},...extra});
const requestSection=(region,index)=>region.locator('details.sqlite-candidate-request').nth(index);
const requestSummary=request=>request.locator('summary').first();
const candidateInput=(request,index=1)=>request.locator(`textarea[aria-label="候选第${index}条"]`);

test('多个请求按倒数编号：仅最新一次展开，折叠内容保持挂载',{timeout:30000},async t=>{
 const olderId=uid(101),latestId=uid(102),olderCandidate=uid(201),latestCandidate=uid(202);
 const data=pageOf([
  requestOf(olderId,[versionOf(olderCandidate,['旧请求的说法正文'])],{selections:[{id:uid(301),candidateId:olderCandidate,versionNo:1,selectionNo:1}]}),
  requestOf(latestId,[versionOf(latestCandidate,['最新请求的说法正文'])]),
 ]);
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'}),sections=region.locator('details.sqlite-candidate-request');
 await expect.poll(()=>sections.count()).toBe(2);
 const older=requestSection(region,0),latest=requestSection(region,1),olderInput=candidateInput(older),latestInput=candidateInput(latest);
 await expect(requestSummary(older)).toHaveText('倒数第 2 次 · 1 个说法 · 已选用');
 await expect(requestSummary(latest)).toHaveText('最新一次 · 1 个说法');
 await expect(olderInput).toHaveCount(1);await expect(olderInput).toBeHidden();
 await expect(latestInput).toHaveCount(1);await expect(latestInput).toBeVisible();await expect(latestInput).toHaveValue('最新请求的说法正文');
 await expect(latest.getByRole('article',{name:'说法1',exact:true})).toBeVisible();
 await expect(latest.locator('h4')).toHaveText('说法 1');
 await expect(region.getByText(/候选第\d+组/)).toHaveCount(0);
 await requestSummary(older).click();
 await expect(olderInput).toBeVisible();await expect(olderInput).toHaveValue('旧请求的说法正文');
 await expect(older.getByText('已记录1次选稿，最近选用第1版。',{exact:true})).toBeVisible();
 await requestSummary(older).click();await expect(olderInput).toBeHidden();
 await requestSummary(latest).click();await expect(latestInput).toBeHidden();
 await requestSummary(latest).click();await expect(latestInput).toBeVisible();
});

test('hasMoreRequests 为真时请求标题仍按倒数计数',{timeout:30000},async t=>{
 const data=pageOf([
  requestOf(uid(111),[versionOf(uid(211),['第1条请求正文'])]),
  requestOf(uid(112),[versionOf(uid(212),['第2条请求正文'])]),
  requestOf(uid(113),[versionOf(uid(213),['第3条请求正文'])]),
 ],{hasMoreRequests:true});
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'}),sections=region.locator('details.sqlite-candidate-request');
 await expect(region.getByText('仅显示最近20次候选请求；更早记录未加载。',{exact:true})).toBeVisible();
 await expect.poll(()=>sections.count()).toBe(3);
 await expect(requestSummary(requestSection(region,0))).toHaveText('倒数第 3 次 · 1 个说法');
 await expect(requestSummary(requestSection(region,1))).toHaveText('倒数第 2 次 · 1 个说法');
 await expect(requestSummary(requestSection(region,2))).toHaveText('最新一次 · 1 个说法');
 await expect(candidateInput(requestSection(region,0))).toBeHidden();
 await expect(candidateInput(requestSection(region,1))).toBeHidden();
 await expect(candidateInput(requestSection(region,2))).toBeVisible();
});

test('保存修改后显示已修改且不显示版本号，回看旧版显示版本提示与回到最新版本',{timeout:30000},async t=>{
 let version=original();
 const f=await panel(t,async operation=>{
  if(operation.action==='read')return pageData(version);
  if(operation.action==='edit'){version={...version,versionNo:2,parentVersionNo:1,origin:'manual',parts:operation.parts,basis:version.basis.map(b=>({...b,verification:'inherited_unverified'}))};return version;}
  if(operation.action==='version')return original();
  throw new Error('未授权的合成页面操作');
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),heading=region.locator('h4'),candidate=region.locator('textarea[aria-label="候选第1条"]');
 await expect(heading).toHaveText('说法 1');
 await expect(heading).not.toContainText(/第\s*\d+\s*版/);
 await expect(region.locator('article')).toHaveAttribute('aria-label','说法1');
 await expect(candidate).toHaveValue('合成候选第一条');
 await candidate.fill('手工修改后的第一条');
 await region.getByRole('button',{name:'保存修改',exact:true}).click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='edit').length).toBe(1);
 await expect(heading).toHaveText('说法 1 · 已修改');
 await expect(heading).not.toContainText('第2版');await expect(heading).not.toContainText('第 2 版');
 await region.getByRole('button',{name:'查看上一版',exact:true}).click();
 await expect(candidate).toHaveValue('合成候选第一条');
 await expect(heading).toHaveText('说法 1 · 正在回看第 1 版（非最新）');
 const back=region.getByRole('button',{name:'回到最新版本',exact:true});
 await expect(back).toBeEnabled();
 await back.click();
 await expect(candidate).toHaveValue('手工修改后的第一条');
 await expect(heading).toHaveText('说法 1 · 已修改');
});

test('折叠的旧请求显示有未保存修改，展开后编辑仍在',{timeout:30000},async t=>{
 const olderId=uid(121),latestId=uid(122),olderCandidate=uid(221),latestCandidate=uid(222);
 const data=pageOf([
  requestOf(olderId,[versionOf(olderCandidate,['旧请求原正文'])],{selections:[{id:uid(321),candidateId:olderCandidate,versionNo:1,selectionNo:1}]}),
  requestOf(latestId,[versionOf(latestCandidate,['最新请求正文'])]),
 ]);
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'}),sections=region.locator('details.sqlite-candidate-request');
 await expect.poll(()=>sections.count()).toBe(2);
 const older=requestSection(region,0),input=candidateInput(older),summary=requestSummary(older);
 await expect(input).toBeHidden();
 await summary.click();await expect(input).toBeVisible();
 await input.fill('折叠期间保留的未保存编辑');
 await summary.click();
 await expect(input).toBeHidden();await expect(input).toHaveCount(1);
 await expect(summary).toHaveText('倒数第 2 次 · 1 个说法 · 已选用 · 有未保存修改');
 await summary.click();await expect(input).toBeVisible();await expect(input).toHaveValue('折叠期间保留的未保存编辑');
});

test('折叠最新项后刷新保持折叠，新增请求后原最新折叠且新最新展开',{timeout:30000},async t=>{
 const first=uid(131),second=uid(132),third=uid(133),c1=uid(231),c2=uid(232),c3=uid(233);
 const two=()=>pageOf([requestOf(first,[versionOf(c1,['第一条请求正文'])]),requestOf(second,[versionOf(c2,['第二条请求正文'])])]);
 let data=two();
 const f=await panel(t,async operation=>{
  if(operation.action!=='read')throw new Error('未授权的合成页面操作');
  return data;
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),refresh=region.getByRole('button',{name:'刷新候选',exact:true}),sections=region.locator('details.sqlite-candidate-request');
 await expect.poll(()=>sections.count()).toBe(2);
 const latestInput=candidateInput(requestSection(region,1)),olderInput=candidateInput(requestSection(region,0));
 await expect(latestInput).toBeVisible();
 await requestSummary(requestSection(region,1)).click();await expect(latestInput).toBeHidden();
 await requestSummary(requestSection(region,0)).click();await expect(olderInput).toBeVisible();
 await refresh.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='read').length).toBe(2);
 await expect(sections).toHaveCount(2);
 await expect(latestInput).toBeHidden();
 await expect(olderInput).toBeVisible();
 data=pageOf([first,second,third].map((requestId,index)=>requestOf(requestId,[versionOf([c1,c2,c3][index],[['第一条请求正文'],['第二条请求正文'],['第三条请求正文']][index])])));
 await refresh.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='read').length).toBe(3);
 await expect(sections).toHaveCount(3);
 await expect(requestSummary(requestSection(region,1))).toHaveText('倒数第 2 次 · 1 个说法');
 await expect(requestSummary(requestSection(region,2))).toHaveText('最新一次 · 1 个说法');
 await expect(candidateInput(requestSection(region,2))).toBeVisible();await expect(candidateInput(requestSection(region,2))).toHaveValue('第三条请求正文');
 await expect(candidateInput(requestSection(region,1))).toBeHidden();
});

// 未做任何手动切换时，刷新追加新请求必须自动折叠原最新项；程序化 open 变动不能被 onToggle 误记为手动覆盖。
test('未手动折叠时新增请求仍自动折叠原最新项，程序化展开不记为手动状态',{timeout:30000},async t=>{
 const first=uid(151),second=uid(152),third=uid(153),fourth=uid(154),c1=uid(251),c2=uid(252),c3=uid(253),c4=uid(254);
 const requestsPage=(requestIds,candidateIds,texts)=>pageOf(requestIds.map((requestId,index)=>requestOf(requestId,[versionOf(candidateIds[index],[texts[index]])])));
 let data=requestsPage([first,second],[c1,c2],['第一条请求正文','第二条请求正文']);
 const f=await panel(t,async operation=>{
  if(operation.action!=='read')throw new Error('未授权的合成页面操作');
  return data;
 });
 const region=f.page.getByRole('region',{name:'表达工作区'}),refresh=region.getByRole('button',{name:'刷新候选',exact:true}),sections=region.locator('details.sqlite-candidate-request');
 await expect.poll(()=>sections.count()).toBe(2);
 // 初始仅最新项默认展开，全程不做任何手动折叠/展开。
 await expect(candidateInput(requestSection(region,1))).toBeVisible();
 await expect(candidateInput(requestSection(region,0))).toBeHidden();
 data=requestsPage([first,second,third],[c1,c2,c3],['第一条请求正文','第二条请求正文','第三条请求正文']);
 await refresh.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='read').length).toBe(2);
 await expect(sections).toHaveCount(3);
 await expect(requestSummary(requestSection(region,1))).toHaveText('倒数第 2 次 · 1 个说法');
 await expect(requestSummary(requestSection(region,2))).toHaveText('最新一次 · 1 个说法');
 // 原最新项自动折叠且内容仍挂载；新最新项自动展开；从未展开过的更早请求保持折叠。
 await expect(candidateInput(requestSection(region,1))).toHaveCount(1);
 await expect(candidateInput(requestSection(region,1))).toBeHidden();
 await expect(candidateInput(requestSection(region,2))).toHaveCount(1);
 await expect(candidateInput(requestSection(region,2))).toBeVisible();
 await expect(candidateInput(requestSection(region,2))).toHaveValue('第三条请求正文');
 await expect(candidateInput(requestSection(region,0))).toBeHidden();
 // 再次追加：若上轮程序化 open 被 onToggle 误记为用户覆盖，第三条请求会错误地保持展开；这里应继续自动折叠。
 data=requestsPage([first,second,third,fourth],[c1,c2,c3,c4],['第一条请求正文','第二条请求正文','第三条请求正文','第四条请求正文']);
 await refresh.click();
 await expect.poll(()=>f.commands.filter(c=>c.action==='read').length).toBe(3);
 await expect(sections).toHaveCount(4);
 await expect(requestSummary(requestSection(region,2))).toHaveText('倒数第 2 次 · 1 个说法');
 await expect(requestSummary(requestSection(region,3))).toHaveText('最新一次 · 1 个说法');
 await expect(candidateInput(requestSection(region,2))).toBeHidden();
 await expect(candidateInput(requestSection(region,3))).toBeVisible();
 await expect(candidateInput(requestSection(region,3))).toHaveValue('第四条请求正文');
});

// 来源失效时读取契约已撤下正文（候选为空），这里只核对界面不再渲染正文与依据，不替代后端撤下证据。
test('失败、未知、生成中与来源失效请求的摘要后缀正确，失效请求按读取契约不渲染正文',{timeout:30000},async t=>{
 const data=pageOf([
  requestOf(uid(141),[],{generationState:'failed'}),
  requestOf(uid(142),[versionOf(uid(241),['未确认结果的合成正文'])],{generationState:'unknown'}),
  requestOf(uid(143),[],{generationState:'running'}),
  requestOf(uid(144),[versionOf(uid(244),['普通请求第一条']),versionOf(uid(245),['普通请求第二条'])]),
  requestOf(uid(145),[],{generationState:'invalidated',sourceState:'unavailable'}),
 ]);
 const f=await panel(t,async()=>data),region=f.page.getByRole('region',{name:'表达工作区'}),sections=region.locator('details.sqlite-candidate-request');
 await expect.poll(()=>sections.count()).toBe(5);
 await expect(requestSummary(requestSection(region,0))).toHaveText('倒数第 5 次 · 生成失败');
 await expect(requestSummary(requestSection(region,1))).toHaveText('倒数第 4 次 · 结果未确认');
 await expect(requestSummary(requestSection(region,2))).toHaveText('倒数第 3 次 · 生成中');
 await expect(requestSummary(requestSection(region,3))).toHaveText('倒数第 2 次 · 2 个说法');
 await expect(requestSummary(requestSection(region,4))).toHaveText('最新一次 · 来源已失效');
 const unavailable=requestSection(region,4);
 await expect(unavailable.locator('article')).toHaveCount(0);
 await expect(unavailable.locator('textarea')).toHaveCount(0);
 await expect(unavailable.getByText('同联系人实际输入依据',{exact:true})).toHaveCount(0);
 await expect(unavailable.getByText('这次候选的来源已失效，正文与依据已撤下。',{exact:true})).toBeVisible();
 await expect(requestSection(region,1).locator('article')).toHaveCount(1);
 await expect(requestSection(region,1).locator('article')).toBeHidden();
 await requestSummary(requestSection(region,1)).click();
 await expect(requestSection(region,1).getByRole('status')).toHaveText('本次模型调用结果暂未确认，请等待本机恢复处理。');
 await expect(region.getByText(/不能换身份重发/)).toHaveCount(0);
 await expect(requestSection(region,3).locator('article')).toHaveCount(2);
 await expect(candidateInput(requestSection(region,3)).first()).toBeHidden();
});
