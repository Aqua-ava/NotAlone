# 恋爱回复 Skill 的固定来源

本索引保留内容选择的来历，不将上游宣传、人物观点或效果断言作为事实或产品能力。包内只保留来源编号和必要的静态教学内容，外部链接仅保存在这个包外索引；模型不会因加载某个包而获得网络访问能力。

## 方法与案例处理

- 对同一具体问题的跨包方法合并；触发条件、表达目标或处理步骤不同的细场景分别保留。
- 案例为重新编写的虚构对话，保留有关方法的处理逻辑；不搬入人物身份、真实私人对话或原始字幕。
- 保留可操作的承接、分享、玩笑、暧昧、邀约、修复和分支接法；当下用户意愿决定具体方向。
- 不将关系标签、回复速度、个人条件分数或人物经验自动当成对方心理和关系事实。亲密沟通以双方明确意愿及可撤回的同意为前提。
- 交友照片、线下行程策划、自我提升、专业判断和长期关系诊断不进入这套回复包；相关主题只取当前沟通所需方法。
- 编号来自源内容盘点中的 D01–D33、E01–E28、G01–G43、C01–C17、T01–T06，代表归纳的任务，不代表上游同名独立文件。

## 固定版本

### D：dating-coach：恋爱教练

- 仓库：[Mayuqi-crypto/HowToGetAlongWithGirls](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/tree/af0897f4b55897624a19de48374d436906e26461)。
- 固定提交：`af0897f4b55897624a19de48374d436906e26461`。
- 主文件：[.claude/skills/dating-coach/SKILL.md](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/SKILL.md)。
- 参考入口：`.claude/skills/dating-coach/references/`。

### E：EROS

- 仓库：[merchantmoh-debug/EROS-AI-Dating-Repository](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/tree/0753f76f6683e5094456fb5c6342391c7de1b2f7)。
- 固定提交：`0753f76f6683e5094456fb5c6342391c7de1b2f7`。
- 主文件：[SKILL.md](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md)。
- 参考入口：`docs/`。

### G：goutoujunshi：狗头军师

- 仓库：[shengjidaguai-china/goutoujunshi](https://github.com/shengjidaguai-china/goutoujunshi/tree/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f)。
- 固定提交：`6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f`。
- 主文件：[SKILL.md](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/SKILL.md)。
- 参考入口：`references/`。

### C：relationship-copilot：关系副驾

- 仓库：[Mowon0303/LoveHelper.skill](https://github.com/Mowon0303/LoveHelper.skill/tree/1e391e26fd1c1bfee06e4daa9b439086a098a49b)。
- 固定提交：`1e391e26fd1c1bfee06e4daa9b439086a098a49b`。
- 主文件：[relationship-copilot/SKILL.md](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/SKILL.md)。
- 参考入口：`relationship-copilot/references/human-progression-playbook.md`。

### T：童锦程视角

- 仓库：[hotcoffeeshake/tong-jincheng-skill](https://github.com/hotcoffeeshake/tong-jincheng-skill/tree/c9caaa9a6576f581c29d016c60bbe935908e20d5)。
- 固定提交：`c9caaa9a6576f581c29d016c60bbe935908e20d5`。
- 主文件：[SKILL.md](https://github.com/hotcoffeeshake/tong-jincheng-skill/blob/c9caaa9a6576f581c29d016c60bbe935908e20d5/SKILL.md)。
- 参考入口：`references/research/`。

## DSH 读取合同核对

2026-10-31 核对后台声明、pnpm 锁和本工作树安装的 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-skill` 为 `0.2.1-rc.2`。官方公开类型导出 SkillProvider 的 list/get 和 registerProvider；安装制品 `lib/index.js` 的 registerProvider、list/get 与项目现有受控 provider 接线一致。固定源码参考提交为 `687f282e8625c6b8d11ff58211a90524be2e4317`，相邻源码仓 HEAD 不同，仅读取固定提交；未据此宣称整个 npm 制品逐字对应源码构建。

本任务仅新增内容包与核验入口，沿用 `backend-ts/src/skills/skill-package.ts` 的 name/description、500 行/5000 估算 tokens、资源相对路径及内容安全校验，以及 `backend-ts/src/skills/sqlite/provider.ts` 的单轮零或一个版本、正文成功后方可读取版本内案例的合同。未增加 DSH API、Tool、脚本或网络能力。

场景、名称和来源候选的一一对应见 [catalog.json](catalog.json)。
