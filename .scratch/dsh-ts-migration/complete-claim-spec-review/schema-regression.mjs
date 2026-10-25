// 仅运行固定 archive 的 035/103/114→116 合成迁移用例，记录精确自有库。
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
import {after} from 'node:test';
import assert from 'node:assert/strict';
const own=new URL('./',import.meta.url);
const state=JSON.parse(await readFile(new URL('private-state.json',own),'utf8'));
const pg=createRequire(resolve(state.archive,'backend-ts/package.json'))('pg');
const original=pg.Client.prototype.query,resources=[];
pg.Client.prototype.query=function(...args){
  const sql=typeof args[0]==='string'?args[0]:'';
  const hit=sql.match(/^(CREATE|DROP) DATABASE "(notalone_schema_ts_[a-f0-9]{32}_test)"/);
  const result=original.apply(this,args);
  if(!hit)return result;
  return result.then(value=>{resources.push({operation:hit[1],database:hit[2]});return value;});
};
after(async()=>{
  pg.Client.prototype.query=original;
  const databases=[...new Set(resources.filter(r=>r.operation==='CREATE').map(r=>r.database))];
  const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
  try{
    const remaining=(await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[databases])).rows;
    await writeFile(new URL('schema-resources.json',own),JSON.stringify({pin:state.pin,pid:process.pid,resources,remaining},null,2)+'\n',{mode:0o600});
    assert.deepEqual(remaining,[]);
    assert.equal(databases.length,3);
  }finally{await admin.end();}
});
await import(pathToFileURL(resolve(state.archive,'backend-ts/test/schema-prepare.test.mjs')));
