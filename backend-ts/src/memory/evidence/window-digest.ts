/** 同一窗口对象的规范化摘要在同一次核验内只序列化一次：按对象身份记忆化，窗口按约定只读、不就地修改。 */
import {digest} from './canonical-json.ts';

const memo=new WeakMap<object,string>();
/** 测试计数桩：computed 为真实序列化次数，hits 为命中记忆化次数；产品逻辑不读取。 */
export const windowDigestStats={computed:0,hits:0};
export function windowDigest(window:unknown):string{
 if(!window||typeof window!=='object')return digest(window);
 const cached=memo.get(window);
 if(cached!==undefined){windowDigestStats.hits++;return cached;}
 const value=digest(window);windowDigestStats.computed++;memo.set(window,value);return value;
}
