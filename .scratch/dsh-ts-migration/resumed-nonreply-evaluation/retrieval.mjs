/** 复用已有完整检索runner，只隔离I/O并补当前提交与源码摘要；不改其断言。 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,relative,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';
import {ROOT,BASELINE,MANIFEST_SHA,sha} from './runner.mjs';

const execute=promisify(execFile);
const sourceURL=new URL('../../../backend-ts/test/retrieval-frozen-validation.mjs',import.meta.url);
const files=['backend-ts/test/retrieval-frozen-validation.mjs','backend-ts/test/retrieval-frozen-fixture.py',
  'backend-ts/test/retrieval-frozen-arm.py','backend-ts/test/retrieval-frozen-vectors.py','backend-ts/test/retrieval-frozen-summary.py'];
async function sourceFiles(){
  const seen=new Set(files),queue=['backend-ts/src/reply-context.ts','backend-ts/src/retrieval-embedding.ts','backend-ts/src/retrieval-hybrid.ts'];
  while(queue.length){
    const path=queue.shift();if(seen.has(path))continue;seen.add(path);
    const text=await readFile(join(ROOT,path),'utf8');
    for(const match of text.matchAll(/['"](\.[^'"]+\.ts)['"]/g)){
      const dependency=relative(ROOT,resolve(ROOT,dirname(path),match[1]));
      assert.ok(dependency.startsWith('backend-ts/src/'),'retrieval_source_graph_escape');
      queue.push(dependency);
    }
  }
  return [...seen].sort();
}
const hashes=async paths=>Object.fromEntries(await Promise.all(paths.map(async path=>[path,sha(await readFile(join(ROOT,path),'utf8'))])));

export async function runRetrievalComparison({newCommit,outputDirectory}){
  assert.match(newCommit??'',/^[a-f0-9]{8,40}$/,'new_commit_pin_required');
  const pin=(await execute('git',['rev-parse','--verify',`${newCommit}^{commit}`],{cwd:ROOT})).stdout.trim();
  const paths=await sourceFiles();
  await execute('git',['diff','--quiet',pin,'--',...paths,'backend-ts/package.json','backend-ts/pnpm-lock.yaml'],{cwd:ROOT});
  const before=await hashes(paths),temporary=await mkdtemp(join(tmpdir(),'notalone-nonreply-retrieval-'));
  const input=join(temporary,'input.json'),vectors=join(temporary,'vectors.json'),result=join(temporary,'result.json');
  const original=await readFile(sourceURL,'utf8');
  assert.ok(original.includes("const inputPath='/tmp/notalone-retrieval-frozen-input.json',vectorPath='/tmp/notalone-retrieval-frozen-vectors.json';"),'upstream_runner_io_changed');
  assert.ok(original.includes("new URL('../../.scratch/dsh-ts-migration/reply-generation/retrieval-frozen-results.json',import.meta.url)"),'upstream_runner_output_changed');
  let derived=original.replace("const inputPath='/tmp/notalone-retrieval-frozen-input.json',vectorPath='/tmp/notalone-retrieval-frozen-vectors.json';",
    `const inputPath=${JSON.stringify(input)},vectorPath=${JSON.stringify(vectors)};`);
  derived=derived.replace(/from '(\.[^']+)'/g,(_all,path)=>`from '${new URL(path,sourceURL).href}'`);
  derived=derived.replace(/new URL\('([^']+)',import.meta.url\)(\.pathname)?/g,(_all,path)=>
    JSON.stringify(path.includes('retrieval-frozen-results.json')?result:fileURLToPath(new URL(path,sourceURL))));
  const script=join(temporary,'derived.mjs');
  await writeFile(script,derived,{mode:0o600});
  try{
    await execute(process.execPath,[script],{cwd:join(ROOT,'backend-ts'),timeout:120000,maxBuffer:1024*1024,
      env:{PATH:process.env.PATH,HOME:process.env.HOME,USER:process.env.USER,
        PYTHONDONTWRITEBYTECODE:'1',NOTALONE_DISABLE_DOTENV:'1'}});
    const report=JSON.parse(await readFile(result,'utf8'));
    assert.equal(report.baseline_commit,BASELINE);
    assert.equal(report.manifest_sha256,MANIFEST_SHA);
    const after=await hashes(paths);
    assert.deepEqual(after,before,'retrieval_sources_changed_during_run');
    await execute('git',['diff','--quiet',pin,'--',...paths,'backend-ts/package.json','backend-ts/pnpm-lock.yaml'],{cwd:ROOT});
    Object.assign(report,{schema_version:'nonreply-current-retrieval-v1',new_commit:pin,
      source_files:before,source_files_unchanged:true,upstream_runner_unchanged:true,
      version_scope:'reachable_retrieval_source_graph_and_lockfiles',
      io_adaptation_only:true,real_model_calls:0,real_model_quality_verified:false,
      production_switch_approved:false,scope:'deterministic_recall_and_local_vector_compatibility_only'});
    await mkdir(outputDirectory,{recursive:true});
    await writeFile(join(outputDirectory,'retrieval-results.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
    return report;
  }finally{
    try{
      const data=JSON.parse(await readFile(input,'utf8'));
      if(data.frozen_source_root?.startsWith(join(tmpdir(),'notalone-retrieval-frozen-')))
        await rm(data.frozen_source_root,{recursive:true,force:true});
    }catch{}
    await rm(temporary,{recursive:true,force:true});
  }
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const argv=process.argv.slice(2),arg=name=>argv[argv.indexOf(name)+1];
  runRetrievalComparison({newCommit:arg('--new-commit'),outputDirectory:arg('--output-directory')})
    .then(report=>console.log(JSON.stringify({new_commit:report.new_commit,summary:report.summary,real_model_calls:0})))
    .catch(error=>{console.error(error.code??error.message);process.exitCode=1;});
}
