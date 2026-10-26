# 后台源码入口

业务文件按职责归组，文件名和导出名称保持；测试仍在 [`../test/`](../test/)。

## 启动与装配

根目录保留外部启动或插件入口：[launch.ts](launch.ts)、[host-plugin.ts](host-plugin.ts)、[plugin.ts](plugin.ts)、[schema-prepare-cli.ts](schema-prepare-cli.ts)、[managed-postgres.ts](managed-postgres.ts)。运行时装配代码位于 [host/](host/)。

## 按业务查找

| 职责 | 目录 |
| --- | --- |
| 联系人、身份与绑定 | [contacts/](contacts/) |
| 历史导入与格式解析 | [imports/](imports/) |
| 记忆提取与来源核验 | [memory/extraction/](memory/extraction/) |
| 记忆查看、修改、采纳与删除 | [memory/management/](memory/management/) |
| 概览与记忆目录 | [memory/overview/](memory/overview/) |
| L2 场景、L3 背景与分层资料管理 | [memory/layered/](memory/layered/) |
| 检索与排序 | [retrieval/](retrieval/) |
| 回复上下文、生成、讨论与探索 | [reply/](reply/) |
| Skill 文件、执行、学习与审核 | [skills/](skills/) |
| 表达偏好 | [preferences/](preferences/) |
| 微信接入、授权范围、历史与增量同步 | [sync/](sync/) |
| 前台会话定位与探针适配 | [foreground/](foreground/) |
| 通用后台任务控制 | [tasks/](tasks/) |
| 跨业务删除协调 | [deletion/](deletion/) |
| 追踪、质量诊断、离线对照与用量 | [diagnostics/](diagnostics/) |
| 数据库、模型调用与进程支持 | [platform/](platform/) |
| 第三方源码 | [vendor/](vendor/) |

业务专属的 HTTP、存储和 worker 文件跟随对应业务。源码身份计算仍以实际文件字节及依赖为依据，目录和引用调整会产生新的源码版本摘要。
