import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readBounded, serializeSkillDocument, validateName, validateRelative} from '../backend-ts/src/skills/skill-package.ts';

export const romanceSourceRoot = fileURLToPath(new URL('../reply-skills/romance-sources/', import.meta.url));
export const allowedRomanceSources = Object.freeze({
  D:{repository:'Mayuqi-crypto/HowToGetAlongWithGirls', commit:'af0897f4b55897624a19de48374d436906e26461'},
  E:{repository:'merchantmoh-debug/EROS-AI-Dating-Repository', commit:'0753f76f6683e5094456fb5c6342391c7de1b2f7'},
  G:{repository:'shengjidaguai-china/goutoujunshi', commit:'6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f'},
  C:{repository:'Mowon0303/LoveHelper.skill', commit:'1e391e26fd1c1bfee06e4daa9b439086a098a49b'},
  T:{repository:'hotcoffeeshake/tong-jincheng-skill', commit:'c9caaa9a6576f581c29d016c60bbe935908e20d5'},
});
export const sourceDigest = text => createHash('sha256').update(text).digest('hex');
export const gitBlobDigest = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const hasEnglishNarrativeLine = text => text.split('\n').some(line =>
  !/^\s*```/.test(line) && !/[\u3400-\u9fff]/u.test(line)
  && /\b(?:the|you|your|she|he|her|his|what|when|how|why|we|they|it|this|that|and|but|not|with|for|from|are|is|was|were|be|do|does|don't|can|will|if|than|because|about|would|should|could|have|has|had|their|them|who|one|just|only|more|less|into|over|after|before|without|while|within|between|each|some|every|often|always|never|much|very|really|still|then|so|also|than|as|at|on|in|of|to|a|an|or|by|up|out)\b/i.test(line));

/** 将中文译文逐条绑定到来源摘录哈希，并要求所有完整英文句段均有译文。 */
export function readRomanceTranslations(document, provenance, evidence) {
  const parsed = JSON.parse(document);
  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.locale, 'zh-CN');
  assert.equal(parsed.policy, 'pinned-source-excerpts-with-source-bound-chinese-translation');
  assert.ok(Array.isArray(parsed.entries));
  const references = [...provenance.common_methods, ...provenance.skills.flatMap(item => [...item.methods, ...item.examples])];
  const byDigest = new Map();
  for (const ref of references) if (!byDigest.has(ref.excerpt_sha256)) byDigest.set(ref.excerpt_sha256, ref);
  const translations = new Map();
  for (const entry of parsed.entries) {
    assert.ok(entry && typeof entry === 'object' && typeof entry.excerpt_sha256 === 'string' && typeof entry.text === 'string');
    const source = byDigest.get(entry.excerpt_sha256);
    assert.ok(source, `译文没有对应的锁定来源摘录：${entry.excerpt_sha256}`);
    assert.deepEqual(entry.source, {source:source.source,path:source.path,start_line:source.start_line,end_line:source.end_line,excerpt_sha256:source.excerpt_sha256},
      '引用片段哈希不一致：译文与固定来源行号不匹配');
    assert.ok(entry.text.trim(), `来源摘录译文为空：${entry.excerpt_sha256}`);
    assert.ok(!translations.has(entry.excerpt_sha256), `来源摘录存在重复译文：${entry.excerpt_sha256}`);
    translations.set(entry.excerpt_sha256, entry.text);
  }
  for (const [digest, ref] of byDigest) if (hasEnglishNarrativeLine(evidence.excerpt(ref).text)) {
    assert.ok(translations.has(digest), `英文摘录缺少中文译文：${keyOf(ref)}:${ref.start_line}-${ref.end_line}`);
  }
  for (const [digest, text] of translations) assert.ok(!hasEnglishNarrativeLine(text), `译文仍含完整英文句段：${digest}`);
  return translations;
}
const keyOf = ref => `${ref.source}/${ref.path}`;
// 与可替换的来源表和快照分开锁定；测试传入的 sourceRoot 不能覆盖此表。
const sourceLock = JSON.parse(readBounded(fileURLToPath(new URL('../reply-skills/romance-sources.lock.json', import.meta.url))));
assert.equal(sourceLock.schema_version, 1);
assert.equal(sourceLock.policy, 'pinned-upstream-blobs');
const pinnedFiles = new Map(sourceLock.files.map(file => [keyOf(file), file]));
assert.equal(pinnedFiles.size, sourceLock.files.length);
const cleanLineEndings = text => {
  const lines = text.split('\n').map(line => line.trimEnd());
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
};

/** 先核对固定仓库与 Git blob，再从真实文件行号取原文；不接收自由编写的段落。 */
export function openRomanceEvidence(provenance, root = romanceSourceRoot) {
  assert.equal(provenance.schema_version, 1);
  assert.equal(provenance.policy, 'upstream-extracts-only');
  const files = new Map();
  for (const file of provenance.files) {
    const expected = allowedRomanceSources[file.source];
    assert.ok(expected, `未知来源 ${file.source}`);
    assert.equal(file.repository, expected.repository);
    assert.equal(file.commit, expected.commit);
    validateRelative(file.path);
    const fileKey = keyOf(file);
    const pinned = pinnedFiles.get(fileKey);
    assert.ok(pinned, `${fileKey} 不在已核对的源文件锁中`);
    for (const property of ['source','repository','commit','path','blob_sha','sha256']) {
      assert.equal(file[property], pinned[property], `${fileKey} 不符合已核对的源文件锁`);
    }
    assert.ok(!files.has(fileKey), `重复来源文件 ${fileKey}`);
    const snapshot = JSON.parse(readBounded(join(root, `${fileKey}.json`)).toString('utf8'));
    for (const property of ['source','repository','commit','path','blob_sha','sha256']) assert.equal(snapshot[property], file[property], `${fileKey} 元数据不一致`);
    assert.equal(typeof snapshot.content, 'string');
    const bytes = Buffer.from(snapshot.content);
    assert.equal(sourceDigest(bytes), file.sha256, `${fileKey} 来源正文哈希不一致`);
    assert.equal(gitBlobDigest(bytes), file.blob_sha, `${fileKey} 不是锁定的 Git blob`);
    const lines = snapshot.content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    files.set(fileKey, {file, lines, content:snapshot.content});
  }
  function excerpt(ref) {
    assert.ok(ref && typeof ref === 'object');
    assert.equal(typeof ref.source, 'string'); assert.equal(typeof ref.path, 'string');
    const item = files.get(keyOf(ref));
    assert.ok(item, `未登记的来源文件 ${keyOf(ref)}`);
    for (const [property, expected] of Object.entries({repository:item.file.repository, commit:item.file.commit,
      blob_sha:item.file.blob_sha, source_sha256:item.file.sha256})) {
      if (ref[property] !== undefined) assert.equal(ref[property], expected, `${keyOf(ref)} 引用来源元数据不一致`);
    }
    assert.ok(Number.isSafeInteger(ref.start_line) && Number.isSafeInteger(ref.end_line));
    assert.ok(ref.start_line >= 1 && ref.end_line >= ref.start_line && ref.end_line <= item.lines.length, `${keyOf(ref)} 行号越界`);
    const text = item.lines.slice(ref.start_line - 1, ref.end_line).join('\n');
    assert.ok(text.trim(), `${keyOf(ref)} 空白原文不能作为依据`);
    const digest = sourceDigest(text);
    if (ref.excerpt_sha256 !== undefined) assert.equal(digest, ref.excerpt_sha256, `${keyOf(ref)} 引用片段哈希不一致`);
    return {text, reference:{source:ref.source, path:ref.path, start_line:ref.start_line, end_line:ref.end_line,
      excerpt_sha256:digest, source_sha256:item.file.sha256, blob_sha:item.file.blob_sha,
      repository:item.file.repository, commit:item.file.commit, ...(ref.kind ? {kind:ref.kind} : {})}};
  }
  function license(source) {
    if (source === 'D') {
      const item = files.get('D/README.md');
      assert.ok(item && item.content.includes('### License\n\nMIT'), 'D 缺少原 README 许可声明');
      return [excerpt({source:'D',path:'README.md',start_line:62,end_line:62}).text,
        excerpt({source:'D',path:'README.md',start_line:84,end_line:86}).text].join('\n\n');
    }
    const item = files.get(`${source}/LICENSE`);
    assert.ok(item && item.content.startsWith('MIT License'), `${source} 缺少对应许可证`);
    return item.content;
  }
  return {excerpt, license, files};
}

function materialBlock(material, index, label) {
  return `### ${label} ${index + 1}\n\n${cleanLineEndings(material.text)}\n`;
}

const exampleLabels = Object.freeze({dialogue:'教学对话', phrase:'话术片段', template:'表达模板', scenario:'情境示例'});

export const romanceLicenseHeading = '\n\n## 原作者许可声明\n\n';

/** 整套材料的许可集中保存在包外来源文档，单个包不携带重复副本。 */
export function renderRomanceLicenseAppendix(provenance, evidence) {
  const refs = [...provenance.common_methods, ...provenance.skills.flatMap(item => [...item.methods, ...item.examples])];
  const sources = [...new Set(refs.map(ref => ref.source))].sort();
  return romanceLicenseHeading + '以下保留本套材料所用来源的许可声明，统一随整套材料保存。\n\n' + sources.map(source =>
    `### ${source} · ${allowedRomanceSources[source].repository}\n\n\`\`\`text\n${evidence.license(source).trimEnd()}\n\`\`\`\n`
  ).join('\n');
}

/** 仅编排标题和读取提示；出处单独返回写入溯源文档，方法与示例不改写。 */
export function renderRomanceSourceSkill(entry, selection, evidence, commonReferences = [], translations = new Map()) {
  validateName(entry.name);
  assert.equal(selection.id, entry.id);
  assert.equal(selection.name, entry.name);
  assert.ok(['direct','shared_method','unsupported'].includes(selection.support));
  assert.ok(Array.isArray(selection.methods) && Array.isArray(selection.examples));
  if (selection.support === 'unsupported') {
    assert.equal(selection.methods.length, 0);
    assert.equal(selection.examples.length, 0);
  }
  else assert.ok(selection.methods.length > 0, `${entry.name} 缺少方法依据`);
  const localize = item => {
    const translation = translations.get(item.reference.excerpt_sha256);
    return translation === undefined ? item : {...item, text:translation};
  };
  const methods = selection.methods.map(evidence.excerpt).map(localize);
  const examples = selection.examples.map(ref => {
    assert.ok(['dialogue','phrase','template','scenario'].includes(ref.kind));
    return evidence.excerpt(ref);
  }).map(localize);
  const common = commonReferences.map(evidence.excerpt).map(localize);
  const description = selection.support === 'unsupported'
    ? `${entry.title}：当前没有足够可用的方法，暂不参与回复策略选择。`
    : `${entry.title}：用于该恋爱沟通场景，参考${selection.support === 'shared_method' ? '通用沟通方法' : '相应处理方法'}${examples.length ? '及表达示例' : ''}。`;
  let content = `# ${entry.title}\n\n`;
  if (common.length) content += `## 处理边界\n\n${common.map((item,i) => materialBlock(item,i,'共用规则')).join('\n')}\n`;
  content += `## 具体方法\n\n${methods.length ? methods.map((item,i) => materialBlock(item,i,'方法')).join('\n') : '本项暂无可用方法，暂不参与回复策略选择。'}\n\n`;
  content += '## 按需查看示例\n\n需要参考具体表达时读取 `references/cases.md`。\n';
  let cases = `# ${entry.title}：示例\n\n`;
  cases += examples.length ? examples.map((item,i) => materialBlock(item,i,exampleLabels[item.reference.kind])).join('\n') : '本项暂无单列示例。方法中的例句仍随相应方法保留。\n';
  const references = {schema_version:1, policy:'pinned-source-excerpts-with-source-bound-chinese-translation', name:entry.name, support:selection.support,
    common:common.map(item => item.reference), methods:methods.map(item => item.reference), examples:examples.map(item => item.reference)};
  return {document:serializeSkillDocument(entry.name,description,content), resources:new Map([
    ['references/cases.md', Buffer.from(cases.trimEnd()+'\n')],
  ]), references};
}
