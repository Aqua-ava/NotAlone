import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
async function pageFixture(t, phase='needs_detection') {
 const browser=await chromium.launch({headless:true,executablePath:process.env.NOTALONE_TEST_CHROMIUM_PATH});t.after(()=>browser.close());
 const page=await browser.newPage();
 const bundle=await build({stdin:{contents:`
 import React from 'react';import {createRoot} from 'react-dom/client';import {WechatSetupPanel} from './src/renderer/WechatSetupPanel';
 let state={phase:${JSON.stringify(phase)},accountId:null,failureCode:null,revision:1};const listeners=new Set();window.calls=[];
 window.update=value=>{state={...state,...value,revision:state.revision+1};for(const fn of listeners)fn(state);};
 const bridge={getState:async()=>state,refresh:async()=>window.calls.push('refresh'),onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 detect:async()=>{window.calls.push('detect');window.update({phase:'ready',accountId:'synthetic-account'});},
 confirm:async value=>{window.calls.push(value);window.update({phase:'connected'});},retryRestart:async()=>window.calls.push('retry')};
 createRoot(document.getElementById('root')).render(<WechatSetupPanel bridge={bridge}><button>同步总开关</button></WechatSetupPanel>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:bundle.outputFiles[0].text});return page;
}
test('新用户先主动检测，再核对账号并一次授权全部现有及新增私聊',async t=>{
 const page=await pageFixture(t);
 await expect(page.getByRole('button',{name:'检测微信账号',exact:true})).toBeVisible();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh']);
 await expect(page.getByRole('button',{name:'同步总开关',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'确认连接并同步全部私聊',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'检测微信账号',exact:true}).click();
 await expect(page.getByText('synthetic-account',{exact:true})).toBeVisible();
 await expect(page.getByText('读取工具配置的微信账号：synthetic-account',{exact:true})).toBeVisible();
 await expect(page.getByText(/现有及以后新增的微信私聊/)).toBeVisible();
 await page.getByRole('button',{name:'确认连接并同步全部私聊',exact:true}).click();
 assert.deepEqual((await page.evaluate(()=>window.calls)).at(-1),{revision:2,confirmed:true});
 await expect(page.getByText('微信账号已连接',{exact:true})).toBeVisible();
 await expect(page.getByText('已关联的微信账号：synthetic-account',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'同步总开关',exact:true})).toBeVisible();
});
test('未准备的工具不能伪装为连接成功，保存后只重试加载',async t=>{
 const page=await pageFixture(t,'tool_not_ready');
 await expect(page.getByText(/当前版本尚不能完成全新电脑的微信读取工具初始化/)).toBeVisible();
 await expect(page.getByRole('button',{name:'确认连接并同步全部私聊',exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.update({phase:'restart-failed',accountId:'synthetic-account'}));
 await expect(page.getByText(/授权已保存/)).toBeVisible();
 await page.getByRole('button',{name:'重新加载连接',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.calls),['refresh','retry']);
});
