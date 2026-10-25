/** 当前受控源码的故障回归；明确不是固定提交的正式质量执行。 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {FormalExecutor,hash} from './formal-executor.mjs';
import {enumerateFiles} from '../ticket25-final-run/source-snapshot.mjs';
import {prepareFormalPlan} from './plan.mjs';
import {BASELINE} from '../resumed-nonreply-evaluation/runner.mjs';
import {budgetFixture} from './test-fixture.mjs';
import {extractionBusiness} from './extraction-business.mjs';
import {createFakeSupplier} from './fake-supplier.mjs';
const execute=promisify(execFile),root=fileURLToPath(new URL('../../../',import.meta.url));
export async function runRetryRegression(){
  const directory=await mkdtemp(join(tmpdir(),'notalone-seam-retry-test-'));await chmod(directory,0o700);
  const candidateCommit=(await execute('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim();
  const plan=await prepareFormalPlan({candidateCommit}),runs=plan.runs.filter(r=>r.case_id==='明确事实'&&r.repeat===1);
  const files={};for(const p of await enumerateFiles(join(root,'backend-ts/src')))files['backend-ts/src/'+p]=hash(await readFile(join(root,'backend-ts/src',p)));
  const sourceValue={candidate_commit:candidateCommit,old_commit:BASELINE,source_sha256:hash(files),executed_tree_kind:'controlled_working_tree',matches_commit_tree:false};
  const source={async assertCurrent(){for(const [p,sha]of Object.entries(files))assert.equal(hash(await readFile(join(root,p))),sha,'controlled_source_changed');return sourceValue;}};
  await mkdir(join(directory,'legacy'),{mode:0o700});const archive=join(directory,'old.tar');
  await execute('git',['archive',BASELINE,'--format=tar','--output='+archive,'--','backend/src/notalone'],{cwd:root});
  await execute('tar',['-xf',archive,'-C',join(directory,'legacy')]);await rm(archive);
  const budget=await budgetFixture({limit:20,deadline:Date.now()+60000}),contexts=new Map(),receipts=[],controller=new AbortController();
  const supplier=await createFakeSupplier({contexts,directory,faultStatus:503});let report,watchFailure;
  const executor=new FormalExecutor({plan,source,budget:budget.port,permission:{assertAllowed:async()=>true},supplier:supplier.port,
    business:extractionBusiness({snapshotRoot:directory,directory,contexts,receipts})});
  const watcher=(async()=>{
    // 一条有界就绪等待：只观察该新臂首次恢复事件，发现旧默认后立即取消本测试。
    for(let i=0;i<100;i++){
      const current=contexts.get(runs.find(r=>r.arm==='new').run_id);
      if(current){
        const events=current.final_trace??await current.fixture.client.query("SELECT payload FROM memory_extraction_trace_event WHERE stage='extraction_recovery' AND owner_id=$1 AND contact_id=$2 ORDER BY position",[current.run.scope.owner_id,current.run.scope.contact_id]).then(r=>r.rows).catch(()=>[]);
        const recovery=events.find(e=>e.stage==='extraction_recovery'||e.payload?.will_retry!==undefined);
        if(recovery){if(recovery.payload.will_retry!==false){watchFailure='business_retry_not_disabled';controller.abort();}return;}
      }
      await delay(100);
    }
    watchFailure='recovery_event_not_observed';controller.abort();
  })();
  try{report=await executor.executePair(runs.map(r=>r.run_id),{signal:controller.signal});await watcher;await source.assertCurrent();}
  finally{controller.abort();await watcher;await supplier.close();
    await writeFile(join(directory,'budget-final.json'),JSON.stringify(budget.read()),{mode:0o600});await budget.close();await rm(join(directory,'legacy'),{recursive:true});}
  const newRun=runs.find(r=>r.arm==='new'),newContext=contexts.get(newRun.run_id),recoveries=newContext?.final_trace?.filter(e=>e.stage==='extraction_recovery')??[];
  const summary={source:sourceValue,source_files:files,report,watch_failure:watchFailure??null,
    calls:supplier.wire.map(w=>({arm:contexts.get(w.run_id).run.arm,path:w.path,status:w.status})),
    new_recoveries:recoveries.map(e=>e.payload),ledger_counts:Object.fromEntries([...contexts].map(([k,v])=>[v.run.arm,v.final_ledger_count])),
    receipts,real_model_calls:0,private_directory_label:directory.split('/').at(-1)};
  await writeFile(join(directory,'retry-result.json'),JSON.stringify(summary,null,2),{mode:0o600});
  assert.equal(watchFailure,undefined,watchFailure);
  assert.equal(summary.calls.filter(c=>c.arm==='new'&&c.path==='/anthropic/v1/messages').length,1,'E_must_send_once');
  assert.equal(summary.calls.filter(c=>c.arm==='new'&&c.path==='/beta/chat/completions').length,0,'V_must_not_send');
  assert.ok(recoveries.length===1&&recoveries[0].payload.will_retry===false,'business_retry_must_be_disabled');
  assert.equal(summary.ledger_counts.new,1,'failed_E_must_remain_accounted');
  assert.ok(receipts.every(r=>r.dropped),'owned_fixtures_must_drop');
  return summary;
}
