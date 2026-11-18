import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import { launchChromium } from './helpers/browser.mjs';

const names=['backend','startup','foreground','bindings','session'];
async function withStates(t,inspect){
 const compiled=await build({stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`
  import React from 'react';import {createRoot} from 'react-dom/client';
  import {useBackendState} from './src/renderer/backend-status';
  import {useStartupState} from './src/renderer/StartupSettings';
  import {useForegroundState} from './src/renderer/ForegroundPanel';
  import {useBindingConsent} from './src/renderer/use-binding-consent';
  import {useRevisionedSession} from './src/renderer/use-revisioned-session';
  const names=['backend','startup','foreground','bindings','session'];
  const listeners=Object.fromEntries(names.map(name=>[name,new Set()]));
  window.reads=Object.fromEntries(names.map(name=>[name,[]]));
  const bridges=Object.fromEntries(names.map(name=>[name,{
    getState:()=>new Promise((resolve,reject)=>window.reads[name].push({resolve,reject})),
    onStateChanged:listener=>{listeners[name].add(listener);return()=>listeners[name].delete(listener);},
  }]));
  window.notalone=bridges;
  const values={backend:{phase:'connected'},startup:{phase:'ready',helperWarnings:[]},foreground:{phase:'confirmed'},
    bindings:{phase:'ready',scopeRevision:1,sessions:[],bindings:[],syncEnabled:false,sessionIssue:null,busy:null,errorCode:null,notice:null},
    session:{scopeRevision:1}};
  window.emit=(name,revision)=>{for(const listener of listeners[name])listener({...values[name],revision});};
  window.rejectRead=(name,index=0)=>window.reads[name][index].reject(new Error('合成状态读取失败'));
  const initial={revision:-1,scopeRevision:0},contacts={state:{contacts:[]}};
  function View({name,view,error=view.error,retry=view.retry}){return <section aria-label={name}>
    <output aria-label="revision">{view.state.revision}</output>{error&&<p role="alert">{error}</p>}
    <button onClick={()=>void retry()}>重试读取</button></section>;}
  function App(){
    const backend=useBackendState(),startup=useStartupState(),foreground=useForegroundState(bridges.foreground,true);
    const bindings=useBindingConsent(contacts),session=useRevisionedSession(initial,bridges.session);
    window.operationError=()=>session.setError('合成业务操作失败');
    return <><View name="backend" view={backend}/><View name="startup" view={startup}/><View name="foreground" view={foreground}/>
      <View name="bindings" view={bindings} error={bindings.readError} retry={bindings.retryRead}/><View name="session" view={session}/></>;
  }
  createRoot(document.getElementById('root')).render(<App/>);
 `},bundle:true,platform:'browser',format:'iife',write:false,jsx:'automatic',loader:{'.css':'empty'}});
 const browser=await launchChromium({ timeout: 10000 });t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(4000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://127.0.0.1/initial-state-test',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await page.goto('http://127.0.0.1/initial-state-test');await page.addScriptTag({content:compiled.outputFiles[0].text});
 await page.waitForFunction(()=>Object.values(window.reads).every(reads=>reads.length===1));
 await inspect(page);assert.deepEqual(errors,[]);
}

test('有效状态事件清除五类首帧错误，旧状态事件不清错也不触发重复读取',{timeout:20000},async t=>{
 await withStates(t,async page=>{
  for(const name of names){
   const region=page.getByRole('region',{name,exact:true});
   await page.evaluate(name=>window.rejectRead(name),name);await region.getByRole('alert').waitFor();
   await page.evaluate(name=>window.emit(name,2),name);await region.getByLabel('revision',{exact:true}).filter({hasText:'2'}).waitFor();
   assert.equal(await region.getByRole('alert').count(),0,`${name}恢复后清除读取错误`);
   await region.getByRole('button',{name:'重试读取'}).click();await page.waitForFunction(name=>window.reads[name].length===2,name);
   await page.evaluate(name=>window.rejectRead(name,1),name);await region.getByRole('alert').waitFor();
   await page.evaluate(name=>window.emit(name,1),name);
   assert.equal(await region.getByRole('alert').count(),1,`${name}忽略旧状态不能误清错误`);
   await page.evaluate(name=>window.emit(name,3),name);await region.getByLabel('revision',{exact:true}).filter({hasText:'3'}).waitFor();
   assert.equal(await region.getByRole('alert').count(),0);
   assert.equal(await page.evaluate(name=>window.reads[name].length,name),2);
  }
 });
});

test('有效事件先到时迟到首帧失败不恢复错误，会话业务错误仍保留',{timeout:20000},async t=>{
 await withStates(t,async page=>{
  for(const name of names){
   await page.evaluate(name=>window.emit(name,2),name);
   await page.getByRole('region',{name,exact:true}).getByLabel('revision',{exact:true}).filter({hasText:'2'}).waitFor();
   await page.evaluate(name=>window.rejectRead(name),name);
  }
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.getByRole('alert').count(),0);
  await page.evaluate(()=>window.operationError());const session=page.getByRole('region',{name:'session',exact:true});
  await session.getByRole('alert').filter({hasText:'合成业务操作失败'}).waitFor();
  await page.evaluate(()=>window.emit('session',3));await session.getByLabel('revision',{exact:true}).filter({hasText:'3'}).waitFor();
  assert.equal(await session.getByRole('alert').innerText(),'合成业务操作失败');
 });
});
