import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {SqliteReplyCandidateHttp} from '../src/reply/sqlite/candidates/http.ts';

const contactId=randomUUID(),discussionId=randomUUID();
function candidate(index,basisCount=1){
 return {candidateId:randomUUID(),versionNo:1,origin:'model',parentVersionNo:null,parts:['合成候选'],basis:Array.from({length:basisCount},(_,item)=>({itemNo:item+1,kind:'message',text:'a'.repeat(100000),verification:'actual_input'}))};
}
function request(index,basisCount=1){return {requestId:randomUUID(),generationState:'committed',coverageWarning:null,sourceState:'available',candidates:[candidate(index,basisCount)],selections:[],loadedSkills:[]};}
async function serve(t,requests){
 const calls=[];const service={view:async(...args)=>{calls.push(args);return requests;}};
 const http=new SqliteReplyCandidateHttp({storage:{},service,turns:undefined,authorize:()=>true}),server=createServer(async(req,res)=>{if(!await http.handle(req,res)){res.writeHead(404);res.end();}});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {calls,url:`http://127.0.0.1:${server.address().port}/api/contacts/${contactId}/assistant-sessions/${discussionId}/reply-candidates`};
}

test('候选页读取固定最近窗口，第21个请求只标记有更早记录',async t=>{
 const requests=Array.from({length:21},(_,index)=>request(index,0)),f=await serve(t,requests),response=await fetch(f.url),body=await response.json();
 assert.equal(response.status,200);assert.equal(body.requests.length,20);assert.equal(body.hasMoreRequests,true);assert.equal(Object.hasOwn(body,'coverage'),false);assert.equal(Object.hasOwn(body,'recentMessages'),false);
 assert.deepEqual(f.calls,[[contactId,discussionId,{includeSkillText:false,limit:21}]]);
});

test('候选页超过软预算时裁掉最旧请求且整体仍低于桌面2MB合同',async t=>{
 const f=await serve(t,[request(1,9),request(2,9)]),response=await fetch(f.url),wire=await response.text();
 assert.equal(response.status,200);assert.ok(Buffer.byteLength(wire,'utf8')<2_000_000);
 const body=JSON.parse(wire);assert.equal(body.requests.length,1);assert.equal(body.hasMoreRequests,true);
});

test('单个最新请求仍超过页面预算时明确拒绝而不是返回超限正文',async t=>{
 const f=await serve(t,[request(1,20)]),response=await fetch(f.url),body=await response.json();
 assert.equal(response.status,409);assert.deepEqual(body,{error:'reply_page_too_large'});
});
