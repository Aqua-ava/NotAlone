import test from 'node:test';
import assert from 'node:assert/strict';
import {projectHistorySyncStatus} from '../src/history/sqlite/http.ts';

const coverage=(id,phase='not_started')=>({goalId:phase==='not_started'?null:'synthetic-goal',contactId:id,bindingId:'binding-'+id,phase,failureCode:null,cursor:null,messageCount:phase==='complete'?2:0,nonTextCount:0,pageCount:phase==='complete'?1:0,quarantinedCount:0});
test('首次渠道在goal建立前受阻，状态显示原因但不伪造持久覆盖或正文资格',()=>{
 const rows=[coverage('a')],before=structuredClone(rows);
 const result=projectHistorySyncStatus({body_available:false},rows,{phase:'blocked',lastError:'history_support_unverified',contacts:[{contactId:'a',phase:'blocked',lastError:'history_support_unverified'}]});
 assert.equal(result.body_available,false);assert.equal(result.cli_backfill_phase,'incomplete');
 assert.equal(result.cli_backfill_failure_code,'history_support_unverified');assert.equal(result.cli_backfill_incomplete_contacts,1);assert.equal(result.cli_backfill_pending_contacts,0);
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
