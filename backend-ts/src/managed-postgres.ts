/** 本次自建 PostgreSQL 的窄寿命监督；不发现或接管其他进程。 */
import {spawn,type ChildProcess} from 'node:child_process';
import {lstat,rm,realpath,type FileHandle} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openManagedLifetimeFile,ManagedLifetimeError} from './platform/database/managed-database-lifetime.ts';
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
function running(child:ChildProcess):boolean{return child.exitCode===null&&child.signalCode===null;}
async function main():Promise<number>{
 const argv=process.argv.slice(2),keys=['--postgres','--data-directory','--port','--parent-pid','--lifetime-lock'];
 if(argv.length!==10||keys.some((key,i)=>argv[i*2]!==key))return 2;
 const [postgres,cluster,portText,parentText,lock]=keys.map((_,i)=>argv[i*2+1]);
 const port=Number(portText),parent=Number(parentText);
 if(!Number.isSafeInteger(port)||port<1||port>65535||!Number.isSafeInteger(parent)||parent<=1||process.ppid!==parent||[postgres,cluster,lock].some(value=>!isAbsolute(value)||/[\0\r\n]/.test(value)))return 2;
 let original:FileHandle|undefined,exclusive:FileHandle|undefined,child:ChildProcess|undefined;
 let timer:NodeJS.Timeout|undefined,stop!:()=>void;
 const stopping=new Promise<void>(resolve=>{stop=resolve;});
 let lost=false;const requestStop=()=>{lost=true;stop();};
 const sameFile=async()=>{const current=await lstat(lock),owned=await original!.stat();return current.isFile()&&current.dev===owned.dev&&current.ino===owned.ino;};
 let exited:Promise<number>|undefined;
 try{
  original=await openManagedLifetimeFile(lock,undefined,true);
  process.stdin.resume();process.stdin.once('end',requestStop);process.once('SIGINT',requestStop);process.once('SIGTERM',requestStop);
  timer=setInterval(()=>{if(process.ppid!==parent)requestStop();},100);
  if(process.ppid!==parent||lost)return 2;
  child=spawn(postgres,['-D',cluster,'-h','127.0.0.1','-p',String(port),'-c','unix_socket_directories=','-c','password_encryption=scram-sha-256','-c','logging_collector=off'],{stdio:'ignore'});
  exited=new Promise<number>(resolve=>{child!.once('error',()=>resolve(2));child!.once('exit',(code)=>resolve(code??2));});
  await new Promise<void>((resolve,reject)=>{child!.once('spawn',resolve);child!.once('error',reject);});
  if(!child.pid)return 2;
  process.stdout.write(JSON.stringify({pid:child.pid})+'\n');
  await Promise.race([exited,stopping]);
  while(running(child)&&!exclusive){
   if(!await sameFile())throw new ManagedLifetimeError('managed_lifetime_invalid');
   try{exclusive=await openManagedLifetimeFile(lock,'exclusive');}
   catch(error){if(!(error instanceof ManagedLifetimeError)||error.code!=='managed_lifetime_busy')throw error;await delay(100);}
  }
  if(running(child)){
   if(!await sameFile())throw new ManagedLifetimeError('managed_lifetime_invalid');
   child.kill('SIGINT');
   let stopTimer:NodeJS.Timeout|undefined;
   try{const forced=new Promise<void>(resolve=>{stopTimer=setTimeout(resolve,10000);});await Promise.race([exited,forced]);}
   finally{clearTimeout(stopTimer);}
   if(running(child))child.kill('SIGQUIT');
  }
  return await exited;
 }catch{
  // 寿命文件归属或锁不明时保留资料服务，不能越过未知消费者停库。
  return child&&running(child)&&exited?await exited:2;
 }finally{
  clearInterval(timer);process.stdin.removeListener('end',requestStop);process.stdin.pause();process.removeListener('SIGINT',requestStop);process.removeListener('SIGTERM',requestStop);
  if(original){try{if(await sameFile())await rm(lock);}catch{}await exclusive?.close();await original.close();}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(await realpath(process.argv[1])).href)process.exitCode=await main();
