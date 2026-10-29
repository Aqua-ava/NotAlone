import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
test('SQLite实际讨论保留顺序和来源，失效正文必须撤下且候选不冒充发言',async()=>{
 const output=await build({entryPoints:['src/main/reply/sqlite-discussion-read.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const {readSqliteDiscussion}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
 const id=randomUUID(),request=randomUUID(),call=randomUUID();
 const value={mode:'sqlite',session_id:id,runtime_recovery:'blocked',entries:[{entry_id:randomUUID(),position:'1',role:'user',text:'合成要求',request_id:request,call_id:null,content_state:'available'},{entry_id:randomUUID(),position:'2',role:'assistant',text:'合成实际发言',request_id:request,call_id:call,content_state:'available'}]};
 const read=readSqliteDiscussion(value,id,7);assert.equal(read.discussionEntries[1].text,'合成实际发言');assert.equal(read.runtimeRecovery,'blocked');assert.deepEqual(read.turns,[]);
 assert.throws(()=>readSqliteDiscussion({...value,entries:[{...value.entries[1],content_state:'cleared'}]},id,7));
 assert.equal(readSqliteDiscussion({...value,entries:[{...value.entries[1],content_state:'cleared',text:null,call_id:null}]},id,7).discussionEntries[0].text,null);
 assert.throws(()=>readSqliteDiscussion({...value,entries:[value.entries[1],value.entries[0]]},id,7));
 assert.throws(()=>readSqliteDiscussion({...value,entries:[{...value.entries[1],call_id:null}]},id,7));
});
