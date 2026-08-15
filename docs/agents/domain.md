# 领域文档

本仓库采用 single-context 布局。

## 开始探索前

按任务需要读取：

- 根目录 `CONTEXT.md`（如果存在）
- `architecture/README.md`
- `architecture/` 中与任务相关的架构文档
- `architecture/adr/` 中与任务相关的 ADR

如果 `CONTEXT.md` 不存在，继续当前任务，不需要预先创建。`domain-modeling` skill 会在领域术语需要正式整理时按需创建它。

## 文档权威边界

- `AGENTS.md` 中的产品范围、隐私和人工发送约束是当前最高优先级规则。
- `architecture/` 是设计记录，不代表其中所有方案都正确或已经实现。
- 标记为“草案”的内容只用于理解探索方向，不得当作实现约束。
- 标记为“已采纳”的 ADR 是当前阶段性决定；如果新证据表明它不合适，应明确提出复审，并通过新 ADR 修订或替代。
- 实际代码和测试用于判断已经实现的行为，不得用架构文档代替运行验证。

## 文件结构

```text
/
├── CONTEXT.md                 # 按需创建的领域词汇表
├── architecture/
│   ├── README.md
│   ├── 01-domain-data.md
│   └── adr/                   # 已有的正式架构决策
└── docs/
    └── agents/                # engineering skills 配置
```

## 使用统一领域语言

输出中的领域概念应使用 `CONTEXT.md` 已定义的名称。如果概念尚未定义，应先判断它是错误同义词，还是需要通过 `domain-modeling` 补充的真实领域缺口。

## 标明 ADR 冲突

如果提议与现有 ADR 冲突，必须明确指出冲突，不得静默覆盖：

> 与 ADR-XXX 冲突；重新讨论的原因是……
