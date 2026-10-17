import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,writeFile,symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { algorithm } from './algorithm-fixture.mjs';

test('真实升级卡片区分旧人工事实与未知证明，明确新结果和预算批准',async()=>{
  const owned=await mkdtemp(path.join(tmpdir(),'notalone-upgrade-view-'));
  try{
    await symlink(path.resolve('node_modules'),path.join(owned,'node_modules'),'dir');
    const entry=path.join(owned,'entry.ts');
    await writeFile(entry,`export {UpgradeJobCard} from ${JSON.stringify(path.resolve('src/renderer/MemoryUpgradePage.tsx'))};\n`
      +`export {createElement} from ${JSON.stringify(path.resolve('node_modules/react/index.js'))};\n`
      +`export {renderToStaticMarkup} from ${JSON.stringify(path.resolve('node_modules/react-dom/server.node.js'))};\n`);
    const output=path.join(owned,'view.mjs');
    await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent',jsx:'automatic',packages:'external',
      banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}});
    const {UpgradeJobCard,createElement,renderToStaticMarkup}=await import(pathToFileURL(output).href);
    const old={memory_id:'synthetic-old',text:'合成旧人工事实<script>无执行</script>',revision:3,scope_kind:'contact',adoption_method:'manual',proof_kind:'unknown',source_ids:[]};
    const html=renderToStaticMarkup(createElement(UpgradeJobCard,{selection:{kind:'contact',contactId:'synthetic-contact',scopeRevision:1},job:{
      algorithm,job_id:'synthetic-job',revision:4,state:'active',budget:{message_limit:20,batch_size:10,model_calls:8},model_calls_used:2,
      batches:[{algorithm,batch_id:'synthetic-batch',revision:2,state:'failed',number:1,message_count:2,error_code:'algorithm_changed',
        comparison:{version:1,current:[old],current_count:1,stats:{pending:1},actions:[{kind:'pending',candidate_id:'synthetic-candidate',previous:null,
          new:{text:'合成新待确认结果',has_new_proof:false,source_ids:['synthetic-source'],correction_review:[]}}]}}]}}));
    for(const text of ['用户明确确认','旧版证明未知','合成新待确认结果','预计加入待确认','确认应用所选批次','确认撤销所选批次','按剩余预算恢复','2 / 8',algorithm.protocol,algorithm.digest,'算法或配置已变化，请重新预览；原批准不能复用。'])assert.ok(html.includes(text),text);
    assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
  }finally{await rm(owned,{recursive:true,force:true});}
});
