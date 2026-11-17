import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {createServer} from 'node:http';
test('SQLite实际讨论保留顺序和来源，失效正文必须撤下且候选不冒充发言',async()=>{
 const output=await build({entryPoints:['src/main/reply/sqlite-discussion-read.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const {readSqliteDiscussion}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
 const id=randomUUID(),request=randomUUID(),call=randomUUID();
 const value={mode:'sqlite',session_id:id,runtime_recovery:'blocked',entries:[{entry_id:randomUUID(),position:'1',role:'user',text:'合成要求',request_id:request,call_id:null,content_state:'available'},{entry_id:randomUUID(),position:'2',role:'assistant',text:'合成实际发言',request_id:request,call_id:call,content_state:'available'}]};
 const read=readSqliteDiscussion(value,id,7);assert.equal(read.discussionEntries[1].text,'合成实际发言');assert.equal(read.runtimeRecovery,'blocked');
 assert.throws(()=>readSqliteDiscussion({...value,entries:[{...value.entries[1],content_state:'cleared'}]},id,7));
 assert.equal(readSqliteDiscussion({...value,entries:[{...value.entries[1],content_state:'cleared',text:null,call_id:null}]},id,7).discussionEntries[0].text,null);
 assert.throws(()=>readSqliteDiscussion({...value,entries:[value.entries[1],value.entries[0]]},id,7));
 assert.throws(()=>readSqliteDiscussion({...value,entries:[{...value.entries[1],call_id:null}]},id,7));
});

test('会话读取单次请求承载完整视图，取消、连接换代与超限响应都丢弃本次读取',async()=>{
 const output=await build({stdin:{contents:"export {readAssistantSession} from './src/main/reply/assistant-sessions';export {BackendRequestFailure} from './src/main/backend/json-client';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
 const {readAssistantSession,BackendRequestFailure}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
 const contactId=randomUUID(),sessionId=randomUUID(),entryId=randomUUID(),requestId=randomUUID();
 const snapshot={mode:'sqlite',session_id:sessionId,runtime_recovery:'unchecked',entries:[{entry_id:entryId,position:'1',role:'user',text:'合成发言',request_id:requestId,call_id:null,content_state:'available'}]};
 // 读取中连接换代：本次读取按取消丢弃。
 let generation=7;
 const changed={getConnectionGeneration:()=>generation,requestJson:async()=>{generation=8;return {generation:7,data:snapshot};}};
 await assert.rejects(readAssistantSession(changed,contactId,sessionId,new AbortController().signal),
  error=>error instanceof BackendRequestFailure&&error.kind==='cancelled');
 // 请求期间发出取消信号：同样丢弃，不返回半程结果。
 const controller=new AbortController();
 const cancelled={getConnectionGeneration:()=>7,requestJson:async()=>{controller.abort();return {generation:7,data:snapshot};}};
 await assert.rejects(readAssistantSession(cancelled,contactId,sessionId,controller.signal),
  error=>error instanceof BackendRequestFailure&&error.kind==='cancelled');
 // 响应超出运输字节门禁：错误如实传播，不做分片重试。
 const calls=[];
 const tooLarge={getConnectionGeneration:()=>7,requestJson:async input=>{calls.push(input);throw new BackendRequestFailure('response',undefined,'response_too_large');}};
 await assert.rejects(readAssistantSession(tooLarge,contactId,sessionId,new AbortController().signal),
  error=>error instanceof BackendRequestFailure&&error.code==='response_too_large');
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(calls[0].maxResponseBytes,8388608);
});

test('既有讨论读取与权威投影保留SQLite实际发言，失效后的旧读取不能恢复正文',async()=>{
 const output=await build({stdin:{contents:"export {readAssistantSession} from './src/main/reply/assistant-sessions';export {AssistantSessionProjection} from './src/main/reply/assistant-session-projection';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
 const {readAssistantSession,AssistantSessionProjection}=await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
 const contactId=randomUUID(),sessionId=randomUUID(),requestId=randomUUID(),entryId=randomUUID(),calls=[];
 const backend={getConnectionGeneration:()=>7,requestJson:async input=>{calls.push(input);return {generation:7,data:{mode:'sqlite',session_id:sessionId,runtime_recovery:'unchecked',entries:[{entry_id:entryId,position:'1',role:'user',text:'实际读取链上的合成发言',request_id:requestId,call_id:null,content_state:'available'}]}};}};
 const saved=await readAssistantSession(backend,contactId,sessionId,new AbortController().signal);
 assert.equal(calls.length,1);assert.equal(calls[0].method,'GET');assert.equal(saved.discussionEntries[0].entryId,entryId);
 const scope={connectionGeneration:7,contactId,sessionId,scopeRevision:4},projection=new AssistantSessionProjection();
 projection.registerDisplay(scope,{phase:'loading',sessionId,discussionEntries:[],runtimeRecovery:'none'});
 const read=projection.beginRead(scope),accepted=projection.acceptRead(read,saved);
 assert.equal(accepted.kind,'accepted');assert.equal(accepted.snapshot.discussionEntries[0].text,'实际读取链上的合成发言');assert.equal(accepted.snapshot.runtimeRecovery,'unchecked');
 projection.invalidateSource();assert.equal(projection.acceptRead(read,saved).kind,'superseded');
});

async function transportPorts() {
 const output = await build({stdin: {contents: `
  export {readAssistantSession} from './src/main/reply/assistant-sessions';
  export {JsonClient, BackendRequestFailure} from './src/main/backend/json-client';
  export {SqliteDiscussionHttp} from '../backend-ts/src/reply/sqlite/http';
 `, resolveDir: process.cwd()}, bundle: true, platform: 'node', format: 'esm', write: false});
 return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
}

async function withReadTransport(ports, handle, use) {
 const server = createServer((req, res) => { void handle(req, res).catch(error => res.destroy(error)); });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const client = new ports.JsonClient({port: server.address().port, token: 'synthetic_token'});
 const calls = [];
 const backend = {getConnectionGeneration: () => 7, requestJson: async input => {
  calls.push(input);
  return {generation: 7, data: (await client.perform(input)).data};
 }};
 try { await use({backend, calls}); }
 finally {
  client.cancelPending(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
 }
}

test('正式会话HTTP投影经真实运输接纳恰好8MiB的中文会话，超出1字节整次拒绝', async t => {
 const ports = await transportPorts(), sessionId = randomUUID(), contactId = randomUUID();
 const entries = Array.from({length: 29}, (_, index) => ({id: randomUUID(), position: index + 1,
  role: 'user', body: index < 28 ? '测'.repeat(99_000) : '合成', origin_request_id: randomUUID(),
  origin_call_id: null, content_state: 'available'}));
 const publicView = () => ({mode: 'sqlite', session_id: sessionId, runtime_recovery: 'none',
  entries: entries.map(e => ({entry_id: e.id, position: String(e.position), role: e.role, text: e.body,
   request_id: e.origin_request_id, call_id: null, content_state: e.content_state}))});
 const limit = 8_388_608;
 entries.at(-1).body += 'x'.repeat(limit - Buffer.byteLength(JSON.stringify(publicView())));
 assert.equal(Buffer.byteLength(JSON.stringify(publicView())), limit);
 assert.ok(entries.every(e => e.body.length <= 100_000), '每条合成正文都遵守正式受理上限');
 let reads = 0;
 // 只替换资料服务；HTTP字段投影、JSON序列化、回环传输及桌面读取均走正式实现。
 const http = new ports.SqliteDiscussionHttp({view: async (contact, session) => {
  reads++; assert.equal(contact, contactId); assert.equal(session, sessionId);
  return {discussion: {currentRuntimeId: null}, entries};
 }}, req => req.headers.authorization === 'Bearer synthetic_token');
 await withReadTransport(ports, async (req, res) => {
  assert.equal(await http.handle(req, res), true);
 }, async ({backend, calls}) => {
  const signal = new AbortController().signal;
  const result = await ports.readAssistantSession(backend, contactId, sessionId, signal);
  assert.equal(result.discussionEntries.length, entries.length);
  assert.deepEqual(result.discussionEntries.map(e => e.text), entries.map(e => e.body));
  assert.equal(calls.length, 1); assert.equal(calls[0].signal, signal);
  entries.at(-1).body += 'x';
  await assert.rejects(ports.readAssistantSession(backend, contactId, sessionId, signal),
   error => error instanceof ports.BackendRequestFailure && error.code === 'response_too_large');
  assert.equal(calls.length, 2); assert.equal(reads, 2, '失败后不自动分片或重试');
 });
 t.diagnostic(`完整JSON ${limit}字节成功，${limit + 1}字节拒绝；29条正文均不超过100000 UTF-16单元`);
});

test('单次会话响应的HTTP声明字节数不符或JSON被截断时不发布正文', async () => {
 const ports = await transportPorts(), sessionId = randomUUID(), contactId = randomUUID();
 const body = JSON.stringify({mode: 'sqlite', session_id: sessionId, runtime_recovery: 'none', entries: []});
 for (const framing of ['content-length', 'json']) {
  await withReadTransport(ports, async (_req, res) => {
   res.writeHead(200, {'Content-Type': 'application/json',
    ...(framing === 'content-length' ? {'Content-Length': Buffer.byteLength(body) + 1} : {}),
    Connection: 'close'});
   // 第一种保持JSON完整但缺少HTTP声明的1字节；第二种HTTP完整但JSON缺少末尾括号。
   res.end(framing === 'content-length' ? body : body.slice(0, -1));
  }, async ({backend, calls}) => {
   await assert.rejects(ports.readAssistantSession(backend, contactId, sessionId, new AbortController().signal),
    error => error instanceof ports.BackendRequestFailure && ['connection', 'response'].includes(error.kind));
   assert.equal(calls.length, 1);
  });
 }
});

test('会话读取在请求前已取消、响应代次错误或异常时换代都按取消处理', async () => {
 const {readAssistantSession, BackendRequestFailure} = await transportPorts();
 const contactId = randomUUID(), sessionId = randomUUID(), controller = new AbortController();
 controller.abort();
 let calls = 0;
 await assert.rejects(readAssistantSession({getConnectionGeneration: () => 7,
  requestJson: async () => {calls++; throw new Error('已取消读取不应发送请求');}}, contactId, sessionId, controller.signal),
  error => error instanceof BackendRequestFailure && error.kind === 'cancelled');
 assert.equal(calls, 0);
 await assert.rejects(readAssistantSession({getConnectionGeneration: () => 7,
  requestJson: async () => ({generation: 8, data: null})}, contactId, sessionId, new AbortController().signal),
  error => error instanceof BackendRequestFailure && error.kind === 'cancelled');
 let generation = 7;
 await assert.rejects(readAssistantSession({getConnectionGeneration: () => generation,
  requestJson: async () => {generation = 8; throw new Error('合成连接异常');}}, contactId, sessionId, new AbortController().signal),
  error => error instanceof BackendRequestFailure && error.kind === 'cancelled');
});
