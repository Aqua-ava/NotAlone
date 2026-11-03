# 桌面测试分类

`inventory.json` 登记 `.test.mjs`、`.test.ts` 和 `.spec.ts`。`pnpm run test:inventory` 只核对文件与分类，不导入或运行测试；新增、删除、改名及重复登记都会失败。改变用例内容时仍须核对递归夹具和环境分支，不能只凭文件名判断安全范围。

在 `desktop/` 运行命令，实际脚本以 [package.json](../package.json) 为准：

| 分类 | 执行边界 | 入口 |
| --- | --- | --- |
| `safe-node` | Node 内存、SSR、合成文件、回环 HTTP 或合成子进程；部分 macOS 用例编译和签名仓库探针或空程序，不执行探针、不启动 App、不构建产品包。 | `pnpm test` 先类型与登记检查，再运行该明确列表。 |
| `headless` | 无头 Chromium 与 React，使用各用例的合成夹具；不等同于真实 Electron、权限或渠道验收。 | 按登记指定文件，先核对浏览器及夹具；刷新相关窄组可用 `pnpm run test:polling`。 |
| `isolated-http` | 生产 HTTP 边界或文件显式要求的外部证据。 | 核对实际文件和合成数据准备后执行，不对目录无差别 glob。 |
| `native` | 原生进程、真实微信工具或权限现场，按用例实际能力区分。 | `pnpm run test:native` 运行 Swift 合成套件及 CLI 入口回归；真实观察另按[桌面验收](../README.md#桌面验收与自动化测试)。 |
| `app` | Electron 或历史打包前置；登记不证明用例兼容当前开发路径。 | 实际 App 仅使用 `pnpm run dev` 并先 `dev:status`；逐项核对夹具，发布类仍受门禁阻止。 |
| `historical` | 固定旧实现或兼容历史入口。 | 先查[历史测试说明](../../backend-ts/test/HISTORICAL.md)，不从当前树恢复 Python／PG 后台。 |

[默认 runner](../scripts/test-safe.mjs)只传递核准的 `safe-node` 文件；需要编译的 TypeScript 测试使用本轮临时目录并清理。`test:polling` 是窄回归，不代表全部页面覆盖。

[test:pages](../scripts/test-pages.mjs)当前仅保留 `--status`、合成租约探针和旧页面指引，旧 `--case` 组合不会在当前树执行。当前页面测试按 inventory 运行；产品历史候选功能的测试名称不等于退役后台测试。

[test:app](../scripts/test-app.mjs)保留明确范围、期限、启动数和互斥参数，`pnpm run test:app:status` 只读占用。自动化参数不要求用户额外预约，也不授权打包或执行与热更新约束不兼容的旧夹具。未知残留须先核对归属，不能删除锁或终止未知进程继续。

记录分别说明静态／合成验证、无头页面、Computer Use、真实原生／微信及模型质量覆盖。任何默认测试通过都不能代签完整桌面业务闭环；本文件是入口说明，不是本轮测试成绩。
