/** 自有测试进程持有官方SDK写句柄；只由父测试释放，不模拟flock。 */
import {Context} from '@deepseek-ai/cordis';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import {SessionId} from '@deepseek-ai/dsh-session';

const root=process.argv[2],id=process.argv[3],ctx=new Context();
if(!root?.includes('/notalone-persistent-assistant-')||!/^[-a-f0-9]{36}$/.test(id??''))throw Error('仅允许自有合成运行目录');
const provider=ctx.plugin(Persistence,{root,compression:'none'});await provider.await();
let consumer;const plugin=ctx.plugin({name:'synthetic-lock-consumer',inject:['sessionPersistence'],apply(current){consumer=current;}});await plugin.await();
const handle=await consumer.sessionPersistence.open(SessionId(id),'write');
process.stdin.resume();
process.stdout.write('VALIDATION_LOCK_READY\n');
await new Promise(resolve=>process.once('SIGTERM',resolve));
await handle.close();await plugin.dispose();await provider.dispose();process.stdin.destroy();
