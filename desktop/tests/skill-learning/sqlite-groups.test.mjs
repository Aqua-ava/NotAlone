import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

const packageA='aaaaaaaa-1111-4111-8111-000000000001',packageB='bbbbbbbb-1111-4111-8111-000000000002';
const contactA='cccccccc-1111-4111-8111-000000000001',contactB='dddddddd-1111-4111-8111-000000000002';
const skill=(packageId,name,title)=>({package_id:packageId,name,title,tags:['场景'],description:'用于合成表达',directory_name:name,enabled_state:'enabled',verification_state:'verified',
 verification_reason:null,head_revision:'1',current_revision_no:'1',state_label:'合成状态',
 revisions:[{revision_no:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),source_kind:'user_directory',verification_state:'verified',availability:'current'}]});

/** 内存后端：按真实 HTTP 合同回答分组请求，并记录请求体。 */
function fakeBackend(){
 const groups=[],calls=[];let counter=0,generation=1;
 const view=g=>({group_id:g.id,name:g.name,revision:String(g.revision),package_ids:[...g.packageIds].sort(),contact_ids:[...g.contactIds].sort()});
 const failure=code=>Object.assign(new Error('本机业务请求未完成'),{code});
 return {groups,calls,setGeneration:value=>{generation=value;},backend:{getConnectionGeneration:()=>generation,requestJson:async input=>{
  calls.push(structuredClone(input));
  if(input.method==='GET'&&input.path==='/api/skills')return {generation,data:{storage:'sqlite',mode:'minimal',skills:[skill(packageA,'gentle','温柔表达'),skill(packageB,'direct','直接表达')]}};
  if(input.method==='GET'&&input.path==='/api/skills/groups')return {generation,data:{storage:'sqlite',groups:groups.map(view)}};
  const body=input.body;assert.equal(body.confirmed,true);
  if(input.path==='/api/skills/groups'){
   if(groups.some(g=>g.name===body.name))throw failure('skill_group_name_conflict');
   const g={id:`eeeeeeee-1111-4111-8111-${String(++counter).padStart(12,'0')}`,name:body.name,revision:1,packageIds:body.package_ids,contactIds:[]};groups.push(g);
   return {generation,data:{group:view(g)}};
  }
  let match=/^\/api\/skills\/groups\/([^/]+)\/(update|delete)$/.exec(input.path);
  if(match){
   const g=groups.find(item=>item.id===match[1]);
   if(!g||String(g.revision)!==body.expected_revision)throw failure('skill_group_revision_conflict');
   if(match[2]==='delete'){groups.splice(groups.indexOf(g),1);return {generation,data:{deleted:true,group_id:g.id}};}
   g.name=body.name;g.packageIds=body.package_ids;g.revision++;return {generation,data:{group:view(g)}};
  }
  match=/^\/api\/skills\/contacts\/([^/]+)\/group$/.exec(input.path);
  assert.ok(match,input.path);
  const current=groups.find(g=>g.contactIds.includes(match[1]));
  if((current?.id??null)!==body.expected_group_id)throw failure('skill_group_assignment_conflict');
  if(current)current.contactIds=current.contactIds.filter(c=>c!==match[1]);
  if(body.group_id)groups.find(g=>g.id===body.group_id).contactIds.push(match[1]);
  return {generation,data:{contact_id:match[1],group_id:body.group_id}};
 }}};
}
async function controllerFor(t,backend){
 const dir=await mkdtemp(path.join(tmpdir(),'notalone-skill-groups-ui-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=path.join(dir,'controller.mjs');await build({entryPoints:['src/main/skill-learning/library.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SkillLibraryController}=await import(pathToFileURL(output).href);return new SkillLibraryController(backend);
}
const base={connectionGeneration:1,confirmed:true};

test('分组控制器只发送精确请求体，回执核对后重新读取，错误码映射为可操作提示',async t=>{
 const fake=fakeBackend(),controller=await controllerFor(t,fake.backend);
 assert.deepEqual(await controller.readGroups(),{connectionGeneration:1,groups:[]});
 const created=await controller.createGroup({...base,name:'恋人',packageIds:[packageA]});
 const group=created.groups[0];assert.equal(group.name,'恋人');assert.deepEqual(group.packageIds,[packageA]);
 assert.deepEqual(fake.calls.find(c=>c.method==='POST').body,{name:'恋人',package_ids:[packageA],confirmed:true});
 await assert.rejects(controller.createGroup({...base,name:'恋人',packageIds:[]}),/已有同名分组/);
 await assert.rejects(controller.updateGroup({...base,groupId:group.groupId,expectedRevision:'9',name:'恋人',packageIds:[]}),/已被其他操作改动/);
 await assert.rejects(controller.createGroup({...base,name:' 恋人 ',packageIds:[]}),/1–30 个字符/);
 await assert.rejects(controller.createGroup({...base,name:'x',packageIds:['not-a-uuid']}));
 await assert.rejects(controller.createGroup({...base,name:'x',packageIds:[],owner_id:'other'}));
 await assert.rejects(controller.createGroup({...base,confirmed:false,name:'x',packageIds:[]}));
 const assigned=await controller.assignContactGroup({...base,contactId:contactA.toUpperCase(),groupId:group.groupId,expectedGroupId:null});
 assert.deepEqual(assigned.groups[0].contactIds,[contactA]);
 await assert.rejects(controller.assignContactGroup({...base,contactId:contactA,groupId:null,expectedGroupId:null}),/已被其他操作改动/);
 const cleared=await controller.assignContactGroup({...base,contactId:contactA,groupId:null,expectedGroupId:group.groupId});
 assert.deepEqual(cleared.groups[0].contactIds,[]);
 fake.setGeneration(2);await assert.rejects(controller.deleteGroup({...base,groupId:group.groupId,expectedRevision:'1'}),/尚未核对/);
 fake.setGeneration(1);
 assert.deepEqual((await controller.deleteGroup({...base,groupId:group.groupId,expectedRevision:'1'})).groups,[]);
});

test('控制器拒绝一位联系人同时出现在多个分组的异常回执',async t=>{
 const fake=fakeBackend(),controller=await controllerFor(t,fake.backend);
 fake.groups.push({id:'eeeeeeee-1111-4111-8111-000000000001',name:'甲',revision:1,packageIds:[],contactIds:[contactA]},
  {id:'eeeeeeee-1111-4111-8111-000000000002',name:'乙',revision:1,packageIds:[],contactIds:[contactA]});
 await assert.rejects(controller.readGroups(),/尚未核对/);
});

test('联系人分组页：新建、选择回复场景、分配联系人与删除，未分组如实说明',{timeout:30000},async t=>{
 const fake=fakeBackend(),controller=await controllerFor(t,fake.backend);
 const browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:900}});
 await page.exposeFunction('libraryCommand',(method,...args)=>controller[method](...args));
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SkillLearningPage}from'./src/renderer/SkillLearningPage';
 const methods={readLibrary:'read',verifyLibrary:'verify',changeLibraryEnabled:'changeEnabled'};
 window.notalone={backend:{onStateChanged:()=>()=>{}},skillLearning:new Proxy({},{get:(_,key)=>(...args)=>window.libraryCommand(methods[key]??key,...args)})};
 const contacts=[{contactId:'${contactA}',displayName:'小林',messageCount:0,sourceCount:0},{contactId:'${contactB}',displayName:'同事老王',messageCount:0,sourceCount:0}];
 createRoot(document.getElementById('root')).render(<SkillLearningPage session={{state:{selectedContactId:null,scopeRevision:0,contacts}}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'empty'},write:false});
 await page.route('http://127.0.0.1/skill-groups',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await page.goto('http://127.0.0.1/skill-groups');await page.addScriptTag({content:compiled.outputFiles[0].text});
 await expect(page.getByRole('article',{name:'回复场景：温柔表达'})).toBeVisible();
 assert.equal(fake.calls.some(c=>c.path==='/api/skills/groups'),false,'未进入分组页时不读取分组');
 await page.getByRole('tab',{name:'联系人分组'}).click();
 await expect(page.getByText('还没有分组')).toBeVisible();
 await expect(page.getByLabel('「小林」所属分组')).toHaveValue('');
 await expect(page.getByLabel('「小林」所属分组').locator('option:checked')).toHaveText('未分组（不使用回复场景）');
 const create=page.getByRole('form',{name:'新建分组'});
 await create.getByLabel('分组名称').fill('恋人');await create.getByRole('button',{name:'新建分组'}).click();
 const lovers=page.getByRole('article',{name:'分组：恋人'});await expect(lovers).toBeVisible();await expect(lovers).toContainText('暂无联系人');
 await lovers.getByLabel('温柔表达').check();
 await lovers.getByRole('button',{name:'保存分组'}).click();
 await expect.poll(()=>fake.groups[0].packageIds).toEqual([packageA]);
 await expect(lovers.getByRole('button',{name:'保存分组'})).toBeDisabled();
 await create.getByLabel('分组名称').fill('同事');await create.getByRole('button',{name:'新建分组'}).click();
 await expect(page.getByRole('article',{name:'分组：同事'})).toBeVisible();
 await expect(page.getByLabel('「小林」所属分组').locator('option')).toHaveText(['未分组（不使用回复场景）','恋人','同事']);
 await page.getByLabel('「小林」所属分组').selectOption({label:'恋人'});
 await expect(page.getByRole('article',{name:'分组：恋人'})).toContainText('1 位联系人');
 assert.deepEqual(fake.groups.find(g=>g.name==='恋人').contactIds,[contactA]);
 await page.getByLabel('「小林」所属分组').selectOption({label:'同事'});
 await expect(page.getByRole('article',{name:'分组：恋人'})).toContainText('暂无联系人');
 await page.getByRole('article',{name:'分组：同事'}).getByRole('button',{name:'删除分组'}).click();
 await expect(page.getByText('将回到“未分组”')).toBeVisible();
 await page.getByRole('button',{name:'确认删除'}).click();
 await expect(page.getByRole('article',{name:'分组：同事'})).toHaveCount(0);
 await expect(page.getByLabel('「小林」所属分组')).toHaveValue('');
 await page.getByRole('tab',{name:'回复场景'}).click();
 await expect(page.getByRole('article',{name:'回复场景：温柔表达'})).toBeVisible();
});
