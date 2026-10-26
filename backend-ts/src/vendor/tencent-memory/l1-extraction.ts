/** Copyright (C) 2026 Tencent；MIT 许可见本目录 LICENSE。 */
interface ConversationMessage { id: string; role: string; timestamp: string | null; content: string; }

export const EXTRACT_MEMORIES_SYSTEM_PROMPT = `你是专业的"情境切分与记忆提取专家"。
你的任务是分析用户的对话，判断情境切换，并从中提取结构化的核心记忆（类别和输出字段以本次结构化工具为准）。

**输出语言**：所有自由文本字段（\`scene_name\`、memory \`text\`）使用与用户消息相同的语言；JSON 字段名、枚举值、ISO 时间戳保持英文。

### 任务一：情境切分（Scene Segmentation）
分析【待提取的新消息】，结合【上一个情境】，判断并输出当前对话的情境。
- 继承：无明显切换，沿用上一个情境。
- 切换条件：用户发出明确指令（如"换话题"）、意图转变、或提出独立新目标。
- 一段对话可能只有一个情境，也可能有多个情境（话题多次切换时）。
- 命名规则："双方围绕某个持续主题的场景"（**使用上述输出语言**，约 30-50 个字符或等价长度，单句，全局唯一）。

---

### 任务二：核心记忆提取（Memory Extraction）
结合背景和当前情境，仅从【待提取的新消息】中提取核心信息。

【通用提取原则】
1. 宁缺毋滥：过滤琐碎闲聊、临时性指令和一次性操作（如"这次、本单"）；剔除不可靠的边缘信息。
2. 独立完整：记忆必须"跳出当前对话依然成立"，无上下文也能看懂。必须保留来源中真实的人物主体；分析助手不是对话一方。
3. 归纳合并：强关联或因果关系的多条消息，必须合并为一条完整记忆，不可碎片化。
`;

export function getExtractMemoriesSystemPrompt(): string { return EXTRACT_MEMORIES_SYSTEM_PROMPT; }

export function formatExtractionPrompt(params: {
  newMessages: ConversationMessage[];
  backgroundMessages?: ConversationMessage[];
  previousSceneName?: string;
}): string {
  const { newMessages, backgroundMessages = [], previousSceneName = "无" } = params;

  const bgText = backgroundMessages.length > 0
    ? backgroundMessages
        .map((m) => `[${m.id}] [${m.role}] [${(m.timestamp ?? "unknown")}]: ${m.content}`)
        .join("\n\n")
    : "无";

  const newText = newMessages
    .map((m) => `[${m.id}] [${m.role}] [${(m.timestamp ?? "unknown")}]: ${m.content}`)
    .join("\n\n");

  return `**输出语言**：根据下方"待提取的新消息"中 真实双方发言的主导语言书写 \`scene_name\` 和 memory \`text\`。

【上一个情境】：${previousSceneName}

【背景对话】（仅供理解上下文推断关系/时间，严禁从中提取记忆）：
${bgText}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

【待提取的新消息】（只按来源日历锚点判断时间，未知时不推算，只从这里提取记忆！）：
${newText}`;
}
