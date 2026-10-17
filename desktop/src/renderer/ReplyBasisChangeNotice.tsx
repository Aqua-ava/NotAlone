import type { ReplyBasisChange } from '../shared/reply-basis-change';

const kindNames = { confirmed_memory: '关系资料', owner_memory: '本人资料', pending_candidate: '未确认记忆候选', reply_skill: '回复方法' };
const reasonNames = { memory_revised: '记忆已修正、否决或替代', memory_expired: '记忆有效期已结束',
  memory_not_yet_valid: '记忆当前尚未生效', memory_time_changed: '记忆时间信息已变化', skill_policy_changed: '用户已调整本范围的方法使用决定' };

export function ReplyBasisChangeNotice({ changes }: { changes: readonly ReplyBasisChange[] | undefined }) {
  if (!changes?.length) return null;
  return <aside aria-label="依据已变化">
    <strong>依据已变化</strong>
    <ul>{changes.map((change) => <li key={`${change.kind}:${change.evidenceId}:${change.reason}`}>
      {kindNames[change.kind]}：{reasonNames[change.reason]}。
    </li>)}</ul>
    <p>{changes.some(change => change.reason === 'skill_policy_changed')
      ? '请先保留当前编辑并重新生成；旧候选不能继续用于新一轮。'
      : '仍可回看合法的旧正文；明确继续时将重新核验当前依据。请先保存当前修改。'}</p>
  </aside>;
}
