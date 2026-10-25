# 最小合成原生验收夹具交接

- 工作范围仅本目录和自有私有临时目录；未动产品、测试、其他 scratch 或 Git index，未提交、未开 App/微信/DSH、未调用模型。
- 入口：`fixture.mjs` 的 `prepare()` / `inspect(sessionPath)` / `control(sessionPath, boolean)` / `close(sessionPath)`；导入零资源副作用，prepare 结束后资源持续存在，只有显式 close 清理。
- 运行前读 `operations.md`（不超过 40 行）；root 使用 CUA，启动只用私有快照的 `npm run dev`。CLI 输出路径、session.json、env、backend-launch、日志全为私有。
- 选型核对：旧 incremental-sync/app-fixture 与 dsh-app-session 仍含 Python 接线及旧迁移数量；借鉴当前 pure-ts-runtime-fixture 的 Node schema-prepare seam，直接复用产品 TS 迁移与业务服务，不调用 Python fixture（26 的退役状态保持）。
- 当前迁移自动发现并逐项比对 SHA，实测 116；没有硬编码 109/110/111/116 为通过条件。
- 最小种子：1 owner、2 明显合成联系人及绑定、3 规范消息、3 来源（含手录来源）、1 manual、1 pending、1 auto、1 段保存讨论；各联系人另备 2 条可导入 JSONL。
- 模型 key 在文件及干净启动环境中均为空；全部 runtime 显式 typescript；真实渠道、原生探针、外部发送均无路径。同步默认关闭、范围 selected；历史授权留给实际 UI 确认。
- 隔离细节：现有 external backendEnvironment 将 managed userData 根替换成 projectDirectory，model-host 会据此保存 journal。因此准备约 10 MB 私有源码快照，仅 node_modules 链接原已装依赖；运行产物/journal 都在自有目录，原配置与账本不读不写。
- `source-snapshot.sha256` 固定实测源码；prepare 每次重新按当前源码复制并校验，若 root 冻结要求变化，需重新核对该清单。原仓后续变更不会进入正在验收的快照。
- 验证：语法检查；有限 prepare → 独立 Node 进程读取/导入预览/CLI 协议/来源隔离/既有讨论 → 独立进程 close；`verification.json` 只记录合成及清理结果。
- 自检中曾修正 macOS /var 与 /private/var 别名核验，以及手录自动生成来源的计数断言；失败自有资源已清理，未转为产品修改。
- 已知未验：实际 GUI 是否可达/是否正确呈现、真实微信/OCR、模型生成及在途生成取消；种子没有伪造真实模型结果或提取追踪。「查看依据」无真实提取过程时须如实记录。
- 可在 GUI 核对的取消为导入确认、编辑/删除确认和可用任务的停止；完整版本撤销与语义矩阵继续 deferred_by_user。
- 最终进度由 root 汇总，本夹具不签收 25 或启动 26，不改变两争议延期范围。

源码依据（相对仓库根）：
- `backend-ts/src/schema-prepare.ts:63`、`backend-ts/test/pure-ts-runtime-fixture.mjs:9`：当前 TS 迁移 seam。
- `desktop/src/main/backend/config.ts:148`、`desktop/src/main/backend/process.ts:27`、`backend-ts/src/model-host.ts:43`：私有源码快照理由。
- `desktop/src/renderer/ImportPage.tsx:65`、`backend-ts/test/history-import-api.test.mjs:17`：单联系人 JSONL 与实际 UI。
- `desktop/src/renderer/MemoryPage.tsx:193`、`backend-ts/src/memory-service.ts:13`：审核、编辑、撤销/删除入口。
- `desktop/src/renderer/AssistantSessionPanel.tsx:172`、`backend-ts/src/assistant-discussion-http.ts:96`：讨论读取/删除。
- `desktop/src/renderer/SyncControlPanel.tsx:104`、`desktop/src/renderer/BackgroundTasksPanel.tsx:104`：历史授权/覆盖与停止任务。
