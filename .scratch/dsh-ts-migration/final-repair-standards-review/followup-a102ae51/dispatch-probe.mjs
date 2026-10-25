import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.NOTALONE_REVIEW_SOURCE;
assert.ok(root);
const at=relative=>import(pathToFileURL(join(root,relative)).href);
const {default:pg}=await at('backend-ts/node_modules/pg/lib/index.js');
const {HostStorage,HostStorageError}=await at('backend-ts/src/host-storage.ts');
const {SkillLearningNotFound}=await at('backend-ts/src/skill-learning-contract.ts');
const {createStorageFixture}=await at('backend-ts/test/host-storage-fixture.mjs');
const fixture=await createStorageFixture();
const storage=await HostStorage.open({...fixture.options,environment:{NOTALONE_DISABLE_DOTENV:'1',
 NOTALONE_DATABASE_URL:'host=/tmp dbname='+fixture.client.database}});
const checks=[];
try {
 const parserError=new Error('synthetic-parser-first');
 let eventQuery,eventCalls=0;
 await assert.rejects(storage.businessTransaction(async client=>{
  await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[randomUUID(),'合成回滚标记']);
  return new Promise((resolve,reject)=>{
   eventQuery=new pg.Query({text:"SELECT 'synthetic'::text AS value; SELECT 1/0",types:{
    getTypeParser(oid,format){return oid===25?()=>{throw parserError;}:pg.types.getTypeParser(oid,format);},
   }});
   const original=eventQuery.handleError;
   assert.equal(Object.hasOwn(eventQuery,'handleError'),false);
   eventQuery.once('error',function(error){
    eventCalls++;
    try {
     assert.equal(this,eventQuery);
     assert.equal(error,parserError);
     assert.equal(eventQuery.callback,undefined);
     assert.equal(eventQuery.handleError,original);
     assert.equal(Object.hasOwn(eventQuery,'handleError'),false);
     assert.equal(eventQuery.listenerCount('end'),0);
     reject(error);
    } catch(failure){reject(failure);}
   });
   assert.equal(client.query(eventQuery),eventQuery);
  });
 }),error=>error instanceof HostStorageError&&error.code==='database_unavailable');
 assert.equal(eventCalls,1);
 assert.equal((await storage.setupStatus()).owner_configured,false);
 checks.push({name:'event_parser_precedence',passed:true,original_error_identity:true,rollback:true,
  query_identity:true,prototype_dispatch_restored:true,tracking_listener_removed:true});

 let query,callbackValue,endValue,endThis,originalDescriptor,thenCalls=0;
 function callback(error,value){
  if(error)return rejectSuccess(error);
  try {
   assert.equal(this,query);assert.equal(query.callback,callback);
   callbackValue=value;resolveSuccess(value);
  } catch(failure){rejectSuccess(failure);}
 }
 let resolveSuccess,rejectSuccess;
 const value=await storage.businessTransaction(client=>new Promise((resolve,reject)=>{
  resolveSuccess=resolve;rejectSuccess=reject;
  query=new pg.Query({text:'SELECT 7 AS value'},callback);
  Object.defineProperty(query,'callback',{value:callback,writable:false,configurable:false});
  Object.defineProperty(query,'handleError',{value:query.handleError,writable:true,configurable:true,enumerable:false});
  originalDescriptor=Object.getOwnPropertyDescriptor(query,'handleError');
  query.then=()=>{thenCalls++;throw new Error('synthetic-query-must-not-be-assimilated');};
  query.once('end',function(result){endThis=this;endValue=result;});
  assert.equal(client.query(query),query);
  assert.equal(query.callback,callback);
 }));
 assert.deepEqual(value.rows,[{value:7}]);
 assert.equal(value,callbackValue);assert.equal(value,endValue);assert.equal(endThis,query);
 assert.equal(query.callback,callback);assert.equal(thenCalls,0);
 assert.deepEqual(Object.getOwnPropertyDescriptor(query,'handleError'),originalDescriptor);
 assert.equal(query.listenerCount('end'),0);
 checks.push({name:'successful_identity_and_cleanup',passed:true,readonly_callback_preserved:true,
  callback_this:true,result_identity:true,then_not_consumed:true,own_descriptor_restored:true});

 const domain=new SkillLearningNotFound();let mappedCalls=0;
 await assert.rejects(storage.businessTransaction(async client=>{
  await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[randomUUID(),'合成映射回滚标记']);
  await client.query({name:'synthetic_mapping',text:'SELECT 1'});
  return new Promise((resolve,reject)=>{
   let mapped;
   function callback(error,result){
    mappedCalls++;
    try {
     assert.equal(this,mapped);assert.equal(mapped.callback,callback);
     if(error)reject(domain);else resolve(result);
    } catch(failure){reject(failure);}
   }
   mapped=new pg.Query({name:'synthetic_mapping',text:'SELECT 2'},callback);
   assert.equal(client.query(mapped),mapped);
  });
 }),error=>error===domain);
 assert.equal(mappedCalls,1);
 assert.equal((await storage.setupStatus()).owner_configured,false);
 checks.push({name:'mapped_domain_identity',passed:true,rollback:true,callback_once:true});
 console.log(JSON.stringify({checks,passed:checks.length}));
} finally {await storage.close();await fixture.close();}
