// 测试专用：只在随机合成数据库内对一次来源窗口注入真实 PostgreSQL 超时。
import pg from 'pg';
import { appendFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
const database=process.env.NOTALONE_SYNTHETIC_DATABASE,home=process.env.NOTALONE_SYNTHETIC_BUSINESS_HOME;
if(!/^notalone_ts_host_[a-f0-9]{32}_test$/.test(database??'')||!home||!isAbsolute(home))throw new Error('仅允许独立合成数据库和资料目录');
const query=pg.Client.prototype.query;
let injected=false;
pg.Client.prototype.query=function(...args){
  const result=Reflect.apply(query,this,args);
  if(injected||typeof args[0]!=='string'||!args[0].includes("set_config('statement_timeout'")||args[1]?.[0]!=='500ms'||!result?.then)return result;
  injected=true;
  return result.then(async value=>{
    try{await this.query('SELECT pg_sleep(0.65)');}
    catch(error){appendFileSync(join(home,'source-window-timeout.jsonl'),JSON.stringify({database,code:error.code})+'\n',{mode:0o600});throw error;}
    throw new Error('真实来源窗口超时未触发');
  });
};
