/** 专属父宿主：复用真实launcher，错误回执不输出配置或认证token。 */
import {readFile} from 'node:fs/promises';
import {launchDsh} from '../src/launch.ts';

try {
  const configuration=JSON.parse(await readFile(process.argv[2],'utf8'));
  const host=await launchDsh(configuration,()=>true);
  process.send?.({type:'launched',pid:host.pid});
  const clean=await host.waitForExit(120000);
  process.send?.({type:'stopped',clean});
  if(!clean)process.exitCode=1;
} catch {
  process.send?.({type:'failed'});
  process.exitCode=1;
} finally {
  process.disconnect?.();
}
