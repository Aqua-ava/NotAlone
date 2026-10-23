import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncIncrementalCli } from '../src/sync-incremental-cli.ts';
async function fixture(t, source, options={}) {
  const dir=await mkdtemp(join(tmpdir(),'notalone-sync-cli-'));
  const executable=join(dir,'cli');
  await writeFile(executable,`#!${process.execPath}\n${source}`,{mode:0o700});
  const cli=new SyncIncrementalCli({executable,...options});
  t.after(async()=>{await cli.close();await rm(dir,{recursive:true,force:true});});
  return cli;
}
test('固定版本命令仅返回版本，不携带原始调试字段',async t=>{
  const cli=await fixture(t,`if(JSON.stringify(process.argv.slice(2))!=='["--version"]')process.exit(2);console.log(JSON.stringify({ok:true,data:{version:'synthetic-1'}}));`);
  assert.equal(await cli.version(),'synthetic-1');
});
test('取消、超时、预算和永久关闭均有界失败',async t=>{
  const cli=await fixture(t,`setInterval(()=>{},1000);`);
  const controller=new AbortController();const pending=cli.version({signal:controller.signal});controller.abort();
  await assert.rejects(pending,{code:'cli_cancelled'});
  await assert.rejects(cli.version({timeoutMs:30}),{code:'cli_timeout'});
  const noisy=await fixture(t,`process.stdout.write('x'.repeat(20000));`,{maxOutputBytes:100});
  await assert.rejects(noisy.version(),{code:'cli_output_limit'});
  const waiting=cli.version();const rejection=assert.rejects(waiting,{code:'cli_cancelled'});await cli.close();await rejection;
  await assert.rejects(cli.version(),{code:'cli_cancelled'});
});
test('已配置账号复用严格就绪合同且固定参数',async t=>{
  const cli=await fixture(t,`const a=process.argv.slice(2);if(a.join(' ')!=='status --include-debug --strict-read-only')process.exit(2);console.log(JSON.stringify({ok:true,data:{status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'wxid_synthetic'}}}}));`);
  assert.equal(await cli.configuredAccount(),'wxid_synthetic');
  await assert.rejects(cli.configuredAccount({expectedAccount:'different'}),{code:'cli_account_changed'});
});
test('会话解析只投影身份并拒绝无效预算',async t=>{
  const cli=await fixture(t,`const a=process.argv.slice(2);if(a.join(' ')!=='resolve-chat wxid_synthetic --type-filter private --strict-read-only')process.exit(2);console.log(JSON.stringify({ok:true,data:{candidates:[{username:'wxid_synthetic',display_name:'合成',chat_type:'private',summary:'不得传播'}]}}));`);
  assert.deepEqual(await cli.resolveChat('wxid_synthetic',{typeFilter:'private'}),{query:'wxid_synthetic',candidates:[{username:'wxid_synthetic',display_name:'合成',chat_type:'private'}]});
  await assert.rejects(cli.resolveChat('x',{timeoutMs:1001}),{code:'cli_invalid_argument'});
});
test('精确缺表只读计数分类删除历史且不把一般缺表当空结果',async t=>{
  const cli=await fixture(t,`const a=process.argv.slice(2);if(a[0]==='tail'){console.log(JSON.stringify({ok:false,error:{code:'tool_error',message:'table msg_x not found in 2 message shards'}}));process.exitCode=1;}else if(a[0]==='sql'&&a.includes('--strict-read-only')&&a[1].startsWith('SELECT ')){console.log(JSON.stringify({ok:true,data:{freshness:{message_source:'live_selected_db_read_only'},query:{has_more:false,returned:1},rows:[{deleted_count:1,session_count:0,empty_session_count:0}]}}));}else process.exit(2);`);
  assert.equal((await cli.tail('wxid_synthetic')).local_history_state,'deleted');
  const unknown=await fixture(t,`console.log(JSON.stringify({ok:false,error:{code:'tool_error',message:'table msg_x not found in opened message shards'}}));process.exitCode=1;`);
  await assert.rejects(unknown.tail('wxid_synthetic'),{code:'cli_message_table_missing'});
});
test('全局流只保留元数据，关闭排空，不启动按联系人follow',async t=>{
  const cli=await fixture(t,`const a=process.argv.slice(2);if(a.join(' ')!=='tail --mode sessions --scan-limit 5000 --poll-interval 3s --include-media-paths false --follow --jsonl --strict-read-only')process.exit(2);console.log(JSON.stringify({type:'session',cursor:'c1',session:{username:'wxid_synthetic',summary:'不得保留'}}));setInterval(()=>{},1000);`);
  const stream=await cli.sessionEventsFollow();
  assert.ok(Number.isInteger(stream.process_id)&&stream.process_id>0);
  assert.equal(await stream.read({timeoutMs:0}),null);
  assert.deepEqual(await stream.read({timeoutMs:2000}),{cursor:'c1',conversation_locator:'wxid_synthetic'});
  const waiting=stream.read({timeoutMs:2000});await stream.close();assert.equal(await waiting,null);assert.equal(stream.closed,true);
});
test('队列溢出不静默跳过事件，EOF及取消可供调度重连',async t=>{
  const cli=await fixture(t,`for(let n=0;n<3;n++)console.log(JSON.stringify({type:'session',cursor:'c'+n,username:'wxid_synthetic'}));`,{maxQueuedEvents:1});
  const stream=await cli.sessionEventsFollow();await stream.drained;
  await assert.rejects(stream.read(),{code:'cli_stream_overflow'});
  const empty=await fixture(t,`process.exit(0);`);const end=await empty.sessionEventsFollow();await end.drained;
  await assert.rejects(end.read(),{code:'cli_stream_closed'});
  const endless=await fixture(t,`setInterval(()=>{},1000);`);const controller=new AbortController();const cancelled=await endless.sessionEventsFollow({signal:controller.signal});controller.abort();await cancelled.drained;
  await assert.rejects(cancelled.read(),{code:'cli_cancelled'});
});
test('流结构化错误稳定脱敏，超长行拒绝',async t=>{
  const cli=await fixture(t,`console.log(JSON.stringify({ok:false,error:{code:'tool_error',message:'enc_key automatic key refresh is disabled sensitive'}}));`);
  const stream=await cli.sessionEventsFollow();await stream.drained;await assert.rejects(stream.read(),{code:'cli_key_refresh_required'});
  const noisy=await fixture(t,`process.stdout.write('x'.repeat(500));`,{maxOutputBytes:100});const other=await noisy.sessionEventsFollow();await other.drained;await assert.rejects(other.read(),{code:'cli_output_limit'});
});
test('adapter退出清空所有流并等待子进程关闭',async t=>{
  const cli=await fixture(t,`console.log(JSON.stringify({type:'session',cursor:'c',username:'wxid_synthetic'}));setInterval(()=>{},1000);`);
  const stream=await cli.sessionEventsFollow();assert.ok(await stream.read({timeoutMs:2000}));
  const waiting=stream.read({timeoutMs:2000});await cli.close();assert.equal(await waiting,null);assert.equal(stream.closed,true);
  await assert.rejects(cli.sessionEventsFollow(),{code:'cli_cancelled'});
});
test('增量尾读固定cursor参数保留事件，拒绝跨会话结果',async t=>{
  const cli=await fixture(t,`const a=process.argv.slice(2);if(a.join(' ')!=='tail wxid_synthetic --cursor old --limit 10 --include-media-paths false --strict-read-only')process.exit(2);console.log(JSON.stringify({ok:true,data:{events:[{type:'message',cursor:'new',message:{id:{local_id:8,talker:'wxid_synthetic'},kind:'text',text:'合成消息',is_from_me:false}}],cursor:'new',freshness:{message_source:'live_message_db'},query:{chat:'wxid_synthetic',has_more:false}}}));`);
  const page=await cli.tail('wxid_synthetic',{cursor:'old',limit:10});assert.equal(page.cursor,'new');assert.equal(page.events[0].text,'合成消息');assert.equal(page.freshness_confirmed,true);
  await assert.rejects(cli.tail('wxid_synthetic',{cursor:'old',sinceTime:'2026-01-01'}),{code:'cli_invalid_argument'});
  const mismatch=await fixture(t,`console.log(JSON.stringify({ok:true,data:{events:[],freshness:{message_source:'live_message_db'},query:{chat:'different',has_more:false}}}));`);await assert.rejects(mismatch.tail('wxid_synthetic'),{code:'cli_freshness_unknown'});
});
test('警告缺表不触发SQL；本地空会话保持empty而非完整历史',async t=>{
  const warn=await fixture(t,`const a=process.argv.slice(2);if(a[0]==='sql'){console.log(JSON.stringify({ok:false,error:{code:'invalid_argument'}}));process.exit(1);}console.log(JSON.stringify({ok:false,warnings:['partial'],error:{code:'tool_error',message:'table x not found in 2 message shards'}}));process.exitCode=1;`);
  await assert.rejects(warn.tail('wxid_synthetic'),{code:'cli_message_table_missing'});
  const empty=await fixture(t,`if(process.argv[2]==='tail'){console.log(JSON.stringify({ok:false,error:{code:'tool_error',message:'table x not found in 2 message shards'}}));process.exitCode=1;}else console.log(JSON.stringify({ok:true,data:{freshness:{message_source:'live_selected_db_read_only'},query:{has_more:false,returned:1},rows:[{deleted_count:0,session_count:1,empty_session_count:1}]}}));`);
  const result=await empty.tail("synthetic'quoted");assert.equal(result.local_history_state,'empty');assert.equal(result.cursor,null);
});
test('账号复验服从调用者剩余截止预算',async t=>{
  const cli=await fixture(t,`setInterval(()=>{},1000);`);
  const started=performance.now();
  await assert.rejects(cli.configuredAccount({timeoutMs:30}),{code:'cli_timeout'});
  assert.ok(performance.now()-started<1000,'应采用30ms调用预算，不能等默认5s状态预算');
});
test('全局流异常退出保留follow失败分类',async t=>{
  const cli=await fixture(t,`process.exit(7);`);const stream=await cli.sessionEventsFollow();await stream.drained;
  await assert.rejects(stream.read(),{code:'cli_follow_failed'});
});
test('已确认账号的任意重复复验只读status，绝不读取sessions摘要',async t=>{
  const cli=await fixture(t,`if(process.argv.slice(2).join(' ')!=='status --include-debug --strict-read-only')process.exit(2);console.log(JSON.stringify({ok:true,data:{status:{account:{identity_configured:true,schema2_ready:true},live_read_ok:true,readiness:'ready',mode:{strict_read_only:true},account_debug:{wxid:'wxid_synthetic'}}}}));`);
  for(let i=0;i<3;i++)assert.equal(await cli.configuredAccount({expectedAccount:'wxid_synthetic',timeoutMs:1000}),'wxid_synthetic');
});
