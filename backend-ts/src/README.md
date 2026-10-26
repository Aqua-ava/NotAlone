# 后台源码入口

业务文件按职责归组，目录内文件名省略重复的业务前缀；测试仍在 [`../test/`](../test/)。记忆模块的入口和内部划分见 [memory/README.md](memory/README.md)。

## 启动与装配

根目录保留外部启动或插件入口：[launch.ts](launch.ts)、[host-plugin.ts](host-plugin.ts)、[plugin.ts](plugin.ts)、[schema-prepare-cli.ts](schema-prepare-cli.ts)、[managed-postgres.ts](managed-postgres.ts)。运行时装配代码位于 [host/](host/)。

## 按业务查找

| 职责 | 目录 |
| --- | --- |
| 联系人、身份与绑定 | [contacts/](contacts/) |
| 历史导入与格式解析 | [imports/](imports/) |
| 记忆提取与来源核验 | [memory/extraction/](memory/extraction/) |
| 记忆裁决、去重与自动采纳 | [memory/adoption/](memory/adoption/) |
| 已存记忆与生成资料的查询、修改和删除 | [memory/records/](memory/records/) |
| 概览与记忆目录 | [memory/overview/](memory/overview/) |
| L2 场景整理 | [memory/scenarios/](memory/scenarios/) |
| L3 长期背景生成 | [memory/profiles/](memory/profiles/) |
| 检索与排序 | [retrieval/](retrieval/) |
| 回复上下文、生成、讨论与探索 | [reply/](reply/) |
| Skill 文件、执行、学习与审核 | [skills/](skills/) |
| 表达偏好 | [preferences/](preferences/) |
| 微信接入、授权范围、历史与增量同步 | [sync/](sync/) |
| 前台会话定位与探针适配 | [foreground/](foreground/) |
| 通用后台任务控制 | [tasks/](tasks/) |
| 跨业务删除协调 | [deletion/](deletion/) |
| 追踪、质量诊断与用量 | [diagnostics/](diagnostics/) |
| 数据库、模型调用与进程支持 | [platform/](platform/) |

业务专属的 HTTP、存储和 worker 文件跟随对应业务。源码身份计算仍以实际文件字节及依赖为依据，目录和引用调整会产生新的源码版本摘要。
