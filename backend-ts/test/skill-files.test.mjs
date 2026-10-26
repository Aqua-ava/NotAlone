import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillFiles, matchesSkillPackage, packageManifest } from '../src/skills/skill-files.ts';
import { readPackage } from '../src/skills/skill-package.ts';
const owner='00000000-0000-4000-8000-000000000001', skill='00000000-0000-4000-8000-000000000002', id='00000000-0000-4000-8000-000000000003';
const document='---\nname: gentle-reply\ndescription: "用于回应感受"\n---\n\n先回应感受。\n';
function fixture(t) { const dir=mkdtempSync(join(tmpdir(),'notalone-skill-files-')); t.after(()=>rmSync(dir,{recursive:true,force:true})); const input=join(dir,'input','gentle-reply'); mkdirSync(input,{recursive:true});writeFileSync(join(input,'SKILL.md'),document);return {dir,input,files:new SkillFiles(join(dir,'store'))}; }
test('发布并读取不可变版本，复试保持已有字节，冲突不能覆盖', t=>{const {files,input,dir}=fixture(t);const pkg=readPackage(input);const receipt=files.prepareVersion(owner,skill,id,pkg);const row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};assert.equal(receipt.content_path,`.versions/${owner}/${skill}/${id}/gentle-reply/SKILL.md`);assert.equal(files.readContent(row),'先回应感受。\n');assert.equal(files.readManifest(row).description,'用于回应感受');assert.equal(readFileSync(join(dir,'store',receipt.content_path),'utf8'),document);assert.deepEqual(files.prepareVersion(owner,skill,id,pkg),receipt);writeFileSync(join(input,'SKILL.md'),document+'改变。\n');assert.throws(()=>files.prepareVersion(owner,skill,id,readPackage(input)));assert.equal(files.readContent(row),'先回应感受。\n');});

test('只读旧103字节并核验独立资源与方法正文',async t=>{
 const {files,input,dir}=fixture(t);mkdirSync(join(input,'references'));writeFileSync(join(input,'references','example.md'),'合成案例。');
 const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg);const row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};
 const method='00000000-0000-4000-8000-000000000004';Object.assign(row,files.prepareMethods(owner,skill,id,[{method_id:method,title:'感受',instruction:'先回应感受。'}]));
 assert.equal(files.readResource(row,'references/example.md').toString(),'合成案例。');assert.equal(files.readMethods(row,[method])[0].instruction,'先回应感受。');
 const path=join(dir,'store',receipt.content_path);const before=readFileSync(path);files.readManifest(row);files.readContent(row);assert.deepEqual(readFileSync(path),before);
 writeFileSync(join(dir,'store',`.versions/${owner}/${skill}/${id}/methods/${method}.json`),'{}');assert.deepEqual(files.readMethods(row,[method],[]),[]);assert.throws(()=>files.readMethods(row,[method]));
 assert.throws(()=>files.readResource(row,'../SKILL.md'));assert.throws(()=>files.readContent({...row,owner_id:'00000000-0000-4000-8000-000000000009'}));
 writeFileSync(join(dir,'store',`.versions/${owner}/${skill}/${id}/gentle-reply/references/example.md`),'被改写');assert.throws(()=>files.readResource(row,'references/example.md'));
});

test('工作副本只在显式写入后可发现，清理覆盖版本根与工作包',t=>{const {files,input}=fixture(t);const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg),row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};assert.deepEqual(files.discover(owner),[]);files.writeWorking(row);assert.equal(files.discover(owner)[0].name,pkg.name);files.remove(`${owner}/${pkg.name}`);assert.deepEqual(files.discover(owner),[]);files.remove(`.versions/${owner}/${skill}`);assert.throws(()=>files.readContent(row));files.remove(`.versions/${owner}/${skill}`);assert.throws(()=>files.remove(owner));assert.throws(()=>files.remove(`.versions/${owner}/../${skill}`));});

// 旧103序列化逐字节对照在固定23a历史命令保留。

test('拒绝包、资源、版本祖先和清理路径中的链接，外部文件不变',async t=>{
 const {symlinkSync}=await import('node:fs');const {files,input,dir}=fixture(t);const outside=join(dir,'outside');mkdirSync(outside);writeFileSync(join(outside,'keep.txt'),'保留');
 symlinkSync(outside,join(input,'references'));assert.throws(()=>readPackage(input));rmSync(join(input,'references'));const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg),row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};
 const version=join(dir,'store',`.versions/${owner}/${skill}/${id}`);rmSync(version,{recursive:true});symlinkSync(outside,version);assert.throws(()=>files.readManifest(row));assert.throws(()=>files.remove(`.versions/${owner}/${skill}/${id}`));assert.equal(readFileSync(join(outside,'keep.txt'),'utf8'),'保留');
});

test('包清洗拒绝脚本、外部URL、私人导出、重复YAML键和超预算内容',t=>{
 const {input}=fixture(t);for(const body of ['访问外部网络','https://example.invalid/test','sender_wxid: fake','执行脚本','先回应。\n'.repeat(501),'字'.repeat(5001)]){writeFileSync(join(input,'SKILL.md'),document+body);assert.throws(()=>readPackage(input));}
 writeFileSync(join(input,'SKILL.md'),document.replace('name: gentle-reply','name: wrong\nname: gentle-reply'));assert.throws(()=>readPackage(input));
 writeFileSync(join(input,'SKILL.md'),document+'禁止执行脚本。');assert.doesNotThrow(()=>readPackage(input));
 mkdirSync(join(input,'assets'));writeFileSync(join(input,'assets','a.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>');assert.throws(()=>readPackage(input));
 writeFileSync(join(input,'assets','a.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><text>示例</text></svg>');assert.doesNotThrow(()=>readPackage(input));
 writeFileSync(join(input,'assets','a.svg'),Buffer.alloc(1024*1024+1,32));assert.throws(()=>readPackage(input));
});

test('导出当前核验版本到指定目录，拒绝链接且不泄漏方法或清单',async t=>{const {files,input,dir}=fixture(t);const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg),row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};const destination=join(dir,'exports','gentle-reply');files.exportPackage(row,destination);assert.equal(readPackage(destination).content,pkg.content);files.exportPackage(row,destination);const {symlinkSync}=await import('node:fs');rmSync(join(destination,'SKILL.md'));const other=join(dir,'other');writeFileSync(other,'保留');symlinkSync(other,join(destination,'SKILL.md'));assert.throws(()=>files.exportPackage(row,destination));assert.equal(readFileSync(other,'utf8'),'保留');});

// 旧Python对照保留在 historical-inventory.json 指向的固定23a原测试。

test('发现忽略隐藏和普通文件，独立报告链接且排除项不重新纳入',async t=>{const {files,input,dir}=fixture(t);const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg);files.writeWorking({owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt});const root=join(dir,'store',owner);mkdirSync(join(root,'.ignored'));writeFileSync(join(root,'note.txt'),'说明');const {symlinkSync}=await import('node:fs');symlinkSync(input,join(root,'unsafe'));const scan=files.scan(owner);assert.equal(scan.packages.length,1);assert.deepEqual(scan.failedNames,['unsafe']);assert.equal(scan.rootFailed,false);assert.deepEqual(files.scan(owner,['unsafe','gentle-reply']).packages,[]);});

test('资源数量与合计预算在读取时受限',t=>{const {input}=fixture(t);mkdirSync(join(input,'references'));for(let i=0;i<101;i++)writeFileSync(join(input,'references',`${i}.txt`),'合成');assert.throws(()=>readPackage(input),e=>e.code==='resource_count_exceeded');rmSync(join(input,'references'),{recursive:true});mkdirSync(join(input,'references'));for(let i=0;i<5;i++)writeFileSync(join(input,'references',`${i}.txt`),Buffer.alloc(1024*1024,32));assert.throws(()=>readPackage(input),e=>e.code==='resource_budget_exceeded');});

test('方法索引及正文采用原Python紧凑键顺序，拒绝身份重排或超集',t=>{const {files,input,dir}=fixture(t);const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg),row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};const method='00000000-0000-4000-8000-000000000004';Object.assign(row,files.prepareMethods(owner,skill,id,[{method_id:method,title:'感受',instruction:'先回应感受。'}]));assert.equal(readFileSync(join(dir,'store',`.versions/${owner}/${skill}/${id}/methods/${method}.json`),'utf8'),' {"method_id":"00000000-0000-4000-8000-000000000004","title":"感受","instruction":"先回应感受。"}'.trim());assert.throws(()=>files.readMethods(row,[owner]));assert.throws(()=>files.readMethods(row,[method],[owner]));assert.throws(()=>files.prepareMethods(owner,skill,id,[{method_id:method,title:'变化',instruction:'先回应感受。'}]));assert.equal(files.readMethods(row,[method])[0].title,'感受');});

// 旧Python对照保留在 historical-inventory.json 指向的固定23a原测试。

test('沿用Python splitlines的CR及Unicode分行，500行不能经Unicode分隔符绕过',async t=>{
 const {input}=fixture(t);
 writeFileSync(join(input,'SKILL.md'),document.replaceAll('\n','\r'));assert.equal(readPackage(input).content,'先回应感受。\r');
 for(const separator of ['\r','\u0085','\u2028','\u2029','\v','\f','\x1c','\x1d','\x1e']){
  writeFileSync(join(input,'SKILL.md'),document+'行'+(separator+'行').repeat(501));assert.throws(()=>readPackage(input),e=>e.code==='skill_size_exceeded');
 }
});

test('显式选择包根的任意祖先链接不能借canonicalRoot洗掉',async t=>{
 const {input,dir}=fixture(t),{symlinkSync}=await import('node:fs');symlinkSync(join(dir,'input'),join(dir,'alias'));
 assert.throws(()=>readPackage(join(dir,'alias','gentle-reply')),e=>e.code==='symlink_not_allowed');
 const files=new SkillFiles(join(dir,'alias','store'));assert.throws(()=>files.prepareVersion(owner,skill,id,readPackage(input)));
});

test('Unicode换行后危险指令不能沿用上一行否定词',t=>{
 const {input}=fixture(t);for(const separator of ['\r','\u0085','\u2028']){writeFileSync(join(input,'SKILL.md'),document+'禁止操作'+separator+'执行脚本');assert.throws(()=>readPackage(input),e=>e.code==='unsafe_instruction');}
});

test('瞬时读取故障与非法包分开且异常不带路径',async t=>{
 const {input}=fixture(t);rmSync(join(input,'SKILL.md'));
 assert.throws(()=>readPackage(input),error=>error.name==='SkillPackageReadError'&&error.code==='file_unavailable'&&!error.message.includes(input));
 writeFileSync(join(input,'SKILL.md'),'非法包');assert.throws(()=>readPackage(input),error=>error.name==='SkillPackageError');
});

test('孤立快照枚举只接受owner内两层UUID目录，拒绝链接及未知目录',async t=>{
 const {files,input,dir}=fixture(t),{symlinkSync}=await import('node:fs');assert.deepEqual(files.scanSnapshotDirectories(owner),[]);
 const receipt=files.prepareVersion(owner,skill,id,readPackage(input));
 assert.deepEqual(files.scanSnapshotDirectories(owner),[{skill_id:skill,version_id:id,relative_path:`.versions/${owner}/${skill}/${id}`}]);
 assert.deepEqual(files.scanSnapshotDirectories('00000000-0000-4000-8000-000000000009'),[]);
 const root=join(dir,'store','.versions',owner);mkdirSync(join(root,'unknown'));assert.throws(()=>files.scanSnapshotDirectories(owner));rmSync(join(root,'unknown'),{recursive:true});
 symlinkSync(input,join(root,'00000000-0000-4000-8000-000000000008'));assert.throws(()=>files.scanSnapshotDirectories(owner));
 assert.equal(files.readContent({owner_id:owner,skill_id:skill,id,name:'gentle-reply',...receipt}),'先回应感受。\n');
});


test('暂存只枚举owner内技能目录供数据库判断，保留内部内容',async t=>{
 const {files,dir}=fixture(t);assert.deepEqual(files.scanStagingDirectories(owner),[]);
 const relative=`.staging/${owner}/${skill}`,root=join(dir,'store',relative);mkdirSync(root,{recursive:true});writeFileSync(join(root,'pending.txt'),'合成待重试');
 assert.deepEqual(files.scanStagingDirectories(owner),[{skill_id:skill,relative_path:relative}]);assert.equal(readFileSync(join(root,'pending.txt'),'utf8'),'合成待重试');
 const {symlinkSync}=await import('node:fs');symlinkSync(root,join(dir,'store',`.staging/${owner}/00000000-0000-4000-8000-000000000008`));assert.throws(()=>files.scanStagingDirectories(owner));
});


test('导出覆盖同名文件、保留无关文件并返回实际导出哈希',t=>{
 const {files,input,dir}=fixture(t);mkdirSync(join(input,'references'));writeFileSync(join(input,'references','a.md'),'合成资源');
 const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg),row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt},destination=join(dir,'export');
 mkdirSync(destination);writeFileSync(join(destination,'keep.txt'),'保留');writeFileSync(join(destination,'SKILL.md'),'旧文档');
 const result=files.exportPackage(row,destination);assert.equal(result.destination,destination);assert.deepEqual(result.resource_paths,['references/a.md']);assert.equal(readFileSync(join(destination,'keep.txt'),'utf8'),'保留');
 rmSync(join(destination,'keep.txt'));const renamed=join(dir,pkg.name);mkdirSync(renamed);files.exportPackage(row,renamed);assert.equal(result.package_sha256,readPackage(renamed).package_sha256);
});


test('目录匹配按资源身份比较并保留name、描述、正文及每项资源字段',t=>{
 const {input}=fixture(t);mkdirSync(join(input,'references'));for(const name of ['😀','\ue000'])writeFileSync(join(input,'references',name+'.txt'),'合成资源');
 const pkg=readPackage(input),manifest=packageManifest(pkg),row={name:pkg.name,content_sha256:pkg.content_sha256};
 const reversed={...manifest,resources:[...manifest.resources].reverse()};assert.equal(matchesSkillPackage(row,reversed,pkg),true);assert.equal(reversed.resources[0],manifest.resources.at(-1));
 for(const change of [{name:'another-name'},{content_sha256:'changed'}])assert.equal(matchesSkillPackage({...row,...change},manifest,pkg),false);
 assert.equal(matchesSkillPackage(row,{...manifest,description:'不同说明'},pkg),false);
 for(const [key,value] of Object.entries({relative_path:'references/other.txt',resource_kind:'asset',media_type:'text/csv',byte_size:99,content_sha256:'changed'})){
  assert.equal(matchesSkillPackage(row,{...manifest,resources:manifest.resources.map((r,i)=>i? r:{...r,[key]:value})},pkg),false,key);
 }
 assert.equal(matchesSkillPackage(row,{...manifest,resources:[]},pkg),false);
});
