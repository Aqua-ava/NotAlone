import test from 'node:test';
import assert from 'node:assert/strict';
import { projectHistoryMessages, projectHistorySyncStatus } from '../src/history/sqlite/http.ts';

const id='00000000-0000-4000-8000-000000000001';
const coverage={goalId:id,contactId:id,bindingId:id,phase:'running',failureCode:null,cursor:'opaque',messageCount:2,nonTextCount:1,pageCount:2,quarantinedCount:0};
const message=(changes={})=>({id,contactId:id,bindingId:id,sender:'contact',kind:'text',text:'合成文字',originalType:'1',sentAt:'1001',timePrecision:'millisecond',orderScheme:null,orderKey:null,ordering:'unknown',displayPosition:'9007199254740993',sourceRecordIds:[id],...changes});
test('消息HTTP投影保留非文字占位、未知顺序与精确显示位置，分页不暴露渠道游标',()=>{
 const projected=projectHistoryMessages({messages:[message(),message({id:'00000000-0000-4000-8000-000000000002',kind:'voice',text:null})],coverage,replyEligibility:'history_syncing'},1);
 assert.equal(projected.messages[0].occurred_at,'1970-01-01T00:00:01.001Z');
 assert.equal(projected.messages[0].display_position,'9007199254740993');
 assert.equal(projected.messages[0].ordering,'unknown');
 assert.equal(projected.next_cursor,id);
 assert.equal(projected.reply_eligibility,'history_syncing');
 assert.equal(JSON.stringify(projected).includes('opaque'),false);
 const voice=projectHistoryMessages({messages:[message({kind:'voice',text:null})],coverage,replyEligibility:'history_syncing'},20);
 assert.equal(voice.messages[0].text,null);assert.equal(voice.messages[0].media_placeholder,'[语音]');
 assert.deepEqual(voice.messages[0].source_record_ids,[id]);
});
test('同步HTTP投影映射运行状态并报告文字与占位，不把部分读取标成完整',()=>{
 const projected=projectHistorySyncStatus({sync_enabled:true},[coverage]);
 assert.equal(projected.cli_history_authorization_state,'accepted');
 assert.equal(projected.cli_history_coverages[0].phase,'syncing');
 assert.equal(projected.cli_history_coverages[0].message_count,1);
 assert.equal(projected.cli_history_coverages[0].non_text_count,1);
 assert.equal(projected.cli_backfill_completed_contacts,0);
 assert.equal(projected.cli_backfill_phase,'backfilling');
 const incomplete=projectHistorySyncStatus({},[{...coverage,phase:'incomplete',failureCode:'history_identity_conflict'}]);
 assert.equal(incomplete.cli_backfill_incomplete_contacts,1);
 assert.equal(incomplete.cli_history_coverages[0].failure_code,'history_identity_conflict');
});

test('同步HTTP投影单独报告增量检查点与降级，不把不可用或受阻标成已同步',()=>{
 const incremental={goalId:'00000000-0000-4000-8000-000000000003',phase:'ready',failureCode:null,cursorPresent:true,pagesAccepted:3,lastAcceptedAt:1700000000000,resumedFromGoalId:id};
 const projected=projectHistorySyncStatus({sync_enabled:true},[{...coverage,phase:'complete',incremental}]);
 assert.equal(projected.cli_history_coverages[0].incremental_phase,'ready');
 assert.equal(projected.cli_history_coverages[0].incremental_pages,3);
 assert.equal(projected.cli_history_coverages[0].incremental_last_accepted_at,1700000000000);
 assert.equal(projected.cli_incremental_phase,'idle');
 assert.equal(projected.cli_incremental_failure_code,null);
 // 运行状态覆盖持久阶段：受阻可见且优先于检查点。
 const blocked=projectHistorySyncStatus({},[{...coverage,phase:'complete',incremental}],undefined,{phase:'blocked',lastError:null,contacts:[{contactId:id,phase:'blocked',lastError:'history_tail_unsupported'}]});
 assert.equal(blocked.cli_history_coverages[0].incremental_phase,'blocked');
 assert.equal(blocked.cli_history_coverages[0].incremental_failure_code,'history_tail_unsupported');
 assert.equal(blocked.cli_incremental_phase,'incomplete');
 assert.equal(blocked.cli_incremental_failure_code,'history_tail_unsupported');
 // 交接不可证明：全部不可用时不伪报已同步。
 const unavailable=projectHistorySyncStatus({},[{...coverage,phase:'complete',incremental:{goalId:null,phase:'unavailable',failureCode:'history_incremental_unavailable',cursorPresent:false,pagesAccepted:0,lastAcceptedAt:null,resumedFromGoalId:null}}]);
 assert.equal(unavailable.cli_incremental_phase,'unavailable');
 assert.equal(unavailable.cli_history_coverages[0].incremental_failure_code,'history_incremental_unavailable');
});

test('已认证空目标只投影为等待新消息，不造成不可用或全局degraded',()=>{
 const empty={...coverage,phase:'complete',failureCode:null,messageCount:0,nonTextCount:0,
  incremental:{goalId:null,phase:'unavailable',failureCode:'history_incremental_unavailable',cursorPresent:false,pagesAccepted:0,lastAcceptedAt:null,resumedFromGoalId:null,emptyTargetAwaitingMessages:true}};
 const projected=projectHistorySyncStatus({sync_enabled:true,cli_bound_count:1,cli_sync_phase:'degraded',cli_failure_code:'wechat_body_unavailable'},[empty],undefined,
  {phase:'blocked',lastError:'history_incremental_unavailable',contacts:[{contactId:id,phase:'blocked',lastError:'history_incremental_unavailable'}]},false);
 assert.equal(projected.cli_sync_phase,'active');
 assert.equal(projected.cli_failure_code,null);
 assert.equal(projected.body_available,false,'空目标不应伪报消息正文读取能力');
 assert.equal(projected.cli_history_coverages[0].incremental_phase,'not_started');
 assert.equal(projected.cli_history_coverages[0].incremental_failure_code,null);
 assert.equal(projected.cli_history_coverages[0].incremental_waiting_for_messages,true);
 assert.equal(projected.cli_incremental_phase,'idle');
 assert.equal(projected.cli_incremental_failure_code,null);
 const paused=projectHistorySyncStatus({sync_enabled:false,cli_bound_count:1,cli_sync_phase:'disabled'},[empty]);
 assert.equal(paused.cli_history_coverages[0].incremental_waiting_for_messages,undefined,'总开关关闭时不能宣称还会定期检查');
 const failed=projectHistorySyncStatus({sync_enabled:true,cli_bound_count:1,cli_sync_phase:'degraded'},[empty],undefined,
  {phase:'blocked',lastError:'history_snapshot_window_changed',contacts:[{contactId:id,phase:'degraded',lastError:'history_snapshot_window_changed'}]},false);
 assert.equal(failed.cli_history_coverages[0].incremental_failure_code,'history_snapshot_window_changed','真实瞬时错误仍须可见');
 assert.equal(failed.cli_history_coverages[0].incremental_waiting_for_messages,undefined);
});
