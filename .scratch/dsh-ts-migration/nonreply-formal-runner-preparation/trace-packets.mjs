/** 从自有私有journal重建E/V盲包；不读取真实资料、不评分。 */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeTracePackets} from './neutral-trace.mjs';
import {REPO,OWN} from './snapshot.mjs';
import {sha} from '../resumed-nonreply-evaluation/runner.mjs';
const [label,packetLabel='neutral-ev-final']=process.argv.slice(2);
assert.ok(/^[a-zA-Z0-9_-]+$/.test(label)&&/^[a-zA-Z0-9_-]+$/.test(packetLabel),'owned_report_label_required');
const report=JSON.parse(await readFile(join(REPO,OWN,label,'report.json'),'utf8'));
assert.match(report.private_evidence_directory_label,/^notalone-nonreply-formal-evidence-[a-zA-Z0-9]+$/);
const directory=join(tmpdir(),report.private_evidence_directory_label),journal=await readFile(join(directory,'observations.jsonl'),'utf8');
const records=journal.trim().split('\n').map(JSON.parse).filter(r=>r.domain==='memory_extraction').map(r=>({
  case_id:r.case_id,arm:r.arm,commit:r.commit,scope:r.scope,sources:r.adaptation.sources,events:r.audit.trace_events}));
const receipt=await writeTracePackets({records,directory:join(directory,packetLabel),repositoryRoot:REPO});
await writeFile(join(REPO,OWN,`${packetLabel}-receipt.json`),JSON.stringify({...receipt,source_report:`${label}/report.json`,
  source_report_sha256:sha(await readFile(join(REPO,OWN,label,'report.json'),'utf8')),private_journal_sha256:sha(journal),
  original_failures_preserved:true},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
