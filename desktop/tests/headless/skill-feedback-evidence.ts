import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// 在隔离环境清理前捕获本轮目录，后续写证据不重新读取宿主环境。
export function createSkillFeedbackEvidenceWriter(directory: string | undefined) {
  if (!directory || !path.isAbsolute(directory)) throw new Error('方法反馈页面缺少本轮证据目录。');
  return async (stage: 'original' | 'regenerated', value: unknown) => {
    await writeFile(path.join(directory, `feedback-generation-${stage}-${randomUUID()}.json`),
      JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
  };
}
