import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectWechatComponents } from './wechat-components.mjs';

export async function prepareWechatComponents({ sourceCache, outputDirectory, allowDownload = false }) {
  if (!sourceCache || !outputDirectory || !path.isAbsolute(sourceCache) || !path.isAbsolute(outputDirectory)) throw new Error('wechat_arguments');
  if (await lstat(outputDirectory).catch(() => undefined)) throw new Error('wechat_output_exists');
  const lock = JSON.parse(await readFile(new URL('../wechat-sources.lock.json', import.meta.url), 'utf8'));
  for (const item of lock.archives) {
    if (!(await lstat(path.join(sourceCache, item.filename)).catch(() => undefined)) && !allowDownload) throw new Error(`wechat_source_missing:${item.filename}`);
  }
  const { buildWechatComponents } = await import('./build-wechat-components.mjs');
  return buildWechatComponents({ sourceCache, outputDirectory, allowDownload });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (key === '--allow-download' && !options.allowDownload) { options.allowDownload = true; continue; }
    const mapping = { '--source-cache': 'sourceCache', '--output-directory': 'outputDirectory', '--check-directory': 'checkDirectory' };
    if (!mapping[key] || options[mapping[key]] || !process.argv[i + 1] || !path.isAbsolute(process.argv[i + 1]) || /[\0\r\n]/.test(process.argv[i + 1])) throw new Error('wechat_arguments');
    options[mapping[key]] = path.resolve(process.argv[++i]);
  }
  if (options.checkDirectory) {
    if (Object.keys(options).length !== 1) throw new Error('wechat_arguments');
    const result = await inspectWechatComponents(options.checkDirectory); console.log(`微信研发组件完整性通过：${result.files.length} 个文件；真实微信接入仍未验收。`);
  } else await prepareWechatComponents(options);
}
