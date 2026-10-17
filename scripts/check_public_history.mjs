#!/usr/bin/env node
// 在端侧检查指定分支的完整历史；只输出问题位置，不输出敏感值。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
let ref = 'HEAD';
let workingTree = false;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--ref' && args[i + 1]) ref = args[++i];
  else if (args[i] === '--working-tree') workingTree = true;
  else throw new Error('用法：node scripts/check_public_history.mjs [--ref 分支或提交] [--working-tree]');
}
const git = (argv, options = {}) => execFileSync('git', argv, {
  maxBuffer: 512 * 1024 * 1024,
  ...options,
});
const repo = git(['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
if (git(['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
  throw new Error('隐私检查需要完整历史；请先补齐浅克隆历史再推送。');
}
const oid = git(['rev-parse', '--verify', ref + '^{commit}'], { encoding: 'utf8' }).trim();
const excluded = (name) => /(?:^|\/)node_modules(?:\/|$)/.test(name)
  || /^\.scratch\/unfinished-work\/coordinator-cross-account-handoff-.*\.md$/.test(name)
  || /^desktop\/tests\/manual-real-ecnu-[^/]+\.spec\.ts$/.test(name)
  || /(?:^|\/)\.env(?:\.[^/]*)?$/.test(name) && !/(?:^|\/)\.env\.example$/.test(name)
  || /^chat_exports(?:\/|$)/.test(name)
  || /\.(?:dump|backup|sql\.tmp)$/.test(name);
const commonDir = git(['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
const policyPath = path.resolve(commonDir, 'publication-audit-policy.json');
const policy = fs.existsSync(policyPath) ? JSON.parse(fs.readFileSync(policyPath, 'utf8')) : {};
const sensitiveValues = (Array.isArray(policy.privateAddresses) ? policy.privateAddresses : [])
  .filter((value) => typeof value === 'string' && value.length > 0)
  .map((value) => ({ value, kind: '私有部署地址' }));
const envPath = process.env.NOTALONE_PUBLICATION_ENV_FILE ?? path.join(repo, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(NOTALONE_[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, '$2');
    if (value.length >= 16 && !/^(?:your-|replace-|example|placeholder)/i.test(value)) {
      sensitiveValues.push({ value, kind: '本机实际凭据' });
    }
  }
}
const issues = [];
let totalIssues = 0;
let blobCount = 0;
let commitCount = 0;
let fileCount = 0;
function record(where, kind, line) {
  totalIssues += 1;
  if (issues.length < 50) issues.push({ location: where, line, kind });
}
function inspect(buffer, where) {
  if (buffer.includes(0)) return;
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) return;
  const patterns = [
    [/\/Users\/(?!local-user(?:\/|\b))[^\/\s"'\x60<>()\[\]{}]+/g, '本机用户名路径'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '内部会话标识'],
    [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, '私钥内容'],
    [/\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16})\b/g, '凭据格式'],
  ];
  for (const [pattern, kind] of patterns) {
    for (const match of text.matchAll(pattern)) record(where, kind, text.slice(0, match.index).split('\n').length);
  }
  for (const { value, kind } of sensitiveValues) {
    let index = text.indexOf(value);
    while (index !== -1) {
      record(where, kind, text.slice(0, index).split('\n').length);
      index = text.indexOf(value, index + value.length);
    }
  }
}
// 附注标签的说明也会上传；先检查标签对象，再检查其指向的完整提交历史。
let target = git(['rev-parse', '--verify', ref], { encoding: 'utf8' }).trim();
while (git(['cat-file', '-t', target], { encoding: 'utf8' }).trim() === 'tag') {
  const tag = git(['cat-file', 'tag', target]);
  inspect(tag, 'tag @' + target.slice(0, 8));
  const match = tag.toString('utf8').match(/^object ([a-f0-9]{40})\n/);
  if (!match) throw new Error('标签缺少目标对象');
  target = match[1];
}
const objects = git(['rev-list', '--objects', oid], { encoding: 'utf8' }).trim().split('\n');
const names = new Map();
const objectIds = [];
for (const entry of objects) {
  const id = entry.slice(0, 40);
  const name = entry.length > 41 ? entry.slice(41) : '';
  names.set(id, name);
  objectIds.push(id);

}
const trees = new Map();
const roots = new Set();
const batch = git(['cat-file', '--batch'], { input: objectIds.join('\n') + '\n' });
let position = 0;
for (const expected of objectIds) {
  const end = batch.indexOf(10, position);
  const header = batch.toString('ascii', position, end).split(' ');
  if (end < 0 || header[0] !== expected || !/^\d+$/.test(header[2] ?? '')) throw new Error('Git 对象流无效');
  const size = Number(header[2]);
  const start = end + 1;
  const stop = start + size;
  if (stop >= batch.length || batch[stop] !== 10) throw new Error('Git 对象字节数无效');
  if (header[1] === 'blob') {
    blobCount += 1;
    inspect(batch.subarray(start, stop), (names.get(expected) || 'blob') + ' @' + expected.slice(0, 8));
  } else if (header[1] === 'commit') {
    commitCount += 1;
    const raw = batch.subarray(start, stop);
    const tree = raw.toString('utf8', 0, raw.indexOf(10)).match(/^tree ([a-f0-9]{40})$/);
    if (!tree) throw new Error('提交缺少根树');
    roots.add(tree[1]);
    inspect(raw, 'commit @' + expected.slice(0, 8));
  } else if (header[1] === 'tree') {
    trees.set(expected, batch.subarray(start, stop));
  }
  position = stop + 1;
}
if (position !== batch.length) throw new Error('Git 对象流有剩余字节');
// 同一对象可以出现在多个路径；按树与路径组合遍历，避免去重时漏掉禁用名称。
const visitedTrees = new Set();
function inspectTree(treeId, prefix) {
  const key = treeId + ':' + prefix;
  if (visitedTrees.has(key)) return;
  visitedTrees.add(key);
  const tree = trees.get(treeId);
  if (!tree) throw new Error('缺少可达树对象');
  let cursor = 0;
  while (cursor < tree.length) {
    const space = tree.indexOf(32, cursor);
    const zero = tree.indexOf(0, space + 1);
    if (space < cursor || zero < space || zero + 21 > tree.length) throw new Error('树条目无效');
    const mode = tree.toString('ascii', cursor, space);
    const name = prefix + tree.toString('utf8', space + 1, zero);
    const child = tree.subarray(zero + 1, zero + 21).toString('hex');
    if (excluded(name)) record(name + ' @tree ' + treeId.slice(0, 8), '应排除的历史路径', 0);
    if (mode === '40000') inspectTree(child, name + '/');
    cursor = zero + 21;
  }
}
for (const tree of roots) inspectTree(tree, '');
if (workingTree) {
  const files = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const name of new Set(files)) {
    const full = path.join(repo, name);
    if (!fs.existsSync(full)) continue;
    fileCount += 1;
    if (excluded(name)) record(name, '应排除的当前文件', 0);
    const stat = fs.lstatSync(full);
    if (stat.isFile()) inspect(fs.readFileSync(full), name);
    else if (stat.isSymbolicLink()) inspect(Buffer.from(fs.readlinkSync(full)), name);
  }
}
console.log(JSON.stringify({ commit: oid, historicalBlobs: blobCount, historicalCommits: commitCount, currentFiles: fileCount, issues: totalIssues, locations: issues }, null, 2));
process.exitCode = totalIssues ? 1 : 0;
