# 21 真实 CLI 元数据读取边界审计

审计代码基线：`f270f348`。本记录只含公开源码、构建记录、工具文件摘要与静态检查，不含真实账号、联系人名称、消息正文、凭据或本机绝对目录。

## 结论与适用范围

本机当前 CLI 的历史构建记录、锁定补丁字节与现存二进制静态特征相互支持，可将下列固定摘要文件作为本次限定元数据验收的只读构建。结论不是仅由版本号、上游 commit、单个字符串或复制后的相同摘要推导。

该开发工具目录缺少组件 `manifest.json`；本轮没有重建 CLI、重跑 Go 合成测试或执行实际 CLI。因此不声称通过完整组件发行校验、可重现构建、Developer ID、公证或干净机器验收。普通文件签名完整性通过也不等于来源可信或读取范围授权。

## 固定源码与构建记录链

1. `desktop/wechat-sources.lock.json:7–13` 固定上游 `r266-tech/wx-cli`，版本 `2.0.1-rc.5`，commit `795071fa0591da5fc2c6ab94a70f22ccd93ef06c`，tree `5d617ff3250c27fd9b33a60cb0182e153c521057`。
2. 历史修复提交为 `f4c056c2e3f45f2686b346cdc4ad2f9163453ae6`。本轮读取该提交内的原始锁文件及补丁字节，其补丁 SHA-256 与当前 `desktop/wechat-sources.lock.json:114–118` 一致：
   - `readonly-cli.patch`：`c143ef47728d32c5e647196c75efc33278b49647bd35f3f058b51aeb92ce06aa`。
   - 测试锁定摘要：`a534c8322564cb5ea409fe689aa775e1f5f4d59354ec63ec6be62f31bf0e02ce`。
3. [原票 01](../../authorized-private-history-sync/issues/01-custom-username-identity.md) 第 22、28–30 行记载固定 Go 1.26.5、WCDB 2.1.16 与相同 pinned CLI 源的独立重建；完整 `^TestNotAlone`、来源锁、严格补丁应用、源码／补丁／测试镜像及 ad-hoc 签名检查通过。第 51 行明确补丁与测试镜像逐字节一致。此处引用历史验收记录，不冒称本轮重新执行。
4. 提交 `0c9614ee0d7a145ae814d639500768160fb03f97` 中的[后续修复记录](../../authorized-private-history-sync/real-wechat-acceptance-20261023-repair.md)第 8 行链接上述只读 status 重建；第 9 行记录同一已核验 CLI 与配套 WCDB 复制到独立开发目录、未重签，以及下表 CLI 摘要。本轮仅查该构建／复制元数据，未读取其中业务验收材料。

## 当前工具与 WCDB 的静态证据

工具根目录仅以相对布局标识；未将用户目录或实际配置写入本记录。

| 文件 | 字节数 | 本轮 SHA-256 | `codesign --verify --strict` |
| --- | ---: | --- | --- |
| `bin/wechat-cli` | 8495824 | `d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655` | 退出 0 |
| `lib/libWCDB.dylib` | 4490832 | `4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d` | 退出 0 |

两者为现存普通文件，未见符号链接。`manifest.json` 不存在；本轮未更改或重签文件。

只读读取 CLI 字节后，补丁后的 sessions 元数据 SELECT 和新增精确会话身份 SELECT 各出现一次；上游原 sessions 摘要 SELECT 与 `summary LIKE ? COLLATE NOCASE` 均未出现。此结果仅作为上述构建记录的静态交叉支持，不能单独证明任意调用分支或实际运行加载状态。

`otool -L` 显示 CLI 的直接依赖为系统 Security、CoreFoundation、libresolv 与 libSystem，未显示直接链接 WCDB。固定源码 `main.go:93–104,361–375` 另行选择 WCDB 路径并交给 `wcdb.Bootstrap`。[固定装载入口](https://raw.githubusercontent.com/r266-tech/wx-cli/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/main.go) 配套库的 install name 为 `@rpath/libWCDB.dylib`，其依赖为系统 Security、Foundation、CoreFoundation、libz、libc++ 与 libSystem；未见另一非系统 CoreWCDB 导入。这里证明目录内配套库的字节和静态依赖，**不证明本轮实际进程加载了哪个 WCDB 路径**，也不以 install name 的版本值代替源码版本核验。

## sessions 的实际读取边界

固定上游 `sessions.go:56–67` 原本查询摘要、未读数、最近发送人与消息类型，关键词还搜索摘要；`--strict-read-only` 只约束写入，不能单独消除这些读取。[固定官方源码](https://raw.githubusercontent.com/r266-tech/wx-cli/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/sessions.go)

当前 `desktop/wechat-patches/readonly-cli.patch:195–246` 在 SQL 层移除摘要搜索及上述正文／最近消息字段，只保留 `username,last_timestamp,sort_timestamp`；名称与类型由 contact 元数据补充。不是先查询正文再由 TS 丢弃输出。当前 TS `foreground-location-sessions.ts:13–21` 仍只投影 `username,display_name,chat_type`，作为额外最小化边界。

`desktop/wechat-patches/readonly-cli-test.go:200–211` 使用没有摘要列的合成 SessionTable；第 251–259 行检查名称／身份搜索，第 293–305 行证明加入正文独有关键词后仍不能按它搜索会话。此测试已存在于上述历史修复提交的完整门禁中。

上游 `toolSessions` 没有根据 metadata-only 参数切换上述 SQL 的分支；当前产品通过固定补丁更改默认查询，不依赖新增命令参数。本轮不臆造 `--metadata-only`、`--no-summary` 等选项。

## resolve-chat 的调用闭包

- 固定 `cli.go:239–244` 将命令交给 `resolve_chat`；`agent.go:294–315` 仅调用 `chatCandidates` 后包装候选和来源，不调度消息读取。[CLI 入口](https://raw.githubusercontent.com/r266-tech/wx-cli/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/cli.go)、[候选实现](https://raw.githubusercontent.com/r266-tech/wx-cli/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/agent.go)
- 实时路径 `chat_resolution_live.go:14–102` 查询 contact 的名称／身份，随后以候选 username 查询 SessionTable 身份／时间，不查询消息正文。[固定实时解析](https://raw.githubusercontent.com/r266-tech/wx-cli/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/chat_resolution_live.go)
- 实时失败才走该文件第 117 行起的缓存名称分支；`agent.go:148–172` 只选择 `sessions_unified`／`contacts_unified` 的名称、身份、类型及时间，不选择正文或摘要。
- `cache.go:127` 起以只读方式打开缓存；`157–160` 在 strict 模式直接跳过自动刷新。补丁 `readonly-cli.patch:151–171` 固定开启严格只读与禁止自动刷新，参数或环境不能关闭。因此该分支不因名称解析自动抓取历史正文。[固定缓存实现](https://raw.githubusercontent.com/r266-tech/wx-cli/795071fa0591da5fc2c6ab94a70f22ccd93ef06c/cmd/wechat-cli/cache.go)
- 产品补丁第 1–63 行还增加精确 username 的 session 身份优先路径；联系人库仅补显示名称与验证类型。显示名解析仍不是稳定身份确认，也不授予读取权限。

以上网络源码均取不可变官方 commit；本轮没有找到完整本机源码缓存，不能把网络核对表述为本机源码核验。上述行号按 raw 文件实际行号，网页提取器去除空行后的行号可能不同。

## 本轮许可与验收限制

这份审计只支持继续既有的元数据名单／名称定位流程；名单需保留未绑定及群聊竞争者，不能通过仅保留测试对象制造唯一性。不因工具白名单包含 `tail/watch` 就取得正文或历史授权；本次核对没有执行这些入口，也未执行 `sessions`、`resolve-chat`、原生探针、App、模型或数据库命令。

旧构建测试和本轮静态检查不能代替 21 的真实原生窗口 OCR、当前官方宿主 HTTP、实际开发 App 或完整重启验收。当前目录缺少 `manifest.json`，不能声称已通过 `desktop/scripts/wechat-components.mjs:43–60` 要求的完整组件清单、库存、来源锁及补丁核验，也不能据此签收独立发行工具包。

本轮实际操作仅为：读取指定历史构建／复制元数据，读取历史 Git blob，计算固定文件摘要和特征计数，静态检查 Mach-O 依赖及代码签名，并读取固定官方公开源码。没有访问微信业务资料、修改系统权限或替换用户工具。
