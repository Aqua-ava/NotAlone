export interface SkillLibraryItem {
 packageId: string; name: string; title: string; tags: string[]; description: string; directoryName: string;
 enabledState: 'enabled' | 'disabled' | 'unknown';
 verificationState: 'verified' | 'pending' | 'missing' | 'conflict' | 'invalid';
 verificationReason: string | null; headRevision: string; currentRevisionNo: string | null;
 revisions: {revisionNo: string; availability: 'current' | 'unavailable'; manifestDigest: string; contentDigest: string}[];
}
export interface SqliteSkillLibrarySnapshot {mode:'sqlite';connectionGeneration:number;skills:SkillLibraryItem[]}
export type SkillLibrarySnapshot = SqliteSkillLibrarySnapshot;
export interface SkillLibraryCommand {packageId:string;expectedHeadRevision:string;connectionGeneration:number;confirmed:true}
/** 联系人分组：用户自定义名称，绑定若干回复场景；联系人至多一个分组，未分组不使用任何场景。 */
export interface SkillGroupItem {groupId: string; name: string; revision: string; /** 内置“恋人”分组：自动使用全部回复场景，不可改名、改绑定或删除。 */ allPackages: boolean; packageIds: string[]; contactIds: string[]}
export interface SkillGroupsSnapshot {connectionGeneration: number; groups: SkillGroupItem[]}
interface SkillGroupCommandBase {connectionGeneration: number; confirmed: true}
export interface SkillGroupCreateCommand extends SkillGroupCommandBase {name: string; packageIds: string[]}
export interface SkillGroupUpdateCommand extends SkillGroupCommandBase {groupId: string; expectedRevision: string; name: string; packageIds: string[]}
export interface SkillGroupDeleteCommand extends SkillGroupCommandBase {groupId: string; expectedRevision: string}
export interface SkillGroupAssignCommand extends SkillGroupCommandBase {contactId: string; groupId: string | null; expectedGroupId: string | null}
export interface SkillLibraryBridge {
 readLibrary(): Promise<SkillLibrarySnapshot>;
 changeLibraryEnabled(command: SkillLibraryCommand & {enabled:boolean}): Promise<SqliteSkillLibrarySnapshot>;
 readGroups(): Promise<SkillGroupsSnapshot>;
 createGroup(command: SkillGroupCreateCommand): Promise<SkillGroupsSnapshot>;
 updateGroup(command: SkillGroupUpdateCommand): Promise<SkillGroupsSnapshot>;
 deleteGroup(command: SkillGroupDeleteCommand): Promise<SkillGroupsSnapshot>;
 assignContactGroup(command: SkillGroupAssignCommand): Promise<SkillGroupsSnapshot>;
}
