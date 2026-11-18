import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';
import { expect } from '@playwright/test';
import { launchChromium, mountBundle } from '../helpers/browser.mjs';

async function mount(t, initiallyActive = true) {
  const compiled=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';
    import{UsageController}from'./src/main/usage/controller';import{UsagePanel}from'./src/renderer/UsagePanel';
    window.usageReads=0;window.usageStateReads=0;window.holdUsage=false;window.failUsage=false;let generation=1;const connectionListeners=new Set();
    const summary={schema_version:1,total_calls:11,total_attempts:11,authorized_unconfirmed_calls:0,not_sent_attempts:0,unknown_usage_calls:0,total_input_tokens:110,total_output_tokens:22,known_input_tokens:110,known_output_tokens:22,unknown_cost_calls:11,provider_counts:{synthetic:11},outcome_counts:{succeeded:11},cost_totals:[],recent:[]};
    const controller=new UsageController({getConnectionGeneration:()=>generation,onStateChanged:fn=>{connectionListeners.add(fn);return()=>connectionListeners.delete(fn);},requestJson:async()=>{const accepted=generation;window.usageReads++;if(window.holdUsage)await new Promise(resolve=>{window.finishUsage=resolve;});if(window.failUsage)throw new Error('合成失败');return {generation:accepted,data:summary};}});
    const bridge={getState:async()=>{window.usageStateReads++;return controller.getState();},onStateChanged:fn=>controller.onStateChanged(fn),refresh:()=>controller.refresh()};
    window.disconnectUsage=()=>{generation=undefined;for(const listener of connectionListeners)listener();};
    function Harness(){const[visible,setVisible]=useState(${initiallyActive});window.setUsageActive=setVisible;return <><button onClick={()=>setVisible(!visible)}>切换设置页</button><div hidden={!visible}><UsagePanel bridge={bridge} active={visible}/></div></>;}createRoot(document.getElementById('root')).render(<Harness/>);`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',jsx:'automatic',write:false,logLevel:'silent'});
  const browser=await launchChromium();t.after(()=>browser.close());const page=await browser.newPage();
  await mountBundle(page, compiled);
  return page;
}

test('设置用量重复进入首帧保留统计且复用在途读取，失败和断线撤下', {timeout:20000}, async t => {
  const page=await mount(t);
  const value=page.locator('.usage-stat-primary dd');await expect(value).toHaveText('11次');
  await page.evaluate(()=>{window.holdUsage=true;});
  for(let index=0;index<3;index++){
    await page.getByRole('button',{name:'切换设置页'}).click();await expect(value).toBeHidden();
    const before=await page.evaluate(()=>window.usageReads);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(()=>window.usageReads),before,'隐藏不触发刷新');
    const firstFrame=await page.evaluate(async()=>{window.setUsageActive(true);await new Promise(requestAnimationFrame);return document.querySelector('.usage-stat-primary dd')?.textContent;});
    assert.equal(firstFrame,'11次','再次显示的首帧直接保留统计');await expect(value).toBeVisible();
    await expect(page.getByRole('button',{name:'刷新用量',exact:true})).toBeDisabled();
  }
  assert.equal(await page.evaluate(()=>window.usageReads),2,'首次读取和一轮共享后台刷新');
  assert.equal(await page.evaluate(()=>window.usageStateReads),1,'切页不卸载订阅或重复读取IPC快照');
  await page.evaluate(()=>{window.holdUsage=false;window.finishUsage();});await expect(page.getByRole('button',{name:'刷新用量',exact:true})).toBeEnabled();
  await page.evaluate(()=>{window.failUsage=true;});await page.getByRole('button',{name:'刷新用量',exact:true}).click();
  await expect(value).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('用量读取失败');
  await page.evaluate(()=>{window.failUsage=false;});await page.getByRole('button',{name:'刷新用量',exact:true}).click();await expect(value).toHaveText('11次');
  await page.evaluate(()=>window.disconnectUsage());await expect(value).toHaveCount(0);await expect(page.getByRole('status')).toContainText('用量');
});


test('隐藏预挂载的用量页不读取，隐藏期间断线仍立即撤下统计', {timeout:20000}, async t => {
  const page=await mount(t,false),value=page.locator('.usage-stat-primary dd');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>window.usageReads),0);
  await page.getByRole('button',{name:'切换设置页'}).click();await expect(value).toHaveText('11次');
  await page.getByRole('button',{name:'切换设置页'}).click();await expect(value).toBeHidden();
  await page.evaluate(()=>window.disconnectUsage());await expect(value).toHaveCount(0);
  assert.equal(await page.evaluate(()=>window.usageReads),1);
  await page.getByRole('button',{name:'切换设置页'}).click();await expect(page.getByRole('status')).toContainText('用量');
  assert.equal(await page.evaluate(()=>window.usageReads),1);
});
