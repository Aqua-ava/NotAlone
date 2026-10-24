/** 本轮独占正式111库；只删除自己的随机_test库，不终止其他连接。 */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
export async function createUnconfiguredFixture(){
 const directory=await mkdtemp(join(tmpdir(),'na-unconfigured-pg-'));
 const database=`notalone_unconfigured_${randomUUID().replaceAll('-','')}_test`;
 const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();let created=false,client;
 try{
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);created=true;
  execFileSync(process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-B','-c',
   'from pathlib import Path\nfrom notalone.database_migrations import migrate\nimport sys\nmigrate("host=/tmp dbname="+sys.argv[1],Path(sys.argv[2]))',
   database,new URL('../../backend/database/migrations/',import.meta.url).pathname],{env:process.env,timeout:60000,stdio:'pipe'});
  client=new pg.Client({host:'/tmp',database});await client.connect();
 }catch(error){if(client)await client.end();if(created)await admin.query(`DROP DATABASE "${database}"`);await admin.end();await rm(directory,{recursive:true,force:true});throw error;}
 const envFilePath=join(directory,'synthetic.env');await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${database}\n`);
 let closed;
 return {directory,client,database,envFilePath,
  options:{envFilePath,migrationsDirectory:new URL('../../backend/database/migrations/',import.meta.url).pathname,environment:{}},
  close(){return closed??=(async()=>{
   try{
    await client.end();let active=1;
    // end()返回与PG后端退出有短窗口；有界等待自己的连接消失，不强杀连接。
    for(let i=0;i<25;i++){
     await admin.query('SELECT pg_stat_clear_snapshot()');
     active=(await admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[database])).rows[0].n;
     if(active===0)break;
     await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(active!==0)throw Error('独占测试库仍有活动连接，不强制删除');
    await admin.query(`DROP DATABASE "${database}"`);
   }finally{await admin.end();await rm(directory,{recursive:true,force:true});}
  })();},
 };
}
