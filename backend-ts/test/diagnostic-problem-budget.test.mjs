import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {chmod,mkdtemp,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindDiagnosticProblemBudget} from '../src/diagnostic-problem-budget.ts';

const python=process.env.NOTALONE_TEST_PYTHON??join(homedir(),'miniconda3/envs/NotAlone/bin/python');
const environment={PATH:process.env.PATH,NOTALONE_DISABLE_DOTENV:'1',PYTHONPATH:new URL('../../backend/src',import.meta.url).pathname};
function control(path,...args) {
 return JSON.parse(execFileSync(python,['-m','notalone.experiments.problem_budget','--ledger',path,...args],{env:environment,timeout:10000,stdio:['ignore','pipe','pipe']}).toString());
}
const start=(path,round)=>control(path,'start','--round',round,'--hypothesis','只验证同一问题的合成累计预留');
const finish=(path,round,outcome)=>control(path,'finish','--round',round,'--outcome',outcome,'--evidence','synthetic-evidence');
const bind=(path,round='r1')=>bindDiagnosticProblemBudget({NOTALONE_PROBLEM_BUDGET:path,NOTALONE_PROBLEM_ROUND:round});
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'na-shared-problem-budget-'));await chmod(directory,0o700);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const path=join(directory,'problem.sqlite');
 control(path,'create','--problem','synthetic-cumulative-problem','--calls','8','--minutes','30');start(path,'r1');
 return {directory,path};
}
async function worker(t,command,args) {
 const child=spawn(command,args,{env:environment,stdio:['pipe','pipe','pipe']});
 const exited=once(child,'exit'),lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
 let errors='';child.stderr.on('data',v=>errors+=v);
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exited;});
 assert.equal((await lines.next()).value,'ready',errors);
 return {run:async()=>{child.stdin.end('go\n');const result=JSON.parse((await lines.next()).value);assert.equal((await exited)[0],0,errors);return result;}};
}

test('既有 Python CLI 可管理 TS 共用账本；未结案及连续两轮无改善均停止',{timeout:15000},async t=>{
 const {path}=await fixture(t),r1=bind(path);r1.reserve()();
 assert.equal(control(path,'status').used,1);
 assert.throws(()=>start(path,'r2'));
 assert.throws(()=>bind(path,'r2').reserve(),/round_unsettled/);
 finish(path,'r1','unchanged');start(path,'r2');
 assert.throws(()=>r1.reserve(),/round_unsettled/);
 bind(path,'r2').reserve()();
 assert.equal(control(path,'status').used,2);
 finish(path,'r2','unknown');
 assert.throws(()=>bind(path,'r2').reserve(),/no_improvement/);
 assert.throws(()=>start(path,'r3'));
 assert.equal(control(path,'status').no_improvement_rounds,2);
});

test('Python 与 TS 多进程并发使用同一 SQLite 锁；无任何计数重置',{timeout:15000},async t=>{
 const {path}=await fixture(t);bind(path).reserve()();
 const py=await worker(t,python,[new URL('./diagnostic-problem-budget-python-fixture.py',import.meta.url).pathname,path,'r1']);
 const ts=await worker(t,process.execPath,[new URL('./diagnostic-problem-budget-node-fixture.mjs',import.meta.url).pathname,path,'r1']);
 const results=await Promise.all([py.run(),ts.run()]);
 assert.equal(results.reduce((n,r)=>n+r.reserved,0),7);
 assert.equal(control(path,'status').used,8);
 assert.throws(()=>bind(path).reserve(),/exhausted/);
 assert.throws(()=>control(path,'create','--problem','reset','--calls','8','--minutes','30'));
});

test('原有显式继续授权记录仍限制轮次与期限，不改变累计用量',{timeout:15000},async t=>{
 const {path}=await fixture(t);bind(path).reserve()();finish(path,'r1','unchanged');
 start(path,'r2');finish(path,'r2','unknown');
 control(path,'authorize-continuation','--reason','合成测试中的明确新授权','--max-new-rounds','1','--minutes','1');
 start(path,'r3');bind(path,'r3').reserve()();
 assert.equal(control(path,'status').used,2);
 finish(path,'r3','improved');assert.throws(()=>start(path,'r4'));
});

test('绑定固定私有既有绝对路径，撤 env、换文件和公开权限不能解除限制',async t=>{
 const {path,directory}=await fixture(t);
 assert.equal(bindDiagnosticProblemBudget({}),null);
 for(const env of [{NOTALONE_PROBLEM_BUDGET:path},{NOTALONE_PROBLEM_ROUND:'r1'},{NOTALONE_PROBLEM_BUDGET:'relative.sqlite',NOTALONE_PROBLEM_ROUND:'r1'}])assert.throws(()=>bindDiagnosticProblemBudget(env),/binding_invalid/);
 const env={NOTALONE_PROBLEM_BUDGET:path,NOTALONE_PROBLEM_ROUND:'r1'},guard=bindDiagnosticProblemBudget(env);
 delete env.NOTALONE_PROBLEM_BUDGET;delete env.NOTALONE_PROBLEM_ROUND;guard.reserve()();
 assert.equal(control(path,'status').used,1);
 const link=join(directory,'symlink.sqlite');await symlink(path,link);assert.throws(()=>bind(link),/not_private/);
 await chmod(path,0o644);assert.throws(()=>guard.reserve(),/not_private/);await chmod(path,0o600);
 await chmod(directory,0o755);assert.throws(()=>guard.reserve(),/not_private/);await chmod(directory,0o700);
 await rename(path,join(directory,'original.sqlite'));
 control(path,'create','--problem','synthetic-cumulative-problem','--calls','8','--minutes','30');start(path,'r1');
 assert.throws(()=>guard.reserve(),/replaced/);
 assert.equal(control(path,'status').used,0,'替换文件不能让已绑定发送者使用新计数');
 const missing=join(directory,'missing.sqlite');assert.throws(()=>bind(missing),/unavailable/);
 await writeFile(join(directory,'not-a-ledger'),'invalid',{mode:0o600});
 assert.throws(()=>bind(join(directory,'not-a-ledger')).reserve(),/unavailable/);
});
