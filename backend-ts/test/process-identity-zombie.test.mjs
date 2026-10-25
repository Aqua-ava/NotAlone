/** 仅创建本轮合成子进程；验证实际 zombie 与进程身份的拒绝边界。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {once} from 'node:events';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {captureProcessIdentity,processIdentityState} from '../src/process-identity.ts';

const execute=promisify(childProcess.execFile);
const psArguments=pid=>['-ww','-p',String(pid),'-o','pid=,ppid=,lstart=,stat=,comm='];
const python=process.env.NOTALONE_TEST_PYTHON||join(homedir(),'miniconda3/envs/NotAlone/bin/python');
async function until(read,label){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){const value=await read();if(value)return value;await delay(10);}
  assert.fail(`合成进程未在期限内就绪：${label}`);
}

async function zombieFixture(t){
  const script=`import json,os,sys
r,w=os.pipe()
pid=os.fork()
if pid==0:
 os.close(w)
 os.read(r,1)
 os._exit(0)
os.close(r)
print(json.dumps({'pid':pid}),flush=True)
try:
 for line in sys.stdin:
  if line.strip()=='exit-child':
   os.write(w,b'x')
  elif line.strip()=='reap':
   break
finally:
 os.close(w)
 reaped,status=os.waitpid(pid,0)
 print(json.dumps({'reaped':reaped==pid,'child_exit_code':os.waitstatus_to_exitcode(status)}),flush=True)
`;
  const parent=childProcess.spawn(python,['-u','-c',script],{
    env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1',NOTALONE_DISABLE_DOTENV:'1'},stdio:['pipe','pipe','pipe'],
  });
  const exited=once(parent,'exit');let output='',stderr='',closed;
  parent.stdout.setEncoding('utf8');parent.stdout.on('data',value=>output+=value);
  parent.stderr.setEncoding('utf8');parent.stderr.on('data',value=>stderr+=value);
  const close=()=>closed??=(async()=>{
    parent.stdin.end('reap\n');
    assert.deepEqual(await exited,[0,null],stderr);
    assert.deepEqual(JSON.parse(output.trim().split('\n').at(-1)),{reaped:true,child_exit_code:0});
    t.diagnostic(JSON.stringify({owned_child_reaped:true,owned_parent_exited:true,signals_sent:0}));
  })();
  t.after(close);
  const {pid}=await until(()=>output.includes('\n')&&JSON.parse(output.split('\n')[0]),'父进程发布本轮子进程');
  const identity=await captureProcessIdentity(pid,parent.pid,python);
  return {parent,pid,identity,close};
}

test('真实未reap的zombie识别为gone，capture仍拒绝接管它',async t=>{
  const fixture=await zombieFixture(t);
  assert.equal(await processIdentityState(fixture.identity),'same');
  fixture.parent.stdin.write('exit-child\n');
  const ps=await until(async()=>{
    const {stdout}=await execute('/bin/ps',psArguments(fixture.pid),{env:{LC_ALL:'C',PATH:'/usr/bin:/bin'}});
    return /\sZ\S*\s/.test(stdout)&&stdout;
  },'真实内核zombie状态');
  if(process.platform==='darwin')assert.match(ps,/\s<defunct>\s*$/,'必须覆盖无绝对可执行路径的真实macOS僵尸');
  assert.equal(await processIdentityState(fixture.identity),'gone');
  await assert.rejects(captureProcessIdentity(fixture.pid,fixture.parent.pid,python),/process_identity_unknown/);
  await fixture.close();
  assert.equal(await processIdentityState(fixture.identity),'gone');
});

test('存活身份保持same，旧启动时间和不同可执行实例均为gone且不影响原进程',async()=>{
  const identity=await captureProcessIdentity(process.pid,process.ppid,process.execPath);
  assert.equal(await processIdentityState(identity),'same');
  await assert.rejects(captureProcessIdentity(process.pid,process.ppid+1,process.execPath),/process_identity_unknown/);
  await assert.rejects(captureProcessIdentity(process.pid,process.ppid,dirname(process.execPath)),/process_identity_unknown/);
  assert.equal(await processIdentityState({...identity,startedAt:'Fri Jan 1 00:00:00 1999'}),'gone');
  assert.equal(await processIdentityState({...identity,executable:dirname(identity.executable)}),'gone');
  assert.equal(await processIdentityState(identity),'same');
});

test('不合法identity与非绝对executable继续返回unknown',async()=>{
  const identity=await captureProcessIdentity(process.pid,process.ppid,process.execPath);
  for(const invalid of [null,{},
    {...identity,pid:0},{...identity,pid:1.5},{...identity,pid:Number.MAX_SAFE_INTEGER+1},
    {...identity,parentPid:NaN},{...identity,startedAt:''},{...identity,executable:'relative-python'},
    {...identity,executable:null},
  ])assert.equal(await processIdentityState(invalid),'unknown');
  assert.equal(await processIdentityState(identity),'same');
});

test('ps系统边界的存活相对路径、错PID和未解析zombie继续拒绝为unknown',async()=>{
  const identity=await captureProcessIdentity(process.pid,process.ppid,process.execPath);
  let stdout='';
  const original=childProcess.execFile;
  // 只替换本测试进程的外部 ps 边界；独立模块实例仍执行正式解析和身份规则。
  const synthetic=()=>{throw new Error('synthetic_ps_requires_promisify');};
  synthetic[promisify.custom]=async(file,args)=>{
    assert.equal(file,'/bin/ps');assert.deepEqual(args,psArguments(identity.pid));
    return {stdout,stderr:''};
  };
  childProcess.execFile=synthetic;syncBuiltinESMExports();
  try{
    const api=await import(new URL('../src/process-identity.ts?synthetic-ps-boundary',import.meta.url));
    const row=(pid,status,executable)=>`${pid} ${identity.parentPid} ${identity.startedAt} ${status} ${executable}\n`;
    stdout=row(identity.pid,'S',identity.executable);
    assert.equal(await api.processIdentityState(identity),'same','系统边界夹具必须先通过有效对照');
    stdout=row(identity.pid,'S','relative-python');
    assert.equal(await api.processIdentityState(identity),'unknown');
    stdout=row(identity.pid+1,'Z','<defunct>');
    assert.equal(await api.processIdentityState(identity),'unknown','zombie不能跳过PID核对');
    stdout=`${identity.pid} ${identity.parentPid} invalid-start-time Z <defunct>\n`;
    assert.equal(await api.processIdentityState(identity),'unknown','zombie不能跳过完整ps行解析');
    stdout=row(identity.pid,'Z','<defunct>');
    assert.equal(await api.processIdentityState({...identity,pid:0}),'unknown','zombie不能跳过输入身份校验');
  }finally{
    childProcess.execFile=original;syncBuiltinESMExports();
  }
  assert.equal(await processIdentityState(identity),'same');
});
