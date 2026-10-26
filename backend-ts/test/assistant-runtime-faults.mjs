/** 仅测试自有宿主的文件系统故障与持久性屏障；不替换业务或SDK接口。 */
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';

const home=process.env.NOTALONE_SYNTHETIC_BUSINESS_HOME,control=process.env.NOTALONE_SYNTHETIC_RUNTIME_FAULTS;
if(!home||control!==join(home,'runtime-faults.json')||!/^notalone_ts_host_[a-f0-9]+_test$/.test(process.env.NOTALONE_SYNTHETIC_DATABASE??''))throw Error('仅允许自有合成宿主文件屏障');
const original={open:fs.open,writeFile:fs.writeFile,readFile:fs.readFile,link:fs.link};
const root=join(await fs.realpath(home),'assistant-runtime')+'/';
const configuration=async()=>JSON.parse(await original.readFile(control,'utf8'));
let reported=false;const durable=new Set();
const report=()=>{if(!reported){reported=true;process.stdout.write('VALIDATION_RUNTIME_DURABLE_MARKER\n');}};
fs.open=async function(path,...args){
 const handle=await original.open(path,...args);
 if(typeof path==='string'&&path.startsWith(root)){
  const sync=handle.sync.bind(handle),close=handle.close.bind(handle);
  handle.sync=async()=>{
   await sync();const config=await configuration();
   if(!reported&&config.durable_marker&&path.includes('.jsonl')&&(await original.readFile(path,'utf8')).includes(config.durable_marker)){durable.add(path);if(path.endsWith('.jsonl'))report();}
  };
  handle.close=async()=>{
   const config=await configuration();await close();
   if(config.fail_lock_close&&path.endsWith('/session.lock'))throw Object.assign(Error('合成锁关闭确认失败'),{code:'EIO'});
  };
 }
 return handle;
};
fs.link=async function(source,target){await original.link(source,target);if(durable.has(source)&&typeof target==='string'&&target.endsWith('.jsonl'))report();};
fs.writeFile=async function(path,...args){
 if(typeof path==='string'&&path.startsWith(root)&&path.endsWith('/business-reference.json')){
  const config=await configuration();
  if(config.fail_reference){process.stdout.write('VALIDATION_RUNTIME_WRITE_REFUSED\n');throw Object.assign(Error('合成磁盘写入失败'),{code:'ENOSPC'});}
  if(config.hold_reference){process.stdout.write('VALIDATION_RUNTIME_WRITE_HELD\n');await new Promise(resolve=>process.once('SIGUSR2',resolve));}
 }
 return original.writeFile(path,...args);
};
syncBuiltinESMExports();
