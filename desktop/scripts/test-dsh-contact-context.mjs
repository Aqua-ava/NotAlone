// 真实源码开发宿主验收：仅合成 PG、独立配置和 renderer 操作；不打包、不调用模型或微信。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { selectContact } from '../tests/contact-picker-actions.mjs';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createStorageFixture } from '../../backend-ts/test/host-storage-fixture.mjs';
import { developmentProcesses, requireDevelopmentOnly } from './development-policy.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.dirname(desktop);
const output = process.env.NOTALONE_TEST_OUTPUT || path.join(root, '.scratch/dsh-ts-migration/contact-context/desktop');
const python = process.env.NOTALONE_TEST_PYTHON || path.join(homedir(), 'miniconda3/envs/NotAlone/bin/python');
const npm = process.env.NOTALONE_TEST_NPM_CLI || path.join(path.dirname(path.dirname(python)), 'lib/node_modules/npm/bin/npm-cli.js');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(probe, message, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
const existing = await developmentProcesses(desktop);
requireDevelopmentOnly(existing);
assert.equal(existing.development.length, 0, '已有开发宿主，保留现场，不能用合成配置替换');
await mkdir(output, { recursive: true });
const fixture = await createStorageFixture();
const originalLedger = (await fixture.client.query('SELECT name, checksum FROM public.notalone_schema_migration ORDER BY name')).rows;
assert.equal(originalLedger.length, 107);
const userData = path.join(fixture.directory, 'desktop');
await mkdir(userData, { recursive: true });
const infoPath = path.join(fixture.directory, 'backend.info');
await writeFile(path.join(userData, 'backend-launch.json'), JSON.stringify({
  pythonExecutable: python, projectDirectory: root, envFilePath: fixture.envFilePath,
  backendInfoPath: infoPath, wechatCliPath: path.join(fixture.directory, 'unavailable-cli'),
  syncProbePath: path.join(fixture.directory, 'unavailable-probe'),
}), { mode: 0o600 });
const environment = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'DISPLAY', 'USER', 'LOGNAME'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
environment.PATH = `${path.dirname(process.execPath)}:${path.dirname(python)}:${environment.PATH || '/usr/bin:/bin'}`;
environment.NOTALONE_DEV_CDP = '1';
let runner, browser, electronPid;
const ownedBackends = new Set();
const results = [];
async function handshake() {
  const text = await readFile(infoPath, 'utf8');
  const data = Object.fromEntries(text.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const pid = Number(data.pid);
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  ownedBackends.add(pid);
  return data;
}
async function launch() {
  await rm(path.join(userData, 'DevToolsActivePort'), { force: true });
  const log = await open(path.join(fixture.directory, 'dev.log'), 'a', 0o600);
  try { runner = spawn(process.execPath, [npm, 'run', 'dev', '--', '--user-data-dir', userData],
    { cwd: desktop, env: environment, detached: true, stdio: ['ignore', log.fd, log.fd] }); }
  finally { await log.close(); }
  const port = await until(async () => {
    assert.equal(runner.exitCode, null, '开发监督器提前退出');
    const value = await readFile(path.join(userData, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const selected = Number(value.split('\n')[0]);
    return Number.isInteger(selected) && selected > 0 && selected <= 65535 ? selected : undefined;
  }, '开发 CDP 未就绪', 60000);
  const state = await developmentProcesses(desktop, userData);
  requireDevelopmentOnly(state);
  assert.equal(state.development.length, 1);
  electronPid = state.development[0];
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url() === 'notalone://app/index.html#manager'), '开发页面未就绪');
  await page.waitForFunction(() => window.notalone?.backend && window.notalone?.setup);
  await until(async () => (await page.evaluate(() => window.notalone.backend.getState())).phase === 'connected', '本机后台未连接');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name: '设置', exact: true }).click();
  await handshake();
  return page;
}
async function stop() {
  // 热更新可能已更换宿主 PID，只结束本轮用户目录对应的开发实例。
  const current = await developmentProcesses(desktop, userData);
  for (const pid of current.development) if (alive(pid)) process.kill(pid, 'SIGTERM');
  if (electronPid && alive(electronPid)) process.kill(electronPid, 'SIGTERM');
  await until(() => (!electronPid || !alive(electronPid)) && (!runner || runner.exitCode !== null)
    && [...ownedBackends].every(pid => !alive(pid)), '认证退出未完成，保留合成库现场', 25000);
  await browser?.close(); browser = undefined; electronPid = undefined; runner = undefined;
}
let cleaned = false;
const ids = Array.from({length:3},()=>randomUUID());
const sources = [randomUUID(),randomUUID()];
const messages = [randomUUID(),randomUUID()];
const memoryId = randomUUID();
async function scope(page) { return page.evaluate(async()=>{const state=await window.notalone.contacts.getState();return {contactId:state.selectedContactId,scopeRevision:state.scopeRevision};}); }
async function readContext(page, selection) {
  return page.evaluate(async selection=>{
    await Promise.all([window.notalone.sources.refresh(selection),window.notalone.memory.refreshOverview(selection)]);
    return {sources:await window.notalone.sources.getState(),memory:await window.notalone.memory.getState()};
  },selection);
}
try {
  const page = await launch();
  await page.getByLabel('本人展示名称').fill('合成联系人上下文验收本人');
  await page.getByRole('button',{name:'初始化本人',exact:true}).click();
  await until(async()=> (await page.evaluate(()=>window.notalone.setup.getState())).phase==='ready','本人初始化未完成');
  await handshake();
  const owner=(await fixture.client.query('SELECT id FROM public.owner')).rows[0].id;
  for(let i=0;i<3;i++) await fixture.client.query('INSERT INTO public.contact(id,owner_id,display_name) VALUES($1,$2,$3)',[ids[i],owner,i<2?'合成同名联系人':'合成空联系人']);
  for(let i=0;i<2;i++) {
    await fixture.client.query("INSERT INTO public.source_document(id,owner_id,contact_id,source_type,file_name,content_sha256,record_count) VALUES($1,$2,$3,'manual',$4,$5,1)",[sources[i],owner,ids[i],`synthetic-${i}.txt`,'a'.repeat(64)]);
    await fixture.client.query("INSERT INTO public.message(id,owner_id,contact_id,speaker,message_type,text_content,occurred_at) VALUES($1,$2,$3,'contact','text',$4,'2026-10-01T01:02:03.123456Z')",[messages[i],owner,ids[i],`合成联系人${i===0?'甲':'乙'}专属消息`]);
    await fixture.client.query("INSERT INTO public.message_source_ref(message_id,owner_id,contact_id,source_kind,source_document_id,source_locator,raw_payload) VALUES($1,$2,$3,'source_document',$4,'line:1',$5)",[messages[i],owner,ids[i],sources[i],{time_iso:'2026-10-01T01:02:03.123456+00:00',synthetic:true}]);
  }
  await fixture.client.query("INSERT INTO public.confirmed_memory(id,owner_id,contact_id,text_content,category,source_ids,adoption_method) VALUES($1,$2,$3,'合成甲喜欢清淡食物','preference',$4,'manual')",[memoryId,owner,ids[0],[sources[0]]]);
  await page.evaluate(()=>window.notalone.contacts.refreshContacts());
  const picker=page.getByRole('combobox',{name:'本次联系人',exact:true});
  await selectContact(picker,ids[0]);
  const first=await scope(page);
  const alpha=await readContext(page,first);
  assert.deepEqual(alpha.sources.sources.map(item=>item.sourceId),[sources[0]]);
  assert.equal(alpha.memory.overview.value.entries[0].memory.memoryId,memoryId);
  await page.getByRole('navigation',{name:'管理导航'}).getByRole('button',{name:'记忆',exact:true}).click();
  await page.getByText('合成甲喜欢清淡食物',{exact:true}).waitFor();
  await page.screenshot({path:path.join(output,'contact-a.png')});
  results.push('同名联系人按原ID选择，甲关系资料和来源只属于甲');
  await page.getByRole('button',{name:'打开输入小窗',exact:true}).click();
  const helper=await until(()=>browser.contexts().flatMap(context=>context.pages()).find(item=>item.url()==='notalone://app/index.html#helper'),'输入小窗未打开');
  await helper.waitForFunction(()=>window.notalone?.replies);
  await helper.evaluate(async selection=>{await window.notalone.replies.loadMessages({...selection,older:false});},first);
  const messageState=await helper.evaluate(()=>window.notalone.replies.getState());
  assert.deepEqual(messageState.messages.items.map(item=>item.messageId),[messages[0]]);
  await helper.getByText('最近聊天 · 查看／补充',{exact:true}).click();
  await helper.getByText('合成联系人甲专属消息',{exact:true}).waitFor();
  await helper.screenshot({path:path.join(output,'helper-a.png')});
  results.push('真实helper控制器及画面读取甲原消息ID，不调用模型');
  await selectContact(picker,ids[1]);
  const second=await scope(page);
  const beta=await readContext(page,second);
  assert.deepEqual(beta.sources.sources.map(item=>item.sourceId),[sources[1]]);
  assert.deepEqual(beta.memory.overview.value.entries,[]);
  await helper.evaluate(async selection=>{await window.notalone.replies.loadMessages({...selection,older:false});},second);
  assert.deepEqual((await helper.evaluate(()=>window.notalone.replies.getState())).messages.items.map(item=>item.messageId),[messages[1]]);
  assert.equal(await helper.getByText('合成联系人甲专属消息',{exact:true}).count(),0);
  assert.equal(await page.getByText('合成甲喜欢清淡食物',{exact:true}).count(),0);
  const stale=await page.evaluate(async selection=>{try{await window.notalone.sources.refresh(selection);return false;}catch{return true;}},first);
  assert.equal(stale,true);
  await page.screenshot({path:path.join(output,'contact-b.png')});
  results.push('切到同名乙清除甲资料，原甲范围提交明确拒绝');
  await selectContact(picker,ids[2]);
  const empty=await readContext(page,await scope(page));
  assert.deepEqual(empty.sources.sources,[]);assert.deepEqual(empty.memory.overview.value.entries,[]);
  await page.screenshot({path:path.join(output,'empty-contact.png')});
  results.push('已存在空联系人返回明确空来源与空关系概览');
  await stop();
  const reopened=await launch();
  await reopened.evaluate(()=>window.notalone.contacts.refreshContacts());
  await selectContact(reopened.getByRole('combobox',{name:'本次联系人',exact:true}),ids[0]);
  const restored=await readContext(reopened,await scope(reopened));
  assert.equal(restored.memory.overview.value.entries[0].memory.memoryId,memoryId);
  assert.deepEqual(restored.sources.sources.map(item=>item.sourceId),[sources[0]]);
  assert.deepEqual((await fixture.client.query('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name')).rows,originalLedger);
  results.push('开发实例重启保留原联系人/来源/资料ID及107条迁移checksum');
  await stop();await fixture.close();cleaned=true;
  await writeFile(path.join(output,'result.json'),JSON.stringify({passed:results,cleanup:true,mode:'npm run dev',computerUse:'unavailable',renderer:'Playwright CDP',modelCalls:0,wechatReads:0},null,2));
  console.log(JSON.stringify({passed:results.length,cleanup:true}));
} catch (error) { console.error(error); console.error((await readFile(path.join(fixture.directory,'dev.log'),'utf8').catch(()=>'' )).slice(-8000)); throw error; }
finally { if(!cleaned){await stop();await fixture.close();} }
