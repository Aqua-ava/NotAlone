import type { PersonalBackground } from '../shared/personal-background';
const kinds = { fact: '事实', preference: '明确偏好', inference: '模型推断（未证实）', contradiction: '未解矛盾' };
const sections: Record<string, string> = { basic_information: '基本信息', core_traits: '核心特征',
  explicit_preferences: '明确偏好', implicit_signals: '隐性信号', narrative: '场景叙事', evolution: '变化轨迹',
  contradictions: '未解矛盾', long_term_preferences: '长期偏好', life_context: '生活背景', interests: '兴趣', insights: '深层洞察' };
export function PersonalBackgroundDetails({ item }: { item: PersonalBackground }) {
  if (!item.kind) return null;
  return <div><p>{kinds[item.kind]}{item.section ? ` · ${sections[item.section] ?? item.section}` : ''}</p>
    {item.basis && <p>整理依据：{item.basis}</p>}</div>;
}
