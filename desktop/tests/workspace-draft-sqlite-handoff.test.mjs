import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

const bundle=await build({stdin:{contents:`
 import React,{useState} from 'react';
 import {createRoot} from 'react-dom/client';
 import {AssistantWorkspaceDraft} from './src/renderer/AssistantWorkspaceDraft';
 import {ReplyCandidates} from './src/renderer/RewritePanel';
 const current='11111111-1111-4111-8111-111111111111',history='22222222-2222-4222-8222-222222222222';
 const requestId='33333333-3333-4333-8333-333333333333',candidateId='44444444-4444-4444-8444-444444444444';
 const listeners=new Set();
 window.fixture={commands:[],draftWrites:[],authorityDraft:'',sourceUnavailable:false};
 const bridge={onInvalidated:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
  candidates:{execute:async command=>{
   window.fixture.commands.push(command);
   if(command.action==='generate')return {session_id:command.sessionId,request_key:command.requestKey,segmented:false,replayed:false};
   if(command.action==='select')return {id:'55555555-5555-4555-8555-555555555555'};
   if(command.action!=='read')throw new Error('未安排的正常接口：'+command.action);
   return {requests:[{requestId,coverageWarning:null,sourceState:window.fixture.sourceUnavailable?'unavailable':'available',
    candidates:window.fixture.sourceUnavailable?[]:[{candidateId,versionNo:1,origin:'model',parentVersionNo:null,parts:['同联系人候选'],basis:[]}],selections:[],loadedSkills:[]}]};
  }}};
 window.notalone={sqliteDiscussion:bridge};
 function View(){
  const [phase,setPhase]=useState('ready'),[sessionId,setSessionId]=useState(current),[draft,setDraft]=useState('');
  window.fixture.authorityDraft=draft;
  const contacts={state:{selectedContactId:'contact-a',scopeRevision:1,draft},setDraft:async text=>{window.fixture.draftWrites.push(text);setDraft(text);}};
  const replies={state:{revision:1,contactId:'contact-a',scopeRevision:1,generationBlock:null,
   savedSession:{phase,sessionId,discussionEntries:[],runtimeRecovery:'none'},
   sessionCatalog:{phase:'ready',currentSessionId:current,selectionPending:false,items:[]}},
   readSavedSession:async()=>setPhase('loading'),listSavedSessions:async()=>{},newSavedSession:async()=>{},viewSavedSession:async()=>{}};
  return <><button onClick={()=>setPhase('loading')}>开始只读刷新</button>
   <button onClick={()=>setPhase('ready')}>完成讨论读取</button>
   <button onClick={()=>{setSessionId(history);setPhase('ready');}}>查看历史讨论</button>
   <button onClick={()=>{setSessionId(current);setPhase('ready');}}>返回当前讨论</button>
   <button onClick={()=>{for(const listener of listeners)listener();}}>来源变化通知</button>
   <button onClick={()=>{window.fixture.sourceUnavailable=true;}}>模拟来源失效</button>
   <AssistantWorkspaceDraft contacts={contacts} replies={replies}/>
   <ReplyCandidates replies={replies} currentDraft={draft} onDraftChange={text=>{void contacts.setDraft(text);}}/>
  </>;
 }
 createRoot(document.getElementById('root')).render(<View/>);
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,jsx:'automatic',loader:{'.css':'empty'}});

async function fixture(t){
 const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<div id="root"></div>');});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(5000);await page.goto(`http://127.0.0.1:${server.address().port}`);await page.addScriptTag({content:bundle.outputFiles[0].text});
 const draft=page.getByRole('textbox',{name:'有什么想说的',exact:true});await expect(draft).toBeEnabled();
 return {page,draft,authority:()=>page.evaluate(()=>window.fixture.authorityDraft)};
}

test('当前讨论只读刷新经过loading和ready，联系人独立草稿始终保留',async t=>{
 const f=await fixture(t);await f.draft.fill('当前会话尚未提交的独立想法');assert.equal(await f.authority(),'当前会话尚未提交的独立想法');
 await f.page.getByRole('button',{name:'开始只读刷新',exact:true}).click();await expect(f.draft).toHaveValue('当前会话尚未提交的独立想法');
 await f.draft.fill('等待读取时继续编辑的独立想法');await f.page.getByRole('button',{name:'完成讨论读取',exact:true}).click();
 await expect(f.draft).toHaveValue('等待读取时继续编辑的独立想法');assert.equal(await f.authority(),'等待读取时继续编辑的独立想法');
 assert.ok((await f.page.evaluate(()=>window.fixture.commands)).every(command=>command.action==='read'));
});

test('当前讨论切到历史再返回，不消费或回写当前联系人独立草稿',async t=>{
 const f=await fixture(t);await f.draft.fill('只属于当前联系人的未提交想法');
 const writes=await f.page.evaluate(()=>window.fixture.draftWrites.length);
 await f.page.getByRole('button',{name:'查看历史讨论',exact:true}).click();await expect(f.draft).toBeDisabled();await expect(f.draft).toHaveValue('');
 assert.equal(await f.authority(),'只属于当前联系人的未提交想法');assert.equal(await f.page.evaluate(()=>window.fixture.draftWrites.length),writes);
 await f.page.getByRole('button',{name:'返回当前讨论',exact:true}).click();await expect(f.draft).toBeEnabled();await expect(f.draft).toHaveValue('只属于当前联系人的未提交想法');
});

test('历史讨论来源通知只撤下派生内容，不清当前联系人独立草稿',async t=>{
 const f=await fixture(t);await f.draft.fill('历史失效时仍应保留的独立想法');await f.page.getByRole('button',{name:'查看历史讨论',exact:true}).click();
 const writes=await f.page.evaluate(()=>window.fixture.draftWrites.length);await f.page.getByRole('button',{name:'来源变化通知',exact:true}).click();
 await expect(f.page.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);assert.equal(await f.authority(),'历史失效时仍应保留的独立想法');
 assert.equal(await f.page.evaluate(()=>window.fixture.draftWrites.length),writes);
 await f.page.getByRole('button',{name:'返回当前讨论',exact:true}).click();await expect(f.draft).toHaveValue('历史失效时仍应保留的独立想法');
});

test('当前来源失效保留独立想法，同时撤下候选及旧携入',async t=>{
 const f=await fixture(t);await f.draft.fill('来源失效时保持的独立想法');await f.page.getByRole('button',{name:'以这个说法继续',exact:true}).click();
 await f.page.getByRole('button',{name:'模拟来源失效',exact:true}).click();await f.page.getByRole('button',{name:'刷新候选',exact:true}).click();
 await expect(f.draft).toHaveValue('来源失效时保持的独立想法');assert.equal(await f.authority(),'来源失效时保持的独立想法');
 await expect(f.page.getByRole('textbox',{name:'候选第1条',exact:true})).toHaveCount(0);await expect(f.page.getByRole('button',{name:'取消候选继续',exact:true})).toHaveCount(0);
});

test('只有当前输入实际提交成功才清联系人草稿',async t=>{
 const f=await fixture(t);await f.draft.fill('成功生成后才清空的独立想法');assert.equal(await f.authority(),'成功生成后才清空的独立想法');
 await f.page.getByRole('button',{name:'帮我表达',exact:true}).click();await expect(f.draft).toHaveValue('');assert.equal(await f.authority(),'');
 assert.equal((await f.page.evaluate(()=>window.fixture.commands)).filter(command=>command.action==='generate').length,1);
});
