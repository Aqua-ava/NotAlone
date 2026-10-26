/** 未配置模型的真实合成PG也只走Node schema与同一精确清理入口。 */
import {createStorageFixture} from './host-storage-fixture.mjs';
export async function createUnconfiguredFixture(){
 const fixture=await createStorageFixture();
 return {...fixture,database:fixture.client.database};
}
