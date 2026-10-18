/** 系统整理中的事实与推断；旧版本可以没有分类。 */
export interface PersonalBackground {
  kind?: 'fact' | 'preference' | 'inference' | 'contradiction';
  section?: string;
  basis?: string;
  uncertainty?: string;
}
