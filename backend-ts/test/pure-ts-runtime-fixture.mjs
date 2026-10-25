/** 合成数据库完全经 Node 准备；产品进程与夹具均不调用 Python。 */
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchDsh} from '../src/launch.ts';
import {prepareDatabaseSchema} from '../src/schema-prepare.ts';
export async function pureTsFixture(t){
 const directory=await mkdtemp(join(tmpdir(),'notalone-pure-ts-'));
 const name=`notalone_pure_ts_${randomUUID().replaceAll('-','')}_test`;
 const admin=new pg.Client({host:'/tmp',database:'postgres'});await admin.connect();
 await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
 const prepared=await prepareDatabaseSchema({databaseUrl:`host=/tmp dbname=${name}`,migrationsDirectory:resolve('../backend/database/migrations'),environment:{HOME:directory}});
 if(prepared.code!=='ready'){await admin.query(`DROP DATABASE "${name}"`);await admin.end();await rm(directory,{recursive:true,force:true});throw new Error('纯 TS 合成库准备失败：'+prepared.code);}
 const client=new pg.Client({host:'/tmp',database:name});await client.connect();
 const hosts=[],cleanups=[];
 t.after(async()=>{
  try{for(const host of hosts)await host.terminate();for(const cleanup of cleanups.reverse())await cleanup();}
  finally{await client.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end();await rm(directory,{recursive:true,force:true});}
 });
 const envFilePath=join(directory,'runtime.env');
 await writeFile(envFilePath,`NOTALONE_DATABASE_URL=host=/tmp dbname=${name}\nNOTALONE_SKILLS_DIR=${directory}/skills\n`,{mode:0o600});
 return {directory,client,cleanup(work){cleanups.push(work);},async start(environment={}){
  const infoPath=join(directory,'backend.info');
  const previousPath=process.env.PATH;process.env.PATH='/usr/bin:/bin';let host;
  try{host=await launchDsh({nodeExecutable:process.execPath,projectDirectory:resolve('..'),envFilePath,infoPath,businessHome:directory,
   pythonExecutable:join(directory,'python-does-not-exist'),environment:{NOTALONE_MANAGED_USER_DATA:directory,NOTALONE_WECHAT_CLI:join(directory,'unconfigured-cli'),NOTALONE_HOST_RUNTIME:'typescript',...environment}},()=>true);}
  finally{if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath;}
  hosts.push(host);
  let connection;
  for(let attempt=0;attempt<150&&host.isRunning();attempt++){
   try{connection=Object.fromEntries((await readFile(infoPath,'utf8')).trim().split('\n').map(line=>line.split('=')));break;}catch{}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!connection){await host.terminate();throw new Error('纯 TS 产品必须发布认证握手');}
  return {host,connection,async request(path,body,method=body===undefined?'GET':'POST',token=connection.token,headers={}){
   const response=await fetch(`http://${connection.address}${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
   return {status:response.status,data:await response.json()};
  }};
 }};
}
