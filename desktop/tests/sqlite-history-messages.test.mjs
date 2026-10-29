import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const bundled=await build({stdin:{contents:`
 import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
 import { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
 export { readReplyMessages, mergeReplyMessages } from './src/main/reply/messages';
 export function render(items,extra={}) { return renderToStaticMarkup(<UnifiedReplyWorkspace contacts={{state:{selectedContactId:'c',scopeRevision:1,draft:''}}} replies={{state:{contactId:'c',scopeRevision:1,phase:'idle',mode:'rewrite_draft',options:{tone:'original',instruction:'',inputKind:'workspace',includeRelationshipContext:true},savedSession:{phase:'ready',sessionId:'s'},messages:{phase:'ready',items},...extra}}} />); }
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,loader:{'.css':'empty'}});
const loaded={exports:{}};new Function('require','module','exports',bundled.outputFiles[0].text)(createRequire(import.meta.url),loaded,loaded.exports);
const {readReplyMessages,mergeReplyMessages,render}=loaded.exports;
const id='00000000-0000-4000-8000-000000000001';
const wire=(changes={})=>({message_id:id,speaker:'contact',message_type:'voice',text:null,media_placeholder:'[语音]',occurred_at:'2026-01-01T00:00:00.000Z',quoted:null,ordering:'unknown',display_position:'9007199254740993',...changes});
const backend=items=>({requestJson:async()=>({generation:1,data:{messages:items,next_cursor:null}})});
test('SQLite消息保留未知顺序及精确展示位置，多页合并不按发送时间推测先后',async()=>{
 const read=await readReplyMessages(backend([wire()]),id,null,new AbortController().signal);
 assert.equal(read.messages[0].ordering,'unknown');
 assert.equal(read.messages[0].displayPosition,'9007199254740993');
 const other={...read.messages[0],messageId:'00000000-0000-4000-8000-000000000002',displayPosition:'9007199254740992',occurredAt:'2026-02-01T00:00:00.000Z'};
 assert.deepEqual(mergeReplyMessages([other],read.messages).map(m=>m.messageId),[id,other.messageId]);
 assert.equal(mergeReplyMessages([other],read.messages).length,2);
 const html=render(read.messages);
 assert.match(html,/顺序未核验/);assert.match(html,/\[语音\]/);
 assert.doesNotMatch(html,/最近一条：/);
});
test('消息解析拒绝缺少顺序声明或非法展示位置，保留旧消息合同',async()=>{
 for(const change of [{ordering:undefined},{display_position:'9007199254740993.1'},{ordering:'guessed'},{display_position:'-1'}]) {
  await assert.rejects(readReplyMessages(backend([wire(change)]),id,null,new AbortController().signal));
 }
 const old=wire();delete old.ordering;delete old.display_position;
 const read=await readReplyMessages(backend([old]),id,null,new AbortController().signal);
 assert.equal(read.messages[0].ordering,undefined);
});

test('已保存历史可独立刷新，不要求助手生成资格',()=>{
 const html=render([], {generationBlock:'contact_unconfirmed',savedSession:{phase:'failed',sessionId:null}});
 assert.match(html,/<button>刷新最近聊天<\/button>/);
});
