/** 固定评估脚本与唯一问题总账源码；不实现另一套预算。 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {join,dirname,isAbsolute} from 'node:path';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const scriptNames=['runner.mjs','old-arm.py','source-snapshot.mjs','observe-plugin.mjs','complete-output.mjs','bridge.mjs','bridge.py','execution-snapshot.mjs','primary.json','dependencies.mjs','local-provider.mjs','vendor-forward.mjs','legacy-system.json','run-full.mjs'];
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}

export function freezeProblemBudgetConfiguration(value,expected){
 if(!value||Object.keys(value).sort().join(',')!=='budget,moduleRoot,python,repositoryRoot'||!['python','moduleRoot','repositoryRoot'].every(key=>value[key]===expected[key])||!value.budget||Object.keys(value.budget).sort().join(',')!=='ledger,problem_id,round'||!['ledger','round','problem_id'].every(key=>typeof value.budget[key]==='string'&&value.budget[key].trim()===value.budget[key]&&value.budget[key])||!isAbsolute(value.budget.ledger))throw Error('budget_configuration_required');
 return freeze(structuredClone(value));
}

export async function captureEvaluationRuntime({collectorRoot,moduleRoot}){
 const entries=await Promise.all([
  ...scriptNames.map(async name=>['collector/'+name,await readFile(join(collectorRoot,name))]),
  ...['__init__.py','problem_budget.py'].map(async name=>['budget-modules/notalone/'+name,await readFile(join(moduleRoot,'notalone',name))]),
 ]);
 return {bytes:new Map(entries),files:Object.fromEntries(entries.map(([name,bytes])=>[name,sha(bytes)]))};
}

export async function freezeEvaluationRuntime(snapshot,directory){
 for(const [name,bytes]of snapshot.bytes){const path=join(directory,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes,{flag:'wx'});}
 await verifyEvaluationRuntime(snapshot,directory);
}

async function filesBelow(directory,prefix=''){
 const files=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(entry.isDirectory())files.push(...await filesBelow(join(directory,entry.name),prefix+entry.name+'/'));
  else if(entry.isFile())files.push(prefix+entry.name);
  else throw Error('evaluation_runtime_non_regular_file');
 }
 return files.sort();
}

export async function verifyEvaluationRuntime(snapshot,directory){
 assert.deepEqual(await filesBelow(directory),Object.keys(snapshot.files).sort(),'evaluation_runtime_file_set_changed');
 for(const [name,hash]of Object.entries(snapshot.files))assert.equal(sha(await readFile(join(directory,name))),hash,'evaluation_runtime_bytes_changed: '+name);
}

export function fixedBudgetConfiguration(configuration,directory){
 return freeze({...structuredClone(configuration),moduleRoot:join(directory,'budget-modules')});
}
