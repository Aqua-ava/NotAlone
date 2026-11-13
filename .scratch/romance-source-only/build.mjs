import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {openRomanceEvidence,renderRomanceSourceSkill,sourceDigest,gitBlobDigest,allowedRomanceSources} from '../../scripts/romance-source-material.mjs';
const cache='.scratch/romance-source-only';
const old=JSON.parse(await readFile('reply-skills/romance/catalog.json','utf8'));
const index=JSON.parse(await readFile(cache+'/upstream-index.json','utf8'));
const selections=(await Promise.all(['001-031','032-062','063-092'].map(async n=>JSON.parse(await readFile(cache+'/selections/'+n+'.json','utf8'))))).flat().sort((a,b)=>a.id-b.id);
assert.equal(selections.length,92);assert.equal(new Set(selections.map(s=>s.id)).size,92);
for(let i=0;i<92;i++)assert.equal(selections[i].id,i+1);
const common=[{source:'G',path:'SKILL.md',start_line:44,end_line:46}];
const refs=[...common,...selections.flatMap(s=>[...s.methods,...s.examples])];
const keys=new Set(refs.map(r=>r.source+'/'+r.path));
for(const source of new Set(refs.map(r=>r.source)))keys.add(source+'/'+(source==='D'?'README.md':'LICENSE'));
const files=index.files.filter(f=>keys.has(f.source+'/'+f.path)).map(f=>({source:f.source,repository:f.repository,commit:f.commit,path:f.path,blob_sha:f.blob_sha,sha256:f.sha256}));
assert.equal(files.length,keys.size);
for(const f of files){
 const content=await readFile(cache+'/upstream/'+f.source+'/'+f.path,'utf8');const bytes=Buffer.from(content);
 assert.equal(sourceDigest(bytes),f.sha256);assert.equal(gitBlobDigest(bytes),f.blob_sha);
 const target='reply-skills/romance-sources/'+f.source+'/'+f.path+'.json';await mkdir(dirname(target),{recursive:true});await writeFile(target,JSON.stringify({...f,content},null,2)+'\n');
}
const proof={schema_version:1,policy:'upstream-extracts-only',files,common_methods:common,skills:selections.map(s=>({...s,name:old.entries.find(e=>e.id===s.id).name}))};
const evidence=openRomanceEvidence(proof);
proof.common_methods=common.map(r=>evidence.excerpt(r).reference);
proof.skills=proof.skills.map(s=>({...s,methods:s.methods.map(r=>evidence.excerpt(r).reference),examples:s.examples.map(r=>evidence.excerpt(r).reference)}));
const catalog={schema_version:2,title:old.title,content_policy:proof.policy,provenance_file:'provenance.json',entries:old.entries.map(e=>{
const s=proof.skills.find(s=>s.id===e.id);return{id:e.id,name:e.name,title:e.title,category:e.category,inventory_candidates:e.inventory_candidates??e.source_candidates,provenance_status:s.support,source_method_count:s.methods.length,source_example_count:s.examples.length};})};
await writeFile('reply-skills/romance/catalog.json',JSON.stringify(catalog,null,2)+'\n');
await writeFile('reply-skills/romance/provenance.json',JSON.stringify(proof,null,2)+'\n');
for(const e of catalog.entries){const p=renderRomanceSourceSkill(e,proof.skills.find(s=>s.id===e.id),evidence,proof.common_methods);for(const [rel,bytes]of new Map([['SKILL.md',p.document],...p.resources])){const path=join('reply-skills/romance',e.name,rel);await mkdir(dirname(path),{recursive:true});await writeFile(path,bytes);}}
const status={direct:'直接依据',shared_method:'共用方法',unsupported:'尚无相符方法'};
function link(r){const repo=allowedRomanceSources[r.source];const path=r.path.split('/').map(encodeURIComponent).join('/');return '['+r.source+' L'+r.start_line+'–'+r.end_line+'](https://github.com/'+repo.repository+'/blob/'+repo.commit+'/'+path+'#L'+r.start_line+'-L'+r.end_line+')';}
let doc='# 92 项恋爱回复 Skill 的来源对照\n\nSkill 正文只放方法与已有示例；仓库、文件、行号及核对记录统一保存在本文与 [provenance.json](provenance.json)。\n\n## 整理口径\n\n- 本版本撤回旧版自行编写的 184 则案例。方法与单列示例全部从下列固定原文件连续行段提取，不新增人物、背景、意图、反例或后续对话。\n- 原作者模板、话术片段、假设场景和教学对话按实际类型保留，不宣称是真实事件或效果证据。\n- 直接依据表示原文明确讨论此类问题；共用方法表示只找到相关通用方法，不能称为原文的专门细分策略。没有相符示例时留空，不凑两例。\n- 编排仅增加目录名称、章节和按需读取提示，去除行尾空白及片段首尾空行，保留原有字句。原文中的跨资料提示不产生额外运行权限。\n- 盘点编号仅用于追溯 92 项的拆分历史，不能替代以下源文件行号。引用的源文件 JSON 快照在 [romance-sources](../romance-sources/README.md)，保存完整原文字节并核对 Git blob SHA 与 SHA-256。\n- 运行规则仍以用户当前意愿与产品既有边界为准；保留原文不等于已验证其关系判断、时长建议或效果主张。\n\n## 固定来源及许可\n\n';
for(const [id,s] of Object.entries(allowedRomanceSources))doc+='- '+id+'：['+s.repository+'](https://github.com/'+s.repository+'/tree/'+s.commit+')，固定提交 '+s.commit+'。'+(id==='D'?'[README 许可声明](https://github.com/'+s.repository+'/blob/'+s.commit+'/README.md#L84-L86)明确 MIT，[复制使用说明](https://github.com/'+s.repository+'/blob/'+s.commit+'/README.md#L62)允许复制技能目录并按需调整；无单独 LICENSE 文件。':'[MIT 许可](https://github.com/'+s.repository+'/blob/'+s.commit+'/LICENSE)。')+'\n';
doc+='\n## 共用证据边界\n\n'+proof.common_methods.map(link).join('、')+'：冲突指出矛盾、缺失保持未知，不为完整而虚构；必要时才追问。该原句可在各包中重复使用。\n\n## 逐项对照\n\n| 编号 | 场景 | 方法支持 | 方法出处 | 单列示例出处 |\n| --- | --- | --- | --- | --- |\n';
for(const e of catalog.entries){const s=proof.skills.find(s=>s.id===e.id);doc+='| '+String(e.id).padStart(3,'0')+' | '+e.title.replaceAll('|','／')+' | '+status[s.support]+' | '+(s.methods.map(link).join('、')||'未取得')+' | '+(s.examples.map(link).join('、')||'未单列，不补写')+' |\n';}
doc+='\n## 对照备注\n\n以下是整理者的适用性记录，不进入 Skill 的方法正文。\n\n';
for(const e of catalog.entries){const s=proof.skills.find(s=>s.id===e.id);if(s.notes)doc+='- '+String(e.id).padStart(3,'0')+'：'+s.notes+'\n';}
doc+='\n## 技术核验范围\n\n源文件先核固定仓库／提交与 Git blob，再核每个引用段的包含行号和 SHA-256。成品必须与确定性编排的正文、示例及许可声明逐字节一致；增加无来源段落、改写示例或增加未登记资源都会使校验失败。源快照核验与结构／加载回归不能代替原方法的实际效果验证。\n';
await writeFile('reply-skills/romance/SOURCES.md',doc);
let sourceReadme='# 原 Skill 的固定源快照\n\n只保存本轮实际引用的原文件及许可声明；JSON 的 content 字段保留原文字节（包含换行）。blob_sha 对应固定 Git 提交中的原 Git blob，sha256 再核本地字节。每个快照的仓库、提交和原路径同时记在元数据。快照不进入模型的 Skill 资源目录；具体引用位置见 [独立来源文档](../romance/SOURCES.md)。\n\n源例子仍是原作者的教学资料，不能当成真实聊天或独立证实的效果。D 的 MIT 声明在原 README，其他四源保留各自 LICENSE。\n\n| 来源 | 原文件 | Git blob |\n| --- | --- | --- |\n';
for(const f of files)sourceReadme+='| '+f.source+' | ['+f.path+']('+f.source+'/'+f.path.split('/').map(encodeURIComponent).join('/')+'.json) | '+f.blob_sha+' |\n';
await writeFile('reply-skills/romance-sources/README.md',sourceReadme);
console.log(JSON.stringify({packages:catalog.entries.length,sourceFiles:files.length,direct:proof.skills.filter(s=>s.support==='direct').length,shared:proof.skills.filter(s=>s.support==='shared_method').length,unsupported:proof.skills.filter(s=>s.support==='unsupported').length,methods:proof.skills.reduce((n,s)=>n+s.methods.length,0),examples:proof.skills.reduce((n,s)=>n+s.examples.length,0),noExamples:proof.skills.filter(s=>!s.examples.length).map(s=>s.id)}));

