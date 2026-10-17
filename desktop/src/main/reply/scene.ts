// 精确场景只能来自用户声明或后端冻结输入，不能从模式、来话或Skill名称推断。
export function readReplyScene(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.trim() !== value) throw new Error('精确场景无效。');
  return value;
}

export function sceneSnapshot(value: unknown): { scene?: string } {
  const scene = readReplyScene(value);
  return scene === null ? {} : { scene };
}
