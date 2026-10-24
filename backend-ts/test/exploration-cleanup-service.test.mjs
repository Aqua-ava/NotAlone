import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {stat,rm} from 'node:fs/promises';
import pg from 'pg';
import {fixture} from './exploration-public-support.mjs';

test('公开夹具异常退出仍关闭全部连接并非强制删除自有合成库',{timeout:60000},async t=>{
 const x=await fixture(t,{importSkill:false});
 const stopped=once(x.publicProcess,'exit');x.publicProcess.kill('SIGKILL');await stopped;
 let failure;try{await x.close();}catch(error){failure=error;}
 const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();let remaining,directoryExists;
 try{remaining=(await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[x.f.client.database])).rows;directoryExists=await stat(x.f.directory).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});}
 finally{
  // RED 也只收回本用例自有资源，防止清理回归本身遗留合成库。
  if(remaining?.length){await x.host.stop();await x.storage.close();await x.f.client.end();assert.match(x.f.client.database,/^notalone_ts_host_[a-f0-9]+_test$/);await admin.query(`DROP DATABASE "${x.f.client.database}"`);}
  await admin.end();await rm(x.f.directory,{recursive:true,force:true});
 }
 assert.deepEqual(remaining,[]);assert.equal(directoryExists,false);
 assert.ok(failure instanceof AggregateError);assert.match(failure.errors.map(error=>error.message).join('\n'),/公开夹具退出异常/);
});
