#!/usr/bin/env node
// 使用仓库内的钩子；拒绝静默替换其他自定义钩子目录。
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import path from 'node:path';
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const current = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8', cwd: repo });
if (current.status !== 0 && current.status !== 1) throw new Error('无法读取 Git 钩子配置');
const configured = current.stdout.trim();
if (configured && configured !== '.githooks') throw new Error('已有自定义 core.hooksPath，请先合并现有钩子，未修改配置。');
chmodSync(path.join(repo, '.githooks/pre-push'), 0o755);
execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: repo });
console.log('已启用本仓库的推送前隐私检查；其他克隆需要单独运行此安装命令。');
