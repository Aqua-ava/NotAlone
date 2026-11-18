import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import { expect } from '@playwright/test';
import { launchChromium, mountBundle } from './helpers/browser.mjs';

async function fixture(t) {
 const built=await build({stdin:{contents:`
 import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SetupPanel}from'./src/renderer/SetupPanel';
 let state={phase:'ready',credentialsConfigured:false,revision:1,modelParameters:{reply:{thinkingEffort:'off',temperature:0},memory:{thinkingEffort:'off',temperature:0}}};
 const listeners=new Set();window.calls=[];
 window.update=patch=>{state={...state,...patch,revision:state.revision+1};listeners.forEach(fn=>fn(state));};
 window.notalone={setup:{getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
 saveModelParameters:async value=>{window.calls.push(structuredClone(value));if(window.holdSave)await new Promise(resolve=>window.finishSave=resolve);if(window.rejectSave)throw new Error('synthetic_failed');window.update({modelParameters:value,modelParametersInvalid:false});}}};
 function Harness(){const[visible,setVisible]=useState(true);return <><button onClick={()=>setVisible(!visible)}>切换设置页</button>{visible&&<SetupPanel/>}</>;}
 createRoot(document.getElementById('root')).render(<Harness/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 const browser=await launchChromium();t.after(()=>browser.close());
 const page=await browser.newPage();page.setDefaultTimeout(4000);
 await mountBundle(page, built);return page;
}
const revisit=async page=>{await page.getByRole('button',{name:'切换设置页'}).click();await page.getByRole('button',{name:'切换设置页'}).click();};

test('两组参数分别编辑，开启思考停用温度并保留值，无需密钥保存',async t=>{
 const page=await fixture(t),save=page.getByRole('button',{name:'保存模型参数',exact:true});
 const replyEffort=page.getByLabel('回复生成思考程度'),replyTemperature=page.getByLabel('回复生成温度');
 const memoryEffort=page.getByLabel('记忆处理思考程度'),memoryTemperature=page.getByLabel('记忆处理温度');
 await expect(save).toBeDisabled();await expect(replyEffort).toHaveValue('off');await expect(memoryTemperature).toHaveValue('0');
 await replyTemperature.fill('0.25');await memoryTemperature.fill('0.3');await memoryEffort.selectOption('high');
 await expect(memoryTemperature).toBeDisabled();await expect(memoryTemperature).toHaveValue('0.3');
 await expect(page.getByText('开启思考时，DeepSeek 忽略所设温度并固定为 1；关闭思考后使用已保存的温度。')).toBeVisible();
 await expect(replyTemperature).toBeEnabled();await expect(page.getByLabel('API Key',{exact:true})).toHaveValue('');
 await save.click();
 assert.deepEqual(await page.evaluate(()=>window.calls),[{reply:{thinkingEffort:'off',temperature:0.25},memory:{thinkingEffort:'high',temperature:0.3}}]);
 await expect(save).toBeDisabled();await memoryEffort.selectOption('off');await expect(memoryTemperature).toBeEnabled();await expect(memoryTemperature).toHaveValue('0.3');
});

test('失效的配置明确标为待设置默认值，允许保存重设且支持精细温度',async t=>{
 const page=await fixture(t),save=page.getByRole('button',{name:'保存模型参数',exact:true});
 await page.evaluate(()=>window.update({modelParameters:undefined,modelParametersInvalid:true}));
 await expect(page.getByRole('alert')).toContainText('尚未生效');await expect(save).toBeEnabled();
 await page.getByLabel('回复生成温度').fill('1e-7');await save.click();
 assert.equal((await page.evaluate(()=>window.calls))[0].reply.temperature,1e-7);
 await expect(save).toBeDisabled();await expect(page.getByRole('alert')).toHaveCount(0);
});

test('未保存参数跨页面和同值刷新保留，保存失败能重试并可撤销',async t=>{
 const page=await fixture(t),temperature=page.getByLabel('回复生成温度'),save=page.getByRole('button',{name:'保存模型参数',exact:true});
 await expect(temperature).toHaveValue('0');await temperature.fill('0.9');
 await page.evaluate(()=>window.update({semanticModelReady:true}));await revisit(page);
 await expect(temperature).toHaveValue('0.9');await expect(page.getByText('有未保存的更改')).toBeVisible();
 await page.evaluate(()=>window.rejectSave=true);await save.click();await expect(page.getByRole('alert')).toContainText('模型参数未能保存');
 await revisit(page);await expect(temperature).toHaveValue('0.9');
 await page.evaluate(()=>window.rejectSave=false);await save.click();await expect(save).toBeDisabled();
 await temperature.fill('1.1');await page.getByRole('button',{name:'撤销更改',exact:true}).click();await expect(temperature).toHaveValue('0.9');
});

test('参数保存进行中跨页面保持禁用，空值和越界值不能保存',async t=>{
 const page=await fixture(t),temperature=page.getByLabel('回复生成温度'),save=page.getByRole('button',{name:'保存模型参数',exact:true});
 await expect(temperature).toHaveValue('0');await temperature.fill('');await expect(save).toBeDisabled();
 await temperature.fill('2.1');await expect(save).toBeDisabled();await temperature.fill('1.2');
 await page.evaluate(()=>window.holdSave=true);await save.click();await revisit(page);
 await expect(temperature).toBeDisabled();await expect(page.getByRole('button',{name:'正在保存模型参数…',exact:true})).toBeDisabled();
 await page.evaluate(()=>window.finishSave());await expect(temperature).toBeEnabled();await expect(temperature).toHaveValue('1.2');
 assert.equal((await page.evaluate(()=>window.calls)).length,1);
});
