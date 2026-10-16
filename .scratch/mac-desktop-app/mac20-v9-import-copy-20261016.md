# Mac20：冻结 v9 原生导入与复制组合实测

2026-10-16，本次只运行现有 `candidate-copy.spec.ts` 与 `native-import-only-acceptance.spec.ts`，两项均通过，runner exit 0，整组约 1.5 分钟。未修改产品、测试或新增 harness；报告独立 Standards／Spec 均0项需修，不据此关闭整张 Mac20。

## 范围与同包约束

- 使用 `remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`，ASAR SHA-256 为 `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021`。运行前、结束后 `codesign --verify --deep --strict` 均为 0，ASAR 未改变。入口构建的是工作区测试依赖，本次实际启动始终指向冻结 v9；不以当前源码推定包内实现版本。
- Conda `NotAlone`、`NOTALONE_DISABLE_DOTENV=1`，每项独立随机 userData 和随机 `_test` PostgreSQL 库；显式 `NOTALONE_NATIVE_IMPORT_ONLY_ACCEPTANCE=1`，`NOTALONE_TEST_APP_EXECUTABLE` 指向上述包。
- 有限窗口为本地时间 15:02:31–15:10:31，max launches 2，单 worker、retries 0、repeat 1、max failures 1，实际 2 次 App 启动。前置及收尾均未发现 App/backend/native 占用，默认 userData 目录 dev/ino 保持一致。
- 全部为合成联系人和资料，仅使用夹具内存模型替身。未操作微信、调用真实 CLI/探针/外部模型、发送消息或更改系统权限。此前恢复的 CLI/WCDB pair 未被本组合使用，仍按原身份和 SHA 保留，等待整组桌面任务结束后处理。

## 逐项结果

| 现有验收 | 本场实际结果 | 证据限度 |
| --- | --- | --- |
| 原生复制 | 13.3 秒通过。编辑后“复制”取得当前文本，小窗保持显示；管理窗借桥接复制遭拒；“复制并收起”复制新编辑内容且只隐藏小窗，管理窗仍显示；重开保留编辑内容；模型替身仅一次请求。 | 系统剪贴板在任何读取前先写合成 sentinel；读取只在原有脚本中与已知文本比较，未取回或保存用户原剪贴板正文。finally 只在仍为本轮已知文本时清空。 |
| 系统文件选择器、六条导入 | Root 用 CUA 在实际系统选择器定位本场 `synthetic-import.jsonl`，核对规范化文件 URL 和唯一选中项后选择。原 case 随后自动完成新合成联系人、6 条预览、范围确认、正式导入、新增 6 / 已存在 0、任务全部步骤和最终核验成功；公开菜单退出，App exit 0。约 1.2 分钟通过。 | 独立原生导入结果明确 `shortcutAcceptanceRecorded=false`；本项不覆盖快捷键、微信或真实同步。 |

复制项退出依据为现有 App fixture teardown 及精确 PID 消失；只有导入项实际验证公开菜单正常退出和 exit 0，不将两种退出证据互换。

## 收尾与证据位置

输出根目录：[`desktop/artifacts/mac20-v9-import-copy-20261016-0592b3aa-814e-4f1b-9f78-73b16afb9147/`](../../desktop/artifacts/mac20-v9-import-copy-20261016-0592b3aa-814e-4f1b-9f78-73b16afb9147/)。此目录被忽略，保留本地现场，不提交。

- `execution-scope.json`、`controller-owned.json`：窗口、启动预算、冻结包、租约与 runner 归属。
- `run.log`、`runner-exit.json`：两项通过，15:04:34 本地时间结束，runner 0；两个测试输出目录保留各自 `app-test-owned.json`，导入另有 `native-import-only-owned.json` 与 `native-import-only-results.json`。
- `root-picker-action.json`：来源明确为 Root 的 CUA 实际动作反馈；自动导入结果由原 case 独立断言。
- `resource-verification.json`：6 个已登记 runner/worker/App/夹具 PID 均 ESRCH；两个 userData、两个夹具临时目录、合成文件及其临时父目录均不存在；租约 absent；无 App/backend/native 剩余进程；默认目录身份和冻结包未变。
- `candidate-copy-database-verification.json`：仅对该项已登记的随机测试库执行只读精确名称查询，确认不存在。导入项原有 owned 记录没有持久化数据库名，依赖原夹具 cleanup 成功和进程正常退场；未扩成按名独立 PG 缺失证明，也未列举其他数据库。尝试读取该项 `synthetic.env` 时为 ENOENT，该路径未落盘，未读到配置内容。
- `retained-dependency-verification.json`：此前精确恢复的两文件身份和 SHA 均匹配，本次未使用、未删除。

入口曾先在仓库根目录调用 npm，因没有 `package.json` 立即退出 254，没有租约或 App 启动；保留 `entry-wrong-cwd.log`、`entry-wrong-cwd-exit.json` 和 `entry-correction.json`。随后从正确的 `desktop` 目录启动唯一有效 runner，沿用原绝对截止和 max2；未重跑已通过场景。

本次数据处理仅涉及随机隔离库、合成资料和已知合成剪贴板文本；未保存私人资料、联系人身份、凭据或界面截图。尚未在本报告证明 Mac20 其他 AC，亦不替代真实 CLI 视觉独立场的原失败记录。
