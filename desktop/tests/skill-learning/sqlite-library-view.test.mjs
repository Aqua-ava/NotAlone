import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

test('Skill页自动核验更新并管理启停，不提供手动核验或添加目录入口',{timeout:20000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'notalone-skill-ui-14-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=path.join(dir,'controller.mjs');await build({entryPoints:['src/main/skill-learning/library.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SkillLibraryController}=await import(pathToFileURL(output).href);
 const make=(index,name,title,tags,enabled,verified)=>({package_id:`11111111-1111-4111-8111-${String(index).padStart(12,'0')}`,name,title,tags,description:'用于合成表达',directory_name:name,enabled_state:enabled,verification_state:verified,verification_reason:null,head_revision:'9007199254740993',current_revision_no:verified==='verified'?'1':null,
 state_label:'合成状态',revisions:[{revision_no:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),source_kind:'user_directory',verification_state:'verified',availability:verified==='verified'?'current':'unavailable'}]});
 const firstTitle='初次开聊：承接共同经历或已知兴趣';
 const items=[make(1,'gentle',firstTitle,['初识与重新开聊'],'unknown','verified'),make(2,'missing','轻量接话与延展话题',['接话与相互了解'],'enabled','missing'),make(3,'conflict','拒绝后维持日常往来',['拒绝、分手与复联'],'disabled','conflict'),make(4,'changed','商量长期关系与未来安排',['长期恋爱与婚前家庭'],'enabled','pending')],calls=[];
 let unavailable=false,holdRead=false,rejectHeldRead;
 const backend={getConnectionGeneration:()=>1,requestJson:async input=>{
  calls.push(input);if(input.method==='GET'){if(holdRead)return new Promise((_resolve,reject)=>{rejectHeldRead=reject;});if(unavailable)throw new Error('skill_owner_unavailable');assert.equal(input.path,'/api/skills');return {generation:1,data:{storage:'sqlite',mode:'minimal',skills:structuredClone(items)}};}
  let item;{const id=input.path.split('/')[3];item=items.find(i=>i.package_id===id);assert.equal(input.body.expected_head_revision,item.head_revision);item.head_revision=(BigInt(item.head_revision)+1n).toString();
   if(input.path.endsWith('/enable'))item.enabled_state='enabled';else if(input.path.endsWith('/disable'))item.enabled_state='disabled';else{item.verification_state='verified';item.current_revision_no='1';item.revisions[0].availability='current';}}
  return {generation:1,data:{skill:structuredClone(item)}};
 }};
 const controller=new SkillLibraryController(backend),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:850}});await page.exposeFunction('libraryCommand',(method,...args)=>controller[method](...args));
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SkillLearningPage}from'./src/renderer/SkillLearningPage';
 const methods={readLibrary:'read',verifyLibrary:'verify',changeLibraryEnabled:'changeEnabled'};
 window.failedLibraryCommands=0;window.notalone={backend:{onStateChanged:listener=>{window.libraryConnectionChanged=listener;return()=>{};}},skillLearning:new Proxy({},{get:(_,key)=>(...args)=>window.libraryCommand(methods[key]??key,...args).catch(error=>{window.failedLibraryCommands++;throw error;})})};
 createRoot(document.getElementById('root')).render(<SkillLearningPage session={{state:{selectedContactId:null,scopeRevision:0}}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'empty'},write:false});
 await page.route('http://127.0.0.1/skill-minimal',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/skill-minimal');await page.addScriptTag({content:compiled.outputFiles[0].text});
 const gentle=page.getByRole('article',{name:`回复场景：${firstTitle}`,exact:true});await expect(gentle).not.toContainText('目录已核验');
 await expect(gentle.getByRole('heading',{name:firstTitle,exact:true})).toBeVisible();
 await expect(page.getByRole('switch',{name:`启用「${firstTitle}」`})).toHaveAttribute('aria-checked','false');
 await expect(page.getByRole('button',{name:'重新核验',exact:true})).toHaveCount(0);
 await expect(page.getByRole('form',{name:'关联 Skill 目录'})).toHaveCount(0);await expect(page.getByLabel('包目录名称',{exact:true})).toHaveCount(0);
 const missing=page.getByRole('article',{name:'回复场景：轻量接话与延展话题',exact:true});
 const conflict=page.getByRole('article',{name:'回复场景：拒绝后维持日常往来',exact:true});
 const changed=page.getByRole('article',{name:'回复场景：商量长期关系与未来安排',exact:true});
 await expect(missing).toContainText('目录或文件缺失');
 await expect(conflict).toContainText('目录身份冲突');
 await expect(changed).toContainText('待核验');
 assert.equal(calls.filter(c=>c.method==='POST').length,0);
 await expect(page.getByRole('button',{name:'待审核',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/回滚|删除|经验整理/})).toHaveCount(0);
 await page.getByRole('button',{name:'接话与相互了解'}).click();
 await expect(missing).toBeVisible();await expect(gentle).toHaveCount(0);await expect(page.getByRole('article')).toHaveCount(1);
 await page.getByRole('button',{name:'全部'}).click();
 await page.getByRole('switch',{name:`启用「${firstTitle}」`}).click();await expect(gentle).toContainText('已开启');
 await expect(page.getByRole('switch',{name:`停用「${firstTitle}」`})).toHaveAttribute('aria-checked','true');
 assert.equal(calls.find(c=>c.method==='POST').body.expected_head_revision,'9007199254740993');
 await page.getByRole('switch',{name:`停用「${firstTitle}」`}).click();await expect(gentle).toContainText('已关闭');
 // 自动核验结果随列表读取返回，页面不再发送逐包 verify 请求。
 items[3].verification_state='verified';items[3].current_revision_no='1';items[3].revisions[0].availability='current';
 await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(changed).toContainText('已开启');await expect(changed.getByRole('status')).toHaveCount(0);
 assert.ok(!calls.some(c=>c.path.endsWith('/verify')));
 const discovered=make(5,'new-skill','新的合成回复场景',['接话与相互了解'],'unknown','pending');discovered.revisions=[];items.push(discovered);
 await page.getByRole('button',{name:'刷新状态',exact:true}).click();await expect(page.getByRole('article',{name:'回复场景：新的合成回复场景',exact:true})).toContainText('待核验');
 assert.ok(!calls.some(c=>c.path==='/api/skills/discover'));
 assert.ok(calls.every(c=>c.path.startsWith('/api/skills')));
 // 账号删除后读取拒绝，当前页面必须释放已显示的包资料，再允许显式重读。
 unavailable=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();
 await expect(page.getByRole('article')).toHaveCount(0);
 await expect(page.getByRole('alert')).toHaveText('Skill 状态暂不可用，请重新读取。');
 unavailable=false;await page.getByRole('button',{name:'重新读取 Skill 状态',exact:true}).click();
 await expect(gentle).toContainText('已关闭');
 // 旧页请求失败不能撤下连接变化后已重新读取的新快照。
 holdRead=true;await page.getByRole('button',{name:'刷新状态',exact:true}).click();
 await expect.poll(()=>typeof rejectHeldRead).toBe('function');holdRead=false;
 await page.evaluate(()=>window.libraryConnectionChanged({phase:'disconnected'}));
 await expect(page.getByRole('article')).toHaveCount(0);
 items[0].description='新连接的合成说明';
 await page.evaluate(()=>window.libraryConnectionChanged({phase:'connected'}));
 await expect(gentle).toContainText('新连接的合成说明');
 rejectHeldRead(new Error('old_connection_rejected'));
 await expect.poll(()=>page.evaluate(()=>window.failedLibraryCommands)).toBe(2);
 await expect(gentle).toContainText('新连接的合成说明');await expect(page.getByRole('alert')).toHaveCount(0);
});
