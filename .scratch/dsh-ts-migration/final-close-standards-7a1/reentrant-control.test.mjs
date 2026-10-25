// 独立对照：仅调用固定源码和自有合成 PostgreSQL，不读取仓库配置。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.NOTALONE_REVIEW_FIXED_ROOT;
const load=p=>import(pathToFileURL(join(root,p)).href);
const {pureTsFixture}=await load('backend-ts/test/pure-ts-runtime-fixture.mjs');
const {HostStorage:TargetStorage}=await load('backend-ts/src/host-storage.ts');
const {HostStorage:BaselineStorage}=await import(process.env.NOTALONE_REVIEW_BASELINE_URL);

async function storageFixture(t,Type){
 const fixture=await pureTsFixture(t);
 const storage=await Type.open({envFilePath:join(fixture.directory,'unused-synthetic-config'),
  migrationsDirectory:join(root,'backend/database/migrations'),environment:{NOTALONE_DISABLE_DOTENV:'1',
   NOTALONE_DATABASE_URL:`host=/tmp dbname=${fixture.client.connectionParameters.database}`}});
 t.after(()=>storage.close());
 return {fixture,storage};
}

test('目标继承配置、回调 this 与原对象身份保持',{timeout:20000},async t=>{
 const {storage}=await storageFixture(t,TargetStorage);
 const config=Object.create({text:'SELECT $1::integer AS value',values:[37]});
 let callbackResult;
 const result=await storage.businessTransaction(client=>new Promise((resolve,reject)=>{
  function callback(error,value){
   try{assert.equal(this.callback,callback);callbackResult=value;error?reject(error):resolve(value);}catch(error){reject(error);}
  }
  Object.defineProperty(config,'callback',{value:callback});Object.freeze(config);
  assert.equal(client.query(config),undefined);
 }));
 assert.deepEqual(result.rows,[{value:37}]);assert.equal(result,callbackResult);
 assert.equal(Object.hasOwn(config,'text'),false);
});

// toPostgres 是 pg 的参数转换入口；转换时排入第二条正常查询，随后第一条回调超时。
async function timeoutWithNestedQuery(t,Type){
 const {fixture,storage}=await storageFixture(t,Type);
 let actual,nativeFailure,callbackCount=0,nestedCount=0;
 await assert.rejects(storage.businessTransaction(async client=>{
  await client.query('INSERT INTO owner(id,display_name) VALUES($1,$2)',[randomUUID(),'合成回滚对照']);
  return new Promise((resolve,reject)=>{
   const value={toPostgres(){
    client.query('SELECT 1 AS nested',error=>{assert.ifError(error);nestedCount++;});
    return 'synthetic-only';
   }};
   client.query({text:'SELECT pg_sleep(0.05), $1::text AS value',values:[value],query_timeout:1,
    callback(error,result){callbackCount++;if(error){nativeFailure=error;reject(error);}else resolve(result);}});
  });
 }),error=>{actual=error;return true;});
 assert.equal(callbackCount,1);assert.equal(nestedCount,1);
 assert.equal((await fixture.client.query('SELECT count(*)::int AS n FROM owner')).rows[0].n,0);
 return {actual,nativeFailure};
}

test('283a 对照：原查询超时错误仍可原样逸出',{timeout:20000},async t=>{
 const {actual,nativeFailure}=await timeoutWithNestedQuery(t,BaselineStorage);
 t.diagnostic(JSON.stringify({receivedName:actual.name,receivedCode:actual.code??null,originalDriverErrorEscaped:actual===nativeFailure}));
 assert.equal(actual.name,'Error');assert.equal(actual,nativeFailure);
});

test('目标：参数转换重入后原查询超时仍应归为受控数据库错误',{timeout:20000},async t=>{
 const {actual,nativeFailure}=await timeoutWithNestedQuery(t,TargetStorage);
 t.diagnostic(JSON.stringify({receivedName:actual.name,receivedCode:actual.code??null,
  originalDriverErrorEscaped:actual===nativeFailure}));
 assert.equal(actual.name,'HostStorageError');assert.equal(actual.code,'database_unavailable');
 assert.notEqual(actual,nativeFailure);
});
