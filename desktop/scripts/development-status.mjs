import { fileURLToPath } from 'node:url';
import { developmentProcesses, requireDevelopmentOnly } from './development-policy.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--user-data-dir' || !args[1].startsWith('/') || /[\0\r\n]/.test(args[1]))) throw new Error('使用 dev:status --user-data-dir /绝对路径 核对隔离实例');
const state = await developmentProcesses(project, args[1]);
requireDevelopmentOnly(state);
console.log(JSON.stringify({ mode: state.development.length === 1 ? 'development' : 'stopped', pids: state.development }));
process.exitCode = state.development.length === 1 ? 0 : 1;
