import { sha, type Evidence } from '../../evidence/canonical-json.ts';
export type Message = Evidence & { message_id: string; text: string; sender: string; occurred_at: string | null };
export type Unit = { message: Message; start: number; end: number; text: string };
export type Representation = { target: Message; main: Unit[]; contexts: { unit: Unit; start: number; end: number }[]; quote_start: number; quote_end: number; author_start: number; author: string; observation_end: number };
export const length = (value: string): number => [...value].length;
export const slice = (value: string, start: number, end?: number): string => [...value].slice(start, end).join('');
export const textSpan = (text: string, start: number, end: number): Evidence => ({ start, end, sha256: sha(slice(text, start, end)) });
export const messageSpan = (message: Message, start: number, end: number): Evidence => ({ message_id: message.message_id, span: textSpan(message.text, start, end) });
export function units(messages: Message[]): Unit[] {
  return messages.flatMap(message => [...message.text.matchAll(/[^，；;。！？!?\n]+[，；;。！？!?\n]*/gu)]
    .filter(match => match[0].trim()).map(match => ({ message, start: length(message.text.substring(0, match.index)), end: length(message.text.substring(0, match.index! + match[0].length)), text: match[0] })));
}
export function representations(messages: Message[], candidate: Evidence, targets: string[]): Representation[] {
  const all = units(messages), found: Representation[] = [], text = candidate.text_content as string;
  for (let index = 0; index < all.length; index++) {
    const unit = all[index];
    if (!targets.includes(unit.message.message_id)) continue;
    const members = [[unit]];
    const following = all[index + 1];
    if (following && following.message.message_id === unit.message.message_id && following.start === unit.end) members.push([unit, following]);
    for (const main of members) for (const author of ['用户', '联系人']) {
      const prefixes = ['', ...(unit.message.occurred_at ? [`截至${unit.message.occurred_at.slice(0, 10)}，`] : [])];
      for (const observation of prefixes) {
        const quote = main.map(item => item.text).join(''), prefix = observation + author + '原话：“', opening = prefix + quote + '”';
        if (!text.startsWith(opening)) continue;
        const offset = length(opening), choices: Representation['contexts'][] = [];
        if (offset === length(text)) choices.push([]);
        else if (slice(text, offset).startsWith('（相关原文：')) {
          const visit = (cursor: number, chain: Representation['contexts']): void => {
            if (choices.length >= 2 || chain.length > 16) return;
            if (chain.length && slice(text, cursor) === '）') { choices.push(chain); return; }
            if (chain.length) { if (slice(text, cursor, cursor + 1) !== '；') return; cursor++; }
            for (const context of all) {
              if (main.includes(context) || chain.some(row => row.unit === context)) continue;
              const contextAuthor = context.message.sender === 'self' ? '用户' : '联系人';
              const token = contextAuthor + '说“' + context.text + '”';
              if (slice(text, cursor).startsWith(token)) visit(cursor + length(token), [...chain, { unit: context, start: cursor, end: cursor + length(token) }]);
            }
          };
          visit(offset + length('（相关原文：'), []);
        }
        for (const contexts of choices) {
          found.push({ target: unit.message, main, contexts, quote_start: length(prefix), quote_end: length(prefix + quote), author_start: length(observation), author, observation_end: length(observation) });
          if (found.length >= 2) return found;
        }
      }
    }
  }
  return found;
}
export function validateBody(messages: Message[], candidate: Evidence, targets: string[]): boolean {
  if (!targets.length || new Set(targets).size !== targets.length || targets.join(',') !== messages.filter(item => targets.includes(item.message_id)).map(item => item.message_id).join(',')) return false;
  if (new Set(candidate.source_ids).size !== candidate.source_ids.length) return false;
  const reps = representations(messages, candidate, targets), marker = ' 同一原消息续句：“';
  if (!reps.length && candidate.text_content.includes(marker)) {
    for (const match of candidate.text_content.matchAll(new RegExp(marker, 'gu'))) {
      const split = length(candidate.text_content.substring(0, match.index));
      for (const rep of representations(messages, { ...candidate, text_content: slice(candidate.text_content, 0, split) }, targets)) {
        let cursor = split, previous = rep.main.at(-1)!.start;
        const used = new Set(rep.main.map(unit => `${unit.message.message_id}/${unit.start}`));
        while (cursor < length(candidate.text_content)) {
          const matches = units(messages).filter(unit => unit.message.message_id === rep.target.message_id && unit.start > previous
            && !used.has(`${unit.message.message_id}/${unit.start}`) && slice(candidate.text_content, cursor).startsWith(marker + unit.text + '”'));
          if (matches.length !== 1) break;
          const unit = matches[0]; used.add(`${unit.message.message_id}/${unit.start}`); previous = unit.start; cursor += length(marker + unit.text + '”');
        }
        if (cursor === length(candidate.text_content)) reps.push(rep);
      }
    }
  }
  if (reps.length !== 1) return false;
  const rep = reps[0];
  if (rep.author !== (rep.target.sender === 'self' ? '用户' : '联系人')) return false;
  const breaks = rep.contexts.slice(0, -1).filter(row => !targets.includes(row.unit.message.message_id)).length;
  if (rep.contexts.length && breaks + 1 > rep.main.length) return false;
  const required = new Set([...rep.main.map(unit => unit.message.message_id), ...rep.contexts.map(row => row.unit.message.message_id)]);
  if (required.size !== candidate.source_ids.length || candidate.source_ids.some((id: string) => !required.has(id))) return false;
  if (!['按所引原文分句保留内容；类型为模型判断，来源定位和时间由程序校验。', '原文完成问答明确表示动作已完成，程序据此保留历史动作，不设置当天失效。'].includes(candidate.interpretation_reason)) return false;
  return (candidate.alternatives ?? []).every((value: string) => value === '原文指代在本窗口无法唯一确定，保留原句。');
}
export function representationPayload(rep: Representation, messages: Message[], text: string): Evidence {
  return { version: 1, kind: 'grounded_window_quote_v1', target_message_id: rep.target.message_id,
    source_full: messages.map(message => messageSpan(message, 0, length(message.text))), whole: textSpan(text, 0, length(text)),
    observation: rep.observation_end ? { message_id: rep.target.message_id, candidate: textSpan(text, 0, rep.observation_end) } : null,
    author: textSpan(text, rep.author_start, rep.author_start + length(rep.author)), quote: textSpan(text, rep.quote_start, rep.quote_end),
    quote_sources: rep.main.map(unit => messageSpan(unit.message, unit.start, unit.end)),
    contexts: rep.contexts.map(({ unit, start, end }) => {
      const author = unit.message.sender === 'self' ? '用户' : '联系人', quoteStart = start + length(author + '说“');
      return { source: messageSpan(unit.message, unit.start, unit.end), whole: textSpan(text, start, end), author: textSpan(text, start, start + length(author)), quote: textSpan(text, quoteStart, quoteStart + length(unit.text)) };
    }) };
}
