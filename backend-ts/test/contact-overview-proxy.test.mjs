import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStorageFixture } from './host-storage-fixture.mjs';
import { readContactOverview } from '../src/contact-overview.ts';

test('公开HTTP准备：旧回复从TS读取唯一投影，事务内复核不跨进程重入且不调用模型',async()=>{
 const fixture=await createStorageFixture();
 const calls=[];
 let signalEntered,release;
 const entered=new Promise(resolve=>{signalEntered=resolve;});
 const released=new Promise(resolve=>{release=resolve;});
 const server=createServer(async(req,res)=>{
  try{
   if(req.url==='/test/entered'){await entered;res.writeHead(200).end('{}');return;}
   if(req.url==='/test/release'){release();res.writeHead(200).end('{}');return;}
   assert.equal(req.headers.authorization,'Bearer synthetic-internal-proxy');
   const contact=req.url.split('/')[3],owner=req.headers['x-notalone-owner-id'];
   calls.push({owner,contact});
   if(calls.length===1){signalEntered();await released;}
   await fixture.client.query('BEGIN');
   try{
    await fixture.client.query("SELECT pg_advisory_xact_lock(hashtextextended('contact:' || $1 || ':' || $2,0))",[owner,contact]);
    const overview=await readContactOverview(fixture.client,owner,contact,true);
    await fixture.client.query('COMMIT');
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({overview}));
   }catch(error){await fixture.client.query('ROLLBACK');throw error;}
  }catch(error){res.writeHead(500).end(JSON.stringify({error:String(error)}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const {stdout}=await promisify(execFile)(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),[new URL('./contact-overview-proxy-fixture.py',import.meta.url).pathname,`host=/tmp dbname=${fixture.client.database}`,`127.0.0.1:${server.address().port}`,'synthetic-internal-proxy'],{env:{...process.env,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend',import.meta.url).pathname+':'+new URL('../../backend/src',import.meta.url).pathname},timeout:30000});
  const result=JSON.parse(stdout);
  assert.equal(result.prepared,true);
  assert.equal(result.concurrent_stop,true);
  assert.equal(result.model_calls,0);
  assert.equal(result.transaction_read_only,true);
  assert.equal(result.explicit_fallback,true);
  assert.equal(result.automatic_fallback,false);
  assert.ok(calls.length>=1);
  assert.ok(calls.every(call=>call.owner===result.owner&&call.contact===result.contact));
 }finally{release();await new Promise(resolve=>server.close(resolve));await fixture.close();}
});
