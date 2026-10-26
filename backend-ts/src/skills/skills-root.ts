/** 管理与回复共用既有Skill目录配置；不读取文件或创建模型。 */
import {join,resolve} from 'node:path';
export function resolveSkillsRoot(environment:Readonly<NodeJS.ProcessEnv>,businessHome:string,projectDirectory:string):string {
 const raw=environment.NOTALONE_SKILLS_DIR??join(businessHome,'.notalone','skills');
 return resolve(projectDirectory,raw.replace(/^~(?=\/|$)/,businessHome));
}
