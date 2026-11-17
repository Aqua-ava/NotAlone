import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const bundled=await build({stdin:{contents:`
 import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
 import { ContactHistoryCoverage } from './src/renderer/HistoryCoverageStatus';
 export { readContactHistoryMessages, mergeContactHistoryMessages } from './src/main/contact-history/messages';
 export function renderCoverage(row) { return renderToStaticMarkup(<ContactHistoryCoverage contactId='c' bodyAvailable={true} coverages={[{bindingId:'b',contactId:'c',phase:'complete',failureCode:null,messageCount:0,nonTextCount:0,pageCount:1,...row}]} />); }
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'}});
const loaded={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const {readContactHistoryMessages,mergeContactHistoryMessages,renderCoverage}=loaded.exports;
const id='00000000-0000-4000-8000-000000000001';
const wire=(changes={})=>({message_id:id,speaker:'contact',message_type:'voice',text:null,media_placeholder:'[语音]',occurred_at:'2026-01-01T00:00:00.000Z',quoted:null,ordering:'unknown',display_position:'9007199254740993',...changes});
const backend=items=>({requestJson:async()=>({generation:1,data:{messages:items,next_cursor:null}})});
test('联系人历史保留未知先后声明，晚保存旧消息不挤占近期消息',async()=>{
 const read=await readContactHistoryMessages(backend([wire()]),id,null,new AbortController().signal);
 assert.equal(read.messages[0].ordering,'unknown');
 assert.equal(read.messages[0].displayPosition,'9007199254740993');
 const other={...read.messages[0],messageId:'00000000-0000-4000-8000-000000000002',displayPosition:'9007199254740992',occurredAt:'2026-02-01T00:00:00.000Z'};
 assert.deepEqual(mergeContactHistoryMessages([other],read.messages).map(m=>m.messageId),[other.messageId,id]);
 assert.equal(mergeContactHistoryMessages([other],read.messages).length,2);
});
test('联系人历史使用时间分页接口并原样续接同范围游标',async()=>{
 const requests=[],before='00000000-0000-4000-8000-000000000003';
 await readContactHistoryMessages({requestJson:async request=>{requests.push(request);return {generation:1,data:{messages:[wire()],next_cursor:null}};}},id,before,new AbortController().signal);
 assert.equal(requests[0].path,`/api/contacts/${id}/history-messages?limit=20&before=${before}`);
});
test('联系人历史保留微秒、同时间大整数位置和未知时间的稳定展示',()=>{
 const known={messageId:id,occurredAt:'2026-10-31T12:00:00.000002Z',displayPosition:'1'};
 const same={...known,messageId:'00000000-0000-4000-8000-000000000002',displayPosition:'9007199254740994'};
 const earlier={...known,messageId:'00000000-0000-4000-8000-000000000003',occurredAt:'2026-10-31T12:00:00.000001Z',displayPosition:'9007199254740995'};
 const unknown={...known,messageId:'00000000-0000-4000-8000-000000000004',occurredAt:null,displayPosition:'9007199254740996'};
 assert.deepEqual(mergeContactHistoryMessages([earlier,unknown],[known,same]),[same,known,earlier,unknown]);
});
test('消息解析拒绝缺少顺序声明或非法展示位置，保留旧消息合同',async()=>{
 for(const change of [{ordering:undefined},{display_position:'9007199254740993.1'},{ordering:'guessed'},{display_position:'-1'}]) {
  await assert.rejects(readContactHistoryMessages(backend([wire(change)]),id,null,new AbortController().signal));
 }
 const old=wire();delete old.ordering;delete old.display_position;
 const read=await readContactHistoryMessages(backend([old]),id,null,new AbortController().signal);
 assert.equal(read.messages[0].ordering,undefined);
});

test('系统等独立元数据单独计数，不误称为空历史或聊天正文',()=>{
 const html=renderCoverage({metadataOnlyCount:3});
 assert.match(html,/另保存 3 条系统等元数据记录/);
 assert.match(html,/不含正文/);
 assert.doesNotMatch(html,/当前范围内暂无可读历史|部分历史尚未核验/);
 assert.match(renderCoverage({metadataOnlyCount:0}),/当前范围内暂无可读历史/);
});
