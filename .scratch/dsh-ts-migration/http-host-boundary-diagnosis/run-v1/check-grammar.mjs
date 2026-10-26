/** 仅擦除TS类型后做JS语法检查，不装载或执行任何产品模块。 */
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
for(const file of process.argv.slice(2)){
 const source=stripTypeScriptTypes(readFileSync(file,'utf8'),{mode:'strip'});
 const result=spawnSync(process.execPath,['--input-type=module','--check'],{input:source,encoding:'utf8'});
 if(result.stdout)process.stdout.write(result.stdout);if(result.stderr)process.stderr.write(result.stderr);
 if(result.status!==0)process.exit(result.status??2);
}
