import type { PersonalBackground } from '../shared/personal-background';

/** 在资料页和回复依据中一致保留分类；不接受半套推断元数据。 */
export function readPersonalBackground(item: Record<string, unknown>, profile = false): PersonalBackground {
  if (!['kind', 'section', 'basis'].some(key => key in item)) return {};
  const sections = profile
    ? ['basic_information', 'long_term_preferences', 'life_context', 'interests', 'insights', 'evolution', 'contradictions']
    : ['basic_information', 'core_traits', 'explicit_preferences', 'implicit_signals', 'narrative', 'evolution', 'contradictions'];
  if (typeof item.kind !== 'string' || !['fact', 'preference', 'inference', 'contradiction'].includes(item.kind)
    || typeof item.section !== 'string' || !sections.includes(item.section)
    || typeof item.basis !== 'string' || !item.basis.trim() || item.basis.length > 1000
    || typeof item.uncertainty !== 'string' || item.uncertainty.length > 240
    || (['inference', 'contradiction'].includes(item.kind)
      && (!item.uncertainty.trim() || (profile && item.temporal_status !== 'uncertain')))) {
    throw new Error('系统整理的分类或推断依据不可用。');
  }
  return { kind: item.kind as PersonalBackground['kind'], section: item.section,
    basis: item.basis, uncertainty: item.uncertainty };
}
