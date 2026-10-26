/** 质量公开 HTTP seam，数据库只包含本文件创建的随机合成资料。 */
import {createServer} from 'node:http';
import {createLayeredMemoryManagement} from '../src/memory/records/documents/service.ts';
import {OrganizationQualityStore} from '../src/diagnostics/organization-quality-store.ts';
import {createOrganizationQualityApi} from '../src/diagnostics/organization-quality-api.ts';
import {managementFixture} from './layered-memory-management-fixture.mjs';

export function inputAnnotations(input, kind='agent'){
  return {input_sha256:input.input_sha256,reviewer:{kind,name:'合成审阅者'},dimension:'subject',
    scenario_key:input.case_id,decision:'approved',supported_claims:[],prohibited_claims:[],
    independence_notes:'本用例只核验工程合同，不登记人工质量资格。',empty_support_policy:'normal',verifier_challenges:{}};
}

export async function organizationQualityFixture(t,options={}){
  const f=await managementFixture(t);
  const store=new OrganizationQualityStore({transaction:f.transaction,...options});
  const api=createOrganizationQualityApi({ownerId:f.ownerId,transaction:f.transaction,store,...options});
  const manager=createLayeredMemoryManagement({ownerId:f.ownerId,transaction:f.transaction,
    qualityInput:(client,scope,versions)=>store.insertInputInTransaction(client,scope,versions)});
  const server=createServer(async(req,res)=>{
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString('utf8')):undefined;
      const url=new URL(req.url,'http://127.0.0.1');
      const selected=req.headers['x-test-owner']?createOrganizationQualityApi({ownerId:req.headers['x-test-owner'],transaction:f.transaction,store,...options}):api;
      const result=await selected.handle(req.method,url,body,new AbortController().signal)
        ??await manager.handle(req.method,url,body,new AbortController().signal);
      res.writeHead(result?.status??404,{'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify(result?.body??{error:'not_found'}));
    }catch{res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"fixture_failed"}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const request=async(path,body,method=body===undefined?'GET':'POST',owner)=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path.startsWith('/')?path:`/api/layered-memory/${path}`}`,{
      method,headers:{'Content-Type':'application/json',...(owner?{'X-Test-Owner':owner}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  return {...f,store,api,request,
    async createInput(contact=f.contactId,memory=f.memoryId){
      const prefix=contact===null?'/api/memories/owner':`/api/contacts/${contact}`;
      return request(`${prefix}/layered-memory/quality-input`,{memory_versions:[{memory_id:memory,revision:1}]});
    },
    createRun:(caseIds,overrides={})=>request('quality-runs',{case_ids:caseIds,max_http_attempts:16,
      dataset_version:'organization-quality-http-v1',data_kind:'fixed_synthetic',purpose_confirmed:true,...overrides}),
  };
}
