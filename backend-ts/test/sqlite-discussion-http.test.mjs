import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteDiscussionHttp} from '../src/reply/sqlite/http.ts';

test('讨论HTTP中文信封不在具名正文字符上限之前截断',async t=>{
 const contactId=randomUUID(),discussionId=randomUUID(),requestKey=randomUUID(),text='合'.repeat(40_000);let accepted;
 // 只检查传输信封；正常业务、SQLite与官方模型的证据由集成用例负责。
 const http=new SqliteDiscussionHttp({},()=>true,undefined,{generate:async input=>{accepted=input;return {discussionId,segmented:false,replayed:false};}});
 const server=createServer((req,res)=>http.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussionId}/entries`,{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request_key:requestKey,text,confirmed_contact:true}),
 });
 assert.equal(response.status,200);assert.equal((await response.json()).request_key,requestKey);assert.equal(accepted.text,text);
});
