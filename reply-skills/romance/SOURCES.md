# 92 项恋爱回复 Skill 的来源对照

Skill 正文只放方法与已有示例；仓库、文件、行号及核对记录统一保存在本文与 [provenance.json](provenance.json)。

## 整理口径

- 本版本撤回旧版自行编写的 184 则案例。方法与单列示例全部从下列固定原文件连续行段提取，不新增人物、背景、意图、反例或后续对话。
- `translations.json` 为完整英文摘录登记中文译文；每条译文绑定原来源行号与摘要，生成 Skill 与案例时仅在对应摘录位置显示中文。翻译层不改动锁定源快照，也不增加方法或示例。
- 原作者模板、话术片段、假设场景和教学对话按实际类型保留，不宣称是真实事件或效果证据。
- 直接依据表示原文明确讨论此类问题；共用方法表示只找到相关通用方法，不能称为原文的专门细分策略。没有相符示例时留空，不凑两例。
- 英文摘录以 `translations.json` 的中文译文显示；未翻译的源摘录仍保持原文。出处始终按锁定的英文来源行号与摘要校验，翻译层不改变原引用。其余编排只增加目录名称、章节和按需读取提示，并去除行尾空白及片段首尾空行。原文中的跨资料提示不产生额外运行权限。
- 盘点编号仅用于追溯 92 项的拆分历史，不能替代以下源文件行号。引用的源文件 JSON 快照在 [romance-sources](../romance-sources/README.md)，保存完整原文字节并核对 Git blob SHA 与 SHA-256。
- 运行规则仍以用户当前意愿与产品既有边界为准；保留原文不等于已验证其关系判断、时长建议或效果主张。

## 固定来源及许可

- D：[Mayuqi-crypto/HowToGetAlongWithGirls](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/tree/af0897f4b55897624a19de48374d436906e26461)，固定提交 af0897f4b55897624a19de48374d436906e26461。[README 许可声明](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/README.md#L84-L86)明确 MIT，[复制使用说明](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/README.md#L62)允许复制技能目录并按需调整；无单独 LICENSE 文件。
- E：[merchantmoh-debug/EROS-AI-Dating-Repository](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/tree/0753f76f6683e5094456fb5c6342391c7de1b2f7)，固定提交 0753f76f6683e5094456fb5c6342391c7de1b2f7。[MIT 许可](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/LICENSE)。
- G：[shengjidaguai-china/goutoujunshi](https://github.com/shengjidaguai-china/goutoujunshi/tree/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f)，固定提交 6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f。[MIT 许可](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/LICENSE)。
- C：[Mowon0303/LoveHelper.skill](https://github.com/Mowon0303/LoveHelper.skill/tree/1e391e26fd1c1bfee06e4daa9b439086a098a49b)，固定提交 1e391e26fd1c1bfee06e4daa9b439086a098a49b。[MIT 许可](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/LICENSE)。
- T：[hotcoffeeshake/tong-jincheng-skill](https://github.com/hotcoffeeshake/tong-jincheng-skill/tree/c9caaa9a6576f581c29d016c60bbe935908e20d5)，固定提交 c9caaa9a6576f581c29d016c60bbe935908e20d5。[MIT 许可](https://github.com/hotcoffeeshake/tong-jincheng-skill/blob/c9caaa9a6576f581c29d016c60bbe935908e20d5/LICENSE)。

## 共用证据边界

[G L44–46](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/SKILL.md#L44-L46)：冲突指出矛盾、缺失保持未知，不为完整而虚构；必要时才追问。该原句可在各包中重复使用。

## 逐项对照

| 编号 | 场景 | 方法支持 | 方法出处 | 单列示例出处 |
| --- | --- | --- | --- | --- |
| 001 | 初次开聊：承接共同经历或已知兴趣 | 直接依据 | [E L111–116](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L111-L116)、[G L22–33](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%9C%BA%E6%99%AF%E6%84%9F%E3%80%81%E6%9D%BE%E5%BC%9B%E6%84%9F%E4%B8%8E%E7%A4%BE%E4%BA%A4%E6%A0%A1%E5%87%86%EF%BC%9A%E4%BB%8E%E6%8E%A5%E8%AF%9D%E5%88%B0%E5%85%B3%E7%B3%BB%E6%8E%A8%E8%BF%9B.md#L22-L33) | [E L7–40](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/examples/conversation-examples.md#L7-L40) |
| 002 | 对方慢热谨慎时的轻量破冰 | 共用方法 | [C L66–70](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L66-L70) | 未单列，不补写 |
| 003 | 很久没联系后的重新搭话 | 直接依据 | [G L32–37](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E8%81%8A%E5%A4%A9%E5%8C%96%E8%A2%AB%E5%8A%A8%E4%B8%BA%E4%B8%BB%E5%8A%A8%EF%BC%9A%E5%BC%95%E5%AF%BC%E4%BA%92%E5%8A%A8%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L32-L37)、[G L62–68](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E8%81%8A%E5%A4%A9%E5%8C%96%E8%A2%AB%E5%8A%A8%E4%B8%BA%E4%B8%BB%E5%8A%A8%EF%BC%9A%E5%BC%95%E5%AF%BC%E4%BA%92%E5%8A%A8%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L62-L68) | [G L66–68](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E8%81%8A%E5%A4%A9%E5%8C%96%E8%A2%AB%E5%8A%A8%E4%B8%BA%E4%B8%BB%E5%8A%A8%EF%BC%9A%E5%BC%95%E5%AF%BC%E4%BA%92%E5%8A%A8%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L66-L68) |
| 004 | 例行问候聊成流水账后的重启 | 共用方法 | [D L36–37](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/knowledge-base.md#L36-L37) | 未单列，不补写 |
| 005 | 回应“怎么突然找我” | 直接依据 | [G L17–29](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L17-L29)、[G L49–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L49-L53) | [G L103–115](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L103-L115) |
| 006 | 延展对方已经抛出的话题 | 直接依据 | [G L33–49](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%B7%A7%E5%A6%99%E6%8E%A5%E8%AF%9D%E6%8A%80%E5%B7%A7%EF%BC%9A%E8%AE%A9%E6%B2%9F%E9%80%9A%E6%9B%B4%E6%B5%81%E7%95%85%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L33-L49) | [G L39–42](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%B7%A7%E5%A6%99%E6%8E%A5%E8%AF%9D%E6%8A%80%E5%B7%A7%EF%BC%9A%E8%AE%A9%E6%B2%9F%E9%80%9A%E6%9B%B4%E6%B5%81%E7%95%85%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L39-L42) |
| 007 | 对方只回“哈哈”、表情或短词 | 直接依据 | [E L114–129](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L114-L129) | [G L87–101](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L87-L101)、[E L44–89](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/examples/conversation-examples.md#L44-L89) |
| 008 | 连续查户口后改成双向分享 | 直接依据 | [C L205–213](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L205-L213) | [C L215–225](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L215-L225) |
| 009 | 对方愿意回但不主动找话题 | 直接依据 | [C L84–94](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L84-L94) | [C L96–101](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L96-L101) |
| 010 | 正在聊天但需要先结束 | 共用方法 | [G L17–29](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L17-L29)、[G L49–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L49-L53) | [G L87–101](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L87-L101) |
| 011 | 原话题聊完或单次冷场后的转场 | 直接依据 | [G L31–36](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L31-L36) | [G L37–38](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L37-L38) |
| 012 | 分享自己的真实经历和生活状态 | 直接依据 | [C L205–213](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L205-L213) | [C L221–225](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L221-L225) |
| 013 | 回应前任、恋爱史等问题 | 直接依据 | [D L331–332](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/signal-patterns.md#L331-L332) | [D L339–341](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/signal-patterns.md#L339-L341) |
| 014 | 回应择偶标准、感情观等问题 | 直接依据 | [D L331–332](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/signal-patterns.md#L331-L332) | [D L339–342](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/signal-patterns.md#L339-L342) |
| 015 | 被问暂时不想说的私人问题 | 共用方法 | [G L81–84](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L81-L84) | [G L82–84](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L82-L84) |
| 016 | 接住对方的玩笑、调侃和轻挑战 | 直接依据 | [E L168–184](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L168-L184) | [E L176–182](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L176-L182) |
| 017 | 回应“你对谁都这样吗”的真诚质疑 | 直接依据 | [E L361–370](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L361-L370) | [G L177–189](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L177-L189)、[E L363–370](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L363-L370) |
| 018 | 基于真实细节夸奖对方 | 直接依据 | [G L23–32](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%87%E8%83%BD%E5%A4%B8%E4%BA%BA%E7%9A%84%E8%AF%9D%E6%9C%AF%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%9C%9F%E8%AF%9A%E8%AE%A4%E5%8F%AF%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L23-L32) | [G L79–81](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%87%E8%83%BD%E5%A4%B8%E4%BA%BA%E7%9A%84%E8%AF%9D%E6%9C%AF%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%9C%9F%E8%AF%9A%E8%AE%A4%E5%8F%AF%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L79-L81) |
| 019 | 轻度暧昧试探与接招 | 直接依据 | [G L41–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L41-L53) | [G L191–205](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L191-L205) |
| 020 | 轻松表达“想你了” | 直接依据 | [G L49–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L49-L53) | [G L163–175](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L163-L175) |
| 021 | 从朋友式相处表达不同的好感 | 直接依据 | [C L109–117](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L109-L117) | [C L119–129](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L119-L129) |
| 022 | 从游戏搭子转成想和对方相处 | 直接依据 | [C L165–173](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L165-L173) | [C L175–203](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L175-L203) |
| 023 | 表露好感后的接话与收住 | 直接依据 | [C L255–269](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L255-L269) | [C L277–299](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L277-L299) |
| 024 | 暧昧过头、让对方不舒服后的收回 | 共用方法 | [G L77–85](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%9C%BA%E6%99%AF%E6%84%9F%E3%80%81%E6%9D%BE%E5%BC%9B%E6%84%9F%E4%B8%8E%E7%A4%BE%E4%BA%A4%E6%A0%A1%E5%87%86%EF%BC%9A%E4%BB%8E%E6%8E%A5%E8%AF%9D%E5%88%B0%E5%85%B3%E7%B3%BB%E6%8E%A8%E8%BF%9B.md#L77-L85) | 未单列，不补写 |
| 025 | 试探对方是否愿意见面 | 直接依据 | [E L155–163](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L155-L163) | [E L157–185](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L157-L185) |
| 026 | 把“有空约”落实为具体安排 | 直接依据 | [G L21–28](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BB%E5%8A%A8%E8%A1%A8%E8%BE%BE%E3%80%81%E7%AC%AC%E4%B8%80%E6%AC%A1%E8%A7%81%E9%9D%A2%E4%B8%8E%E8%87%AA%E7%84%B6%E6%8E%A5%E8%A7%A6.md#L21-L28)、[G L117–131](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L117-L131) | [G L119–131](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L119-L131) |
| 027 | 通话或视频聊天的邀约 | 直接依据 | [E L147–149](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L147-L149) | [E L150–152](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L150-L152) |
| 028 | 邀约只得到“下次吧”“再看看” | 直接依据 | [E L196–207](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L196-L207)、[G L49–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L49-L53) | [G L133–145](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L133-L145) |
| 029 | 有见面意愿但时间冲突的协调 | 直接依据 | [E L196–207](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L196-L207)、[G L117–131](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L117-L131) | [E L201–202](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L201-L202) |
| 030 | 已经约好却临时取消或改期 | 直接依据 | [G L147–161](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L147-L161) | [G L149–161](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L149-L161) |
| 031 | 见面前再次确认必要细节 | 共用方法 | [G L40–43](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BB%E5%8A%A8%E8%A1%A8%E8%BE%BE%E3%80%81%E7%AC%AC%E4%B8%80%E6%AC%A1%E8%A7%81%E9%9D%A2%E4%B8%8E%E8%87%AA%E7%84%B6%E6%8E%A5%E8%A7%A6.md#L40-L43) | 未单列，不补写 |
| 032 | 约会临时增加朋友或同行者 | 直接依据 | [D L244–258](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L244-L258)、[D L288–300](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L288-L300) | [D L247–253](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L247-L253)、[D L288–295](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L288-L295) |
| 033 | 见面时冷场或接不上话 | 直接依据 | [D L151–179](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L151-L179)、[D L183–215](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L183-L215) | [D L167–169](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L167-L169)、[D L188–193](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L188-L193)、[D L203–210](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L203-L210) |
| 034 | 见面时说错话、出糗或尴尬的化解 | 共用方法 | [G L23–30](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L23-L30) | [G L28–30](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L28-L30) |
| 035 | 见面结束后的第一条跟进 | 直接依据 | [E L200–201](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/date-planning.md#L200-L201) | [E L167–174](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/examples/conversation-examples.md#L167-L174) |
| 036 | 承接上次体验提出再次见面 | 直接依据 | [E L203–204](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/date-planning.md#L203-L204) | [E L176–183](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/examples/conversation-examples.md#L176-L183) |
| 037 | 约会不合拍时结束当次见面 | 直接依据 | [E L155–161](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L155-L161)、[E L166–172](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L166-L172) | 未单列，不补写 |
| 038 | 一条消息迟迟没有回复 | 直接依据 | [D L30–37](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/signal-patterns.md#L30-L37) | [D L32–35](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/signal-patterns.md#L32-L35) |
| 039 | 多轮互动逐渐变冷 | 直接依据 | [E L90–107](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L90-L107) | [E L99–107](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L99-L107) |
| 040 | 对方忽冷忽热时稳定交流 | 直接依据 | [C L233–247](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L233-L247) | [C L249–253](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L249-L253) |
| 041 | 对方说忙、困或想休息时收住 | 直接依据 | [C L23–28](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L23-L28) | [C L249–253](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L249-L253) |
| 042 | 自己连发追问、解释过多后的降压 | 直接依据 | [C L23–28](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L23-L28) | 未单列，不补写 |
| 043 | 对方主要在需要帮助时才联系 | 直接依据 | [C L141–157](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L141-L157) | 未单列，不补写 |
| 044 | 长时间倾诉陪聊却没有双向相处 | 直接依据 | [C L137–157](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L137-L157) | [C L159–163](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L159-L163) |
| 045 | 回应“达到某条件才考虑在一起” | 直接依据 | [C L308–315](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L308-L315) | [C L323–327](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L323-L327) |
| 046 | 说有好感却持续回避见面等矛盾信息 | 共用方法 | [C L23–28](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L23-L28) | [E L123–128](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L123-L128) |
| 047 | 对方难过或受委屈时回应 | 直接依据 | [G L23–31](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L23-L31) | [G L48–54](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L48-L54) |
| 048 | 对方焦虑、纠结或担忧未来时回应 | 直接依据 | [G L38–41](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L38-L41) | [G L55–61](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L55-L61) |
| 049 | 对方生气、抱怨别人或某件事时回应 | 直接依据 | [G L38–41](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L38-L41) | [G L69–75](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L69-L75) |
| 050 | 对方分享好消息或成果时捧场 | 直接依据 | [G L32–37](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L32-L37) | [G L62–68](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L62-L68) |
| 051 | 对方身体不适或疲惫时关心 | 共用方法 | [G L15–17](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L15-L17)、[G L42–46](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L42-L46) | [G L15–15](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md#L15-L15) |
| 052 | 感谢对方为自己做的具体事情 | 直接依据 | [E L438–445](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L438-L445)、[G L23–38](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%87%E8%83%BD%E5%A4%B8%E4%BA%BA%E7%9A%84%E8%AF%9D%E6%9C%AF%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%9C%9F%E8%AF%9A%E8%AE%A4%E5%8F%AF%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L23-L38) | [G L44–45](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%87%E8%83%BD%E5%A4%B8%E4%BA%BA%E7%9A%84%E8%AF%9D%E6%9C%AF%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%9C%9F%E8%AF%9A%E8%AE%A4%E5%8F%AF%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md#L44-L45) |
| 053 | 稳定关系中疏远后的重新亲近 | 直接依据 | [E L414–432](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/relationship-phases.md#L414-L432) | [E L453–457](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L453-L457) |
| 054 | 情侣之间提出或回应具体求助 | 共用方法 | [G L14–21](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E6%89%98%E4%BA%BA%E5%8A%9E%E4%BA%8B%E7%9A%84%E9%AB%98%E6%95%88%E8%AF%9D%E6%9C%AF%E6%8C%87%E5%8D%97.md#L14-L21)、[G L29–45](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E6%89%98%E4%BA%BA%E5%8A%9E%E4%BA%8B%E7%9A%84%E9%AB%98%E6%95%88%E8%AF%9D%E6%9C%AF%E6%8C%87%E5%8D%97.md#L29-L45) | [G L37–45](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E6%89%98%E4%BA%BA%E5%8A%9E%E4%BA%8B%E7%9A%84%E9%AB%98%E6%95%88%E8%AF%9D%E6%9C%AF%E6%8C%87%E5%8D%97.md#L37-L45) |
| 055 | 忙事业或学习时说明陪伴安排 | 直接依据 | [T L91–101](https://github.com/hotcoffeeshake/tong-jincheng-skill/blob/c9caaa9a6576f581c29d016c60bbe935908e20d5/README.md#L91-L101) | [T L88–104](https://github.com/hotcoffeeshake/tong-jincheng-skill/blob/c9caaa9a6576f581c29d016c60bbe935908e20d5/README.md#L88-L104) |
| 056 | 正式表白与回应表白 | 直接依据 | [G L21–28](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BB%E5%8A%A8%E8%A1%A8%E8%BE%BE%E3%80%81%E7%AC%AC%E4%B8%80%E6%AC%A1%E8%A7%81%E9%9D%A2%E4%B8%8E%E8%87%AA%E7%84%B6%E6%8E%A5%E8%A7%A6.md#L21-L28)、[D L37–53](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L37-L53) | [G L25–26](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%BB%E5%8A%A8%E8%A1%A8%E8%BE%BE%E3%80%81%E7%AC%AC%E4%B8%80%E6%AC%A1%E8%A7%81%E9%9D%A2%E4%B8%8E%E8%87%AA%E7%84%B6%E6%8E%A5%E8%A7%A6.md#L25-L26)、[D L39–47](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L39-L47) |
| 057 | 过早表白后的沟通补救 | 直接依据 | [D L106–131](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L106-L131) | [D L120–126](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L120-L126) |
| 058 | 暧昧已久时问清彼此的关系意愿 | 直接依据 | [G L45–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/06-%E5%90%B8%E5%BC%95%E7%BA%A6%E4%BC%9A%E4%B8%8E%E5%85%B3%E7%B3%BB%E5%90%AF%E5%8A%A8.md#L45-L53)、[C L23–28](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L23-L28) | [G L207–212](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md#L207-L212) |
| 059 | 明确排他性、称谓和承诺范围 | 直接依据 | [G L47–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/06-%E5%90%B8%E5%BC%95%E7%BA%A6%E4%BC%9A%E4%B8%8E%E5%85%B3%E7%B3%BB%E5%90%AF%E5%8A%A8.md#L47-L53)、[E L342–353](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/relationship-phases.md#L342-L353) | [E L346–353](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/relationship-phases.md#L346-L353) |
| 060 | 商量联系频率和消息回应期待 | 直接依据 | [G L31–42](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/03-%E4%BE%9D%E6%81%8B%E7%90%86%E8%AE%BA%E4%B8%8E%E6%83%85%E7%BB%AA%E8%B0%83%E8%8A%82.md#L31-L42)、[G L47–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/06-%E5%90%B8%E5%BC%95%E7%BA%A6%E4%BC%9A%E4%B8%8E%E5%85%B3%E7%B3%BB%E5%90%AF%E5%8A%A8.md#L47-L53) | [G L31–35](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/03-%E4%BE%9D%E6%81%8B%E7%90%86%E8%AE%BA%E4%B8%8E%E6%83%85%E7%BB%AA%E8%B0%83%E8%8A%82.md#L31-L35) |
| 061 | 表达独处、朋友或个人生活的空间需要 | 直接依据 | [G L44–49](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/03-%E4%BE%9D%E6%81%8B%E7%90%86%E8%AE%BA%E4%B8%8E%E6%83%85%E7%BB%AA%E8%B0%83%E8%8A%82.md#L44-L49)、[E L414–432](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/relationship-phases.md#L414-L432) | 未单列，不补写 |
| 062 | 身体亲密前后表达、确认和撤回同意 | 直接依据 | [G L5–20](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/08-%E5%90%8C%E6%84%8F%E8%BE%B9%E7%95%8C%E6%80%A7%E4%B8%8E%E4%BA%B2%E5%AF%86.md#L5-L20) | [G L17–20](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/08-%E5%90%8C%E6%84%8F%E8%BE%B9%E7%95%8C%E6%80%A7%E4%B8%8E%E4%BA%B2%E5%AF%86.md#L17-L20) |
| 063 | 关系公开和合照发布的边界 | 直接依据 | [G L61–68](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/09-%E5%9C%A8%E7%BA%BF%E7%BA%A6%E4%BC%9A%E4%B8%8E%E6%95%B0%E5%AD%97%E5%85%B3%E7%B3%BB.md#L61-L68) | [G L24–30](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L24-L30) |
| 064 | 手机、密码、定位和查岗的边界 | 直接依据 | [G L63–71](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/09-%E5%9C%A8%E7%BA%BF%E7%BA%A6%E4%BC%9A%E4%B8%8E%E6%95%B0%E5%AD%97%E5%85%B3%E7%B3%BB.md#L63-L71) | [G L24–30](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L24-L30) |
| 065 | 吃醋或对异性交往不安时的沟通 | 共用方法 | [G L63–71](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/09-%E5%9C%A8%E7%BA%BF%E7%BA%A6%E4%BC%9A%E4%B8%8E%E6%95%B0%E5%AD%97%E5%85%B3%E7%B3%BB.md#L63-L71)、[E L393–405](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L393-L405) | [G L24–30](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L24-L30) |
| 066 | 表达不满与回应对方的不满 | 直接依据 | [G L23–51](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L23-L51) | [G L31–38](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%87%E8%83%BD%E5%90%B5%E6%9E%B6%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%90%86%E6%80%A7%E5%86%B2%E7%AA%81%E5%A4%84%E7%90%86%E6%8C%87%E5%8D%97.md#L31-L38) |
| 067 | 前后说法矛盾时问清一个关键事实 | 直接依据 | [G L36–45](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/09-%E5%9C%A8%E7%BA%BF%E7%BA%A6%E4%BC%9A%E4%B8%8E%E6%95%B0%E5%AD%97%E5%85%B3%E7%B3%BB.md#L36-L45)、[C L28–28](https://github.com/Mowon0303/LoveHelper.skill/blob/1e391e26fd1c1bfee06e4daa9b439086a098a49b/relationship-copilot/references/human-progression-playbook.md#L28-L28) | [G L7–14](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L7-L14) |
| 068 | 文字或语气被误解后的澄清 | 直接依据 | [G L28–32](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/09-%E5%9C%A8%E7%BA%BF%E7%BA%A6%E4%BC%9A%E4%B8%8E%E6%95%B0%E5%AD%97%E5%85%B3%E7%B3%BB.md#L28-L32)、[E L203–206](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L203-L206) | [E L207–207](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/conversation-mastery.md#L207-L207) |
| 069 | 失言伤到对方后的道歉 | 直接依据 | [G L74–84](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L74-L84) | [G L48–48](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E4%B8%87%E8%83%BD%E5%90%B5%E6%9E%B6%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%90%86%E6%80%A7%E5%86%B2%E7%AA%81%E5%A4%84%E7%90%86%E6%8C%87%E5%8D%97.md#L48-L48) |
| 070 | 失约或失信后的具体补救 | 共用方法 | [G L76–84](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L76-L84) | [G L75–83](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L75-L83) |
| 071 | 争执升温时暂停并约好恢复沟通 | 直接依据 | [G L53–64](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L53-L64) | [G L62–62](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L62-L62) |
| 072 | 冷战后重新开启对话 | 共用方法 | [G L66–72](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L66-L72) | [E L453–457](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/SKILL.md#L453-L457) |
| 073 | 同一矛盾反复出现时协商可试行办法 | 直接依据 | [G L41–51](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L41-L51) | [G L43–45](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md#L43-L45)、[G L44–51](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L44-L51) |
| 074 | 对方说“不合适”“不想恋爱”时回应 | 直接依据 | [D L335–338](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L335-L338)、[D L385–387](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L385-L387) | [D L327–330](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L327-L330)、[D L374–374](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L374-L374) |
| 075 | 自己不想继续发展时说清楚 | 直接依据 | [E L157–162](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L157-L162) | [E L163–164](https://github.com/merchantmoh-debug/EROS-AI-Dating-Repository/blob/0753f76f6683e5094456fb5c6342391c7de1b2f7/docs/crisis-management.md#L163-L164) |
| 076 | 被拒后仍需同学、同事式往来 | 直接依据 | [D L49–62](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L49-L62)、[D L66–72](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L66-L72) | [D L73–85](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L73-L85)、[D L462–465](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L462-L465) |
| 077 | 聚会遇到对方新伴侣时的回应 | 直接依据 | [D L408–411](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L408-L411)、[D L424–427](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L424-L427)、[D L431–435](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/realistic-scenarios.md#L431-L435) | 未单列，不补写 |
| 078 | 表达分手决定或回应分手 | 直接依据 | [G L7–11](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L7-L11)、[G L13–18](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L13-L18) | [G L12–12](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L12-L12) |
| 079 | 分手后的物品和必要事务交接 | 直接依据 | [G L11–18](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L11-L18) | [G L104–111](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L104-L111) |
| 080 | 明确想尝试复联时写第一条消息 | 直接依据 | [G L33–43](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L33-L43)、[G L71–71](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/practical/%E5%85%B3%E7%B3%BB%E6%8A%95%E5%85%A5%E5%A4%B1%E8%A1%A1%EF%BC%9A%E4%BA%92%E6%83%A0%E5%88%A4%E6%96%AD%E3%80%81%E9%99%8D%E7%BA%A7%E6%8A%95%E5%85%A5%E4%B8%8E%E9%80%80%E5%87%BA%E5%86%B3%E7%AD%96.md#L71-L71) | 未单列，不补写 |
| 081 | 发现背叛后问清与沟通有关的事实 | 直接依据 | [G L45–64](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L45-L64)、[G L5–16](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L5-L16) | 未单列，不补写 |
| 082 | 明确选择尝试修复后谈条件和具体行动 | 直接依据 | [G L62–72](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md#L62-L72) | [G L75–83](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L75-L83) |
| 083 | 见家长前商量意愿、分寸和安排 | 共用方法 | [D L85–90](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/lifecycle.md#L85-L90)、[G L21–26](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L21-L26) | 未单列，不补写 |
| 084 | 谈是否结婚以及时间期待 | 共用方法 | [D L85–90](https://github.com/Mayuqi-crypto/HowToGetAlongWithGirls/blob/af0897f4b55897624a19de48374d436906e26461/.claude/skills/dating-coach/references/lifecycle.md#L85-L90)、[G L15–26](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L15-L26) | [G L85–96](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L85-L96) |
| 085 | 谈生育意愿和未来责任预期 | 直接依据 | [G L34–38](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L34-L38)、[G L52–64](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L52-L64) | [G L85–96](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L85-L96) |
| 086 | 谈居住城市和未来生活安排 | 直接依据 | [G L22–26](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L22-L26) | [G L88–88](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L88-L88) |
| 087 | 谈共同开支和金钱边界 | 直接依据 | [G L9–16](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L9-L16)、[G L28–28](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L28-L28) | [G L18–26](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L18-L26) |
| 088 | 谈日常家务和照护分工 | 直接依据 | [G L30–39](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L30-L39)、[G L45–50](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L45-L50) | [G L43–43](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L43-L43) |
| 089 | 育儿或照护变化后重新商量分工 | 共用方法 | [G L34–46](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L34-L46)、[G L41–50](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L41-L50)、[G L52–64](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L52-L64) | [G L44–51](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L44-L51) |
| 090 | 双方父母介入、探访和责任边界 | 直接依据 | [G L65–75](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md#L65-L75)、[G L52–59](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L52-L59) | [G L91–91](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L91-L91) |
| 091 | 重组家庭中前伴侣、孩子的往来边界 | 直接依据 | [G L45–53](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/16-%E5%A4%9A%E5%85%83%E5%85%B3%E7%B3%BB%E4%B8%8E%E5%8F%8D%E5%88%BB%E6%9D%BF%E5%8D%B0%E8%B1%A1.md#L45-L53) | 未单列，不补写 |
| 092 | 提出并安排一次关系近况沟通 | 直接依据 | [G L61–66](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md#L61-L66) | [G L44–51](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L44-L51)、[G L98–102](https://github.com/shengjidaguai-china/goutoujunshi/blob/6c32b8dbe28268e26d6cd0bb7de1e28ff5dd203f/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md#L98-L102) |

## 对照备注

以下是整理者的适用性记录，不进入 Skill 的方法正文。

- 001：E 的观察—发挥—邀请和 G 的现场取材都直接对应从已知细节开聊。
- 002：只保留轻量自我线索、低风险动机和轻问题的方法；不据慢热断言对方在防御或观察。源文示例把该判断写入话术，本项不选该例；这是可借用的轻量开聊方法，未单列不预设动机的慢热场景。
- 003：G29 对很久没见的熟人给出共同回忆接到当前兴趣的场景。
- 004：D12 的平淡期推进方案含刻意降频和推拉，本项改用 D 聊天总则中交替分享与提问的通用节奏；可围绕用户已提供的真实细节换话题，源文未单列流水账重启案例，也不填具体经历。
- 005：G01 有该质疑的三种原文回复，并提供本轮目标与积极、含糊、拒绝后的通用分支。
- 006：G07 直接讲关键词延伸、选择细节并以提问或分享承接，附有完整示例。
- 007：E05 区分能量变化及不追发的处理；G01 有针对只回哈哈或表情的收束话术。
- 008：C14 直接提出接对方一句、补自己的经历或态度、再留轻问题，并给了采访式与分享式对照。
- 009：C10 原文直接讨论愿意聊但不主动的情况，并提供接住对方可调侃点的例句。
- 010：源文未单列正常聊天中的主动结束，只能借用 G 的收线策略及短回复、低能量时结束当轮的示例。
- 011：G25 直接处理话题断层，方法是从刚聊过的关键词找关联角度，再用提问或分享转场。
- 012：C14 直接覆盖用自己的经历、偏好和态度形成双向聊天；仅抽取源文分享示例，不补用户背景。
- 013：仅选“真诚但别交底、展示原则而非细节”的应对方法，避开对提问动机的推断。表格例句是原作者模板，不代表用户经历；只在“性格不合、和平分手”符合真实情况时才能使用。
- 014：仅选真诚表达原则的通用方法，不推断提问动机。表格中的择偶观回答是原作者模板，不代表用户价值观；只有符合用户真实想法时才能采用。
- 015：G26 的隐私问题示例来自被问工资的通用场景，不是恋爱对象提问；可借用回避具体隐私并转话题的方法，源文未给恋爱场景案例。
- 016：E 的 Art of Banter 直接列出玩笑挑战、callback、角色反转、夸张升级和自嘲，并附尊重边界的护栏；只选原表例句，不把示例细节当作用户事实。
- 017：E05/G01 明确覆盖“你对谁都这样吗”的真诚质疑；例句引用原文，不额外证明用户真诚。
- 018：G09 给出从具体行为提炼优点并说明带来感受的步骤；示例是新认识者聊天细节，不涉及外貌或未给出的个人事实。
- 019：G08/C05 的 G01 原文直接设有“把玩笑转成一点暧昧”场景；例句后附否认或转移时回到轻话题的分支，与普通接梗区分。
- 020：G10 有轻松表达想念的稳健、会撩和直接原文；方法只补充通用后续反馈分支。
- 021：C11 直接要求在已有温度时表达非普通朋友方向的兴趣并避免对抗拒者硬推；示例保留原作者的性别化措辞，主Agent需注意适用边界。
- 022：C13 有专门的游戏搭子/缺人位辨识、承认真实借口并点明想相处后收住的方法，以及积极、拒绝和不接分支。
- 023：C16/C04 在表达或轻推进之后强调收住，并分别给继续调侃与不接时的原文接法；没有补入额外情绪事实。
- 024：源文未单列调情过头后的修复或道歉话术；只选基于反馈降低张力、对不适信号立即停止的通用校准方法，作为shared_method，不提供原例。
- 025：E08 直接覆盖有兴趣、聊了一段时间及共同细节等不同邀约入口；保留原文模板，不据此推断对方意愿。
- 026：G11/C07 对应具体活动、时间与反馈后细化安排；含糊忙碌且无新信息时不连环追问。
- 027：E08 有直接的视频通话桥接说明和建议短时通话的原文句子。
- 028：G11/E10 明确区分只说忙与给替代时间，并分别示范不追问和等待具体安排。
- 029：G11/E08 原文有时间冲突但提供替代时间的情形，建议接住替代窗口并细化，而非把冲突误作拒绝。
- 030：G11 有稳健、轻调侃和明确交还新时间的原文，并提醒紧急状况先关心安全与实际困难。
- 031：D15 也只谈约会地点、流程和结束时铺垫下次，没有见面前复核时间地点的原文话术；G12 仅提供公开场所、时间及活动安排原则，故维持 shared_method。
- 032：D直接讨论约会时对方带朋友，提供接纳同行者的当场回应和提出下次单独见面的原话；没有带入周围文本中的动机推断或三七分配注意力。
- 033：D直接覆盖约会冷场：先用活动转场、降低对话密度，仍无法改善时体面结束；选段包含原场景与退出示例。
- 034：原文提供自嘲承认失误的方法和说错话示例，但例子是通用社交情形，没有恋爱专属话术。
- 035：E分别给出约会结束当晚的首次跟进和次日再次邀约；本项只选当晚、两小时内的原文模板。
- 036：只选次日承接具体共同话题、提出第二次见面的原文模板，不把一次见面解释为双方已承诺继续发展。
- 037：E明确区分普通不合拍与不安全：普通约会不匆忙离开，按原约定时长结束；不安全时可立即离开。原文给出的具体消息是约会后的拒绝继续发展，不能当成结束当次见面的台词，所以本项不单列示例。
- 038：D明确区分一次回复慢和持续趋势，单次延迟可能是忙；没有找到针对一条未回消息的原始跟进话术，不借用长期无回复后的ghosting模板。
- 039：E单列slow fade，包含回复变慢、变短、停止提问和计划推迟等多轮信号，并给澄清或停止过度投入的选项；不选邻近表格的动机推断。
- 040：C直接讨论对方冷热变化时保持自身节奏，并保留原文“示例话术”标签及完整代码围栏；不将冷热互动统一归因为依恋类型。
- 041：C直接把对方忙、累、冷或用户解释过多列为收住的信号，并提供先忙、晚些再续话题的原句；没有更细的休息场景分支。
- 042：C明确把用户已补充过多解释列为降压信号，要求停止追加并留出空间；未找到专门针对连发后的完整原始对话案例。
- 043：C直接列出对方只在无聊、难受或需要帮助时联系的陪聊信号及停止无限供给的方法；不能仅凭一次求助判断关系位置。
- 044：C直接讨论持续陪聊与单向支持，并有夜间倾诉的具体表达；原文没有描述双方轮流分享的案例。
- 045：C直接处理以达到条件交换关系的条件式认可；只选原文的判断与拒绝表达，不扩写对方动机。
- 046：C和E提供信息矛盾时只问一个关键点的通用澄清方法；不支持从取消或回避直接推断喜欢程度、承诺意愿或动机。
- 047：G直接提供负面情绪的倾听、确认和留白步骤，并以工作受挫及考试失利作原例；不添加对方未提供的原因。
- 048：G直接讲焦虑拆分与具体担忧，并给毕业选择、述职压力的原例；不替对方决定职业选择。
- 049：G有同事推活及家人催婚的抱怨原例，方法要求先接情绪而不跟着攻击第三人；不判断第三人的动机。
- 050：G明确要求对成果作具体、关联过程的积极回应，并提供考三次拿驾照与养花开花的原例。
- 051：G提供一般疲惫时的共情和日常关怀。D仅有一句生病话题提示，未提供具体步骤或原例；不补医学建议或具体送药安排。
- 052：E提供关系中的具体感谢模板，G提供行为—特质—实际价值的原例及伴侣记得饮食偏好的表达；不添加未确认的帮助效果。
- 053：E有长期关系保持共同体验与个人性的建议，以及疏远后表达想念并安排相处时间的模板。
- 054：G给出具体说明事项、时限、任务并允许拒绝的通用求助方法，例子来自熟人和工作情境；没有情侣求助的专门方法或案例。
- 055：T04确有事业初期与伴侣时间冲突的原对话；原文是男性对女性的视角，并要求给出时间与承诺但未说明怎样落成具体日程，不能擅自补安排。
- 056：G提供表达好感且不索取即时承诺的方法；D提供表白被拒时的当场回应原话。没有找到接受表白的正向回应示例。
- 057：D直接覆盖关系尚未建立就过早表白后的当场回应：承认着急、降低压力并转开话题；没有选入之后的价值展示或概率判断。
- 058：G明确把排他性、称谓、联系节奏和期待列为关系定义议题；C只问一个关键事实，G另有直接询问关系想法的原句。
- 059：E原句是说明自己的排他立场，不表示对方已同意；这里只取定义协议的范围，不引入其里程碑时间作为规定。
- 060：G支持把联系焦虑转换为具体、有限的请求，并将联系节奏列入关系期待；未规定每天必须联系或即时回复。
- 061：G直接说明需要空间时可协商独处并保持最低连接，E提出长期关系中保留彼此生活与共同体验；未找到具体朋友安排或查阅聊天记录的对话原例。
- 062：G明确说明同意按具体行为区分、持续有效且可撤回，并给出确认和停止表达；不把此前亲密、沉默或关系身份当成同意。
- 063：源候选：G43。原文直接列出关系公开与发布照片前询问；无具体对话示例，练习卡仅提供绿黄红边界分类模板。
- 064：源候选：G43。原文明列手机、密码、定位与线上互动边界，并区分自愿协商和数字控制；没有具体对话示例。
- 065：源候选：E13、G43。原文覆盖线上互动边界、数字监控和过度嫉妒风险，但未单列吃醋对话流程；所选练习是通用边界分类模板。
- 066：源候选：D19、G22。所选 G22 原文提供倾听拆解、我句式、单一问题与共情回应；D19仅作候选且未引用。
- 067：源候选：C08、G03、G19。原文练习区分可观察事实、解释和待确认问题，C08明确建议信息矛盾时只问一个关键问题；未引用其他候选段。
- 068：源候选：E16、G22。E16给出误解时直接轻量澄清的模板，G原文说明文字沟通的语气局限及复杂分歧的媒介选择。
- 069：源候选：E16、G23。G23直接说明承认行为与影响、表达遗憾、询问修补且不强求原谅，并含说错话后的即时纠正原句；未选 E16 的通用尴尬场景。
- 070：源候选：G23。原文只提供通用道歉与修复清单，能借用承担影响、提出修补和检查改变的方法；没有失约/失信专属流程或原作者案例。
- 071：源候选：G22。原文列出暂停的返回时间、降唤醒和按约返回要素，并给出完整暂停原句。
- 072：源候选：E16、E17。原文分别讨论追退循环和疏远后的重新连接，但没有专门针对冷战结束的流程；所选句式只是一般疏远后的联系模板。
- 073：源候选：G22、G34。原文说明共同定义问题、各提方案、低成本试行并约定复盘；关系会议模板可承接重复议题。
- 074：源候选：D27、G24。D场景直接覆盖“不合适”和“不想恋爱”；仅选不追问、不施压的原文处理与原句，未选判断拒绝真假的内容；G24方向相反。
- 075：源候选：E23。原文直接提供约会后坦诚表达没有浪漫感觉的处理原则与原句。
- 076：源候选：D23。D原文直接覆盖被拒后仍需在同事、同学或共同圈子往来的情景，含冷静期、再次见面分支和原对话；场景8作为同圈相处补充。
- 077：源候选：D28。D原文场景和处理方法直接相关；保留心态准备、自然互动与注意力安排方法，不选初次招呼及他人起哄的原句示例。
- 078：源候选：G39。原文提供分手结论、原因、边界及必要事务的结构，并含清楚表达决定的原句。
- 079：源候选：G39。原文将分手后的物品、住房、财务和后续联系列入必要收尾，并有数字权限与共同物品交接清单。
- 080：源候选：G41。原文明确讨论复联前的变化证据、自由意愿、停止线和轻量联系条件；没有提供分手后第一条联系的具体原作者示例。
- 081：源候选：G42。原文针对背叛说明先厘清关系期待和边界如何被违反、区分解释与开脱，并可用事实与解释区分法；没有背叛事实核对的具体对话例。
- 082：源候选：G42。原文区分修复与宽恕、继续关系，并列出诚实、承担影响、重新协商边界和可观察改变；练习卡提供修复清单模板。
- 083：源候选：D20。D原文把见家长列为长期关系节点并提到后续规划，G原文列出双方家庭、探访与隐私议题；两者都没有见家长前确认意愿和分寸的专门流程或示例，故仅共享议题框架。
- 084：源候选：D20、G33。D仅将婚姻节奏列入未来规划，G仅提供婚前主题盘点与十题清单；可共享议题框架，原文没有讨论是否结婚或时间分歧的专门方法或示例。
- 085：源候选：G33、G37。原文列出成为父母前的夜间照护、收入与职业、祖辈参与、休息和心理支持议题，并有婚前十题清单。
- 086：源候选：D20、G33。G33直接列出职业与城市冲突时的决策议题，练习卡含对应问题；D20未引用。
- 087：源候选：G35。原文提供共同财务四层结构、可选制度、预算会议字段及自主边界；示例为预算会议模板。
- 088：源候选：G36。原文区分执行、认知、情绪和责任劳动，并提供标注频率、标准、负责人和替补及定期复盘的方法；无完整对话示例。
- 089：源候选：G37。原文讨论育儿与照护转变、负担变化和分工检查，但没有单列阶段变化后的协商流程；关系会议模板属于通用复盘方法。
- 090：源候选：G38。原文明确列出探访、备用钥匙、隐私、经济支持和决定权议题，也说明边界与支持不等于控制；练习卡含双方家庭问题。
- 091：源候选：G38。原文直接覆盖再婚、继亲、前伴侣和孩子协作边界，但没有具体沟通对话或场景示例。
- 092：源候选：G34。原文明确给出每日、每周、每月和年度关系维护节奏，并提供每周关系会议与关系健康月检模板。

## 技术核验范围

已经核对的原文件哈希另存于[源文件锁表](../romance-sources.lock.json)。该表独立于可替换的来源表和源快照；同时改写快照及其自报哈希也不能通过校验。引用范围、语境和场景匹配另由人工选段及交叉审阅核对，哈希校验不能自动判断语义是否合适。

源文件先核固定仓库／提交与 Git blob，再核每个引用段的包含行号和 SHA-256。成品正文、示例和总文档中的许可声明必须与确定性编排结果逐字节一致；增加无来源段落、改写示例或增加未登记资源都会使校验失败。源快照核验与结构／加载回归不能代替原方法的实际效果验证。

## 原作者许可声明

以下保留本套材料所用来源的许可声明，统一随整套材料保存。

### C · Mowon0303/LoveHelper.skill

```text
MIT License

Copyright (c) 2026 lizugeyo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### D · Mayuqi-crypto/HowToGetAlongWithGirls

```text
复制 `.claude/skills/dating-coach/` 目录到你的 AI 助手技能目录，按需调整。

### License

MIT
```

### E · merchantmoh-debug/EROS-AI-Dating-Repository

```text
MIT License

Copyright (c) 2026 Mohamad Al-Zawahreh

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### G · shengjidaguai-china/goutoujunshi

```text
MIT License

Copyright (c) 2026 powerycy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### T · hotcoffeeshake/tong-jincheng-skill

```text
MIT License

Copyright (c) 2026 hotcoffeeshake

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
