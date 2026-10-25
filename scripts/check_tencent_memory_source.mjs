/** 核对迁入源码及可选的上游检出目录；产品运行不依赖此检查或上游目录。 */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {upstream: {type: 'string'}}, strict: true});
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'backend-ts/src/vendor/tencent-memory');
const manifest = JSON.parse(readFileSync(resolve(directory, 'upstream.json'), 'utf8'));
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function requireDigest(path, expected, name) {
  if (digest(path) !== expected) throw new Error(`源码摘要不匹配：${name}`);
}

requireDigest(resolve(directory, manifest.license_path), manifest.license_sha256, 'LICENSE');
for (const module of manifest.modules) {
  requireDigest(resolve(directory, module.path), module.vendored_sha256, module.path);
}
if (values.upstream) {
  const commit = execFileSync('git', ['-C', values.upstream, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  if (commit !== manifest.commit) throw new Error('上游提交与固定来源不一致');
  requireDigest(resolve(values.upstream, 'LICENSE'), manifest.license_sha256, '上游 LICENSE');
  for (const module of manifest.modules) {
    requireDigest(resolve(values.upstream, module.source_path), module.source_sha256, module.source_path);
  }
}
process.stdout.write(JSON.stringify({commit: manifest.commit, modules_verified: manifest.modules.length,
  upstream_verified: Boolean(values.upstream), license: manifest.license}) + '\n');
