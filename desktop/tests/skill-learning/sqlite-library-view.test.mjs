import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

test('现有Skill页消费SQLite最小状态，明确发现/核验/启停且不发旧学习或回滚',{timeout:20000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'notalone-skill-ui-14-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=path.join(dir,'controller.mjs');await build({entryPoints:['src/main/skill-learning/library.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {SkillLibraryController}=await import(pathToFileURL(output).href);
 const make=(index,name,enabled,verified)=>({package_id:`11111111-1111-4111-8111-${String(index).padStart(12,'0')}`,name,description:'用于合成表达',directory_name:name,enabled_state:enabled,verification_state:verified,verification_reason:null,head_revision:'9007199254740993',current_revision_no:verified==='verified'?'1':null,
 state_label:'合成状态',revisions:[{revision_no:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),source_kind:'user_directory',verification_state:'verified',availability:verified==='verified'?'current':'unavailable'}]});
 const items=[make(1,'gentle','unknown','verified'),make(2,'missing','enabled','missing'),make(3,'conflict','disabled','conflict'),make(4,'changed','enabled','pending')],calls=[];
 let unavailable=false,holdRead=false,rejectHeldRead;
 const backend={getConnectionGeneration:()=>1,requestJson:async input=>{
  calls.push(input);if(input.method==='GET'){if(holdRead)return new Promise((_resolve,reject)=>{rejectHeldRead=reject;});if(unavailable)throw new Error('skill_owner_unavailable');assert.equal(input.path,'/api/skills');return {generation:1,data:{storage:'sqlite',mode:'minimal',skills:structuredClone(items)}};}
  let item;if(input.path==='/api/skills/discover'){item=make(5,input.body.directory_name,'unknown','verified');items.push(item);}else{const id=input.path.split('/')[3];item=items.find(i=>i.package_id===id);assert.equal(input.body.expected_head_revision,item.head_revision);item.head_revision=(BigInt(item.head_revision)+1n).toString();
   if(input.path.endsWith('/enable'))item.enabled_state='enabled';else if(input.path.endsWith('/disable'))item.enabled_state='disabled';else{item.verification_state='verified';item.current_revision_no='1';item.revisions[0].availability='current';}}
  return {generation:1,data:{skill:structuredClone(item)}};
 }};
 const controller=new SkillLibraryController(backend),browser=await chromium.launch({headless:true,channel:'chrome'});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1100,height:850}});await page.exposeFunction('libraryCommand',(method,...args)=>controller[method](...args));
 const compiled=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{SkillLearningPage}from'./src/renderer/SkillLearningPage';
 const methods={readLibrary:'read',discoverLibrary:'discover',verifyLibrary:'verify',changeLibraryEnabled:'changeEnabled'};
 window.failedLibraryCommands=0;window.notalone={backend:{onStateChanged:listener=>{window.libraryConnectionChanged=listener;return()=>{};}},skillLearning:new Proxy({},{get:(_,key)=>(...args)=>window.libraryCommand(methods[key]??key,...args).catch(error=>{window.failedLibraryCommands++;throw error;})})};
 createRoot(document.getElementById('root')).render(<SkillLearningPage session={{state:{selectedContactId:null,scopeRevision:0}}}/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',loader:{'.css':'empty'},write:false});
 await page.route('http://127.0.0.1/skill-minimal',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));await page.goto('http://127.0.0.1/skill-minimal');await page.addScriptTag({content:compiled.outputFiles[0].text});
 const gentle=page.getByRole('article',{name:'Skill gentle',exact:true});await expect(gentle).toContainText('待核验启停 · 目录已核验');
 await expect(page.getByRole('article',{name:'Skill missing',exact:true})).toContainText('已启用 · 目录或文件缺失');
 await expect(page.getByRole('article',{name:'Skill conflict',exact:true})).toContainText('已停用 · 目录身份冲突');
 await expect(page.getByRole('article',{name:'Skill changed',exact:true})).toContainText('待核验');
 assert.equal(calls.filter(c=>c.method==='POST').length,0);
 await expect(page.getByRole('button',{name:'待审核',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/回滚|删除|经验整理/})).toHaveCount(0);
 await gentle.getByRole('button',{name:'确认启用',exact:true}).click();await expect(gentle).toContainText('已启用 · 目录已核验');
 assert.equal(calls.find(c=>c.method==='POST').body.expected_head_revision,'9007199254740993');
 await gentle.getByRole('button',{name:'停用',exact:true}).click();await expect(gentle).toContainText('已停用 · 目录已核验');
 await page.getByRole('article',{name:'Skill changed',exact:true}).getByRole('button',{name:'重新核验',exact:true}).click();await expect(page.getByRole('article',{name:'Skill changed',exact:true})).toContainText('目录已核验');
 await page.getByLabel('包目录名称', {exact:true}).fill('new-skill');await expect(page.getByRole('button',{name:'核验并关联目录',exact:true})).toBeDisabled();
 await page.getByRole('checkbox',{name:'确认关联这个 Skill 目录',exact:true}).check();await page.getByRole('button',{name:'核验并关联目录',exact:true}).click();await expect(page.getByRole('article',{name:'Skill new-skill',exact:true})).toContainText('待核验启停');
 assert.ok(calls.every(c=>c.path.startsWith('/api/skills')));
 // 账号删除后读取拒绝，当前页面必须释放已显示的包资料，再允许显式重读。
 unavailable=true;await page.getByRole('button',{name:'刷新 Skill 状态',exact:true}).click();
 await expect(page.getByRole('article')).toHaveCount(0);
 await expect(page.getByRole('alert')).toHaveText('Skill 状态暂不可用，请重新读取。');
 unavailable=false;await page.getByRole('button',{name:'重新读取 Skill 状态',exact:true}).click();
 await expect(gentle).toContainText('已停用 · 目录已核验');
 // 旧页请求失败不能撤下连接变化后已重新读取的新快照。
 holdRead=true;await page.getByRole('button',{name:'刷新 Skill 状态',exact:true}).click();
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
