import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WechatSessions } from '../src/sync/wechat-sessions.ts';

// 子进程只访问本测试创建的合成目录，不继承真实配置或聊天资料。
async function fixture(t, rows = [], mode = '') {
  const root = await mkdtemp(path.join(tmpdir(), 'notalone-session-fixture-'));
  const executable = path.join(root, 'cli');
  await writeFile(path.join(root, 'rows.json'), JSON.stringify(rows));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = process.env.HOME, mode = process.env.FIXTURE_MODE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args)+'\\n');
const calls = fs.readFileSync(path.join(root, 'calls.jsonl'),'utf8').trim().split('\\n');
function emit(data) { console.log(JSON.stringify({ok:true,data})); }
if (args[0] === 'status') emit({status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:mode==='switch' && calls.length>1?'wxid_other':'wxid_fixture',private_path:'DO_NOT_RETURN'}}});
else if (args[0] === 'sessions') {
  if (mode==='hang') setInterval(()=>{},1000);
  else if (mode==='overflow') process.stdout.write('x'.repeat(2*1024*1024));
  else if (mode==='invalid') console.log('PRIVATE_INVALID_DATA');
  else if (mode==='fail') { console.error('PRIVATE_STDERR');process.exit(1); }
  else emit({sessions:JSON.parse(fs.readFileSync(path.join(root,'rows.json'),'utf8'))});
} else process.exit(9);
`, { mode: 0o700 });
  const cli = new WechatSessions({executable, environment:{HOME:root,FIXTURE_MODE:mode}});
  t.after(async () => { await cli.close(); await rm(root,{recursive:true,force:true}); });
  return {cli, calls:async()=> (await readFile(path.join(root,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse)};
}
const candidate = {username:'wxid_friend',display_name:'合成联系人',chat_type:'private',last_timestamp:10};
const options = {type_filter:'private',expected_account:'wxid_fixture'};

test('固定只读命令前后复验账号且摘要及调试资料不外泄', async t => {
  const f = await fixture(t,[{...candidate,summary:'PRIVATE_SUMMARY',last_sender_display_name:'PRIVATE_SENDER'},
    {...candidate,username:'room@chatroom',chat_type:'group'}, {...candidate,username:'gh_fake'}]);
  assert.deepEqual(await f.cli.sessions(options),[candidate]);
  assert.deepEqual(await f.calls(),[
    ['status','--include-debug','--strict-read-only'],
    ['sessions','--type-filter','private','--limit','5000','--strict-read-only'],
    ['status','--include-debug','--strict-read-only']]);
});
test('账号在列表前不符立即拒绝且不读列表', async t => {
  const f = await fixture(t,[candidate]);
  await assert.rejects(f.cli.sessions({...options,expected_account:'wxid_other'}),{code:'cli_account_changed'});
  assert.equal((await f.calls()).length,1);
});
test('账号在列表后变化不返回候选', async t => {
  const f = await fixture(t,[candidate],'switch');
  await assert.rejects(f.cli.sessions(options),{code:'cli_account_changed'});
});
test('重复稳定身份拒绝而同名不同身份独立返回', async t => {
  const conflict = await fixture(t,[candidate,{...candidate,display_name:'另名'}]);
  await assert.rejects(conflict.cli.sessions(options),{code:'cli_identity_conflict'});
  const distinct = await fixture(t,[candidate,{...candidate,username:'wxid_another'}]);
  assert.equal((await distinct.cli.sessions(options)).length,2);
});
test('不从昵称猜身份，空展示名才回退到已有稳定身份', async t => {
  const invalid = await fixture(t,[{...candidate,username:''}]);
  await assert.rejects(invalid.cli.sessions(options),{code:'cli_output_invalid'});
  const valid = await fixture(t,[{...candidate,display_name:' '}]);
  assert.equal((await valid.cli.sessions(options))[0].display_name,'wxid_friend');
});
test('参数和预先取消在启动进程之前拒绝', async t => {
  const f = await fixture(t);
  for (const limit of [0,5001,1.5,NaN]) await assert.rejects(f.cli.sessions({...options,limit}),{code:'cli_invalid_argument'});
  await assert.rejects(f.cli.sessions({...options,signal:AbortSignal.abort()}),{code:'cli_cancelled'});
  await assert.rejects(f.calls(),{code:'ENOENT'});
});
test('完整候选列表达到请求上限时拒绝，不把截断结果解释为完整授权快照', async t => {
  for (const limit of [2,5000]) {
    const rows = Array.from({length:limit},(_,index)=>({...candidate,username:`wxid_fixture_${index}`}));
    const f = await fixture(t,rows);
    await assert.rejects(f.cli.sessions({...options,limit}),{code:'cli_output_invalid'});
    assert.equal((await f.calls()).filter(args=>args[0]==='sessions').length,1);
  }
  const below = await fixture(t,[candidate]);
  assert.deepEqual(await below.cli.sessions({...options,limit:2}),[candidate]);
});
for (const mode of ['overflow','invalid','fail','hang']) test(`真实子进程${mode}有界失败且不泄漏输出`, async t => {
  const f = await fixture(t,[],mode), start = performance.now();
  await assert.rejects(f.cli.sessions(options), error => {
    assert.ok(error.code); assert.doesNotMatch(error.message,/PRIVATE_|xxxx/); return true;
  });
  assert.ok(performance.now()-start < 5000);
});
test('运行中取消停止子进程且关闭后不再启动', async t => {
  const f = await fixture(t,[],'hang'), abort = new AbortController();
  const pending = f.cli.sessions({...options,signal:abort.signal});
  const timer = setTimeout(()=>abort.abort(),200);
  try { await assert.rejects(pending); } finally { clearTimeout(timer); }
  await f.cli.close();
  await assert.rejects(f.cli.sessions(options),{code:'runtime_stopping'});
});
