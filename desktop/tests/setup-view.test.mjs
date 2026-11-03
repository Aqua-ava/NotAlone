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

async function draftFixture(t){
 const built=await build({stdin:{contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';
 import{DesktopControls}from'./src/renderer/DesktopControls';import{SetupPanel}from'./src/renderer/SetupPanel';import{StartupSettings}from'./src/renderer/StartupSettings';
 const setupListeners=new Set(),desktopListeners=new Set(),backendListeners=new Set();
 let setup={phase:'ready',ownerReady:true,credentialsConfigured:true,baseUrl:'https://saved.example',revision:1};
 let desktop={helperShortcut:'Command+Shift+K',shortcutRegistered:true,helperPinned:false};
 let paths={projectDirectory:'/synthetic/project',envFilePath:'/synthetic/config',backendInfoPath:'/synthetic/backend',wechatCliPath:'/synthetic/cli',syncProbePath:'/synthetic/probe'};
 let backend={phase:'connected',revision:1,canSaveStartupPaths:true,canRetryConnection:false};
 window.updateSetup=patch=>{setup={...setup,...patch,revision:setup.revision+1};setupListeners.forEach(fn=>fn(setup));};
 window.updateDesktop=patch=>{desktop={...desktop,...patch};desktopListeners.forEach(fn=>fn(desktop));};
 window.updatePaths=patch=>{paths={...paths,...patch};};
 window.updateConnection=phase=>{backend={...backend,phase,revision:backend.revision+1};backendListeners.forEach(fn=>fn(backend));};
 window.notalone={backend:{getState:async()=>backend,onStateChanged:fn=>{backendListeners.add(fn);return()=>backendListeners.delete(fn);}},
 getDesktopSettings:async()=>desktop,onDesktopSettingsChanged:fn=>{desktopListeners.add(fn);return()=>desktopListeners.delete(fn);},setHelperShortcut:async value=>{if(window.holdShortcutSave)await new Promise(resolve=>window.finishShortcut=resolve);if(window.rejectShortcutSave)throw new Error('synthetic_save_failed');window.updateDesktop({helperShortcut:value.replace('cmd','Command')});return{settings:desktop,error:null};},
 setup:{getState:async()=>setup,onStateChanged:fn=>{setupListeners.add(fn);return()=>setupListeners.delete(fn);},saveDeepSeekConfiguration:async value=>{if(window.holdAiSave)await new Promise(resolve=>window.finishAi=resolve);window.updateSetup({baseUrl:value.baseUrl});if(window.restartOnAiSave){window.updateConnection('disconnected');window.updateConnection('connected');}},initializeOwner:async()=>{if(window.holdNameSave)await new Promise(resolve=>window.finishName=resolve);window.updateSetup({phase:'ready',ownerReady:true});}},
 startup:{getPaths:async()=>{const snapshot={...paths};if(window.holdPathsRead)await new Promise(resolve=>window.finishPathsRead=resolve);return snapshot;},savePaths:async value=>{if(window.holdPathsSave)await new Promise(resolve=>window.finishPaths=resolve);paths={...value,projectDirectory:value.projectDirectory.trim()};}}};
 function Harness(){const[visible,setVisible]=useState(true);return <><button onClick={()=>setVisible(!visible)}>切换设置页</button>{visible&&<><DesktopControls/><SetupPanel/><StartupSettings open state={{phase:'ready',revision:1,helperWarnings:[],code:'ready'}} backend={backend}/></>}</>;}
 createRoot(document.getElementById('root')).render(<Harness/>);
 `,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'browser',format:'iife',write:false,loader:{'.css':'empty'}});
 const browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(3000);
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:built.outputFiles[0].text});return page;
}
async function revisit(page){await page.getByRole('button',{name:'切换设置页'}).click();await page.getByRole('button',{name:'切换设置页'}).click();}

test('快捷键草稿切页保留，保存成功或已保存值变化后不恢复旧输入',async t=>{
 const page=await draftFixture(t),input=page.getByLabel('小窗快捷键');
 await expect(input).toHaveValue('Command+Shift+K');await input.fill('cmd+Shift+J');await revisit(page);
 await expect(input).toHaveValue('cmd+Shift+J');
 await page.getByRole('button',{name:'保存快捷键',exact:true}).click();await revisit(page);await expect(input).toHaveValue('Command+Shift+J');
 await input.fill('Command+Shift+L');await page.getByRole('button',{name:'切换设置页'}).click();
 await page.evaluate(()=>window.updateDesktop({helperShortcut:'Command+Shift+M'}));await page.getByRole('button',{name:'切换设置页'}).click();
 await expect(input).toHaveValue('Command+Shift+M');
});

test('启动路径草稿切页保留，保存成功和磁盘基准变化均淘汰旧草稿',async t=>{
 const page=await draftFixture(t),input=page.getByLabel('项目目录',{exact:true});
 await expect(input).toHaveValue('/synthetic/project');await input.fill(' /synthetic/new-project ');await revisit(page);
 await expect(input).toHaveValue(' /synthetic/new-project ');
 await page.getByRole('button',{name:'保存启动路径',exact:true}).click();await revisit(page);await expect(input).toHaveValue('/synthetic/new-project');
 await input.fill('/synthetic/old-draft');await page.getByRole('button',{name:'切换设置页'}).click();
 await page.evaluate(()=>window.updatePaths({projectDirectory:'/synthetic/external'}));await page.getByRole('button',{name:'切换设置页'}).click();
 await expect(input).toHaveValue('/synthetic/external');
});

test('AI服务切页只保留地址草稿，密钥清空且地址改动仍清密钥',async t=>{
 const page=await draftFixture(t),url=page.getByLabel('Base URL',{exact:true}),key=page.getByLabel('API Key',{exact:true});
 await expect(url).toHaveValue('https://saved.example');await url.fill('https://draft.example');await key.fill('synthetic-sensitive-key');await revisit(page);
 await expect(url).toHaveValue('https://draft.example');await expect(key).toHaveValue('');
 await key.fill('synthetic-second-key');await url.fill('https://next.example');await expect(key).toHaveValue('');
 await key.fill('synthetic-save-key');await page.getByRole('button',{name:'保存 AI 服务配置'}).click();await revisit(page);
 await expect(url).toHaveValue('https://next.example');await expect(key).toHaveValue('');
 await url.fill('https://discard.example');await page.getByRole('button',{name:'切换设置页'}).click();
 await page.evaluate(()=>window.updateSetup({baseUrl:'https://external.example'}));await page.getByRole('button',{name:'切换设置页'}).click();
 await expect(url).toHaveValue('https://external.example');
});

test('本人名称草稿切页保留，初始化成功后不遗留旧名称',async t=>{
 const page=await draftFixture(t);
 await page.evaluate(()=>window.updateSetup({phase:'needs-owner',ownerReady:false}));
 const name=page.getByLabel('本人展示名称');await name.fill('合成本人');await revisit(page);await expect(name).toHaveValue('合成本人');
 await page.getByRole('button',{name:'初始化本人',exact:true}).click();await expect(name).toHaveCount(0);
 await page.evaluate(()=>window.updateSetup({phase:'needs-owner',ownerReady:false}));await expect(name).toHaveValue('');
});

test('隐藏设置期间重复连接状态保留草稿，真正断线重连则撤销旧草稿',async t=>{
 const page=await draftFixture(t),shortcut=page.getByLabel('小窗快捷键'),url=page.getByLabel('Base URL',{exact:true}),project=page.getByLabel('项目目录',{exact:true});
 await expect(url).toHaveValue('https://saved.example');await shortcut.fill('Command+Shift+J');await url.fill('https://draft.example');await project.fill('/synthetic/draft');
 await page.getByRole('button',{name:'切换设置页'}).click();await page.evaluate(()=>window.updateConnection('connected'));await page.getByRole('button',{name:'切换设置页'}).click();
 await expect(shortcut).toHaveValue('Command+Shift+J');await expect(url).toHaveValue('https://draft.example');await expect(project).toHaveValue('/synthetic/draft');
 await page.getByRole('button',{name:'切换设置页'}).click();await page.evaluate(()=>{window.updateConnection('disconnected');window.updateConnection('connected');});await page.getByRole('button',{name:'切换设置页'}).click();
 await expect(shortcut).toHaveValue('Command+Shift+K');await expect(url).toHaveValue('https://saved.example');await expect(project).toHaveValue('/synthetic/project');
});

test('保存进行中切页仍禁用输入，完成后可继续编辑且失败保留草稿',async t=>{
 const page=await draftFixture(t),input=page.getByLabel('小窗快捷键');
 await expect(input).toHaveValue('Command+Shift+K');await input.fill('Command+Shift+J');
 await page.evaluate(()=>window.holdShortcutSave=true);await page.getByRole('button',{name:'保存快捷键',exact:true}).click();await revisit(page);
 await expect(input).toBeDisabled();await expect(page.getByRole('button',{name:'正在保存…',exact:true})).toBeVisible();
 await page.evaluate(()=>{window.holdShortcutSave=false;window.finishShortcut();});await expect(input).toBeEnabled();await expect(input).toHaveValue('Command+Shift+J');
 await input.fill('Command+Shift+L');await revisit(page);
 await expect(input).toHaveValue('Command+Shift+L');
 await page.evaluate(()=>window.rejectShortcutSave=true);await page.getByRole('button',{name:'保存快捷键',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('桌面设置暂时不可用');await revisit(page);await expect(input).toHaveValue('Command+Shift+L');
});

test('路径与AI配置在途切页保持忙碌，完成后直接显示最新保存结果',async t=>{
 const page=await draftFixture(t),project=page.getByLabel('项目目录',{exact:true}),url=page.getByLabel('Base URL',{exact:true}),key=page.getByLabel('API Key',{exact:true});
 await expect(project).toHaveValue('/synthetic/project');await project.fill(' /synthetic/submitted ');await page.evaluate(()=>window.holdPathsSave=true);
 await page.getByRole('button',{name:'保存启动路径',exact:true}).click();await revisit(page);await expect(project).toBeDisabled();
 await expect(page.getByRole('button',{name:'正在保存…',exact:true})).toBeVisible();await page.evaluate(()=>window.finishPaths());
 await expect(project).toBeEnabled();await expect(project).toHaveValue('/synthetic/submitted');
 await url.fill('https://submitted.example');await key.fill('synthetic-pending-key');await page.evaluate(()=>window.holdAiSave=true);
 await page.getByRole('button',{name:'保存 AI 服务配置',exact:true}).click();await revisit(page);
 await expect(url).toBeDisabled();await expect(key).toBeDisabled();await expect(key).toHaveValue('');await expect(page.getByRole('button',{name:'正在保存配置…',exact:true})).toBeVisible();
 await page.evaluate(()=>window.finishAi());await expect(url).toBeEnabled();await expect(url).toHaveValue('https://submitted.example');
 await page.evaluate(()=>window.updateSetup({phase:'needs-owner',ownerReady:false}));const name=page.getByLabel('本人展示名称');
 await name.fill('合成名称');await page.evaluate(()=>window.holdNameSave=true);await page.getByRole('button',{name:'初始化本人',exact:true}).click();await revisit(page);
 await expect(name).toBeDisabled();await expect(page.getByRole('button',{name:'正在初始化…',exact:true})).toBeVisible();await page.evaluate(()=>window.finishName());await expect(name).toHaveCount(0);
});

test('AI配置保存触发正常重连不误报保存失败',async t=>{
 const page=await draftFixture(t),url=page.getByLabel('Base URL',{exact:true}),key=page.getByLabel('API Key',{exact:true});
 await expect(url).toHaveValue('https://saved.example');await url.fill('https://restart.example');await key.fill('synthetic-restart-key');
 await page.evaluate(()=>window.restartOnAiSave=true);await page.getByRole('button',{name:'保存 AI 服务配置',exact:true}).click();
 await expect(url).toHaveValue('https://restart.example');await expect(key).toHaveValue('');await expect(page.getByRole('alert')).toHaveCount(0);
});

test('后台连接变化不提前解锁尚未结算的本地设置保存',async t=>{
 const page=await draftFixture(t),input=page.getByLabel('小窗快捷键');
 await expect(input).toHaveValue('Command+Shift+K');await input.fill('Command+Shift+J');await page.evaluate(()=>window.holdShortcutSave=true);
 await page.getByRole('button',{name:'保存快捷键',exact:true}).click();await revisit(page);
 await page.evaluate(async()=>{window.updateConnection('disconnected');window.updateConnection('connected');await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
 await expect(input).toBeDisabled();await expect(page.getByRole('button',{name:'正在保存…',exact:true})).toBeVisible();
 await page.evaluate(()=>window.finishShortcut());await expect(input).toBeEnabled();await expect(input).toHaveValue('Command+Shift+J');
});

test('启动路径保存后等待权威基准读完才恢复编辑，不覆盖后续输入',async t=>{
 const page=await draftFixture(t),input=page.getByLabel('项目目录',{exact:true});
 await expect(input).toHaveValue('/synthetic/project');await input.fill(' /synthetic/submitted ');await page.evaluate(()=>window.holdPathsRead=true);
 await page.getByRole('button',{name:'保存启动路径',exact:true}).click();await expect.poll(()=>page.evaluate(()=>typeof window.finishPathsRead)).toBe('function');
 await expect(input).toBeDisabled();await expect(page.getByText('正在读取启动路径…',{exact:true})).toBeVisible();
 await page.evaluate(()=>{window.holdPathsRead=false;window.finishPathsRead();});await expect(input).toBeEnabled();await expect(input).toHaveValue('/synthetic/submitted');
 await input.fill('/synthetic/later-draft');await revisit(page);await expect(input).toHaveValue('/synthetic/later-draft');
});
