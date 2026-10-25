/** 复用原业务投影盲包模块；完整E/V另由trace-packets.mjs补充。 */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeBlindPackets} from '../resumed-nonreply-evaluation/blind.mjs';
import {loadFrozenMaterials,createPlan,sha} from '../resumed-nonreply-evaluation/runner.mjs';
import {OWN,REPO,PIN} from './snapshot.mjs';
const [label,packetLabel='projection-final']=process.argv.slice(2);
assert.ok(/^[a-zA-Z0-9_-]+$/.test(label)&&/^[a-zA-Z0-9_-]+$/.test(packetLabel),'owned_report_label_required');
const path=join(REPO,OWN,label,'report.json'),bytes=await readFile(path,'utf8'),report=JSON.parse(bytes);
assert.match(report.private_evidence_directory_label,/^notalone-nonreply-formal-evidence-[a-zA-Z0-9]+$/);
const privateRoot=join(tmpdir(),report.private_evidence_directory_label);
const observations=(await readFile(join(privateRoot,'observations.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
const plan=createPlan(await loadFrozenMaterials(),{newCommit:PIN});
const receipt=await writeBlindPackets({plan,observations,privateDirectory:join(privateRoot,packetLabel)});
await writeFile(join(REPO,OWN,`${packetLabel}-receipt.json`),JSON.stringify({...receipt,source_report:`${label}/report.json`,
  source_report_sha256:sha(bytes),ev_companion:'neutral-ev-final-receipt.json',independent_reviews_completed:0},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({eligible_records:receipt.eligible_records,complete_pairs:receipt.complete_pairs,independent_reviews_completed:0}));
