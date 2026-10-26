/** 一次性离线文件适配器；只把 visible/ 交给评审者，private/ 不得随包分发。 */
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {createBlindPacket,verifyBlindPacket} from './reply-blind-packet.mjs';
const [capturePath,datasetPath,outputPath,...extra]=process.argv.slice(2);
if(!capturePath||!datasetPath||!outputPath||extra.length)throw Error('用法：node backend-ts/experiments/build-reply-blind-packet.mjs CAPTURE_JSON DATASET_JSON NEW_OUTPUT_DIRECTORY');
const [captureText,datasetText]=await Promise.all([readFile(capturePath,'utf8'),readFile(datasetPath,'utf8')]);
const capture=JSON.parse(captureText),dataset=JSON.parse(datasetText);
const packet=createBlindPacket({capture,dataset,seed:randomBytes(32).toString('hex')});
const verification=verifyBlindPacket({...packet,capture,dataset});
const hash=text=>createHash('sha256').update(text).digest('hex');
const root=resolve(outputPath);
const codeFiles=['reply-blind-packet.mjs','build-reply-blind-packet.mjs','../src/diagnostics/reply-comparison-sources.ts','../src/reply/generation/reply-contract.ts'];
const codeHashes=Object.fromEntries(await Promise.all(codeFiles.map(async path=>[path,hash(await readFile(new URL(path,import.meta.url)))])));
// 新目录的独占创建拒绝覆盖；生成失败只清理本入口刚创建的目录。
await mkdir(root,{mode:0o700});
try{
 await mkdir(join(root,'visible'),{mode:0o755});await mkdir(join(root,'private'),{mode:0o700});
 const visibleText=JSON.stringify(packet.visible,null,2)+'\n';
 // JSON完整呈现所有语义字段；围栏长度从原文推导，避免正文反引号提前闭合。
 const ticks='`'.repeat(Math.max(3,...[...visibleText.matchAll(/`+/g)].map(match=>match[0].length+1)));
 const markdown='# 回复候选独立盲评包\n\n请独立评全部候选，逐项说明依据；未知写 null。只使用本文件中的合成材料。请记录实际评审身份、模型和版本。\n\n'+ticks+'json\n'+visibleText+ticks+'\n';
 await writeFile(join(root,'visible','packet.json'),visibleText,{flag:'wx',mode:0o644});
 await writeFile(join(root,'visible','packet.md'),markdown,{flag:'wx',mode:0o644});
 await writeFile(join(root,'private','binding.json'),JSON.stringify(packet.binding,null,2)+'\n',{flag:'wx',mode:0o600});
 await writeFile(join(root,'private','provenance.json'),JSON.stringify({capture_file_sha256:hash(captureText),dataset_file_sha256:hash(datasetText),tool_files_sha256:codeHashes,visible_json_file_sha256:hash(visibleText),visible_markdown_file_sha256:hash(markdown),verification,internal_consistency_only:true,external_calls:0},null,2)+'\n',{flag:'wx',mode:0o600});
 process.stdout.write(JSON.stringify({items:packet.visible.items.length,verification:verification.status,visible_directory:'visible/',private_binding_directory:'private/',real_model_quality_verified:false,production_switch_approved:false})+'\n');
}catch(error){await rm(root,{recursive:true,force:true});throw error;}
