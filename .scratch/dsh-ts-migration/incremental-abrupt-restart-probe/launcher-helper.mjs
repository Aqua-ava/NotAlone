// 独立helper仅复用真实launcher；外层只对本进程注入SIGKILL。
import {readFile,writeFile} from 'node:fs/promises';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const {launchDsh}=await import(config.projectDirectory+'/backend-ts/src/launch.ts');
try{
 const host=await launchDsh(config,()=>true);
 process.send({type:'launched',helper_pid:process.pid,dsh_pid:host.pid});
 const keep=setInterval(()=>{},1000);
 await host.waitForExit(120000);
 clearInterval(keep);process.send?.({type:'exited',dsh_pid:host.pid});process.disconnect?.();
}catch(error){process.send?.({type:'error',message:String(error),stack:error.stack});process.disconnect?.();process.exitCode=1;}
