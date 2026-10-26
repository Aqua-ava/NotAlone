/** 显式历史入口：固定 Git 整树与独立 venv；不从 HEAD 导入旧生产 Python。 */
import {spawn,execFileSync} from 'node:child_process';
import {readFile,mkdtemp,rm,mkdir,symlink,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {pipeline} from 'node:stream/promises';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const inventory=JSON.parse(await readFile(join(root,'backend-ts/test/historical-inventory.json'),'utf8'));
const commit='23a767330e4af8a024629a00c8740344be564259';
if(inventory.sourceCommit!==commit)throw new Error('历史提交登记不匹配');
const [area,...args]=process.argv.slice(2);
if(area==='--list'){
 console.log(JSON.stringify({sourceCommit:commit,files:inventory.entries.length,cases:inventory.archivedCases.length,executed:false}));
}else{
 if(!['backend','desktop-node','desktop-pages','desktop-app'].includes(area))throw new Error('需要显式历史范围：backend <文件>、desktop-node <文件>、desktop-pages <原页面参数> 或 desktop-app <原App参数>；先用 --list 查看登记。');
 const python=process.env.NOTALONE_HISTORICAL_PYTHON;
 if(!python||!isAbsolute(python))throw new Error('历史测试须显式设置 NOTALONE_HISTORICAL_PYTHON 为固定23a依赖的独立 venv Python；正常测试不需要 Python。');
 const version=JSON.parse(execFileSync(python,['-I','-c','import sys,json; print(json.dumps(dict(prefix=sys.prefix,base=sys.base_prefix)))'],{encoding:'utf8',timeout:10000}));
 if(version.prefix===version.base||!(await stat(join(version.prefix,'pyvenv.cfg'))).isFile())throw new Error('历史测试仅接受独立 venv，不接受 Conda 或系统 Python。');
 let selection=[];
 if(area==='backend'||area==='desktop-node'){
  const file=args.shift();if(!file)throw new Error('历史命令必须指定一个登记文件，不能隐式跑全量。');
  const path=area==='backend'?`backend-ts/test/${file.replace(/^test\//,'')}`:`desktop/${file.replace(/^desktop\//,'')}`;
  if(![...inventory.entries,...inventory.archivedCases].some(row=>row.path===path))throw new Error(`历史测试未登记：${path}`);
  selection=[path.replace(/^(backend-ts|desktop)\//,'')];
 }
 const directory=await mkdtemp(join(tmpdir(),'notalone-historical-23a-'));
 let completed=false;
 function done(child){return new Promise((accept,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>code===0?accept():reject(new Error(`历史子进程失败：${code??signal}`)));});}
 try{
  const archive=spawn('git',['archive',commit],{cwd:root,stdio:['ignore','pipe','pipe']});
  const extract=spawn('/usr/bin/tar',['-x','-C',directory],{stdio:['pipe','ignore','pipe']});
  await Promise.all([pipeline(archive.stdout,extract.stdin),done(archive),done(extract)]);
  for(const project of ['backend-ts','desktop'])await symlink(join(root,project,'node_modules'),join(directory,project,'node_modules'),'dir');
  // 旧测试的固定路径只映射至这个 venv；兼容目录名不代表安装或激活 Conda。
  const home=join(directory,'.historical-home'),compat=join(home,'miniconda3/envs');
  await mkdir(compat,{recursive:true});await symlink(version.prefix,join(compat,'NotAlone'),'dir');
  const environment={PATH:`${dirname(python)}:/usr/bin:/bin`,HOME:home,TMPDIR:process.env.TMPDIR??tmpdir(),
   CONDA_PREFIX:version.prefix,CONDA_DEFAULT_ENV:'NotAlone',NOTALONE_TEST_PYTHON:python,NOTALONE_HISTORICAL_PYTHON:python,
   NOTALONE_HISTORICAL_TEST_ROOT:directory,NOTALONE_DISABLE_DOTENV:'1',
   NOTALONE_COMPARISON_SOURCE_COMMIT:commit,
   GIT_DIR:execFileSync('git',['rev-parse','--absolute-git-dir'],{cwd:root,encoding:'utf8'}).trim(),GIT_WORK_TREE:directory,
   PYTHONPATH:`${directory}/backend/src:${directory}/backend`};
  if(process.env.NOTALONE_TEST_PG_BIN)environment.NOTALONE_TEST_PG_BIN=process.env.NOTALONE_TEST_PG_BIN;
  console.log(`历史测试固定 ${commit}；独立 venv；不证明当前产品通过。`);
  const project=area==='backend'?'backend-ts':'desktop';
  const command=area==='desktop-pages'?['scripts/test-pages.mjs',...args]:area==='desktop-app'?['scripts/test-app.mjs',...args]:['--test',...args,...selection];
  const child=spawn(process.execPath,command,{cwd:join(directory,project),env:environment,stdio:'inherit',timeout:600000,killSignal:'SIGTERM'});
  await done(child);completed=true;
 }finally{
  if(completed)await rm(directory,{recursive:true,force:true});
  else console.error(`历史运行未确认成功，保留精确证据目录：${directory}`);
 }
}
