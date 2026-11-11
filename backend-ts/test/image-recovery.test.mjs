import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverImageTargets} from '../src/memory/extraction/image-recovery.ts';
const signal=()=>new AbortController().signal;
const image=id=>({id,kind:'image'}),text=id=>({id,kind:'text'}),isImage=target=>target.kind==='image';
const recoverable=()=>Object.assign(new Error('synthetic image failure'),{code:'synthetic_image_failure'});
const canRecover=error=>error?.code==='synthetic_image_failure';

test('正常窗口只调用根节点一次，保持目标与图片上下文',async()=>{
 const targets=[text('t1'),image('i1')],calls=[];
 const result=await recoverImageTargets({targets,isImage,signal:signal(),canRecover,
  run:async(items,options)=>{calls.push({items,options});return 'ok';},supersede:async()=>{throw new Error('不得释放成功窗口');}});
 assert.deepEqual(calls,[{items:targets,options:{slot:0,tier:'primary',includeImageContext:true}}]);
 assert.deepEqual(result,{results:[{targets,value:'ok',slot:0}]});
});

test('失败父窗先释放再按图片数对半拆分，文字目标不重复且子窗不带图片上下文',async()=>{
 const targets=[text('t0'),image('i1'),text('t1'),image('i2'),text('t2'),image('i3'),text('t3')],events=[];
 const result=await recoverImageTargets({targets,isImage,signal:signal(),canRecover,
  run:async(items,attempt)=>{events.push({kind:'run',ids:items.map(item=>item.id),...attempt});if(attempt.slot===0)throw recoverable();return attempt.slot;},
  supersede:async({slot})=>{events.push({kind:'supersede',slot});}});
 assert.deepEqual(events.map(event=>[event.kind,event.slot]),[['run',0],['supersede',0],['run',1],['run',2]]);
 assert.deepEqual(result.results.map(row=>row.targets),[targets.slice(0,4),targets.slice(4)]);
 assert.deepEqual(result.results.flatMap(row=>row.targets),targets);
 assert.equal(events[2].includeImageContext,false);assert.equal(events[3].includeImageContext,false);
});

test('单图只追加一次更小版本，不重发根请求，耗尽后先释放再抛出',async()=>{
 const targets=[text('t'),image('i')],events=[],failure=recoverable();
 await assert.rejects(recoverImageTargets({targets,isImage,signal:signal(),canRecover,
  run:async(items,attempt)=>{events.push({kind:'run',...attempt});throw failure;},supersede:async({slot})=>{events.push({kind:'supersede',slot});}}),error=>error===failure);
 assert.deepEqual(events,[{kind:'run',slot:0,tier:'primary',includeImageContext:true},{kind:'supersede',slot:0},
  {kind:'run',slot:64,tier:'degraded',includeImageContext:false},{kind:'supersede',slot:64}]);
});

test('文字目标遇到图片上下文失败，只追加去除图片上下文的不同窗口',async()=>{
 const targets=[text('t1'),text('t2')],calls=[],superseded=[];
 const result=await recoverImageTargets({targets,isImage,signal:signal(),canRecover,
  run:async(items,attempt)=>{calls.push(attempt);if(attempt.includeImageContext)throw recoverable();return 'text-ok';},supersede:async({slot})=>{superseded.push(slot);}});
 assert.deepEqual(calls,[{slot:0,tier:'primary',includeImageContext:true},{slot:128,tier:'primary',includeImageContext:false}]);
 assert.deepEqual(superseded,[0]);assert.deepEqual(result,{results:[{targets,value:'text-ok',slot:128}]});
});

test('重启跳过已持久释放的父窗，不重复发送或释放，耗尽叶也不盲重发',async()=>{
 const targets=[image('i1'),image('i2')],slots=[];
 const result=await recoverImageTargets({targets,isImage,signal:signal(),canRecover,previouslyDegraded:new Set([0]),
  run:async(items,{slot})=>{slots.push(slot);return slot;},supersede:async()=>{throw new Error('不能重复释放');}});
 assert.deepEqual(slots,[1,2]);assert.deepEqual(result.results.map(row=>row.slot),[1,2]);
 await assert.rejects(recoverImageTargets({targets:[image('i')],isImage,signal:signal(),canRecover,previouslyDegraded:new Set([0,64]),
  run:async()=>{throw new Error('不能重复发送耗尽叶');},supersede:async()=>{throw new Error('不能重复释放');}}),error=>error.code==='media_model_input_unavailable'&&error.slot===64);
});

test('8图完整降级最多23个不同窗口，每个成功叶各自覆盖文字与图片目标',async()=>{
 const targets=Array.from({length:8},(_,index)=>[text(`t${index}`),image(`i${index}`)]).flat().concat(text('tail'));
 const calls=[],released=[];
 const result=await recoverImageTargets({targets,isImage,signal:signal(),canRecover,
  run:async(items,attempt)=>{calls.push(attempt);if(attempt.tier==='primary')throw recoverable();return items.map(item=>item.id);},
  supersede:async attempt=>{released.push(attempt);}});
 assert.equal(calls.length,23);assert.equal(new Set(calls.map(call=>call.slot)).size,23);
 assert.equal(released.length,15);assert.equal(result.results.length,8);assert.deepEqual(result.results.flatMap(row=>row.targets),targets);
 assert.equal(Math.max(...calls.map(call=>call.slot)),78);assert.ok(calls.slice(1).every(call=>call.includeImageContext===false));
 assert.deepEqual(released[0],{slot:0,targets,tier:'primary',includeImageContext:true});
});

test('超过8图在任何请求与释放之前拒绝，不能扩大降级树预算',async()=>{
 let calls=0;
 await assert.rejects(recoverImageTargets({targets:Array.from({length:9},(_,index)=>image(`i${index}`)),isImage,signal:signal(),canRecover,
  run:async()=>{calls++;return null;},supersede:async()=>{calls++;}}),/memory_image_recovery_plan_invalid/);
 assert.equal(calls,0);
});

test('未知回执与权限失败不拆分也不释放，取消不会继续子窗，释放失败立即停止',async()=>{
 for(const code of ['model_receipt_unknown','authorization_revoked']){
  const failure=Object.assign(new Error(code),{code});let runs=0,releases=0;
  await assert.rejects(recoverImageTargets({targets:[image('i1'),image('i2')],isImage,signal:signal(),canRecover,
   run:async()=>{runs++;throw failure;},supersede:async()=>{releases++;}}),error=>error===failure);
  assert.equal(runs,1);assert.equal(releases,0);
 }
 const controller=new AbortController();let releases=0;
 await assert.rejects(recoverImageTargets({targets:[image('i1'),image('i2')],isImage,signal:controller.signal,canRecover,
  run:async()=>{controller.abort();throw recoverable();},supersede:async()=>{releases++;}}),{name:'AbortError'});
 assert.equal(releases,0);
 let runs=0;
 await assert.rejects(recoverImageTargets({targets:[image('i1'),image('i2')],isImage,signal:signal(),canRecover,
  run:async()=>{runs++;throw recoverable();},supersede:async()=>{throw new Error('synthetic_release_failed');}}),/synthetic_release_failed/);
 assert.equal(runs,1);
});
