// 审查夹具护栏：仅允许本轮合成库和回环连接，不改变待审源码。
import {createRequire,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import net from 'node:net';
import childProcess from 'node:child_process';
const root=process.env.NOTALONE_REVIEW_FIXED_ROOT;
const records=process.env.NOTALONE_REVIEW_RECORDS;
if(!root||!records)throw new Error('review_isolation_required');
process.umask(0o077);
const require=createRequire(join(root,'backend-ts/package.json'));
const pg=require('pg');
if(require('pg/package.json').version!=='8.16.3')throw new Error('review_pg_version_mismatch');
const readRecords=()=>JSON.parse(readFileSync(records,'utf8'));
const persist=value=>writeFileSync(records,JSON.stringify(value),{mode:0o600});
const connect=pg.Client.prototype.connect;
pg.Client.prototype.connect=function(...args){
 const c=this.connectionParameters;
 if(c.host!=='/tmp'||Number(c.port)!==5432||c.database!=='postgres'&&!readRecords().created.includes(c.database))throw new Error('review_database_scope_rejected');
 return Reflect.apply(connect,this,args);
};
const query=pg.Client.prototype.query;
pg.Client.prototype.query=function(config,...args){
 if(this.connectionParameters.database==='postgres'){
  const text=typeof config==='string'?config:config?.text;
  const match=/^(CREATE|DROP) DATABASE "(notalone_(?:pure_ts|review)_[a-f0-9]+_test)"(?: TEMPLATE template0)?$/.exec(text??'');
  if(!match)throw new Error('review_admin_query_rejected');
  const r=readRecords(),name=match[2];
  if(match[1]==='CREATE'){if(r.created.includes(name))throw new Error('review_database_reused');r.created.push(name);}
  else {if(!r.created.includes(name))throw new Error('review_database_not_owned');r.dropRequested.push(name);}
  persist(r);
 }
 return Reflect.apply(query,this,[config,...args]);
};
const socketConnect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let value=args[0];if(Array.isArray(value))value=value[0];
 const host=typeof value==='object'?value?.host:typeof args[1]==='string'?args[1]:undefined;
 const path=typeof value==='object'?value?.path:typeof value==='string'?value:undefined;
 if(host&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('review_external_network_rejected');
 if(path&&!path.startsWith(root)&&!path.startsWith(process.env.TMPDIR??root)&&path!=='/tmp/.s.PGSQL.5432')throw new Error('review_socket_scope_rejected');
 return Reflect.apply(socketConnect,this,args);
};
const fetch=globalThis.fetch;
globalThis.fetch=(input,...args)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('review_external_fetch_rejected');
 return fetch(input,...args);
};
const spawn=childProcess.spawn;
childProcess.spawn=function(command,args,options){
 if(command===process.execPath){
  options={...options,env:{...options?.env,NODE_OPTIONS:`--import=${fileURLToPath(import.meta.url)}`,
   NOTALONE_REVIEW_FIXED_ROOT:root,NOTALONE_REVIEW_RECORDS:records,TMPDIR:process.env.TMPDIR}};
 }
 const child=Reflect.apply(spawn,this,[command,args,options]);
 if(command===process.execPath&&child.pid){
  appendFileSync(records+'.processes',JSON.stringify({pid:child.pid,event:'spawn'})+'\n',{mode:0o600});
  child.once('exit',code=>appendFileSync(records+'.processes',JSON.stringify({pid:child.pid,event:'exit',code})+'\n',{mode:0o600}));
 }
 return child;
};

// 拒绝读取项目私有环境文件；本轮合成夹具的 runtime.env 不在仓库中。
const originalRead = fs.readFileSync;
fs.readFileSync = function(path,...args) {
 const value = String(path);
 if (value.startsWith(process.env.NOTALONE_REVIEW_REPO + '/') && /(?:^|\/)\.env(?:$|\.)/.test(value)) throw new Error('review_repository_env_rejected');
 return Reflect.apply(originalRead,this,[path,...args]);
};
syncBuiltinESMExports();
