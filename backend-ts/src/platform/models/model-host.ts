/** 宿主唯一的 TS 模型许可；稳定状态不随临时DSH profile销毁。 */
import { mkdir, lstat, rmdir } from 'node:fs/promises';
import { join, resolve, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ModelPermitArbiter } from './model-permits.ts';
import { startModelPermitServer, type ModelPermitAccounting } from './model-permit-server.ts';
export interface ModelHostOptions {
  runtimeEnvironment: Readonly<NodeJS.ProcessEnv>;
  businessHome: string;
  infoPath: string;
  envFilePath: string;
  accounting?: ModelPermitAccounting;
}
export function modelBackgroundConcurrency(environment: Readonly<NodeJS.ProcessEnv>): number {
  const raw = environment.NOTALONE_EXTRACTION_BATCH_CONCURRENCY;
  if (raw === undefined) return 3;
  // Python str.strip/int接受Unicode十进制数与数字间单个下划线；不用JS Number替代。
  const text = raw.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,'');
  const decimal = /\p{Decimal_Number}/u;
  const normalized = [...text].map(character=>{
    if(!decimal.test(character))return character;
    const code=character.codePointAt(0)!;
    let first=code;
    while(first>0&&decimal.test(String.fromCodePoint(first-1)))first--;
    return String((code-first)%10);
  }).join('');
  if (!/^[+-]?\d(?:_?\d)*$/.test(normalized) || normalized.replace(/[^0-9]/g,'').length>4300) throw new Error('model_background_concurrency_invalid');
  const value=Number(normalized.replaceAll('_',''));
  if(!Number.isSafeInteger(value)||value<1||value>4)throw new Error('model_background_concurrency_invalid');
  return value;
}
async function privateDirectory(path: string) {
  let created = false;
  try { await mkdir(path,{mode:0o700}); created = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const entry = await lstat(path);
  if (!entry.isDirectory() || (entry.mode & 0o077) !== 0 || process.getuid && entry.uid !== process.getuid()) throw new Error('model_permit_directory_not_private');
  return created;
}
type ModelHostIdentityOptions = Pick<ModelHostOptions,'runtimeEnvironment'|'businessHome'|'infoPath'|'envFilePath'>;
/** 模式选择与实际ModelHost共用稳定身份；计算本身不创建目录或socket。 */
function modelHostPaths(options:ModelHostIdentityOptions) {
  for (const path of [options.businessHome,options.infoPath,options.envFilePath]) if (!isAbsolute(path)||/[\0\r\n]/.test(path)) throw new Error('model_host_configuration_invalid');
  const managed = options.runtimeEnvironment.NOTALONE_MANAGED_USER_DATA;
  if (managed !== undefined && (!isAbsolute(managed)||/[\0\r\n]/.test(managed))) throw new Error('model_host_configuration_invalid');
  const identity = createHash('sha256').update(JSON.stringify([resolve(options.infoPath),resolve(options.envFilePath)])).digest('hex').slice(0,24);
  const base = managed ?? join(options.businessHome,'.notalone');
  const directory = join(base,'model-permits',identity);
  const socketDirectory = join('/tmp',`na-model-${process.getuid?.() ?? 'local'}-${identity}`);
  return {directory,socketDirectory,path:join(socketDirectory,'p.sock'),statePath:join(directory,'state.json')};
}
export async function startModelHost(options: ModelHostOptions) {
  const {directory,socketDirectory,path,statePath}=modelHostPaths(options);
  const concurrency = modelBackgroundConcurrency(options.runtimeEnvironment);
  await mkdir(directory,{recursive:true,mode:0o700});
  await privateDirectory(directory);
  // macOS Unix socket路径有严格长度限制；只有socket放短私有目录，状态留业务目录。
  const createdSocketDirectory = await privateDirectory(socketDirectory);
  const token = randomBytes(32).toString('base64url');
  const arbiter = new ModelPermitArbiter(concurrency);
  let server: Awaited<ReturnType<typeof startModelPermitServer>>;
  try { server = await startModelPermitServer({path,statePath,token,arbiter,accounting:options.accounting}); }
  catch (error) {
    if (createdSocketDirectory) await rmdir(socketDirectory).catch(()=>{});
    throw error;
  }
  let closing: Promise<void> | undefined;
  async function shutdown() {
    await server.shutdown();
    await rmdir(socketDirectory).catch(()=>{});
  }
  return {
    arbiter,
    statePath,
    permit:{path,token},
    unknownSettlements: server.unknownSettlements,
    unconfirmedPermitIds: server.unconfirmedPermitIds,
    shutdown,
    /** stopNewWork 必须先停业务接收，不能先等排队请求退出。 */
    close(stopNewWork: () => Promise<void>): Promise<void> {
      return closing ??= (async()=>{
        // 先拒绝所有待领许可，让排队请求能退出，再等真实在途结算。
        arbiter.stop();
        try {
          await stopNewWork();
          await arbiter.pauseAndDrain();
          await server.close();
          await rmdir(socketDirectory).catch(()=>{});
        } catch (error) { await shutdown(); throw error; }
      })().catch(error=>{closing=undefined;throw error;});
    },
  };
}
