import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import {createServer} from 'node:http';
import {fixture,owner} from './fixtures/memory-sqlite/support.mjs';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';import {SqliteMemoryManagementHttp,memoryManagementQueryAllowed} from '../src/memory/sqlite/management/http.ts';
import {authorizeSqliteRequest} from '../src/sqlite-host-plugin.ts';
test('认证管理HTTP固定owner并拒绝系统决定、注入字段、Origin和重复范围',async t=>{
 const f=await fixture(t),service=new SqliteMemoryManagement(f.storage,owner),token='synthetic-management-token',handler=new SqliteMemoryManagementHttp(service,req=>authorizeSqliteRequest(req,token));
 const server=createServer(async(req,res)=>{if(!await handler.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/api/memory-management`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 assert.equal((await fetch(`${base}?scope_kind=self`)).status,401);assert.equal((await fetch(`${base}?scope_kind=self`,{headers:{...headers,origin:'https://invalid.example'}})).status,401);
 assert.equal((await fetch(`${base}?scope_kind=self&scope_kind=contact`,{headers})).status,400);
 for(const action of ['auto_accept','auto_update','auto_retire','auto_noop'])assert.equal((await fetch(`${base}/decisions`,{method:'POST',headers,body:JSON.stringify({requestKey:randomUUID(),action,candidateIds:[],candidateRevisions:[]})})).status,400);
 assert.equal((await fetch(`${base}/decisions`,{method:'POST',headers,body:JSON.stringify({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'self',contactId:null},body:'独立合成手录',ownerId:owner})})).status,400);
 const created=await fetch(`${base}/decisions`,{method:'POST',headers,body:JSON.stringify({requestKey:randomUUID(),action:'manual',scope:{scopeKind:'self',contactId:null},body:'独立合成手录'})});assert.equal(created.status,200);
 const read=await fetch(`${base}?scope_kind=self`,{headers});assert.equal(read.status,200);assert.equal((await read.json()).memories[0].current.body,'独立合成手录');
});

test('宿主管理查询白名单仅允许GET的精确self/contact形状',()=>{assert.equal(memoryManagementQueryAllowed('GET',new URL('http://localhost/api/memory-management?scope_kind=self')),true);assert.equal(memoryManagementQueryAllowed('GET',new URL('http://localhost/api/memory-management?scope_kind=self&owner_id=foreign')),false);assert.equal(memoryManagementQueryAllowed('POST',new URL('http://localhost/api/memory-management?scope_kind=self')),false);});

test('主题与长期概览HTTP只读已认证的确定范围并禁止注入',{timeout:10000},async t=>{
 const {SqliteMemoryDocumentsHttp,memoryDocumentsQueryAllowed}=await import('../src/memory/sqlite/documents/http.ts');
 const {SqliteMemoryDocuments}=await import('../src/memory/sqlite/documents/service.ts');
 const {ActiveHolders}=await import('../src/storage/sqlite/deletion/holders.ts');
 const f=await fixture(t),service=new SqliteMemoryDocuments(f.storage,owner,undefined,new ActiveHolders()),token='synthetic-documents-token';
 t.after(()=>service.close());
 const handler=new SqliteMemoryDocumentsHttp(service,req=>authorizeSqliteRequest(req,token));
 const server=createServer(async(req,res)=>{if(!await handler.handle(req,res)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/api/memory-documents`,headers={authorization:`Bearer ${token}`};
 assert.equal((await fetch(`${base}?scope_kind=self`)).status,401);
 assert.equal((await fetch(`${base}?scope_kind=self`,{headers:{...headers,origin:'https://invalid.example'}})).status,401);
 for(const query of ['scope_kind=self&scope_kind=contact','scope_kind=self&owner_id=other','scope_kind=self&contact_id='+f.saved[0].contact_id,'scope_kind=contact&contact_id=bad'])assert.equal((await fetch(`${base}?${query}`,{headers})).status,400);
 assert.equal((await fetch(`${base}?scope_kind=self`,{method:'POST',headers})).status,400);
 const response=await fetch(`${base}?scope_kind=contact&contact_id=${f.saved[0].contact_id}`,{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');const view=await response.json();assert.equal(view.publication,null);assert.deepEqual(view.documents,[]);
 assert.equal(memoryDocumentsQueryAllowed('GET',new URL('http://localhost/api/memory-documents?scope_kind=self')),true);
 assert.equal(memoryDocumentsQueryAllowed('POST',new URL('http://localhost/api/memory-documents?scope_kind=self')),false);
});
