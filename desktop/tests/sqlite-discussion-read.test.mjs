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

test('既有讨论读取与权威投影保留SQLite实际发言，失效后的旧读取不能恢复正文',async()=>{
 const output=await build({stdin:{contents:"export {readAssistantSession} from './src/main/reply/assistant-sessions';export {AssistantSessionProjection} from './src/main/reply/assistant-session-projection';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
 const {readAssistantSession,AssistantSessionProjection}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
 const contactId=randomUUID(),sessionId=randomUUID(),requestId=randomUUID(),entryId=randomUUID(),calls=[];
 const backend={getConnectionGeneration:()=>7,requestJson:async input=>{calls.push(input);return {generation:7,data:{mode:'sqlite',session_id:sessionId,runtime_recovery:'unchecked',entries:[{entry_id:entryId,position:'1',role:'user',text:'实际读取链上的合成发言',request_id:requestId,call_id:null,content_state:'available'}]}};}};
 const saved=await readAssistantSession(backend,contactId,sessionId,new AbortController().signal);
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(saved.discussionEntries[0].entryId,entryId);assert.deepEqual(saved.turns,[]);
 const scope={connectionGeneration:7,contactId,sessionId,scopeRevision:4},projection=new AssistantSessionProjection();
 projection.registerDisplay(scope,{phase:'loading',sessionId,turns:[],inputs:[],currentInputVersionId:null});
 const read=projection.beginRead(scope),accepted=projection.acceptRead(read,saved);
 assert.equal(accepted.kind,'accepted');assert.equal(accepted.snapshot.discussionEntries[0].text,'实际读取链上的合成发言');assert.equal(accepted.snapshot.runtimeRecovery,'unchecked');
 projection.invalidateSource();assert.equal(projection.acceptRead(read,saved).kind,'superseded');
});
