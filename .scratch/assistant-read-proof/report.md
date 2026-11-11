# 助手会话完整读取核验证据

- 基线 `f5317da93`；分支 `perf/assistant-read-proof`；仅在指定工作树安装依赖、测试与提交。
- 结论：取消、连接换代、来源失效和完整响应接纳仍有保障；**删除分片只在完整 JSON ≤8,388,608 字节时安全，不能保证任意长期会话可读**。

## 分片考古（a）
- 已执行 `git log -S 'read_part' --oneline` 并阅读相关提交、说明和测试。
- `42e66bc53` 引入客户端与 Python 服务端；默认 1,048,576 字节门禁始于 `3c004608f:desktop/src/main/backend/json-client.ts:32-35`，是本项目设置，并非 HTTP 或 DSH 硬限制。
- `READ_PART_BYTES=256*1024` 由本项目自设：`42e66bc53:backend/src/notalone/server/assistant_session_read.py:12`；同提交桌面 `assistant-sessions.ts:8` 对齐，完整读取超出默认 1 MiB 后才回退。
- 当时任务记录 `.scratch/assistant-session-context/issues/12-input-budget-guard.md:212-220`（`42e66bc53`）记有 1,088,019 字节/5片、2,281,269 字节/9片的超大历史 RED→GREEN；未找到真实用户事故记录。
- 收齐后先核总字节与 SHA-256，再请求 `read_part=0&read_id=...` 重新核验当前来源与内容；防收齐后并发修改/删除及资格变化，不是重复纯完整性校验（该提交桌面 `assistant-sessions.ts:39-51`、Python helper `:43-50`）。
- 历史具名测试 `test_final_body_received_before_source_deletion_is_revalidated_before_publish`：该提交 `backend/tests/integration/server/test_assistant_session_read_transport.py:298-304`；同文件 `:272-336` 另测读取中删除、CURRENT改变、错误片头/字节数/SHA。
- TS 后端也实现过分片：`ff45f2ec2:backend-ts/src/pure-ts-public-pages.ts:11-23`，测试 `backend-ts/test/pure-ts-reply.test.mjs:30-31`；`8f7bc0c15` 移入 `host/`，`48770e9c6` 删除 Python，`154ac9e2b` 退役旧 TS 测试，`51b75c842` 删除孤立 TS 模块，`2bd5d1098` 最后删除桌面回退。
- 其余 `-S` 命中已核：`5fc4cda76` 增加退出期受限GET白名单（含read_part兼容），不改分片协议；`6a5b4590e` 新增独立UTF-8/SHA及旧read_id=409交叉测试；`1e90d9edd`、`283a609f5` 只涉任务快照/补丁上下文，`7dd7403f2` 删除快照，`e7e415ebd` 删除历史Python测试/桌面夹具，`87eb22930` 移除本机文档跟踪。

## 当前保证与责任位置
| 原保证 | 当前实现与已验证测试 |
| --- | --- |
| 取消，不发布半程结果 | `desktop/src/main/reply/assistant-sessions.ts:71-83` 传 signal、请求前后及异常检查；`desktop/tests/sqlite-discussion-read.test.mjs:18,132` 覆盖请求中/前取消 |
| generation变化丢弃 | 同上 `:71-83` 同时核当前连接与响应代次；同测试 `:18,132` 覆盖期间换代、错误响应代次、异常时换代 |
| 分片字节数、摘要、顺序一致 | 不再拼装多个快照，故无应用层 payload_bytes/SHA 比对；`json-client.ts:157-177` 累计真实字节、等待 HTTP 完成并解析完整 JSON；同测试 `:80,114` 验证中文精确预算、HTTP声明长度不足、JSON截断，未发现半快照接纳 |
| 末次来源/并发复核 | `backend-ts/src/reply/sqlite/read-channel.ts:74-82` 读取前后比较 generation/revision并登记删除持有者；`actions.ts:43-61` 核范围/来源；`backend-ts/test/sqlite-assistant-read.test.mjs:62-71,97-107` 挂住已读取正文后删除/换代，迟到响应被拒 |
| 失效后正文不复活 | `assistant-session-projection.ts:79-81,95-98` 的读取令牌失效；`desktop/tests/sqlite-discussion-source-lifecycle.test.mjs:98-109` 从来源删除入口验证取消及迟到丢弃 |
- 表内简写桌面实现均在 `desktop/src/main/`；已有保证无需修改生产逻辑，本次补充边界与失败路径回归。

## 单次响应体上限（第3点）
- 后端正式提供文件已确认：`backend-ts/src/reply/sqlite/http.ts:44-46` → `service.ts:13` → `actions.ts:53-61`，全量返回 entries，无会话总量上限。
- 用户与助手单条正文各限 100,000 UTF-16 单元（`requests.ts:12`、`generation.ts:171`）；POST JSON 信封上限 610,000 字节（`http.ts:26`），不是 GET 总响应限制。
- 实际读取硬门禁是 `desktop/src/main/backend/json-client.ts:134,157-163` 的 **8,388,608 字节完整 JSON**，包含字段、信封与转义；`assistant-sessions.ts:13,77` 显式申请该预算。
- 读取不经 DSH 会话 RPC：SQLite只读 Worker → 本机 HTTP → JsonClient。`backend-ts/src/storage/sqlite/readonly-worker.ts:61-64` 使用 structuredClone/postMessage，未设响应字节预算；Node v24.22.2 arm64 的 MAX_STRING_LENGTH=536,870,888 UTF-16 单元是运行时天花板，不是业务预算或内存保证。
- DSH 声明、锁与安装版本均为 `0.2.1-rc.2`；官方参考源码 `687f282e8625c6b8d11ff58211a90524be2e4317`，未证明安装制品与该源码逐字一致；本次未改变 DSH 接口。
- 可重跑 `node .scratch/assistant-read-proof/worker-proof.mjs`：真实默认 SQLite registry、manualConfirm→begin→cancel、独立只读 Worker、正式 HTTP 与桌面解析；未装配模型。
- 27条各100,000汉字：8,105,147字节；第28条94,426字符补至 **8,388,608字节，1次GET成功**；再追加“超”：**8,388,798字节，Worker成功但1次GET报 response_too_large**。临时数据库、Worker、HTTP均已清理。
- `sqlite-discussion-read.test.mjs:80` 另以资料服务替身+正式 HTTP/JsonClient 验证恰好8,388,608通过、8,388,609拒绝。
- **待用户决定**：恢复受控服务端分片，或在受理时设置按最终JSON计量的会话总量上限/分段规则并处理已有超限会话；本次不自行改变架构。仅提高门禁不能解决无限增长。

## 请求次数（b）
| 同一有效夹具 | UTF-8 JSON字节 | 256 KiB片数 | `2bd5d1098^` | 当前 |
| --- | ---: | ---: | ---: | ---: |
| 小会话，正常门禁 | 1,024 | 1（不触发分片） | 1 | 1 |
| 大会话，自动回退 | 1,048,577 | 5 | 7 | 1 |
| 小会话，强制回退桩 | 1,024 | 1 | 3 | 1 |
- 回退公式为首次完整请求失败 + N片 + 末次复核 = N+2；计数含失败的本机请求。测试 `desktop/tests/assistant-read-request-count.test.mjs` 用 git show 临时取出旧源码至本任务目录，finally删除，不提交旧源码。
- 桩模拟协议、两版结果深相等；使用两版都支持的传统讨论视图。旧 SQLite fallback 原本缺少 current_input_version_id 对齐，不能冒称旧SQLite大响应集成可用；强制单片行只证明回退协议成本。

## 死代码、验证与范围
- 当前后端无 read_part、READ_PART_BYTES、sessionReadPayload、payload_fragment 或 payload_bytes 分片处理；无需再删除。候选版本 part_count 是业务分段，readBoundary/read-channel 是在用删除守卫；`desktop/src/main/backend/host.ts:129` 兼容命中保留且不在可改范围。
- 已运行：`pnpm install`；desktop `pnpm run typecheck`、`node scripts/test-inventory.mjs`；读取单文件6项、计数单文件4项通过；backend `node --test test/sqlite-assistant-read.test.mjs` 13项通过；真实 Worker 脚本通过。
- desktop 从 `tests/**/*.test.mjs` 选路径含 assistant/reply/discussion 的41个文件，以 `node --test --test-concurrency=4` 运行：389项中387通过、1失败、1既有跳过（包含环境修复后的单文件结果）。缺少Playwright浏览器路径的一项以 `NOTALONE_TEST_CHROMIUM_PATH` 指向已有Chrome后通过。
- **验收未全绿**：未修改的 `desktop/tests/assistant-session-workspace.test.mjs:56` 稳定期待 rgb(47,104,140)，实际 rgba(239,239,239,0.3)；单独重跑仍失败。该React/CSS夹具不引入读取器，测试及renderer均与基线相同，属范围外，按要求仅记录。
- 既有跳过为 `overview-reply-retrieval.test.mjs` 的历史公开GET双范围用例；未改跳过条件。不启动桌面App、不打包、不调用真实模型、不访问正常用户资料；仅用合成临时数据库和无头浏览器，不改变生产数据。
- 现行 `architecture/README.md` 与 `architecture/current/` 在基线工作树缺失，入口引用悬空；按范围只记录。剩余风险是长期会话超8MiB失败、运行时内存/8秒运输期限及上述界面测试；无真实App/模型验收结论。
