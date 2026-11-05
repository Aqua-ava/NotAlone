# 微信数据库密钥缺失与补取

本文记录 2026-11-05 实际走通的补密钥流程和已踩过的坑，下次遇到同类问题直接按此处理，不要重新试错。流程会读取微信进程内存并改写含密钥的配置，每一步都须用户本人授权；密钥值不得出现在对话、日志、提交或文档里。验证记录见[标准图优先取图的真实验证](../verification/image-pick-standard-20261105.md)。

## 什么时候需要

读取程序给每个微信数据库文件配一把密钥，按文件头 16 字节的“盐”对应。微信更新、重装或迁移时会重建数据库并换盐，旧密钥对新文件无效。

典型症状：文字照常读取，图片整批失败。现在后台在读取程序报关联失败、且配置的密钥表里没有 `message_resource.db` 当前文件头盐时，会明确返回 `media_database_key_missing`，聊天里图片显示“图片暂不可用：缺少微信数据库密钥”。旧版本（或配置不可读时）仍只显示 `media_association_unverified`（来源是读取程序 `history_image_association_unverified`），其真实原因同样可能是读取程序打不开该库：`no enc_key for salt … refresh wxkey's schema-2 key map`，不要凭关联失败的错误码断定是关联问题，先做下面的只读判定。

## 先只读判定，不要动配置

核对每个数据库文件头盐是否在配置的密钥表里（只比盐，不打印密钥）：

```bash
python3 -I - <<'PY'
import json, os, glob
cfg = json.load(open(os.path.expanduser('~/.config/wxcli/config.json')))
salts, root = set(cfg['keys']), cfg['db_root'] + '/db_storage'
for p in sorted(glob.glob(root + '/**/*.db', recursive=True)):
    if open(p, 'rb').read(16).hex() not in salts:
        print('缺密钥', os.path.relpath(p, root))
PY
```

只缺 `migrate/unspportmsg.db` 与取图无关。缺 `message/message_resource.db` 就需要补。`wxkey doctor` 也能给出同样的覆盖率，它只读、不扫描内存；其输出“DB 文件: 0 个”表示运行它的环境读不到微信数据目录（见下文）。

## 补取流程

外置 `wxkey` 在 `~/Library/Application Support/NotAloneDesktop/wechat-tool/bin/wxkey`。微信官方安装包带强化运行时，`wxkey` 对它读取内存会被系统拒绝（`task_for_pid kr=5`），所以必须读取它自带的**影子微信副本**（临时签名，位于 `~/Library/Application Support/wx-mcp/WeChat-shadow.app`）。仍保持系统完整性保护开启，不用 `resign-wechat`（会改你正式安装的微信）。

1. **前提**：开发 App 已正常退出（`pnpm run dev:status` 为 stopped），正式微信已退出，管理员密码已由用户存进钥匙串（首次由 `wxkey bootstrap` 弹窗索取，由用户本人输入）。
2. **备份配置**：复制 `~/.config/wxcli/config.json` 到同目录带日期的副本，权限 0600，核对逐字节一致。不要入 Git。
3. **准备影子副本**：若目录里没有 `WeChat-shadow.app`，运行一次 `wxkey bootstrap` 让它生成（它会立刻扫描并因未登录而失败，这是预期，副本会留下）。
4. **直接运行影子副本的程序文件启动**，不要双击：

   ```bash
   "$HOME/Library/Application Support/wx-mcp/WeChat-shadow.app/Contents/MacOS/WeChat" &
   ```

   双击会一闪而过；直接运行可正常启动。
5. **由用户在影子微信里扫码登录，并打开一个有图片的聊天、多滚动几下**，让微信把相关数据库都打开。可用 `lsof -p <影子微信pid> | grep message_resource.db` 确认该库已被打开；未打开时扫描拿不到它的密钥。
6. **扫描并写配置**：先把真实 `config.json` 挪开（`setup` 会整份写默认路径，不能与现有配置混写），再运行：

   ```bash
   wxkey setup --pid <影子微信pid> --root "$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/<wxid>"
   ```

   **不要**重定向或 `tail` 它的输出：扫描结果 JSON 含全部密钥和图片密钥。必须保存时写入权限 0600 的私有文件并在合并后用 `shred` 删除。提权重启时 `--config` 只允许默认路径，所以不能让它写到别的文件。
7. **合并**：把挪开的旧配置放回，只把新文件里“旧配置没有的盐”的密钥并入旧配置的 `keys`，不覆盖、不删除已有密钥，只取较大的 `key_epoch`，原子写回并保持 0600。**不要**把 `image_key` 写进配置，图片密钥仍由应用按需在进程内准备。合并后删除临时文件。
8. **核对**：重跑上面的盐覆盖检查，`message_resource.db` 应不再缺；其余库仍覆盖。
9. **收尾**：用户退出影子微信（Cmd+Q），再从应用程序打开正常微信；保留配置备份。其后切换制品或重启 App 的步骤见[读取程序构建与开发切换](../../desktop/wechat-history/README.md#构建与开发切换)。

## 已验证的坑

- **`wxkey bootstrap` 一启动就扫描**，此时影子微信还没登录，扫不到密钥；调试器备选路径在几秒内结束（零次断点）。不要反复重试 `bootstrap`，改用上面的“直接启动、登录、再 `setup --pid`”。
- **双击影子副本一闪而过**，直接运行程序文件才行。原因未查明。
- **正式微信开着时 `list-pids` 看到的是 `/Applications` 里的官方微信**，对它 `setup` 必然 `kr=5`。先用进程路径确认扫描的是影子副本。
- **在用户的终端 App 和本应用的 `!` 命令里运行 `bootstrap`**，两次都报“未找到加密数据库”；同一工具在 Agent 的执行环境里能看到全部 27 个库。推测与该环境读取其他 App 数据目录的权限有关，未证实。下次先在目标环境运行 `wxkey doctor`，若“DB 文件”为 0，说明该环境读不到数据目录，需要由用户给该终端“完全磁盘访问权限”，那是系统隐私设置，只能用户本人修改。
- **自定义 `--config`** 在需要提权时被拒（`unsafe elevated --config`），只允许默认路径。
- **`WXKEY_NO_ELEVATE=1`、`WXKEY_KEEP_SHADOW_WECHAT=1`** 对上述问题没有帮助，后者也没有让影子副本在 `bootstrap` 结束后留下。

## 边界

- 不关闭系统完整性保护；不修改、重签或注入用户正式安装的微信；不替用户输入管理员密码或点击系统授权弹窗。
- 补密钥只为让已授权联系人的本机读取恢复，不扩大读取范围；产品运行时不调用 `bootstrap`。
- 产品内没有“检测缺密钥并引导”的功能，也不随包提供 `wxkey`；其他用户首次取钥匙和每次微信重建数据库后都会遇到同样的步骤，这是尚待设计的产品缺口。
