/** 固定过去 as_of 与真实 PG 租约时钟的最小双臂证据；不改 Date 或数据库时钟。 */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,chmod,writeFile,readFile} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {CANDIDATE,hash,createLayeredSnapshot} from './snapshot.mjs';
import {createL3ProfileBusiness} from './business.mjs';
import {startSyntheticSupplier} from './loopback-supplier.mjs';
import {prepareFormalPlan} from '../nonreply-formal-model-seam/plan.mjs';
import {FormalExecutor} from '../nonreply-formal-model-seam/formal-executor.mjs';
import {createPersistentBroker} from '../nonreply-persistent-broker/broker.mjs';
import {createLoopbackTransport} from '../nonreply-persistent-broker/transport.mjs';
import {createSyntheticBudget} from '../nonreply-persistent-broker/synthetic-budget.mjs';
const args=process.argv.slice(2);assert.equal(args[0],'--synthetic-only');
const expectation=args[1]??'expired',candidateCommit=args[2]??CANDIDATE;
assert.ok(['expired','live'].includes(expectation));assert.match(candidateCommit,/^[a-f0-9]{40}$/);
const directory=await mkdtemp(join(tmpdir(),'notalone-layered-clock-'));await chmod(directory,0o700);
const snapshot=await createLayeredSnapshot({directory:join(directory,'archive'),candidateCommit});
await writeFile(join(directory,'source-manifest.json'),await readFile(join(directory,'archive/source-manifest.json')),{mode:0o600});
const plan=await prepareFormalPlan({candidateCommit}),contexts=new Map(),receipts=[],leases=[];
let budget,broker,supplier,active,summary;
try{
  await mkdir(join(directory,'budget'),{mode:0o700});await mkdir(join(directory,'journal'),{mode:0o700});
  budget=await createSyntheticBudget({directory:join(directory,'budget'),deadline:Date.now()+300000,limit:1000,problemId:'synthetic-layered-clock'});
  supplier=await startSyntheticSupplier({});const source={assertCurrent:()=>snapshot.assertCurrent()},permission={assertAllowed:async()=>true};
  broker=await createPersistentBroker({directory:join(directory,'journal'),budget:budget.port,source,permission,assertCurrent:()=>active.assertCurrent(),
    controls:{model:'deepseek-flash',maxTokens:393216,temperature:0,thinking:'disabled'},transport:createLoopbackTransport({origin:supplier.origin})});
  const named=createL3ProfileBusiness({snapshot,directory,contexts,receipts,evaluationClock:{mode:'frozen_content',qualification:'pending_independent_review'}});
  const business={async open(run){const session=await named.open(run);active=session;supplier.setRun(run,'success',session.cancel);const close=session.close;
    return {...session,async close(){const context=contexts.get(run.run_id),pg=context.fixture.client;
      leases.push({arm:run.arm,rows:(await pg.query(`SELECT status,created_at,lease_expires_at,clock_timestamp() AS operational_observed_at,
        lease_expires_at>clock_timestamp() AS operational_lease_live,error_code FROM layered_profile_batch WHERE owner_id=$1 AND contact_id=$2`,[run.scope.owner_id,run.scope.contact_id])).rows,
        persisted:await context.durable()});await close();active=null;}};}};
  const pair=plan.runs.filter(r=>r.domain==='l3_profile'&&r.case_id==='l3_profile-01'&&r.repeat===3);assert.equal(pair.length,2);
  const report=broker.reconcileExecutorReport(await new FormalExecutor({plan,business,source,permission,budget:broker.budget,supplier:broker.supplier}).executePair(pair.map(r=>r.run_id)));
  const raw={report,leases,requests:supplier.requests,journal:await broker.summary(),budget:await budget.port.inspect(),source:snapshot.source};
  await writeFile(join(directory,'clock-raw.json'),JSON.stringify(raw,null,2),{mode:0o600});
  summary={schema_version:'layered-past-as-of-clock-probe-v1',candidate_commit:candidateCommit,old_commit:snapshot.source.old_commit,
    requested_as_of:'2026-10-23T12:00:00+08:00',source_observed_at:'2026-10-20T09:00:00+08:00',clock_mode:'frozen_content',Date_mocked:false,pg_now_mocked:false,
    formal_quality:false,independent_semantic_reviews:0,real_vendor_calls:0,physical_loopback_http:supplier.requests.length,outer_used:raw.budget.used,remaining:raw.budget.remaining,
    expectation,records:report.records.map(r=>({arm:r.arm,terminal_status:r.terminal_status,error:r.error_code??r.business_error??null,physical_attempts:r.attempts.filter(a=>a.sent).length,
      scenarios:r.business_output?.scenarios.length??0,profiles:r.business_output?.profiles.length??0,source_snapshot_sha256:r.audit?.source_snapshot_sha256??null})),
    leases:leases.map(l=>({arm:l.arm,rows:l.rows})),source_manifest_sha256:hash(await readFile(join(directory,'source-manifest.json'))),raw_sha256:hash(await readFile(join(directory,'clock-raw.json'))),private_directory_label:directory.split('/').at(-1)};
  const rawText=JSON.stringify(summary,null,2)+'\n';assert.ok(!rawText.includes(homedir()));
  await writeFile(new URL('./'+directory.split('/').at(-1)+'-summary.json',import.meta.url),rawText);await writeFile(join(directory,'public-summary.json'),rawText,{mode:0o600});
  let history=JSON.parse(await readFile(new URL('./probe-history.json',import.meta.url)));history.push({label:summary.private_directory_label,raw_sha256:summary.raw_sha256,public_sha256:hash(rawText),observed:2,physical_http:supplier.requests.length,formal_quality:false,clock_expectation:expectation});await writeFile(new URL('./probe-history.json',import.meta.url),JSON.stringify(history,null,2)+'\n');
  const newer=summary.records.find(r=>r.arm==='new'),newLease=summary.leases.find(l=>l.arm==='new');
  if(expectation==='expired'){assert.equal(newer.terminal_status,'failed');assert.ok(newLease.rows.some(r=>r.operational_lease_live===false));assert.equal(newer.profiles,0);}
  else{assert.ok(summary.records.every(r=>r.terminal_status==='succeeded'&&r.profiles>0));assert.ok(newLease.rows.every(r=>r.operational_lease_live===true));}
  console.log(JSON.stringify(summary));
}finally{await broker?.close();await budget?.close();await supplier?.close();const cleanup={snapshot:await snapshot.close(),all_fixtures_dropped:receipts.every(r=>r.dropped)};
  await writeFile(join(directory,'cleanup.json'),JSON.stringify(cleanup),{mode:0o600});await writeFile(new URL('./'+directory.split('/').at(-1)+'-cleanup.json',import.meta.url),JSON.stringify(cleanup,null,2)+'\n');}
