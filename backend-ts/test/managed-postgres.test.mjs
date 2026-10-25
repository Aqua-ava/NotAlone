import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import pg from 'pg';
import {acquireManagedDatabaseLease} from '../src/managed-database-lifetime.ts';
const pgBin=process.env.NOTALONE_TEST_PG_BIN??join(homedir(),'miniconda3/envs/NotAlone/bin');
const environment={PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',LC_ALL:'C'};
const bounded=(promise,ms)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('合成资料服务未在时限内响应')),ms);promise.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
async function unusedPort(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const {port}=server.address();await new Promise(resolve=>server.close(resolve));return port;}
test('受管PG在父管道关闭后等待原共享寿命锁，消费者收尾后才关闭自有postmaster',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'notalone-managed-pg-test-')),cluster=join(directory,'postgres'),lock=join(directory,'lifetime');
 const initialized=spawnSync(join(pgBin,'initdb'),['-D',cluster,'--username=notalone','--auth=trust','--encoding=UTF8','--locale=C','--no-instructions'],{env:environment,encoding:'utf8',timeout:30000});
 assert.equal(initialized.status,0,'仅初始化隔离合成cluster');const port=await unusedPort();
 const supervisor=spawn(process.execPath,['--experimental-strip-types','--no-warnings',new URL('../src/managed-postgres.ts',import.meta.url).pathname,'--postgres',join(pgBin,'postgres'),'--data-directory',cluster,'--port',String(port),'--parent-pid',String(process.pid),'--lifetime-lock',lock],{env:environment,stdio:['pipe','pipe','pipe']});
 const exited=once(supervisor,'exit');let release;
 t.after(async()=>{await release?.();supervisor.stdin.destroy();supervisor.kill('SIGINT');await bounded(exited,12000).catch(()=>{});spawnSync(join(pgBin,'pg_ctl'),['-D',cluster,'-m','immediate','-w','stop'],{env:environment,stdio:'ignore',timeout:10000});await rm(directory,{recursive:true,force:true});});
 const response=await bounded(new Promise((resolve,reject)=>{let output='';supervisor.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n'))resolve(output.trim());});supervisor.once('exit',()=>reject(new Error('合成监督器未发布PID')));}),5000);
 assert.ok(JSON.parse(response).pid>1);release=await acquireManagedDatabaseLease(lock);
 let ready=false;
 for(let attempt=0;attempt<100&&!ready;attempt++){const client=new pg.Client({host:'127.0.0.1',port,user:'notalone',database:'postgres',connectionTimeoutMillis:500});try{await client.connect();ready=true;}catch{}finally{await client.end().catch(()=>{});}if(!ready)await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal(ready,true);supervisor.stdin.end();
 const client=new pg.Client({host:'127.0.0.1',port,user:'notalone',database:'postgres'});await client.connect();assert.equal((await client.query('SELECT 7 AS retained')).rows[0].retained,7);await client.end();
 assert.equal(supervisor.exitCode,null);await release();release=undefined;
 assert.deepEqual(await bounded(exited,12000),[0,null]);
});
