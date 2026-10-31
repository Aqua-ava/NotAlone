import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {checkNoLinks} from '../backend-ts/src/skills/skill-package.ts';
import {openRomanceEvidence, renderRomanceSourceSkill} from './romance-source-material.mjs';
import {romanceBundleRoot} from './validate_romance_reply_skills.mjs';

// 仅从已登记的原文件行段生成；不调用模型，不接受自由编写的教学正文。
const catalog = JSON.parse(await readFile(join(romanceBundleRoot,'catalog.json'),'utf8'));
const provenance = JSON.parse(await readFile(join(romanceBundleRoot,'provenance.json'),'utf8'));
const evidence = openRomanceEvidence(provenance);
for (const entry of catalog.entries) {
  const selection = provenance.skills.find(item => item.id === entry.id);
  const expected = renderRomanceSourceSkill(entry,selection,evidence,provenance.common_methods);
  const files = new Map([['SKILL.md',expected.document],...expected.resources]);
  for (const [relative,bytes] of files) {
    const path = join(romanceBundleRoot,entry.name,relative);
    checkNoLinks(path);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,bytes);
  }
}
console.log(JSON.stringify({rendered:catalog.entries.length,policy:provenance.policy}));
