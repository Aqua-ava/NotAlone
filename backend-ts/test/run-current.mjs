import {readdir,readFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';

const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../..');
const manifest=JSON.parse(await readFile(resolve(directory,'historical-inventory.json'),'utf8'));
const historical=new Set(manifest.entries.filter(row=>row.path.startsWith('backend-ts/')).map(row=>row.path));
const discovered=(await readdir(directory)).filter(name=>name.endsWith('.test.mjs')).sort();
for(const path of historical)if(discovered.includes(path.split('/').at(-1)))throw new Error(`已归档历史测试不得恢复到当前工作树：${path}；请使用 npm run test:historical`);
const files=discovered.filter(name=>!historical.has(`backend-ts/test/${name}`));
// 防止新增测试恢复已退役执行器；历史源码只能在固定 Git 旧树中显式运行。
for(const file of files){
 const source=await readFile(resolve(directory,file),'utf8');
 if(/from notalone\b|import notalone\b|miniconda3\/envs\/NotAlone\/bin\/python|legacy-backend\.ts|PythonTaskControlGateway/.test(source))
  throw new Error(`正常测试仍依赖退役 Python，请迁移或明确历史登记：${file}`);
}
const args=process.argv.slice(2);
if(args[0]==='--list'){
 console.log(JSON.stringify({current:files.length,historical:historical.size,sourceCommit:manifest.sourceCommit,executed:false}));
}else{
 execFileSync('bash',[resolve(root,'native/skill-read/build.sh')],{stdio:'inherit'});
 const selected=args.filter(arg=>arg.endsWith('.test.mjs'));
 if(selected.some(file=>!files.includes(file.replace(/^test\//,''))))throw new Error('历史测试只能通过 npm run test:historical 显式执行');
 const flags=args.filter(arg=>!arg.endsWith('.test.mjs'));
 const child=spawn(process.execPath,['--test','--test-concurrency=4',...flags,...(selected.length?selected.map(file=>resolve(directory,file.replace(/^test\//,''))):files.map(file=>resolve(directory,file)))],{cwd:resolve(root,'backend-ts'),stdio:'inherit'});
 child.once('error',error=>{console.error(error.message);process.exitCode=1;});
 child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
