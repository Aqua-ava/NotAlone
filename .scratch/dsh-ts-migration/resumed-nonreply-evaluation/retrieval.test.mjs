/** 复用完整冻结召回／向量入口，并绑定当前显式候选版本。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {runRetrievalComparison} from './retrieval.mjs';
const candidate=process.env.NOTALONE_NONREPLY_CANDIDATE_COMMIT??'263365556e9058b3fc7b1abbbdbe43b7f9a323d2';

test('当前候选完整327召回和420向量排序对照有显式pin及材料绑定',{timeout:120000},async()=>{
  const evidence=process.env.NOTALONE_NONREPLY_RETRIEVAL_EVIDENCE_DIRECTORY;
  const directory=evidence?resolve(evidence):await mkdtemp(join(tmpdir(),'notalone-nonreply-retrieval-'));
  try{
    const report=await runRetrievalComparison({newCommit:candidate,outputDirectory:directory});
    assert.equal(report.new_commit,candidate);
    assert.equal(report.summary.recall_runs_per_arm,327);
    assert.equal(report.summary.recall_exact,327);
    assert.equal(report.summary.vector_runs_per_arm,420);
    assert.equal(report.summary.vector_pass,420);
    assert.equal(report.summary.ranking_exact,420);
    assert.equal(report.real_model_calls,0);
    assert.equal(report.real_model_quality_verified,false);
    assert.equal(report.source_files_unchanged,true);
  }finally{if(!evidence)await rm(directory,{recursive:true,force:true});}
});
