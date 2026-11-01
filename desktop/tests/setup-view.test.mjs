import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

async function fixture(t,baseUrl='https://synthetic.example/anthropic'){
 const built=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {SetupPanel} from './src/renderer/SetupPanel';
 const listeners=new Set();window.calls=[];let state={phase:'ready',ownerReady:true,credentialsConfigured:true,officialDefaults:false,baseUrl:${JSON.stringify(baseUrl)},revision:1};
 window.update=value=>{state={...state,...value,revision:state.revision+1};for(const fn of listeners)fn(state);};
 window.notalone={setup:{getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 saveDeepSeekConfiguration:async value=>{window.calls.push(value);window.update({phase:'restarting'});},saveDeepSeekKey:async()=>{throw new Error('不能调用旧密钥接口');}}};
 createRoot(document.getElementById('root')).render(<SetupPanel/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(4000);
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:built.outputFiles[0].text});return page;
}

test('AI服务同时呈现Base URL和空API Key，改地址清空密钥并显式保存两项',async t=>{
 const page=await fixture(t),url=page.getByLabel('Base URL',{exact:true}),key=page.getByLabel('API Key',{exact:true}),save=page.getByRole('button',{name:'保存 AI 服务配置',exact:true});
 await expect(url).toHaveValue('https://synthetic.example/anthropic');await expect(key).toHaveValue('');await expect(save).toBeDisabled();
 await key.fill('synthetic-old-key');await url.fill('https://new-synthetic.example');await expect(key).toHaveValue('');await expect(save).toBeDisabled();
 await key.fill('synthetic-new-key');await save.click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{baseUrl:'https://new-synthetic.example',apiKey:'synthetic-new-key'}]);
 await expect(page.getByText('正在停读并重新加载配置…',{exact:true})).toBeVisible();
 await page.evaluate(()=>window.update({phase:'ready',baseUrl:'https://new-synthetic.example'}));await expect(key).toHaveValue('');
 assert.doesNotMatch(await page.locator('body').innerText(),/synthetic-new-key|synthetic-old-key/);
});

test('旧状态缺地址时预填官方地址，保存前必须输入密钥且不自动发送',async t=>{
 const page=await fixture(t,null);
 await expect(page.getByLabel('Base URL',{exact:true})).toHaveValue('https://api.deepseek.com');
 await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('');
 assert.equal((await page.evaluate(()=>window.calls)).length,0);
});
