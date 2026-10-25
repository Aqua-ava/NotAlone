// 只选本次新增失败/取消、实际 strict 请求与 retry0/旧默认五个用例。
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {after} from 'node:test';
import assert from 'node:assert/strict';
const state=JSON.parse(await readFile(process.env.SPEC_FINAL_STATE,'utf8'));
const pg=createRequire(resolve(state.archive,'backend-ts/package.json'))('pg');
const connect=pg.Client.prototype.connect,owned=new Set();
pg.Client.prototype.connect=function(...args){
  const name=this.connectionParameters.database;
  if(/^notalone_ts_host_[a-f0-9]{32}_test$/.test(name))owned.add(name);
  return connect.apply(this,args);
};
after(async()=>{
  pg.Client.prototype.connect=connect;
  const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
  try{
    const remaining=(await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[[...owned]])).rows;
    await writeFile(new URL('regression-resources.json',import.meta.url),JSON.stringify({candidate:state.pin,owned_databases:[...owned],remaining,pid:process.pid},null,2)+'\n');
    assert.deepEqual(remaining,[]);assert.equal(owned.size,2);
  }finally{await admin.end();}
});
for(const name of ['model-output-configuration.test.mjs','extraction-flow-failure-contract.test.mjs','nonreply-formal-model-seam-retry.test.mjs'])
  await import(pathToFileURL(resolve(state.archive,'backend-ts/test',name)));
