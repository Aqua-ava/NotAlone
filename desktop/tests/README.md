# 桌面测试分类

`inventory.json` 显式登记所有 `.test.mjs`、`.test.ts` 和 `.spec.ts`。`npm run test:inventory` 只扫描文件名，不导入测试。新增、删除、改名或重复登记都会使检查失败；先核对测试及其导入夹具的前置条件，再更新分类。分类不能通过文件名中的 `http`、`native` 或 `react` 自动推断。

| 分类 | 前置条件及执行边界 | 入口 |
| --- | --- | --- |
| `safe-node` | Node 内存/SSR、合成文件、回环假 HTTP 或合成子进程。部分既有用例在 macOS 编译和签名仓库探针或空程序，但不执行探针、不启动 App，不构建产品包。 | `npm test` 默认运行全部已核准文件。 |
| `headless` | 真实无头 Chromium 与 React；测试自行提供内存数据。 | 明确指定文件并核对浏览器准备；生产页面组合使用 `npm run test:pages`。 |
| `isolated-http-pg` | 显式 Python/生产 HTTP/自有合成 PostgreSQL 夹具（依文件而异）；部分组合同时需要无头浏览器、Conda 环境和仓库外证据目录。 | 核对文件夹具后明确指定文件；不得直接对整目录 glob 执行。 |
| `native` | 执行原生探针、真实微信 CLI 或需要本机权限/现场；条件分支也按真实执行能力分类。 | `npm run test:native` 运行 Swift 合成套件及 CLI 诊断入口回归；真实原生/微信项另行协调现场、权限及资源。开发验收遵循 `npm run dev` 约束。 |
| `app` | Electron 或产品打包前置条件。 | 日常实际 App 验收只用 `npm run dev`；发布相关测试仍受发布门禁约束。 |

默认入口先校验完整登记，再只传递 `safe-node` 的明确列表给 Node。两份带省略扩展名导入的 TypeScript Node 测试先用 esbuild 编译到本轮临时目录，结束后删除；其他分类从不由默认入口执行。`test:polling` 等窄范围入口继续用于模块回归，不代表完整覆盖。

`finder-native-permission.test.mjs` 与 `real-sync-visual-independence.test.mjs` 的启动脚本检查只运行合成 Python 桩、不访问 PG/App，但显式要求 NotAlone Python 环境，归入隔离夹具类，不扩大默认入口的运行时前提。

登记是人工核对后的可审查清单，不是沙箱。测试修改后即使文件名未变，也必须复核递归导入和环境分支；新引入真实浏览器、数据库、原生进程或 App 时同步调整分类。macOS 编译项会增加默认验证成本，其通过只证明编译/静态合同，不证明实际窗口、OCR、微信接线或模型质量。

少量历史原生/发布入口需要特定现场或仍受门禁阻止；登记它们只防止遗漏，不表明它们已运行或当前集成可用。不得为执行全量测试解除发布门禁。
