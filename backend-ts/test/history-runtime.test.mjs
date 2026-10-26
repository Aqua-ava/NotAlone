import test from 'node:test';
import assert from 'node:assert/strict';
import {projectHistoryCoverages,resolveHistoryRuntime} from '../src/imports/history-runtime.ts';

const binding='22222222-2222-2222-2222-222222222222';
const contact='33333333-3333-3333-3333-333333333333';
const coverage={
  binding_id:binding,contact_id:contact,phase:'syncing',failure_code:null,
  message_count:2,non_text_count:1,page_count:1,last_local_id:'7',last_cursor:'opaque-cursor',
  watermark_at:'2026-10-25T00:00:00.000Z',started_at:'2026-10-25T00:01:00.000Z',
  completed_at:null,updated_at:'2026-10-25T00:02:00.000Z',
};

test('历史执行方默认唯一typescript，缺少远端或旧选择均失败关闭',()=>{
  assert.equal(resolveHistoryRuntime({}, {incrementalRemoteAvailable:true}),'typescript');
  assert.equal(resolveHistoryRuntime({NOTALONE_HISTORY_RUNTIME:'typescript'}, {incrementalRemoteAvailable:true}),'typescript');
  for(const value of ['', 'python', 'typo', 'TypeScript']){
    assert.throws(()=>resolveHistoryRuntime({NOTALONE_HISTORY_RUNTIME:value}, {incrementalRemoteAvailable:true}),/history_runtime_invalid/);
  }
  assert.throws(()=>resolveHistoryRuntime({NOTALONE_HISTORY_RUNTIME:'typescript'}, {incrementalRemoteAvailable:false}),/history_runtime_incremental_required/);
});

test('公开历史覆盖只投影桌面合同字段并拒绝坏TS状态',()=>{
  assert.deepEqual(projectHistoryCoverages([coverage]),[{
    binding_id:binding,contact_id:contact,phase:'syncing',failure_code:null,
    message_count:2,non_text_count:1,page_count:1,last_cursor:'opaque-cursor',
    watermark_at:'2026-10-25T00:00:00.000Z',started_at:'2026-10-25T00:01:00.000Z',
    completed_at:null,updated_at:'2026-10-25T00:02:00.000Z',
  }]);
  for(const value of [
    undefined,
    [{...coverage,phase:'complete?'}],
    [{...coverage,message_count:-1}],
    [{...coverage,last_cursor:' '}],
    [{...coverage,updated_at:'not-a-date'}],
  ]) assert.throws(()=>projectHistoryCoverages(value),/history_coverages_invalid/);
});
