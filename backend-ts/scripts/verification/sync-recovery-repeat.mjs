#!/usr/bin/env node
/** 在本脚本已创建的同一历史备份副本上再次重开；不重新注入围栏，可用于修复后和并表后的回归。 */
import assert from 'node:assert/strict';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {childPass} from './sync-recovery-replay.mjs';
import {snapshot,assertDataPreserved,verifyReplayArtifact} from './sync-replay-support.mjs';
const args=new Map(process.argv.slice(2).map(value=>{const at=value.indexOf('=');return [value.slice(2,at),value.slice(at+1)];}));
const userData=realpathSync(args.get('user-data')),executable=verifyReplayArtifact(args.get('executable'),args.get('artifact-root')),rounds=Number(args.get('rounds')??6),label=args.get('label')??'repeat';
assert.ok(userData.startsWith(realpathSync('/tmp')+'/notalone-sync-'),'只允许本轮创建的临时副本');
assert.ok(existsSync(join(userData,'pass-0.log'))||existsSync(join(userData,'source-proof-verification.json')),'已有回放或迁移验证记录方可继续');
assert.ok(Number.isSafeInteger(rounds)&&rounds>=6&&/^[a-z0-9-]{1,40}$/.test(label));
const transientRetries=Number(args.get('transient-retries')??0);assert.ok(Number.isSafeInteger(transientRetries)&&transientRetries>=0&&transientRetries<=4);
const file=join(userData,'managed/sqlite/notalone.sqlite'),before=snapshot(file),results=[];
let last=before;
for(let index=0;index<rounds;index++){
 const tested=await childPass({userData,executable,pass:`${label}-${index}`,inject:false,hard:index===2,transientRetries});
 const result=tested.result;console.log(JSON.stringify({event:'repeat-attempt',hardKilled:tested.hardKilled,...result}));
 assert.equal(result.failed,0,'有效范围均可正常接续');assert.equal(result.after.eligibleFences,0,'有效范围均无围栏');
 assert.ok(result.after.fences<=last.fences,'反复重开与硬中断不增加围栏');assertDataPreserved(before,result.after);last=result.after;results.push(result);
 console.log(JSON.stringify({event:'repeat-result',hardKilled:tested.hardKilled,...result}));
}
console.log(JSON.stringify({event:'repeat-summary',lifecycles:rounds,reopens:rounds-1,hardInterrupts:1,before,after:snapshot(file),results}));
