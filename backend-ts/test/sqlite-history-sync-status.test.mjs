import test from 'node:test';
import assert from 'node:assert/strict';
import {projectHistorySyncStatus} from '../src/history/sqlite/http.ts';

const coverage=(id,phase='not_started')=>({goalId:phase==='not_started'?null:'synthetic-goal',contactId:id,bindingId:'binding-'+id,phase,failureCode:null,cursor:null,messageCount:phase==='complete'?2:0,nonTextCount:0,pageCount:phase==='complete'?1:0,quarantinedCount:0});
test('首次渠道在goal建立前受阻，状态显示原因但不伪造持久覆盖或正文资格',()=>{
 const rows=[coverage('a')],before=structuredClone(rows);
 const result=projectHistorySyncStatus({body_available:false},rows,{phase:'blocked',lastError:'history_support_unverified',contacts:[{contactId:'a',phase:'blocked',lastError:'history_support_unverified'}]});
 assert.equal(result.body_available,false);assert.equal(result.cli_backfill_phase,'incomplete');
 assert.equal(result.cli_backfill_failure_code,'history_support_unverified');assert.equal(result.cli_backfill_incomplete_contacts,1);assert.equal(result.cli_backfill_pending_contacts,0);
 assert.equal(result.cli_failure_code,'history_support_unverified','具体的支持阻断原因应覆盖泛化的正文不可用提示');
 assert.equal(result.cli_history_coverages[0].phase,'not_started');assert.equal(result.cli_history_coverages[0].failure_code,'history_support_unverified');assert.deepEqual(rows,before);
});
test('已完成覆盖不被旧派发错误降级，其他有效读取仍显示进行中',()=>{
 const rows=[coverage('a','complete'),coverage('b'),coverage('c')];
 const result=projectHistorySyncStatus({body_available:false},rows,{phase:'running',lastError:'history_source_changed',contacts:[{contactId:'a',phase:'blocked',lastError:'history_source_changed'},{contactId:'b',phase:'blocked',lastError:'history_message_state_unverified'},{contactId:'c',phase:'running',lastError:null}]});
 assert.equal(result.cli_backfill_phase,'backfilling');assert.equal(result.cli_backfill_completed_contacts,1);assert.equal(result.cli_backfill_incomplete_contacts,1);assert.equal(result.cli_backfill_pending_contacts,1);
 assert.equal(result.cli_history_coverages[0].failure_code,null);assert.equal(result.cli_backfill_failure_code,'history_message_state_unverified');
});
test('首次名单读取失败在没有逐人状态时仍可见且不报完成',()=>{
 const result=projectHistorySyncStatus({},[coverage('a')],{phase:'blocked',lastError:'history_first_directory_failed',contacts:[]});
 assert.equal(result.cli_backfill_phase,'incomplete');assert.equal(result.cli_backfill_failure_code,'history_first_directory_failed');assert.equal(result.cli_backfill_completed_contacts,0);
});
test('新的全局名单失败替换旧逐人错误，已完成覆盖保持不变',()=>{
 const result=projectHistorySyncStatus({},[coverage('a'),coverage('b','complete')],{phase:'blocked',lastError:'history_first_directory_failed',contacts:[{contactId:'a',phase:'blocked',lastError:'history_support_unverified'}]});
 assert.equal(result.cli_backfill_failure_code,'history_first_directory_failed');
 assert.equal(result.cli_history_coverages[0].failure_code,'history_first_directory_failed');
 assert.equal(result.cli_history_coverages[1].failure_code,null);assert.equal(result.cli_history_coverages[1].phase,'complete');
});
test('历史覆盖和旧状态不代替当前正文能力核验，并保留本次真实同步失败原因',()=>{
 const result=projectHistorySyncStatus({body_available:true,cli_failure_code:'wechat_body_unavailable'},[coverage('a')],
  {phase:'blocked',lastError:'history_message_state_unverified',contacts:[{contactId:'a',phase:'blocked',lastError:'history_message_state_unverified'}]});
 assert.equal(result.body_available,false);assert.equal(result.cli_failure_code,'history_message_state_unverified');
 assert.equal(result.cli_history_coverages[0].phase,'not_started');assert.equal(result.cli_history_coverages[0].failure_code,'history_message_state_unverified');
});
test('正文能力只接受宿主传入的当前认证信号，不以历史消息数推断',()=>{
 const empty=coverage('a','complete');empty.messageCount=0;
 assert.equal(projectHistorySyncStatus({},[empty]).body_available,false);
 assert.equal(projectHistorySyncStatus({body_available:false},[empty],undefined,undefined,true).body_available,true);
});
test('当前能力认证后清除泛化不可用占位并投影后台阶段，具体失败仍保留',()=>{
 const base={body_available:false,cli_sync_phase:'degraded',cli_failure_code:'wechat_body_unavailable',sync_enabled:true};
 const active=projectHistorySyncStatus(base,[coverage('a','complete')],undefined,undefined,true);
 assert.equal(active.cli_sync_phase,'active');assert.equal(active.cli_failure_code,null);
 const waiting=projectHistorySyncStatus({...base,sync_enabled:true},[],undefined,undefined,true);
 assert.equal(waiting.cli_sync_phase,'waiting_bindings');assert.equal(waiting.cli_failure_code,null);
 const disabled=projectHistorySyncStatus({...base,sync_enabled:false},[coverage('a','complete')],undefined,undefined,true);
 assert.equal(disabled.cli_sync_phase,'disabled');
 const failed=projectHistorySyncStatus(base,[{...coverage('a'),phase:'incomplete',failureCode:'history_native_unavailable'}],undefined,undefined,true);
 assert.equal(failed.cli_sync_phase,'degraded');assert.equal(failed.cli_failure_code,'history_native_unavailable');
});
