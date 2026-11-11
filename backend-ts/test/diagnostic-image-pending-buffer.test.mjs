import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

// 独立进程保证尚未安装写者；通过公开上下文接点观察惰性队列交接，不访问真实资料或模型。
test('图片擦除重排惰性队列保留原溢出计数、观察时刻与联系人保护',()=>{
 const context=new URL('../src/diagnostics/context.ts',import.meta.url).href;
 const source=`import {diagnoseObserved,eraseModelImageDiagnostic,registerDiagnosticLog} from ${JSON.stringify(context)};
 process.env.NOTALONE_DIAGNOSTIC_ROOT='/tmp/notalone-synthetic-unused-pending-root';
 const observedAt=Date.now(),observedNs=process.hrtime.bigint(),noticeNs=observedNs-1n;
 const imageId='00000000-0000-4000-8000-000000000001';
 diagnoseObserved({event:'processing.model_image',callId:'00000000-0000-4000-8000-000000000002',imageId,
  originalBytes:10,sentBytes:20,imageCount:1,requestBytes:30,stage:'before_send',failureCategory:'other'},observedAt,observedNs);
 diagnoseObserved({event:'diagnostics.error',module:'diagnostics',reasonCode:'budget_exhausted',caller:'diagnostic_transport',count:5,contactPrefix:'bbbbbbbb'},observedAt,noticeNs);
 for(let index=0;index<4097;index++)diagnoseObserved({event:'diagnostics.changed',count:1,contactPrefix:'aaaaaaaa'},observedAt,observedNs);
 const clearing=eraseModelImageDiagnostic(imageId),published=[];
 // 同步安装合成接收方，使异步惰性导入不创建任何日志目录。
 registerDiagnosticLog({eraseModelImage:async()=>true},(event,at,ns,protection)=>published.push({event,at,ns,protection}));
 const removed=await clearing;
 const notices=published.filter(row=>row.event.event==='diagnostics.error'&&row.event.reasonCode==='budget_exhausted');
 process.stdout.write(JSON.stringify({removed,images:published.filter(row=>row.event.imageId===imageId).length,
  ordinary:published.filter(row=>row.event.event==='diagnostics.changed').length,
  notices:notices.map(row=>({caller:row.event.caller,count:row.event.count,
   originalTime:row.at===observedAt&&row.ns===(row.event.caller==='diagnostic_transport'?noticeNs:observedNs),
   contactPrefix:row.protection?.contactPrefix})).sort((a,b)=>a.caller.localeCompare(b.caller))}));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH},encoding:'utf8',timeout:10_000});
 assert.equal(child.status,0,child.stderr);
 assert.deepEqual(JSON.parse(child.stdout),{removed:true,images:0,ordinary:4095,notices:[
  {caller:'diagnostic_lazy',count:2,originalTime:true,contactPrefix:'aaaaaaaa'},
  {caller:'diagnostic_transport',count:5,originalTime:true,contactPrefix:'bbbbbbbb'},
 ]});
});
