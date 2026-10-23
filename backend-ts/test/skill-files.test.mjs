import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillFiles, matchesSkillPackage, packageManifest } from '../src/skill-files.ts';
import { readPackage } from '../src/skill-package.ts';
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

test('Python 103序列化清单、正文和方法文件保持字节等价',async t=>{
 const {spawnSync}=await import('node:child_process');const {homedir}=await import('node:os');const {files,input,dir}=fixture(t);mkdirSync(join(input,'references'));writeFileSync(join(input,'references','例子.md'),'合成案例。\n');
 const python=spawnSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',`import json, hashlib, sys\nfrom notalone.skills import LocalSkillPackageReader, SkillPackageValidator\nfrom notalone.persistence.skill_files import serialize_skill_document\nfrom notalone.persistence.skill_manifest import package_manifest\np=SkillPackageValidator().validate(LocalSkillPackageReader().read(sys.argv[1]))\nd=serialize_skill_document(p.name,p.description,p.content)\nm=json.dumps(package_manifest(p),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode('utf-8')\nprint(json.dumps({'document':d.decode(),'manifest':m.decode(),'document_sha256':hashlib.sha256(d).hexdigest(),'manifest_sha256':hashlib.sha256(m).hexdigest(),'content_sha256':p.content_sha256,'package_sha256':p.package_sha256},ensure_ascii=False))`,input],{env:{...process.env,PYTHONPATH:resolveBackend()},encoding:'utf8'});
 assert.equal(python.status,0,python.stderr);const old=JSON.parse(python.stdout),pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg);assert.equal(pkg.package_sha256,old.package_sha256);for(const field of ['document_sha256','manifest_sha256','content_sha256'])assert.equal(receipt[field],old[field]);assert.equal(readFileSync(join(dir,'store',receipt.content_path),'utf8'),old.document);assert.equal(readFileSync(join(dir,'store',`.versions/${owner}/${skill}/${id}/manifest.json`),'utf8'),old.manifest);
 function resolveBackend(){return new URL('../../backend/src/',import.meta.url).pathname;}
});

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

test('YAML1.1名称描述语义与旧解析一致，包含别名、合并、日期和tag',async t=>{
 const {input}=fixture(t),{spawnSync}=await import('node:child_process'),{homedir}=await import('node:os');
 const headers=['name: gentle-reply\ndescription: yes','name: gentle-reply\ndescription: 2026-10-23','name: gentle-reply\ndescription: !!str yes','name: gentle-reply\ndescription: &d 用于回应\nextra: *d','name: gentle-reply\nextra: &d 用于回应\ndescription: *d','defaults: &d {name: gentle-reply, description: 用于回应}\n<<: *d','name: gentle-reply\ndescription: !unknown 用于回应','name: gentle-reply\ndescription: |\n  用于回应\n  第二行'];
 const documents=headers.map(h=>'---\n'+h+'\n---\n\n先回应感受。\n');
 const python=spawnSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',`import json,sys\nfrom notalone.skills.package import SkillPackageValidator\nout=[]\nfor doc in json.load(sys.stdin):\n try:\n  n,d,c=SkillPackageValidator._parse_skill_document(doc.encode(),package_name='gentle-reply');out.append({'name':n,'description':d,'content':c})\n except ValueError:out.append(None)\nprint(json.dumps(out,ensure_ascii=False))`],{env:{...process.env,PYTHONPATH:new URL('../../backend/src/',import.meta.url).pathname},input:JSON.stringify(documents),encoding:'utf8'});assert.equal(python.status,0,python.stderr);const expected=JSON.parse(python.stdout);
 for(let i=0;i<documents.length;i++){writeFileSync(join(input,'SKILL.md'),documents[i]);if(expected[i]===null)assert.throws(()=>readPackage(input),headers[i]);else{const p=readPackage(input);assert.deepEqual({name:p.name,description:p.description,content:p.content},expected[i],headers[i]);}}
});

test('发现忽略隐藏和普通文件，独立报告链接且排除项不重新纳入',async t=>{const {files,input,dir}=fixture(t);const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg);files.writeWorking({owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt});const root=join(dir,'store',owner);mkdirSync(join(root,'.ignored'));writeFileSync(join(root,'note.txt'),'说明');const {symlinkSync}=await import('node:fs');symlinkSync(input,join(root,'unsafe'));const scan=files.scan(owner);assert.equal(scan.packages.length,1);assert.deepEqual(scan.failedNames,['unsafe']);assert.equal(scan.rootFailed,false);assert.deepEqual(files.scan(owner,['unsafe','gentle-reply']).packages,[]);});

test('资源数量与合计预算在读取时受限',t=>{const {input}=fixture(t);mkdirSync(join(input,'references'));for(let i=0;i<101;i++)writeFileSync(join(input,'references',`${i}.txt`),'合成');assert.throws(()=>readPackage(input),e=>e.code==='resource_count_exceeded');rmSync(join(input,'references'),{recursive:true});mkdirSync(join(input,'references'));for(let i=0;i<5;i++)writeFileSync(join(input,'references',`${i}.txt`),Buffer.alloc(1024*1024,32));assert.throws(()=>readPackage(input),e=>e.code==='resource_budget_exceeded');});

test('方法索引及正文采用原Python紧凑键顺序，拒绝身份重排或超集',t=>{const {files,input,dir}=fixture(t);const pkg=readPackage(input),receipt=files.prepareVersion(owner,skill,id,pkg),row={owner_id:owner,skill_id:skill,id,name:pkg.name,...receipt};const method='00000000-0000-4000-8000-000000000004';Object.assign(row,files.prepareMethods(owner,skill,id,[{method_id:method,title:'感受',instruction:'先回应感受。'}]));assert.equal(readFileSync(join(dir,'store',`.versions/${owner}/${skill}/${id}/methods/${method}.json`),'utf8'),' {"method_id":"00000000-0000-4000-8000-000000000004","title":"感受","instruction":"先回应感受。"}'.trim());assert.throws(()=>files.readMethods(row,[owner]));assert.throws(()=>files.readMethods(row,[method],[owner]));assert.throws(()=>files.prepareMethods(owner,skill,id,[{method_id:method,title:'变化',instruction:'先回应感受。'}]));assert.equal(files.readMethods(row,[method])[0].title,'感受');});

test('Python真实生成的103快照保留非BMP路径顺序、原UUID和方法字节',async t=>{
 const {spawnSync}=await import('node:child_process'),{homedir}=await import('node:os');const {files,input,dir}=fixture(t);
 mkdirSync(join(input,'references'));for(const name of ['\ue000','😀'])writeFileSync(join(input,'references',name+'.txt'),'合成资源。');
 const python=spawnSync(join(homedir(),'miniconda3/envs/NotAlone/bin/python'),['-c',`
import json,hashlib,sys,pathlib
from notalone.skills import LocalSkillPackageReader,SkillPackageValidator
from notalone.persistence.skill_files import serialize_skill_document
from notalone.persistence.skill_manifest import package_manifest
from notalone.persistence.skill_methods import _normalized
p=SkillPackageValidator().validate(LocalSkillPackageReader().read(sys.argv[1]))
base=pathlib.Path(sys.argv[2]); base.mkdir(parents=True)
d=serialize_skill_document(p.name,p.description,p.content)
m=json.dumps(package_manifest(p),ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
(base/p.name).mkdir();(base/p.name/'SKILL.md').write_bytes(d);(base/'manifest.json').write_bytes(m)
for r in p.resources:
 target=base/p.name/r.relative_path;target.parent.mkdir(exist_ok=True);target.write_bytes(r.content)
methods=_normalized([{'method_id':'00000000-0000-4000-8000-000000000004','title':'感受😀','instruction':'先回应感受。'}])
entries=[];(base/'methods').mkdir()
for method in methods:
 body=json.dumps(method,ensure_ascii=False,separators=(',',':')).encode();relative='methods/'+method['method_id']+'.json'
 (base/relative).write_bytes(body);entries.append({'method_id':method['method_id'],'relative_path':relative,'content_sha256':hashlib.sha256(body).hexdigest()})
index=json.dumps(entries,ensure_ascii=False,separators=(',',':')).encode();(base/'methods.json').write_bytes(index)
print(json.dumps({'document_sha256':hashlib.sha256(d).hexdigest(),'content_sha256':p.content_sha256,'manifest_sha256':hashlib.sha256(m).hexdigest(),'package_sha256':p.package_sha256,'method_manifest_sha256':hashlib.sha256(index).hexdigest()}))
`,input,join(dir,'store',`.versions/${owner}/${skill}/${id}`)],{env:{...process.env,PYTHONPATH:new URL('../../backend/src/',import.meta.url).pathname},encoding:'utf8'});
 assert.equal(python.status,0,python.stderr);const old=JSON.parse(python.stdout),pkg=readPackage(input);
 assert.equal(pkg.package_sha256,old.package_sha256);
 const base=`.versions/${owner}/${skill}/${id}`,row={owner_id:owner,skill_id:skill,id,name:pkg.name,...old,content_path:base+'/gentle-reply/SKILL.md',method_manifest_path:base+'/methods.json'};
 const receipt=files.prepareVersion(owner,skill,id,pkg);assert.equal(receipt.manifest_sha256,old.manifest_sha256);
 const before=readFileSync(join(dir,'store',base,'methods.json'));assert.equal(files.readMethods(row,['00000000-0000-4000-8000-000000000004'])[0].title,'感受😀');
 assert.equal(files.readResource(row,'references/😀.txt').toString(),'合成资源。');assert.deepEqual(readFileSync(join(dir,'store',base,'methods.json')),before);
});

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
