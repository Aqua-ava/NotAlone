import {pathToFileURL} from 'node:url';
import {isAbsolute,resolve} from 'node:path';
import {loadNarrowWechatOptions} from './wechat/artifacts.ts';
import {NarrowWechatClient} from './wechat/native-client.ts';
import {importSelectedQuarantine} from './quarantine-import.ts';
import {QuarantineVault} from './quarantine-vault.ts';
import {QuarantineViewer} from './quarantine-viewer.ts';

/** 单联系人开发验收命令；不注册为产品运行时工具或后台同步任务。 */
export async function runQuarantineCli(args:string[]):Promise<void> {
 const [command,...rest]=args;
 if(!['import','view'].includes(command??''))throw new Error('quarantine_arguments_invalid');
 const options:Record<string,string>={};
 for(let index=0;index<rest.length;index+=2){
  const key=rest[index],value=rest[index+1];
  if(!['--root','--contact','--executable'].includes(key)||options[key]!==undefined||typeof value!=='string'||!value.length)throw new Error('quarantine_arguments_invalid');
  options[key]=value;
 }
 const root=options['--root'];
 if(!root||!isAbsolute(root)||resolve(root)!==root)throw new Error('quarantine_arguments_invalid');
 if(command==='import'){
  if(!options['--contact']||!options['--executable'])throw new Error('quarantine_arguments_invalid');
  const client=new NarrowWechatClient(await loadNarrowWechatOptions(options['--executable']));
  const vault=await importSelectedQuarantine(client,{root,displayName:options['--contact']});
  try{const summary=vault.summary();console.log(JSON.stringify({snapshotComplete:summary.snapshotComplete,normalHistory:false,recordCount:summary.recordCount,pageCount:summary.pageCount,failureCode:summary.failureCode}));}finally{vault.close();}
 }else{
  if(Object.keys(options).length!==1)throw new Error('quarantine_arguments_invalid');
  const vault=await QuarantineVault.open(root);
  let viewer:QuarantineViewer;
  try{viewer=await QuarantineViewer.start(vault);}catch(error){vault.close();throw error;}
  const shutdown=()=>{void viewer.close().finally(()=>{vault.close();process.exitCode=0;});};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  console.log(viewer.url);
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 runQuarantineCli(process.argv.slice(2)).catch(error=>{
  const code=error&&typeof error==='object'&&typeof error.code==='string'?error.code:error instanceof Error?error.message:'quarantine_failed';
  console.error(/^[a-z][a-z0-9_]{1,100}$/.test(code)?code:'quarantine_failed');process.exitCode=1;
 });
}
