/** 测试专用扩展：生产库只在受控刷新里登记目录、失效来源，不公开按名登记与按 id 失效入口。 */
import {SqliteSkillLibrary} from '../../../src/skills/sqlite/library.ts';
import {validateName} from '../../../src/skills/skill-package.ts';

export class TestSkillLibrary extends SqliteSkillLibrary {
  async discover(directoryName,signal) {
    return this.change(async()=>{
      validateName(directoryName);
      const current=(await this.list(signal)).find(item=>item.directoryName===directoryName);
      return current??this.associateDirectory(directoryName,signal);
    });
  }
  requireVerification(id,expectedHead,signal) {
    return this.change(()=>this.execute('skills.invalidate',{ownerId:this.ownerId,id,expectedHead,verificationState:'pending',reason:'source_qualification_changed'},signal));
  }
}
