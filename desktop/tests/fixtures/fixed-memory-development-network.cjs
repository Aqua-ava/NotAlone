/** 仅供独立合成开发验收；不进入正式构建或修改业务模型配置。 */
// 回执只证明预加载及启动拦截；进程就绪仍由正式认证握手判断。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');

const invalidPlan = () => new Error('fixed_memory_development_plan_invalid');
const invalidLaunch = () => new Error('fixed_memory_development_launch_invalid');
function privateFile(file, limit, writing = false) {
  const fd = fs.openSync(file, (writing ? fs.constants.O_WRONLY | fs.constants.O_APPEND : fs.constants.O_RDONLY)
    | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const metadata = fs.fstatSync(fd);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()
      || (metadata.mode & 0o777) !== 0o600 || metadata.size > limit) throw invalidPlan();
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}
function readPrivate(file, limit) {
  const fd = privateFile(file, limit);
  try { return fs.readFileSync(fd, 'utf8'); } finally { fs.closeSync(fd); }
}
function privateDirectory(directory) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw invalidPlan();
}
const absolute = value => typeof value === 'string' && value.length <= 1024 && !/[\0\r\n]/.test(value)
  && path.isAbsolute(value) && path.resolve(value) === value;
let plan;
try {
  const planFile = process.env.NOTALONE_FIXED_MEMORY_DEVELOPMENT_PLAN;
  if (!absolute(planFile) || path.basename(planFile) !== 'synthetic-desktop-plan.json') throw invalidPlan();
  const root = path.dirname(planFile);
  privateDirectory(root);
  if (fs.realpathSync(root) !== root || path.dirname(root) !== fs.realpathSync(os.tmpdir()) || !path.basename(root).startsWith('notalone-')) throw invalidPlan();
  plan = JSON.parse(readPrivate(planFile, 8192));
  const keys = ['formatVersion', 'role', 'userData', 'databaseId', 'projectDirectory', 'envFilePath', 'infoPath', 'providerUrl', 'auditPath', 'receiptPath'];
  if (!plan || Array.isArray(plan) || Object.keys(plan).length !== keys.length || !keys.every(key => Object.hasOwn(plan, key))
    || plan.formatVersion !== 1 || plan.role !== 'test' || plan.userData !== root
    || typeof plan.databaseId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(plan.databaseId)
    || !absolute(plan.projectDirectory) || fs.realpathSync(plan.projectDirectory) !== plan.projectDirectory
    || plan.envFilePath !== path.join(root, 'synthetic.env') || plan.infoPath !== path.join(root, 'managed/sqlite-backend.info')
    || plan.auditPath !== path.join(root, 'synthetic-network.jsonl') || plan.receiptPath !== path.join(root, 'synthetic-desktop-receipts.jsonl')) throw invalidPlan();
  const origin = new URL(plan.providerUrl);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw invalidPlan();
  privateDirectory(path.join(root, 'managed'));
  if (readPrivate(plan.envFilePath, 512).trim() !== 'NOTALONE_DEEPSEEK_API_KEY=synthetic-only') throw invalidPlan();
  for (const file of [plan.auditPath, plan.receiptPath]) fs.closeSync(privateFile(file, 1_048_576));
  for (const file of ['backend-ts/src/launch.ts', 'backend-ts/profile/sqlite.patch.yml', 'backend-ts/src/sqlite-host-plugin.ts',
    'backend-ts/test/fixtures/sqlite-memory-profile-network-guard.mjs']) {
    if (!fs.lstatSync(path.join(plan.projectDirectory, file)).isFile()) throw invalidPlan();
  }
} catch { throw invalidPlan(); }
const dsh = path.join(plan.projectDirectory, 'backend-ts/node_modules/@deepseek-ai/dsh/lib/bin.js');
const guard = path.join(plan.projectDirectory, 'backend-ts/test/fixtures/sqlite-memory-profile-network-guard.mjs');
const receipt = kind => {
  const fd = privateFile(plan.receiptPath, 1_048_576, true);
  try { fs.writeSync(fd, JSON.stringify({ kind, parentPid: process.pid, ...(kind === 'spawn' ? { guardApplied: true } : {}) }) + '\n'); }
  finally { fs.closeSync(fd); }
};
try { receipt('preload'); } catch { throw invalidPlan(); }
const originalSpawn = childProcess.spawn;
let used = false;
childProcess.spawn = function (file, args, options) {
  const isDsh = value => typeof value === 'string' && value.endsWith('/@deepseek-ai/dsh/lib/bin.js');
  if (!isDsh(file) && !(Array.isArray(args) && args.some(isDsh))) return Reflect.apply(originalSpawn, this, arguments);
  try {
    if (used || file !== process.execPath || !Array.isArray(args) || args.length !== 3
      || args[0] !== dsh || args[1] !== '--profile' || args[2] !== 'notalone'
      || !options || !Array.isArray(options.stdio) || JSON.stringify(options.stdio) !== '["pipe","ignore","ignore"]') throw invalidLaunch();
    const environment = options.env;
    if (!environment || environment.ELECTRON_RUN_AS_NODE !== '1' || environment.HOME !== options.cwd || environment.DSH_HOME !== options.cwd
      || environment.DSH_TELEMETRY_DISABLED !== '1' || environment.NOTALONE_BACKEND_INFO !== plan.infoPath || environment.NOTALONE_ENV_FILE !== plan.envFilePath
      || ['NODE_OPTIONS', 'NOTALONE_FIXED_MEMORY_DEVELOPMENT_PLAN', 'NOTALONE_SYNTHETIC_PROVIDER_URL', 'NOTALONE_SYNTHETIC_NETWORK_AUDIT'].some(key => Object.hasOwn(environment, key))) throw invalidLaunch();
    privateDirectory(options.cwd);
    if (path.dirname(fs.realpathSync(options.cwd)) !== fs.realpathSync(os.tmpdir()) || !path.basename(options.cwd).startsWith('notalone-dsh-host-')
      || environment.NOTALONE_HOST_CONFIG !== path.join(options.cwd, 'host.json')) throw invalidLaunch();
    const host = JSON.parse(readPrivate(environment.NOTALONE_HOST_CONFIG, 16384));
    if (host.nodeExecutable !== file || host.parentPid !== process.pid || host.home !== options.cwd || host.businessHome !== plan.userData
      || host.projectDirectory !== plan.projectDirectory || host.envFilePath !== plan.envFilePath || host.infoPath !== plan.infoPath
      || host.sqlite?.userData !== plan.userData || host.sqlite?.expectedDatabaseId !== plan.databaseId || host.sqlite?.role !== 'test'
      || !Array.isArray(host.sqlite?.capabilities) || !['contacts', 'history', 'memory'].every(value => host.sqlite.capabilities.includes(value))) throw invalidLaunch();
    used = true;
    receipt('spawn');
  } catch { throw invalidLaunch(); }
  const environment = { ...options.env, NOTALONE_SYNTHETIC_PROVIDER_URL: plan.providerUrl, NOTALONE_SYNTHETIC_NETWORK_AUDIT: plan.auditPath };
  return Reflect.apply(originalSpawn, this, [file, ['--import', guard, ...args], { ...options, env: environment }]);
};
syncBuiltinESMExports();
