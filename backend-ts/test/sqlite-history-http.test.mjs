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
