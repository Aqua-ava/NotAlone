import {readdir,readFile} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {existsSync,readdirSync,rmSync} from 'node:fs';
import {availableParallelism,loadavg,tmpdir} from 'node:os';

const directory=dirname(fileURLToPath(import.meta.url)),root=resolve(directory,'../..');
const files=(await readdir(directory)).filter(name=>name.endsWith('.test.mjs')).sort();
// 防止新增测试恢复已退役执行器；历史源码只能在固定 Git 旧树中显式运行。
for(const file of files){
 const source=await readFile(resolve(directory,file),'utf8');
 if(/from notalone\b|import notalone\b|miniconda3\/envs\/NotAlone\/bin\/python|legacy-backend\.ts|PythonTaskControlGateway/.test(source))
  throw new Error(`正常测试仍依赖退役 Python，请迁移或明确历史登记：${file}`);
}
const args=process.argv.slice(2);
// 并发度按启动时的机器负载选择：空闲时取核数的 2/3（上限 8），1 分钟负载已达核数 45% 时退回 4。
// 实测（12 核）：启动负载 ≤5.8 时并发 8 共 6 次全量全部通过，比并发 4 快约 35%；启动负载 ≥5.9 时并发 6/8 共 6 次
// 全部出现时序类偶发失败（SQLite 动作超过 15s 真实预算的 worker_failed、history 启动宿主 409、真实子进程等待）。
// 外部负载持续很高时并发 4 也不能保证（6 个 CPU 占用进程下并发 4、8 均出现 worker_failed）。
// 命令行追加 --test-concurrency=N 可覆盖。
const cores=availableParallelism(),load=loadavg()[0];
const concurrency=load<cores*0.45?Math.max(4,Math.min(8,Math.floor(cores*2/3))):4;
// 测试进程与 SQLite Worker 反复加载同一批 TypeScript 源码；V8 编译缓存按内容校验，只缩短加载，不改变行为。
// 默认缓存放系统临时目录；测试动态生成的临时脚本每次都会产生新条目，条目超过上限时整体清空重建。
// 设置 NODE_COMPILE_CACHE 可改用其他目录（不清理），设置 NODE_DISABLE_COMPILE_CACHE=1 可关闭。
const compileCache=process.env.NODE_COMPILE_CACHE??resolve(tmpdir(),`notalone-test-compile-cache-${process.getuid?.()??'user'}`);
function pruneCompileCache(){
 if(process.env.NODE_COMPILE_CACHE||!existsSync(compileCache))return;
 for(const entry of readdirSync(compileCache)){
  const versioned=resolve(compileCache,entry);
  try{if(readdirSync(versioned).length>20000)rmSync(versioned,{recursive:true,force:true});}catch{/* 非目录或已被并行运行清理，忽略。 */}
 }
}
if(args[0]==='--list'){
 console.log(JSON.stringify({current:files.length,executed:false}));
}else{
 pruneCompileCache();
 console.error(`后台测试并发 ${concurrency}（1 分钟负载 ${load.toFixed(1)}，${cores} 核）`);
 execFileSync('bash',[resolve(root,'native/skill-read/build.sh')],{stdio:'inherit'});
 const selected=args.filter(arg=>arg.endsWith('.test.mjs'));
 if(selected.some(file=>!files.includes(file.replace(/^test\//,''))))throw new Error('只能运行 test 目录下的现行测试文件');
 const flags=args.filter(arg=>!arg.endsWith('.test.mjs'));
 const child=spawn(process.execPath,['--test',`--test-concurrency=${concurrency}`,...flags,...(selected.length?selected.map(file=>resolve(directory,file.replace(/^test\//,''))):files.map(file=>resolve(directory,file)))],{cwd:resolve(root,'backend-ts'),stdio:'inherit',env:{...process.env,NODE_COMPILE_CACHE:compileCache}});
 child.once('error',error=>{console.error(error.message);process.exitCode=1;});
 child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
}
