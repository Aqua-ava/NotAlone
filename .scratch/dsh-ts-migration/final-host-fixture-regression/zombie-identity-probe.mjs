// 只创建和回收本轮合成 Python 父子进程；不接触产品配置或数据。
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {homedir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {captureProcessIdentity,processIdentityState} from '../../../backend-ts/src/process-identity.ts';
const exec=promisify(execFile),python=join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const script=`import os,sys
r,w=os.pipe()
pid=os.fork()
if pid==0:
 os.close(w)
 os.read(r,1)
 os._exit(0)
os.close(r)
print(pid,flush=True)
for line in sys.stdin:
 if line.strip()=='exit-child':
  os.write(w,b'x')
 elif line.strip()=='reap':
  os.waitpid(pid,0)
  print('reaped',flush=True)
  break
`;
const parent=spawn(python,['-u','-c',script],{env:{PATH:'/usr/bin:/bin'},stdio:['pipe','pipe','pipe']});
let buffer='';parent.stdout.setEncoding('utf8');parent.stdout.on('data',value=>buffer+=value);
const wait=async check=>{const end=Date.now()+5000;while(Date.now()<end){const value=await check();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw new Error('owned_probe_timeout');};
try{
 const pid=await wait(()=>/^([0-9]+)\n/.exec(buffer)?.[1]);
 const identity=await captureProcessIdentity(Number(pid),parent.pid,python);
 parent.stdin.write('exit-child\n');
 const ps=await wait(async()=>{const {stdout}=await exec('/bin/ps',['-ww','-p',pid,'-o','pid=,ppid=,lstart=,stat=,comm='],{env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}});return /\sZ\S*\s/.test(stdout)&&stdout.trim();});
 const observed=await processIdentityState(identity);
 console.log(JSON.stringify({ps,observed,expected:'gone'}));
 assert.equal(observed,'gone','已核验实例的 zombie 不能被解释为身份未知');
}finally{
 const exited=once(parent,'exit');parent.stdin.end('reap\n');await exited;
 console.log(JSON.stringify({owned_parent_exited:true,owned_child_reaped:buffer.includes('reaped')}));
}
