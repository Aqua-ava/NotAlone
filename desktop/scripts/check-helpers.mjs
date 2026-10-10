import { acceptanceFlags, argumentsFor, failureReport, inspectRuntime } from './helper-runtime.mjs';

let result;
try { result = await inspectRuntime(argumentsFor(process.argv.slice(2))); }
catch (error) { result = failureReport(error); process.exitCode = 2; }
process.stdout.write(`${JSON.stringify({ ...result, ...acceptanceFlags })}\n`);
