export interface SkillLibraryItem {
 packageId: string; name: string; description: string; directoryName: string;
 enabledState: 'enabled' | 'disabled' | 'unknown';
 verificationState: 'verified' | 'pending' | 'missing' | 'conflict' | 'invalid';
 verificationReason: string | null; headRevision: string; currentRevisionNo: string | null;
 revisions: {revisionNo: string; availability: 'current' | 'unavailable'; manifestDigest: string; contentDigest: string}[];
}
export interface SqliteSkillLibrarySnapshot {mode:'sqlite';connectionGeneration:number;skills:SkillLibraryItem[]}
export type SkillLibrarySnapshot = SqliteSkillLibrarySnapshot | {mode:'legacy';connectionGeneration:number};
export interface SkillLibraryCommand {packageId:string;expectedHeadRevision:string;connectionGeneration:number;confirmed:true}
export interface SkillDirectoryCommand {directoryName:string;connectionGeneration:number;confirmed:true}
export interface SkillLibraryBridge {
 readLibrary(): Promise<SkillLibrarySnapshot>;
 discoverLibrary(command: SkillDirectoryCommand): Promise<SqliteSkillLibrarySnapshot>;
 verifyLibrary(command: SkillLibraryCommand): Promise<SqliteSkillLibrarySnapshot>;
 changeLibraryEnabled(command: SkillLibraryCommand & {enabled:boolean}): Promise<SqliteSkillLibrarySnapshot>;
}
