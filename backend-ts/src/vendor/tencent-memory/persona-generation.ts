/** Copyright (C) 2026 Tencent；MIT 许可见本目录 LICENSE。 */
export interface PersonaPromptParams {
  mode: "first" | "incremental";
  /** Prompt family for L3 generation (default: chat). */
  currentTime: string;
  maxCharacters?: number;
  documentContract: string;
  totalProcessed: number;
  sceneCount: number;
  changedSceneCount: number;
  changedScenesContent: string;
  existingPersona?: string;
  triggerInfo?: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  personaFilePath: string;
  /** @deprecated Kept for call-site compatibility; no longer used in prompt. */
  checkpointPath: string;
}

export interface PersonaPromptResult {
  systemPrompt: string;
  userPrompt: string;
}

const PERSONA_SYSTEM_PROMPT = `# 🧬 Persona Architect - Incremental Evolution Protocol

**输出语言**：\`profile.md\` 的所有自然语言内容（事实、偏好、有来源的洞察与矛盾）使用与变化场景内容相同的语言；Markdown 语法、标签格式、文件名 \`profile.md\` 保持英文。

请你结合已有的 profile.md 和新增/变化的 block 信息深度分析，然后使用文件工具将结果写入 \`profile.md\` 文件。

## ⛔ 文件操作约束（必须严格遵守）

1. **必须使用文件工具将最终 persona 内容写入 \`profile.md\`**。当前工作目录已设为数据目录，直接使用文件名 \`profile.md\`。
   - **首次生成 / 大幅重写**：使用 **write** 工具整体写入。参数：\`path\`=\`profile.md\`, \`content\`=完整内容
   - **增量更新（局部修改）**：使用 **edit** 工具精确替换。参数：\`path\`=\`profile.md\`, \`edits\`=[{\`oldText\`: 旧内容片段, \`newText\`: 新内容片段}]
2. **只能写入 \`profile.md\` 这一个文件**，只可按本次清单读取场景，禁止工作区外内容和其他文件写入。
3. **写入的内容必须只包含最终的 persona 文档**，不要包含你的思考过程、分析步骤或任何非 persona 内容。
4. **无需 read 工具**：当前 profile.md 的完整内容已在用户消息中提供，直接基于它进行更新即可。

### 🚫 严格禁止
- **禁止过长**：profile.md 内容总长度遵守本次输入的字符预算，及时做总结和删除不重要的信息。
- **禁止过度推测**：没提到的信息不要过度臆想导致产生幻觉，特别是在冷启动阶段，要保持克制，如果没有相关信息完全可以不填！
- **禁止使用非场景来源的信息**：Persona 的所有内容必须且只能来自下方提供的场景数据。不要从 workspace 目录结构、文件路径、系统信息等技术元数据中提取任何关于用户的个人信息。
- **禁止写入 profile.md 以外的任何文件**。

---

`;

export function buildPersonaPrompt(params: PersonaPromptParams): PersonaPromptResult {
  const {
    mode,
    currentTime,
    maxCharacters = 2000,
    documentContract,
    totalProcessed,
    sceneCount,
    changedSceneCount,
    changedScenesContent,
    existingPersona,
    triggerInfo,
  } = params;

  const targetFile = "profile.md";
  const modeLabel = mode === "first" ? "🆕 首次生成" : "🔄 迭代更新";

  const triggerSection = triggerInfo
    ? `\n### 触发信息\n${triggerInfo}\n`
    : "";

  const existingPersonaSection = existingPersona
    ? `\n## 📄 当前 Persona（工程已预加载）\n\n` +
      `*以下是现有 profile.md 的完整内容（${existingPersona.length} 字符），基于此更新后请控制在${maxCharacters}字内：*\n\n` +
      `\`\`\`markdown\n${existingPersona}\n\`\`\`\n\n---\n`
    : "";
  const iterationGuide = mode === "incremental"
    ? `\n## 🔄 迭代决策指南\n\n` +
      `面对变化场景，自主判断处理方式：强化（佐证已有洞察）/ 补充（新维度）/ 修正（矛盾）/ 重构（结构调整）/ 不改（无有用新增内容）。\n`
    : "";

  const userPrompt = `**输出语言**：\`${targetFile}\` 使用下方变化场景内容的主导语言。

**⏰ 更新时间**: ${currentTime}
**模式**: ${modeLabel}
${triggerSection}
## 📊 统计
- **总记忆数**: ${totalProcessed} 条
- **场景总数**: ${sceneCount} 个
- **变化场景**: ${changedSceneCount} 个（自上次更新后）

---
${changedScenesContent}

${existingPersonaSection}
${iterationGuide}`;

  return {
    systemPrompt: PERSONA_SYSTEM_PROMPT + "\n\n【NotAlone 资料与输出契约】\n" + documentContract,
    userPrompt,
  };
}
