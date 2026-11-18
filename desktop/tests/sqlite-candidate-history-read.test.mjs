import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';
import { expect } from '@playwright/test';
import { launchChromium } from './helpers/browser.mjs';

const ids={contact:'11111111-1111-4111-8111-111111111111',history:'22222222-2222-4222-8222-222222222222',current:'33333333-3333-4333-8333-333333333333',request:'44444444-4444-4444-8444-444444444444',candidate:'55555555-5555-4555-8555-555555555555'};
const original={candidateId:ids.candidate,versionNo:1,origin:'model',parentVersionNo:null,parts:['合成历史候选原版'],basis:[]};
const edited={...original,versionNo:2,origin:'manual',parentVersionNo:1,parts:['用户保存的历史修改']};

test('历史讨论正常读取候选版本和实际输入，保留写操作门禁且不消费当前草稿',{timeout:30000},async t=>{
 const commands=[],sessionActions=[];
 const compiled=await build({stdin:{contents:`
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import {AssistantSessionPanel} from './src/renderer/AssistantSessionPanel';
  const ids=${JSON.stringify(ids)};
  const state={revision:1,scopeRevision:1,contactId:ids.contact,generationBlock:null,
   savedSession:{phase:'ready',sessionId:ids.history,discussionEntries:[],runtimeRecovery:'none'},
   sessionCatalog:{phase:'ready',selectionPending:false,currentSessionId:ids.current,items:[
    {sessionId:ids.current,isCurrent:true,lastUserActivityAt:'2026-11-17T00:00:00.000Z'},
    {sessionId:ids.history,isCurrent:false,lastUserActivityAt:'2026-11-16T00:00:00.000Z'}]}};
  window.__state=state;
  window.notalone={sqliteDiscussion:{candidates:{execute:command=>window.__execute(command)},onInvalidated:()=>()=>{}}};
  const action=name=>(...args)=>window.__sessionAction(name,args);
  createRoot(document.getElementById('root')).render(<AssistantSessionPanel initialDraft="当前联系人的独立草稿"
   onDraftChange={action('changeDraft')}
   replies={{state,viewSavedSession:action('view'),listSavedSessions:action('list'),newSavedSession:action('new'),
    resumeSavedSession:action('continue'),readSavedSession:action('read'),deleteSavedSession:action('delete')}}/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<div id="root"></div>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await launchChromium();t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(5000);
 await page.exposeFunction('__sessionAction',(name,args)=>{sessionActions.push({name,args});});
 await page.exposeFunction('__execute',command=>{
  commands.push(command);
  assert.equal(command.contactId,ids.contact);assert.equal(command.sessionId,ids.history);
  if(command.action==='read')return {requests:[{requestId:ids.request,coverageWarning:null,sourceState:'available',candidates:[edited],selections:[],loadedSkills:[]}]};
  if(command.action==='version'){assert.equal(command.versionNo,1);return original;}
  if(command.action==='inputs')return {recorded:true,total:1,nextOffset:null,items:[{itemNo:1,kind:'entry',workspaceItem:'instruction',text:'本次一次性写作要求：简短一些，不增加承诺'}]};
  throw new Error(`历史回看不应执行${command.action}`);
 });
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:compiled.outputFiles[0].text});
 const workspace=page.getByRole('region',{name:'表达工作区'}),candidate=workspace.getByRole('textbox',{name:'候选第1条',exact:true});
 await expect(candidate).toHaveValue('用户保存的历史修改');
 assert.equal(await candidate.evaluate(element=>element.readOnly),true);await expect(candidate).toBeEnabled();
 await expect(workspace.getByRole('textbox',{name:'有什么想说的',exact:true})).toHaveValue('');
 for(const name of ['帮我表达','帮我想想','保存修改','选用这个说法','以这个说法继续'])await expect(workspace.getByRole('button',{name,exact:true})).toBeDisabled();
 await workspace.getByRole('button',{name:'查看上一版',exact:true}).click();await expect(candidate).toHaveValue('合成历史候选原版');
 await workspace.locator('.candidate-references > summary').click();
 await workspace.locator('.candidate-reference-group > summary').filter({hasText:'本次输入与讨论'}).click();
 await expect(workspace.getByText('本次一次性写作要求：简短一些，不增加承诺',{exact:true})).toBeVisible();
 await workspace.getByRole('button',{name:'回到最新版本',exact:true}).click();await expect(candidate).toHaveValue('用户保存的历史修改');
 assert.deepEqual(commands.map(command=>command.action),['read','version','inputs']);
 assert.deepEqual(sessionActions,[]);assert.equal(await page.evaluate(()=>window.__state.sessionCatalog.currentSessionId),ids.current);
});
