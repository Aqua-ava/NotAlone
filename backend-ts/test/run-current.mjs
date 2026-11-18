import {readdir,readFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {availableParallelism} from 'node:os';

const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../..');
const files=(await readdir(directory)).filter(name=>name.endsWith('.test.mjs')).sort();
// 防止新增测试恢复已退役执行器；历史源码只能在固定 Git 旧树中显式运行。
for(const file of files){
 const source=await readFile(resolve(directory,file),'utf8');
 if(/from notalone\b|import notalone\b|miniconda3\/envs\/NotAlone\/bin\/python|legacy-backend\.ts|PythonTaskControlGateway/.test(source))
  throw new Error(`正常测试仍依赖退役 Python，请迁移或明确历史登记：${file}`);
}
const args=process.argv.slice(2);
// 并发度取核数的 2/3（上限 8、下限 4），给宿主和时序敏感用例留出余量；命令行追加 --test-concurrency=N 可覆盖。
const concurrency=Math.max(4,Math.min(8,Math.floor(availableParallelism()*2/3)));
if(args[0]==='--list'){
 console.log(JSON.stringify({current:files.length,executed:false}));
}else{
 execFileSync('bash',[resolve(root,'native/skill-read/build.sh')],{stdio:'inherit'});
 const selected=args.filter(arg=>arg.endsWith('.test.mjs'));
 if(selected.some(file=>!files.includes(file.replace(/^test\//,''))))throw new Error('只能运行 test 目录下的现行测试文件');
 const flags=args.filter(arg=>!arg.endsWith('.test.mjs'));
 const child=spawn(process.execPath,['--test',`--test-concurrency=${concurrency}`,...flags,...(selected.length?selected.map(file=>resolve(directory,file.replace(/^test\//,''))):files.map(file=>resolve(directory,file)))],{cwd:resolve(root,'backend-ts'),stdio:'inherit'});
 child.once('error',error=>{console.error(error.message);process.exitCode=1;});
 child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
