/** 只校验私有补丁文本/语法；不加载产品模块或连接PG。 */
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {stripTypeScriptTypes} from 'node:module';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const here=import.meta.dirname,root=process.argv[2];
const binding=JSON.parse(readFileSync(path.join(here,'observer-source-binding.json'),'utf8'));
const sha=s=>createHash('sha256').update(s).digest('hex');
let source=readFileSync(path.join(root,'backend-ts/src/host-storage.ts'),'utf8');
if(sha(source)!==binding.original_sha256)throw Error('original_source_mismatch');
for(const edit of binding.replacements){if(source.split(edit.before).length!==2)throw Error('unique_marker_mismatch');source=source.replace(edit.before,edit.after);}
source=binding.helper_prefix+source;
if(sha(source)!==binding.private_instrumented_sha256)throw Error('patched_source_mismatch');
for(const [args,input] of [[['--input-type=module','--check'],stripTypeScriptTypes(source,{mode:'strip'})],[['--check',path.join(here,'probe.mjs')],undefined]]){
 const checked=spawnSync(process.execPath,args,{input,encoding:'utf8'});
 if(checked.stdout)process.stdout.write(checked.stdout);if(checked.stderr)process.stderr.write(checked.stderr);
 if(checked.status!==0)process.exit(checked.status??2);
}
