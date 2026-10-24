import pg from 'pg';
import {rm,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createStorageFixture} from './host-storage-fixture.mjs';

/** 复用原迁移准备；只在本轮连接全部退出后普通 DROP 自有随机库。 */
export async function createExtractionFixture(){
 const fixture=await createStorageFixture();
 const database=fixture.client.connectionParameters.database;
 if(!/^notalone_ts_host_[a-f0-9]{32}_test$/.test(database))throw new Error('合成库身份不确定，保留现场');
 await writeFile(`${fixture.directory}/task10-owned-database.json`,JSON.stringify({database,pid:process.pid,task:'10'}),{mode:0o600});
 let closed=false;
 return {...fixture,async close(){
  if(closed)return;closed=true;
  await fixture.client.end();
  const admin=new pg.Client({host:'/tmp',database:'postgres'});
  await admin.connect();
  try{
   // client.end只确认本端退出；给PG后端一条至多1秒的有界收尾等待，不强制断连。
   for(let remaining=50;remaining>0;remaining--){
    if(!(await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1 LIMIT 1',[database])).rowCount)break;
    if(remaining===1)throw new Error('合成库仍有连接，保留现场');
    await delay(20);
   }
   await admin.query(`DROP DATABASE "${database}"`);
  }finally{await admin.end();}
  await rm(fixture.directory,{recursive:true,force:true});
 }};
}
