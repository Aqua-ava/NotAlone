import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {NativeForegroundProbe,safeForegroundProbeCode} from '../src/foreground/foreground-location-probe.ts';
const fixture=fileURLToPath(new URL('./foreground-location-probe.fixture.mjs',import.meta.url));
const probe=mode=>new NativeForegroundProbe({executable:process.execPath,args:[fixture,mode??'normal']});
test('预热状态是稳定的领域可投影原因', () => {
  assert.equal(safeForegroundProbeCode('probe_warming'), 'probe_warming');
  assert.equal(safeForegroundProbeCode('probe_warmup_timeout'), 'probe_warmup_timeout');
});
test('start waits for warm readiness and first observation reuses that worker', async () => {
  const p = probe('warm-delay');
  try {
    assert.equal(await p.start(), undefined);
    const first = await p.observe({timeoutMs:1000});
    const second = await p.observe({timeoutMs:1000});
    assert.match(first.display_name, /^合成\d+-1$/);
    assert.equal(second.display_name, first.display_name.replace(/-1$/, '-2'));
  } finally {
    await p.dispose();
  }
});
test('observation during warmup fails without killing the worker', async () => {
  const p = probe('warm-delay');
  try {
    const warming = p.start();
    await assert.rejects(p.observe({timeoutMs:20}), {code:'probe_warming'});
    await warming;
    const observation = await p.observe({timeoutMs:1000});
    assert.match(observation.display_name, /^合成\d+-1$/);
  } finally {
    await p.dispose();
  }
});
test('warmup timeout kills the wedged worker and a later start recovers', async () => {
  const p = probe('warm-delay');
  try {
    await assert.rejects(p.start({timeoutMs:20}), {code:'probe_warmup_timeout'});
    await p.start({timeoutMs:1000});
    assert.equal((await p.observe({timeoutMs:1000})).wechat_in_front, true);
  } finally {
    await p.dispose();
  }
});
test('原生进程复用但每轮重新观察，关闭后允许明确重启',async()=>{
 const p=probe();try {const first=await p.observe({timeoutMs:1000});const second=await p.observe({timeoutMs:1000});assert.match(first.display_name,/^合成\d+-1$/);assert.equal(second.display_name,first.display_name.replace(/-1$/,'-2'));await p.close();const third=await p.observe({timeoutMs:1000});assert.notEqual(third.display_name,first.display_name);assert.match(third.display_name,/-1$/);}finally{await p.dispose();}
});
for(const mode of ['old-id','duplicate','oversized','multi','utf8','bad-header','float-version','invalid-date','bool-confidence','extra-quality','bad-fallback']) test(`协议拒绝 ${mode} 且不回显内容`,async()=>{
 const p=probe(mode);try{await assert.rejects(p.observe({timeoutMs:1000}),error=>error.code==='probe_output_invalid'&&!error.message.includes('秘密'));}finally{await p.dispose();}
});
test('自动预热超预算时保留进程，完成后下一次观察成功',async()=>{
 const p=probe('ready-delay');try{await assert.rejects(p.observe({timeoutMs:60}),{code:'probe_warming'});const result=await p.observe({timeoutMs:1000});assert.match(result.display_name,/^合成\d+-1$/);}finally{await p.dispose();}
});
test('真实观察挂起仍按本轮超时并回收',async()=>{
 const p=probe('hang');try{await assert.rejects(p.observe({timeoutMs:60}),{code:'probe_timeout'});await assert.rejects(p.observe({timeoutMs:60}),{code:'probe_timeout'});}finally{await p.dispose();}
});
test('取消中断在途观察，close可重启，dispose永久停机',async()=>{
 const p=probe('hang');const abort=new AbortController();const result=p.observe({signal:abort.signal,timeoutMs:1000});setTimeout(()=>abort.abort(),50);await assert.rejects(result,{code:'probe_failed'});await p.close();assert.equal((await p.observe({timeoutMs:1000})).wechat_in_front,true);await p.dispose();await assert.rejects(p.observe(),{code:'probe_failed'});
});
test('权限错误熔断，close不恢复；stderr洪泛不阻塞或泄露',async()=>{
 const p=probe('permission');try{await assert.rejects(p.observe(),{code:'screen_capture_permission_missing'});await p.close();await assert.rejects(p.observe(),{code:'screen_capture_permission_missing'});p.resetPermissionGate();await assert.rejects(p.observe(),{code:'screen_capture_permission_missing'});}finally{await p.dispose();}
 const q=probe('stderr');try{assert.equal((await q.observe()).wechat_in_front,true);}finally{await q.dispose();}
});

test('保留旧单帧协议、完整低置信度及emoji文字候选供领域层判定',async()=>{
 for(const mode of ['legacy','low-confidence','fallback']){const p=probe(mode);try{const result=await p.observe();if(mode==='legacy'){assert.equal(result.capture_version,'automatic-window-v2');assert.equal(result.selected_row_name,result.display_name);}if(mode==='low-confidence')assert.equal(result.quality.display_name_confidence,0.4);if(mode==='fallback')assert.equal(result.text_fallback.text,'合成');}finally{await p.dispose();}}
});
test('未知原生错误码不进入公共失败消息',async()=>{
 const p=probe('unknown-error');try{await assert.rejects(p.observe(),{code:'probe_failed',message:'probe_failed'});}finally{await p.dispose();}
});
test('不存在可执行文件映射稳定错误',async()=>{
 const p=new NativeForegroundProbe({executable:'/tmp/notalone-no-such-synthetic-probe'});try{await assert.rejects(p.observe(),{code:'probe_not_found'});}finally{await p.dispose();}
});
test('排队耗时计入同轮预算并取消旧进程，不能发布迟到结果',async()=>{
 const p=probe('hang');try{const first=assert.rejects(p.observe({timeoutMs:1000}),{code:'probe_failed'});const second=assert.rejects(p.observe({timeoutMs:60}),{code:'probe_timeout'});await Promise.all([first,second]);assert.equal((await p.observe({timeoutMs:1000})).wechat_in_front,true);}finally{await p.dispose();}
});

test('空闲EOF后重建，非请求期间的字节不能成为下一次观察',async()=>{
 const p=probe('idle-exit');try{const first=await p.observe();await new Promise(resolve=>setTimeout(resolve,30));const next=await p.observe();assert.notEqual(first.display_name,next.display_name);}finally{await p.dispose();}
 const q=probe('idle-extra');try{await q.observe();await new Promise(resolve=>setTimeout(resolve,30));await assert.rejects(q.observe(),{code:'probe_output_invalid'});}finally{await q.dispose();}
});
test('主动close立即取消在途观察，原进程退出后下一次观察可启动',async()=>{
 const p=probe('hang');try{const first=assert.rejects(p.observe(),{code:'probe_failed'});await new Promise(resolve=>setTimeout(resolve,30));await p.close();await first;assert.equal((await p.observe()).wechat_in_front,true);}finally{await p.dispose();}
});

test('原生进程使用受控环境，不继承宿主秘密变量',async()=>{
 const before=process.env.NOTALONE_PROBE_TEST_SECRET;process.env.NOTALONE_PROBE_TEST_SECRET='合成秘密不可继承';const p=probe('environment');
 try{assert.equal((await p.observe()).display_name,'环境已隔离');}finally{await p.dispose();if(before===undefined)delete process.env.NOTALONE_PROBE_TEST_SECRET;else process.env.NOTALONE_PROBE_TEST_SECRET=before;}
});
test('空闲无请求时保持同一常驻 Worker',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});const p=probe();
 try{await p.start();const first=await p.observe();context.mock.timers.tick(120_000);const second=await p.observe();assert.equal(second.display_name,first.display_name.replace(/-1$/,'-2'));}finally{await p.dispose();context.mock.timers.reset();}
});
