import { fileURLToPath } from 'node:url';
import { developmentProcesses, requireDevelopmentOnly } from './development-policy.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const state = await developmentProcesses(project);
requireDevelopmentOnly(state);
console.log(JSON.stringify({ mode: state.development.length === 1 ? 'development' : 'stopped', pids: state.development }));
process.exitCode = state.development.length === 1 ? 0 : 1;
