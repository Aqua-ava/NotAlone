/** 缓存前冻结完整来源快照，使对象身份可以安全复用一次规范化摘要。 */
import {digest} from './canonical-json.ts';

const memo=new WeakMap<object,string>();
function freezeSnapshot(value:unknown,seen:WeakSet<object>):void{
 if(!value||typeof value!=='object'||seen.has(value))return;
 seen.add(value);
 for(const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))){
  // 快照必须是数据属性；冻结 accessor 不能固定其之后返回的来源内容。
  if(!Object.hasOwn(descriptor,'value'))throw new TypeError('window_snapshot_accessor_invalid');
  freezeSnapshot(descriptor.value,seen);
 }
 Object.freeze(value);
}
/** 测试计数桩：computed 为真实序列化次数，hits 为命中记忆化次数；产品逻辑不读取。 */
export const windowDigestStats={computed:0,hits:0};
export function windowDigest(window:unknown):string{
 if(!window||typeof window!=='object')return digest(window);
 const cached=memo.get(window);
 if(cached!==undefined){windowDigestStats.hits++;return cached;}
 freezeSnapshot(window,new WeakSet());
 const value=digest(window);windowDigestStats.computed++;memo.set(window,value);return value;
}
