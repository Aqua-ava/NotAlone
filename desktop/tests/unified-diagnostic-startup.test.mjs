import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);

test('启动控制面保留失败行为，并将检查与阻塞写成固定状态而不输出路径',async t=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'notalone-startup-controller-')));t.after(()=>rm(root,{recursive:true,force:true}));const output=path.join(root,'ports.cjs');
 await build({stdin:{contents:`export {StartupDiagnostics} from './src/main/startup/diagnostics';export {BackendFailure} from './src/main/backend/connection';export {configureDiagnosticLog} from '../backend-ts/src/diagnostics/unified';export {readDiagnosticRecords} from '../backend-ts/src/diagnostics/unified-log.mjs';`,resolveDir:process.cwd()},outfile:output,bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 const p=require(output),log=p.configureDiagnosticLog(root,{proc:'main',development:true});t.after(()=>log.close());
 const startup=new p.StartupDiagnostics(path.join(root,'synthetic-private-user-data'));
 const phases=[];startup.onStateChanged(state=>phases.push(state.phase));
 await assert.rejects(startup.ensureReady({},()=>true),error=>error instanceof p.BackendFailure&&error.code==='backend_connection_failed');
 assert.deepEqual(phases,['checking','blocked']);assert.equal(startup.getState().code,'cutover_storage_failed');
 await log.flush();const rows=await p.readDiagnosticRecords(root),states=rows.filter(row=>row.event==='startup.state_changed');
 assert.deepEqual(states.map(row=>row.toState),phases);assert.equal(new Set(states.map(row=>row.traceId)).size,1);
 assert.deepEqual(states.map(row=>row.reasonCode),['started','not_ready']);assert.ok(states.every(row=>row.durationMs>=0));
 assert.doesNotMatch(JSON.stringify(rows),/synthetic-private|cutover_storage_failed|user-data/);
});
