/** 只解析用户明确选择的本地包；不执行指令或读取外部引用。 */
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { parseDocument, visit, isScalar } from 'yaml';

export const MAX_RESOURCE_BYTES = 1024 * 1024;
export class SkillPackageError extends Error {
  readonly code: string;
  constructor(code: string) { super('Skill 包校验失败。'); this.name = 'SkillPackageError'; this.code = code; }
}
/** IO 错误不含原始路径；发现器据此保留上一有效状态并重试。 */
export class SkillPackageReadError extends Error { readonly code='file_unavailable'; constructor(){super('Skill 包暂不可读。');this.name='SkillPackageReadError';} }
export interface SkillResource { relative_path: string; resource_kind: 'reference' | 'asset'; media_type: string; content: Buffer; content_sha256: string }
export interface SkillPackage { name: string; description: string; content: string; content_sha256: string; package_sha256: string; resources: SkillResource[]; warnings: string[] }
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** Python 按 Unicode 码点排序；UTF-8 字节序保持相同顺序，避免非 BMP 路径改变旧哈希。 */
export const compareText = (a:string,b:string):number => Buffer.compare(Buffer.from(a),Buffer.from(b));
/** 保留 Python splitlines(keepends=True) 的全部分隔符及原始正文。 */
const splitLines = (text:string):string[] => text.match(/[^\r\n\v\f\x1c-\x1e\u0085\u2028\u2029]*(?:\r\n|[\r\n\v\f\x1c-\x1e\u0085\u2028\u2029])|[^\r\n\v\f\x1c-\x1e\u0085\u2028\u2029]+$/gu) ?? [];
const fail = (code: string): never => { throw new SkillPackageError(code); };
export function validateName(name: string): void { if (typeof name !== 'string' || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail('invalid_name'); }
export function validateRelative(relative: string): void { if (typeof relative !== 'string' || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid_resource_path'); }
const suffixes = new Set(['.csv','.json','.markdown','.md','.txt','.xml','.yaml','.yml']);
export function validateResourcePath(relative: string): void {
  validateRelative(relative);
  const parts=relative.split('/'), suffix=extname(relative).toLowerCase();
  if (parts.length < 2 || !['references','assets'].includes(parts[0]) || parts.some(p=>p.startsWith('.'))) fail('invalid_resource_path');
  if (!suffixes.has(suffix) && !(parts[0]==='assets' && ['.svg','.template','.tmpl'].includes(suffix))) fail('unsupported_resource_type');
}
/** 系统 /tmp、/var 别名仅在明确选择的根父目录规范化；根本身拒绝链接。 */
export function canonicalRoot(path: string): string {
  const absolute=resolve(path);
  // macOS 的两个系统别名可规范化；不能 realpath 整个父目录而抹去用户链接。
  for(const prefix of ['/tmp','/var']) {
    if(absolute===prefix || absolute.startsWith(prefix+'/')) {
      const canonical=realpathSync(prefix);
      if(canonical===prefix || canonical==='/private'+prefix) return canonical+absolute.slice(prefix.length);
    }
  }
  return absolute;
}
export function checkNoLinks(path: string): void {
  const absolute=resolve(path); let current='/';
  for (const part of absolute.split('/').filter(Boolean)) {
    current=join(current,part);
    try { if (lstatSync(current).isSymbolicLink()) fail('symlink_not_allowed'); }
    catch(error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
/** 以 NOFOLLOW 打开并限制实际读取量；非普通文件在读取前拒绝。 */
export function readBounded(path: string, maximum=MAX_RESOURCE_BYTES): Buffer {
  checkNoLinks(path);
  const fd=openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before=fstatSync(fd);
    if (!before.isFile()) fail('invalid_resource_type');
    if (before.size > maximum) fail('resource_size_exceeded');
    const bytes=Buffer.alloc(maximum+1); let length=0;
    while (length<bytes.length) { const n=readSync(fd,bytes,length,bytes.length-length,null); if (!n) break; length+=n; }
    const after=fstatSync(fd);
    if (length>maximum || after.size!==before.size || after.mtimeMs!==before.mtimeMs || after.ctimeMs!==before.ctimeMs) fail('resource_size_exceeded');
    checkNoLinks(path);
    const current=lstatSync(path);if(current.dev!==after.dev || current.ino!==after.ino)fail('invalid_resource_type');
    return bytes.subarray(0,length);
  } finally { closeSync(fd); }
}
export function decodeUtf8(bytes: Uint8Array): string { try { return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); } catch { return fail('invalid_encoding'); } }
export function parseSkillDocument(bytes: Uint8Array, packageName: string): {name:string;description:string;content:string} {
  const document=decodeUtf8(bytes);
  if (document.startsWith('\ufeff')) fail('invalid_encoding');
  const lines=splitLines(document);
  if (lines[0]?.trim()!=='---') fail('missing_frontmatter');
  const closing=lines.findIndex((line,i)=>i>0 && line.trim()==='---');
  if (closing<0) fail('invalid_frontmatter');
  let metadata: Record<string,unknown>;
  try { const parsed=parseDocument(lines.slice(1,closing).join('').replace(/\r\n?|\u0085/g,'\n'),{uniqueKeys:true,version:'1.1',merge:false}); if(parsed.errors.length || parsed.warnings.length) fail('invalid_frontmatter'); visit(parsed,{Pair(_key,pair){if(isScalar(pair.key)&&pair.key.source==='<<'&&pair.key.type==='PLAIN')fail('invalid_frontmatter');}}); metadata=parsed.toJS({maxAliasCount:100}); }
  catch { return fail('invalid_frontmatter'); }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('invalid_frontmatter');
  if(typeof metadata.name!=='string') fail('missing_name');
  const name=metadata.name as string; validateName(name); if(name!==packageName) fail('name_mismatch');
  if(typeof metadata.description!=='string' || !metadata.description.trim()) fail('missing_description');
  const description=(metadata.description as string).trim();
  if([...description].length>1024) fail('description_too_long');
  const content=lines.slice(closing+1).join('').replace(/^[\r\n]+/,'');
  if(!content.trim()) fail('empty_content'); if(lines.length>500) fail('skill_size_exceeded');
  let tokens=0, run=0;
  for(const char of document) { if(/[A-Za-z0-9]/.test(char)){run++;continue;} if(run){tokens+=Math.ceil(run/4);run=0;}if(!/\s/u.test(char)) tokens++; }
  if(tokens+Math.ceil(run/4)>5000) fail('skill_budget_exceeded');
  return {name,description,content};
}
const unsafePatterns = [ /\b(?:run|execute)\s+(?:bash|shell|sh|python|script|command)\b/i,/\b(?:curl|wget)\s+/i,/(?:执行|运行)(?:任意)?(?:脚本|shell|命令)/,/(?:访问|请求|下载)(?:外部)?网络/,/(?:发送|代发)(?:消息|回复)/,/(?:修改|删除|写入)(?:文件|数据库|记忆)/,/(?:调用|注册|创建)(?:Tool|MCP|工具)/i,/(?:ignore|override)\s+(?:previous|system)\s+instructions/i,/(?:忽略|覆盖)(?:之前|系统)(?:的)?指令/ ];
const privatePatterns=[/(?:微信导出|微信聊天记录|聊天记录原文|原始聊天记录|联系人资料|联系人信息)/i,/(?:姓名|微信号|手机号|手机号码|电话号码|联系人)\s*[:：]\s*(?![<{\[])[^\s,，;；]+/i];
const negation=/(?:不要|禁止|不能|不得|不可|不应|不可以|不会|不自动|避免|不处理|不包含|不记录|不保存|不读取|不采集|不导入|不上传|仅供文本|只允许|do not|don't|must not|never|without|avoid|cannot|can't|won't)/i;
export function validateSafety(content: string): void {
  if(/\b(?:https?|ftp|file|data|blob|javascript):|(?<![\w])\/\/[^\s<>"']+/i.test(content)) fail('external_url');
  if(/(?<![A-Za-z0-9_])['"]?(?:sender_wxid|external_local_id|external_talker|raw_payload|source_document_id)['"]?(?:\s*:|(?![A-Za-z0-9_]))/i.test(content)) fail('private_export');
  for(const line of splitLines(content)) for(const [patterns,code] of [[privatePatterns,'private_export'],[unsafePatterns,'unsafe_instruction']] as const) {
    for(const pattern of patterns) { const match=pattern.exec(line); if(match && !negation.test(line.slice(0,match.index).trimEnd())) fail(code); }
  }
}
function resourceText(relative: string, bytes: Buffer): void {
  if(['504b0304','504b0506','504b0708','377abcaf271c','526172211a07','1f8b','425a68','fd377a585a00','494433','4f676753','664c6143','4d546864','1a45dfa3'].some(hex=>bytes.subarray(0,hex.length/2).toString('hex')===hex) || bytes.subarray(4,8).toString()==='ftyp' || (bytes.subarray(0,4).toString()==='RIFF' && ['AVI ','WAVE'].includes(bytes.subarray(8,12).toString()))) fail('unsupported_resource_type');
  let text=decodeUtf8(bytes);if(text.includes('\0')) fail('invalid_text');
  if(extname(relative).toLowerCase()==='.svg') {
    text=text.replace(/&#(?:x([\da-f]+)|(\d+));?/gi,(_,hex,dec)=>String.fromCodePoint(Number.parseInt(hex??dec,hex?16:10))).replace(/&(?:amp|lt|gt|quot|apos);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[entity]!));
    text=text.replace(/(?:%[\da-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch{return part;}});
    text=text.replace(/(\bxmlns(?::[A-Za-z][A-Za-z0-9_.-]*)?\s*=\s*['"])https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)(['"])/gi,'$1$2');
    if(/<\s*(?:[A-Za-z_][A-Za-z0-9_.-]*:)?script\b|\bon[a-z]+\s*=|\b(?:href|xlink:href|src)\s*=\s*['"]\s*(?:[a-z][a-z0-9+.-]*:|\/\/)|\burl\(\s*['"]?(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(text)) fail('unsafe_instruction');
  }
  validateSafety(text);
}
const mediaTypes: Record<string,string>={'.md':'text/markdown','.markdown':'text/markdown','.txt':'text/plain','.csv':'text/csv','.json':'application/json','.yaml':'application/yaml','.yml':'application/yaml','.xml':'application/xml','.svg':'image/svg+xml','.template':'text/plain','.tmpl':'text/plain'};
export function validatePackage(name: string, document: Buffer, resources: SkillResource[]): SkillPackage {
  const parsed=parseSkillDocument(document,name);validateSafety(parsed.description);validateSafety(parsed.content);
  if(resources.length>100) fail('resource_count_exceeded');
  let total=0;const seen=new Set<string>();
  for(const r of resources){validateResourcePath(r.relative_path);if(seen.has(r.relative_path)) fail('duplicate_resource_path');seen.add(r.relative_path);if(r.resource_kind!==(r.relative_path.startsWith('references/')?'reference':'asset') || !r.media_type?.trim() || !Buffer.isBuffer(r.content)) fail('invalid_resource');if(r.content.length>MAX_RESOURCE_BYTES) fail('resource_size_exceeded');total+=r.content.length;if(total>4*MAX_RESOURCE_BYTES) fail('resource_budget_exceeded');resourceText(r.relative_path,r.content);if(sha256(r.content)!==r.content_sha256) fail('resource_hash_mismatch');}
  const ordered=[...resources].sort((a,b)=>compareText(a.relative_path,b.relative_path));
  const hash=createHash('sha256').update('SKILL.md\0').update(document);
  for(const r of ordered)hash.update(r.relative_path).update('\0').update(r.content).update('\0');
  const warnings:string[]=[];
  if(!['适合','用于','使用','场景','需要','说明','策略','when','use','for'].some(h=>parsed.description.toLowerCase().includes(h)))warnings.push('Skill description 建议说明适用场景和使用时机。');
  if(splitLines(parsed.content).filter(l=>l.trim()).length<3)warnings.push('Skill 正文较短，建议补充适用场景、步骤、示例和边界。');
  return {...parsed,content_sha256:sha256(parsed.content),package_sha256:hash.digest('hex'),resources:ordered,warnings};
}
export function readPackage(path: string): SkillPackage {
  try {
    const root=canonicalRoot(path);checkNoLinks(root);if(!lstatSync(root).isDirectory())fail('invalid_package');
    for(const entry of readdirSync(root,{withFileTypes:true})){if(entry.isSymbolicLink())fail('symlink_not_allowed');if(!(entry.name==='SKILL.md' && entry.isFile()) && !(['references','assets'].includes(entry.name) && entry.isDirectory()))fail('unsupported_entry');}
    const document=readBounded(join(root,'SKILL.md'));const resources:SkillResource[]=[];let total=0;
    function visit(relative: string): void {
      const entries=readdirSync(join(root,relative),{withFileTypes:true}).sort((a,b)=>compareText(a.name,b.name));
      for(const entry of entries){const path=relative+'/'+entry.name;validateRelative(path);if(entry.name.startsWith('.'))fail('invalid_resource_path');if(entry.isSymbolicLink())fail('symlink_not_allowed');if(entry.isDirectory()){visit(path);continue;}if(!entry.isFile())fail('invalid_resource_type');validateResourcePath(path);if(resources.length>=100)fail('resource_count_exceeded');const content=readBounded(join(root,path));total+=content.length;if(total>4*MAX_RESOURCE_BYTES)fail('resource_budget_exceeded');resources.push({relative_path:path,resource_kind:relative.startsWith('references')?'reference':'asset',media_type:mediaTypes[extname(path).toLowerCase()],content,content_sha256:sha256(content)});}
    }
    for(const entry of readdirSync(root,{withFileTypes:true}))if(entry.isDirectory())visit(entry.name);
    return validatePackage(basename(root),document,resources);
  } catch(error){if(error instanceof SkillPackageError)throw error;if(typeof (error as NodeJS.ErrnoException)?.code==='string')throw new SkillPackageReadError();throw new SkillPackageError('invalid_package');}
}
export function serializeSkillDocument(name:string,description:string,content:string): Buffer { return Buffer.from(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}`); }
