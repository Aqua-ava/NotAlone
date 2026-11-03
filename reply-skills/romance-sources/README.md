# 原 Skill 的固定源快照

这是来源证据入口；包使用与核验从[Skill 目录](../romance/README.md)进入。JSON 快照、固定提交、Git blob 与许可记录不随产品实现整理而改写。

只保存本资料集实际引用的原文件及许可声明；JSON 的 content 字段保留原文字节（包含换行）。blob_sha 对应固定 Git 提交中的原 Git blob，sha256 再核本地字节。每个快照的仓库、提交和原路径同时记在元数据。已经核对的 68 个不同原文件另有[固定哈希锁表](../romance-sources.lock.json)，其中本版引用并留存 39 个文件；源文件校验不得用快照自报哈希替代锁表。快照不进入模型的 Skill 资源目录；具体引用位置见 [独立来源文档](../romance/SOURCES.md)。

源例子仍是原作者的教学资料，不能当成真实聊天或独立证实的效果。D 的 MIT 声明在原 README，其他四源保留各自 LICENSE。

| 来源 | 原文件 | Git blob |
| --- | --- | --- |
| D | [.claude/skills/dating-coach/references/lifecycle.md](D/.claude/skills/dating-coach/references/lifecycle.md.json) | 0a7b351238a1676c5fcaea08a219a2aaafdad03c |
| D | [.claude/skills/dating-coach/references/knowledge-base.md](D/.claude/skills/dating-coach/references/knowledge-base.md.json) | bdb24bdacd1155d6059ad9b1a1fdaecba8c1e83a |
| D | [.claude/skills/dating-coach/references/realistic-scenarios.md](D/.claude/skills/dating-coach/references/realistic-scenarios.md.json) | 2203d15ea6d01830a1d6c4ce23992c90ae975d39 |
| E | [docs/date-planning.md](E/docs/date-planning.md.json) | fc38b311f98a56790e829e3228a01466161af031 |
| E | [docs/conversation-mastery.md](E/docs/conversation-mastery.md.json) | bd69a07a579ea83da07f89940a5ca8853f0754aa |
| D | [.claude/skills/dating-coach/references/signal-patterns.md](D/.claude/skills/dating-coach/references/signal-patterns.md.json) | 30dd9dbcfea478933aab5c49a78ce1a0188bb006 |
| E | [SKILL.md](E/SKILL.md.json) | 3819452703e3d06ece60b1631fe25c9da93b7154 |
| E | [docs/crisis-management.md](E/docs/crisis-management.md.json) | 50503257ade651e54483b12cc6c9f8292fda4efc |
| E | [examples/conversation-examples.md](E/examples/conversation-examples.md.json) | 7b297e72d500941434d39bc45e0848d1cc2b4152 |
| E | [docs/relationship-phases.md](E/docs/relationship-phases.md.json) | 65ade04192b0ed984b63b6d92439ad86a9d820fe |
| E | [LICENSE](E/LICENSE.json) | 685f23e52ec2716202878b8eac849f21fde87516 |
| G | [SKILL.md](G/SKILL.md.json) | f9c34540c1440ae1a4de8c6790ba107ba4d40a3b |
| G | [references/knowledge/03-依恋理论与情绪调节.md](G/references/knowledge/03-%E4%BE%9D%E6%81%8B%E7%90%86%E8%AE%BA%E4%B8%8E%E6%83%85%E7%BB%AA%E8%B0%83%E8%8A%82.md.json) | 5aaa98debc5d9f211c1140eb3ca86b84092a0e6a |
| G | [references/knowledge/08-同意边界性与亲密.md](G/references/knowledge/08-%E5%90%8C%E6%84%8F%E8%BE%B9%E7%95%8C%E6%80%A7%E4%B8%8E%E4%BA%B2%E5%AF%86.md.json) | 15bc38658e2e4757931ce008b9bf51fb2e7d4bd2 |
| G | [references/knowledge/07-沟通冲突与修复.md](G/references/knowledge/07-%E6%B2%9F%E9%80%9A%E5%86%B2%E7%AA%81%E4%B8%8E%E4%BF%AE%E5%A4%8D.md.json) | 565b825180656a0385b651f4546ad2f810a38a10 |
| G | [references/knowledge/06-吸引约会与关系启动.md](G/references/knowledge/06-%E5%90%B8%E5%BC%95%E7%BA%A6%E4%BC%9A%E4%B8%8E%E5%85%B3%E7%B3%BB%E5%90%AF%E5%8A%A8.md.json) | cbf463e2ca73ca76628eba597758e83ac3d611c2 |
| G | [references/knowledge/09-在线约会与数字关系.md](G/references/knowledge/09-%E5%9C%A8%E7%BA%BF%E7%BA%A6%E4%BC%9A%E4%B8%8E%E6%95%B0%E5%AD%97%E5%85%B3%E7%B3%BB.md.json) | e68b7bd2f1411a6584663831c0f344b6a624110c |
| G | [references/knowledge/12-金钱家务育儿与双方家庭.md](G/references/knowledge/12-%E9%87%91%E9%92%B1%E5%AE%B6%E5%8A%A1%E8%82%B2%E5%84%BF%E4%B8%8E%E5%8F%8C%E6%96%B9%E5%AE%B6%E5%BA%AD.md.json) | 77a2619392de698b184df73f952a101466e24d01 |
| G | [references/knowledge/11-婚姻家庭与生命周期.md](G/references/knowledge/11-%E5%A9%9A%E5%A7%BB%E5%AE%B6%E5%BA%AD%E4%B8%8E%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F.md.json) | f57284bc4e1b261dca21d5fdbd8ca9a5b9d5bbc0 |
| G | [references/knowledge/15-分手背叛与关系修复.md](G/references/knowledge/15-%E5%88%86%E6%89%8B%E8%83%8C%E5%8F%9B%E4%B8%8E%E5%85%B3%E7%B3%BB%E4%BF%AE%E5%A4%8D.md.json) | c5f7f3932420e56ac21342e3064593b565478e7f |
| G | [references/knowledge/16-多元关系与反刻板印象.md](G/references/knowledge/16-%E5%A4%9A%E5%85%83%E5%85%B3%E7%B3%BB%E4%B8%8E%E5%8F%8D%E5%88%BB%E6%9D%BF%E5%8D%B0%E8%B1%A1.md.json) | f360966269747905dc88d2df8accbf450a432325 |
| G | [references/practical/万能吵架技巧：理性冲突处理指南.md](G/references/practical/%E4%B8%87%E8%83%BD%E5%90%B5%E6%9E%B6%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%90%86%E6%80%A7%E5%86%B2%E7%AA%81%E5%A4%84%E7%90%86%E6%8C%87%E5%8D%97.md.json) | 920c33943a84827487e51c8a97367ba63a5e4e37 |
| G | [references/practical/万能夸人的话术技巧：真诚认可的实用指南.md](G/references/practical/%E4%B8%87%E8%83%BD%E5%A4%B8%E4%BA%BA%E7%9A%84%E8%AF%9D%E6%9C%AF%E6%8A%80%E5%B7%A7%EF%BC%9A%E7%9C%9F%E8%AF%9A%E8%AE%A4%E5%8F%AF%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md.json) | eca39e353f4c6941d43b639ec9ba62e8d1fefb2f |
| G | [references/knowledge/18-实用练习与对话卡.md](G/references/knowledge/18-%E5%AE%9E%E7%94%A8%E7%BB%83%E4%B9%A0%E4%B8%8E%E5%AF%B9%E8%AF%9D%E5%8D%A1.md.json) | c850d5ba7f63a117e0f1a38b1e57148eef9fd40a |
| G | [references/practical/为他人提供情绪价值：温暖且有效的回应指南.md](G/references/practical/%E4%B8%BA%E4%BB%96%E4%BA%BA%E6%8F%90%E4%BE%9B%E6%83%85%E7%BB%AA%E4%BB%B7%E5%80%BC%EF%BC%9A%E6%B8%A9%E6%9A%96%E4%B8%94%E6%9C%89%E6%95%88%E7%9A%84%E5%9B%9E%E5%BA%94%E6%8C%87%E5%8D%97.md.json) | 0d52128312b2def237e675b92629eb79e3212758 |
| G | [references/practical/主动表达、第一次见面与自然接触.md](G/references/practical/%E4%B8%BB%E5%8A%A8%E8%A1%A8%E8%BE%BE%E3%80%81%E7%AC%AC%E4%B8%80%E6%AC%A1%E8%A7%81%E9%9D%A2%E4%B8%8E%E8%87%AA%E7%84%B6%E6%8E%A5%E8%A7%A6.md.json) | 906713d0d7ca6aeb54c19b96c85f408498550cf9 |
| G | [references/practical/场景感、松弛感与社交校准：从接话到关系推进.md](G/references/practical/%E5%9C%BA%E6%99%AF%E6%84%9F%E3%80%81%E6%9D%BE%E5%BC%9B%E6%84%9F%E4%B8%8E%E7%A4%BE%E4%BA%A4%E6%A0%A1%E5%87%86%EF%BC%9A%E4%BB%8E%E6%8E%A5%E8%AF%9D%E5%88%B0%E5%85%B3%E7%B3%BB%E6%8E%A8%E8%BF%9B.md.json) | c31631916a1c754fdf7e594cf00d2316f1b9d72f |
| G | [references/practical/实战话术编排器：从一句回复到后续分支.md](G/references/practical/%E5%AE%9E%E6%88%98%E8%AF%9D%E6%9C%AF%E7%BC%96%E6%8E%92%E5%99%A8%EF%BC%9A%E4%BB%8E%E4%B8%80%E5%8F%A5%E5%9B%9E%E5%A4%8D%E5%88%B0%E5%90%8E%E7%BB%AD%E5%88%86%E6%94%AF.md.json) | 393a2fe5a903929290960ee73ea51e5fb1b96136 |
| G | [references/practical/关系投入失衡：互惠判断、降级投入与退出决策.md](G/references/practical/%E5%85%B3%E7%B3%BB%E6%8A%95%E5%85%A5%E5%A4%B1%E8%A1%A1%EF%BC%9A%E4%BA%92%E6%83%A0%E5%88%A4%E6%96%AD%E3%80%81%E9%99%8D%E7%BA%A7%E6%8A%95%E5%85%A5%E4%B8%8E%E9%80%80%E5%87%BA%E5%86%B3%E7%AD%96.md.json) | fb83bf2c6fcc98d5f698467871d0d38f9cf5a65b |
| G | [references/practical/化解尴尬：轻松救场的实用指南.md](G/references/practical/%E5%8C%96%E8%A7%A3%E5%B0%B4%E5%B0%AC%EF%BC%9A%E8%BD%BB%E6%9D%BE%E6%95%91%E5%9C%BA%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md.json) | 6b408aa1945c737a6b98d229932e31e0b9618f3b |
| G | [references/practical/巧妙接话技巧：让沟通更流畅的实用指南.md](G/references/practical/%E5%B7%A7%E5%A6%99%E6%8E%A5%E8%AF%9D%E6%8A%80%E5%B7%A7%EF%BC%9A%E8%AE%A9%E6%B2%9F%E9%80%9A%E6%9B%B4%E6%B5%81%E7%95%85%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md.json) | d32be229b6b7af93c379362e37a784bac8696efc |
| G | [references/practical/托人办事的高效话术指南.md](G/references/practical/%E6%89%98%E4%BA%BA%E5%8A%9E%E4%BA%8B%E7%9A%84%E9%AB%98%E6%95%88%E8%AF%9D%E6%9C%AF%E6%8C%87%E5%8D%97.md.json) | cca288c5c8b341399b0927a1255e5fede03d273f |
| G | [LICENSE](G/LICENSE.json) | bfc9d99fb47f85bc00ca9231383b4fe097a5a9e1 |
| G | [references/practical/聊天化被动为主动：引导互动的实用指南.md](G/references/practical/%E8%81%8A%E5%A4%A9%E5%8C%96%E8%A2%AB%E5%8A%A8%E4%B8%BA%E4%B8%BB%E5%8A%A8%EF%BC%9A%E5%BC%95%E5%AF%BC%E4%BA%92%E5%8A%A8%E7%9A%84%E5%AE%9E%E7%94%A8%E6%8C%87%E5%8D%97.md.json) | a8201024cd229aacbb5779e14a2844ea9aa55483 |
| C | [LICENSE](C/LICENSE.json) | acded3a39c1dd66c9bef1e22ee2e4d4ace6b4905 |
| C | [relationship-copilot/references/human-progression-playbook.md](C/relationship-copilot/references/human-progression-playbook.md.json) | 4e6e1260c3dbd7c36d6172f9afa1330f5c0022f6 |
| T | [README.md](T/README.md.json) | 9140e0bb2eb689e1c2abc50e42303a0f1907b753 |
| T | [LICENSE](T/LICENSE.json) | b29a22645c9f92d128e4e1d6ff8f1ee10cca0aea |
| D | [README.md](D/README.md.json) | 05b4c75cf6dcf205d2df4e9e240f1fa1ad2c21b7 |
