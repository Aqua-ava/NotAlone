package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"github.com/r266-tech/wx-cli/v2/internal/wxkey"
)

// 此测试只调用已裁剪的门禁；不查找微信、不打开Keychain、不访问真实DB。
func TestNotAloneReadonlyBuild(t *testing.T) {
	t.Setenv("WECHAT_CLI_STRICT_READ_ONLY", "false")
	t.Setenv("WX_MCP_STRICT_READ_ONLY", "false")
	t.Setenv("WECHAT_CLI_DISABLE_AUTO_REFRESH", "false")
	if !strictReadOnlyMode() {
		t.Fatal("产品严格只读不能被环境关闭")
	}
	t.Setenv("WX_KEY_BIN", "/bin/sh")
	if _, err := wxkey.FindBinary(); err == nil {
		t.Fatal("产品不能查找外部wxkey")
	}
	if _, _, err := wxkey.RunSetup(); err == nil {
		t.Fatal("产品不能调度wxkey setup")
	}
	if _, _, err := wxkey.RunImageKey(""); err == nil {
		t.Fatal("产品不能调度图片密钥扫描")
	}
}

func notaloneTestDB(t *testing.T, root string, cfg *config.Config, subdir, file, schema, salt string) {
	t.Helper()
	file = filepath.Join(root, "db_storage", subdir, file)
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, nil, 0600); err != nil {
		t.Fatal(err)
	}
	key := strings.Repeat("11", 32)
	db, err := wcdb.OpenWithEncKeyWritable(file, key, salt)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(schema); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()
	cfg.Keys[salt] = key
}

func notaloneRunCLI(t *testing.T, root, cli, configFile string, args ...string) (map[string]any, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, cli, args...)
	command.Dir = root
	command.Env = []string{"HOME=" + root, "TMPDIR=" + root, "PATH=/usr/bin:/bin", "LANG=en_US.UTF-8", "WECHAT_CLI_CONFIG=" + configFile, "WECHAT_CLI_STATE_DIR=" + filepath.Join(root, "state")}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		t.Fatalf("CLI %v失败: %v，%s，%s", args, err, output, stderr.String())
	}
	var envelope struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(output, &envelope); err != nil || !envelope.OK {
		t.Fatalf("CLI协议无效: %s (%v)", output, err)
	}
	return envelope.Data, output
}

// 通过实际CLI验证合成数据库；缺少预览/最近消息列时仍能列出、过滤和观察会话。
func TestNotAloneMetadataOnlySessions(t *testing.T) {
	lib := os.Getenv("NOTALONE_TEST_WCDB")
	if lib == "" {
		t.Fatal("合成WCDB来源缺失")
	}
	if err := wcdb.Bootstrap(lib); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := &config.Config{SchemaVersion: 2, DBRoot: root, Wxid: "wxid_synthetic", Keys: map[string]string{}}
	notaloneTestDB(t, root, cfg, "session", "session.db", `CREATE TABLE SessionTable(username TEXT,last_timestamp INTEGER,sort_timestamp INTEGER,is_hidden INTEGER); INSERT INTO SessionTable VALUES('wxid_friend',100,101,0); INSERT INTO SessionTable VALUES('wxid_unconfirmed',102,103,0); INSERT INTO SessionTable VALUES('wxid_hidden',104,105,1); INSERT INTO SessionTable VALUES('custom_person_88',106,107,0); INSERT INTO SessionTable VALUES('custom_official_77',108,109,0);`, strings.Repeat("22", 16))
	notaloneTestDB(t, root, cfg, "contact", "contact.db", `CREATE TABLE contact(username TEXT,remark TEXT,nick_name TEXT,alias TEXT,verify_flag INTEGER); INSERT INTO contact VALUES('wxid_friend','Synthetic Friend','','friend',0); INSERT INTO contact VALUES('custom_official_77','','','',1);`, strings.Repeat("33", 16))
	msgTable := "Msg_" + talkerHash("custom_person_88")
	notaloneTestDB(t, root, cfg, "message", "message_0.db", fmt.Sprintf(`CREATE TABLE %s(local_id INTEGER,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,message_content TEXT,source TEXT); INSERT INTO %s VALUES(1,900001,1,1,0,106,0,'synthetic custom message','');`, msgTable, msgTable), strings.Repeat("44", 16))
	configuration, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	configFile := filepath.Join(root, "config.json")
	if err := os.WriteFile(configFile, configuration, 0600); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(filepath.Dir(lib), "..", "bin", "wechat-cli")
	run := func(args ...string) map[string]any {
		t.Helper()
		files := []string{configFile, filepath.Join(root, "db_storage", "session", "session.db"), filepath.Join(root, "db_storage", "contact", "contact.db"), filepath.Join(root, "db_storage", "message", "message_0.db")}
		before := make([][]byte, len(files))
		for i, file := range files {
			before[i], err = os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
		}
		data, output := notaloneRunCLI(t, root, cli, configFile, args...)
		for _, field := range []string{`"summary"`, `"content_summary"`, `"message_content"`, `"last_sender_wxid"`, `"last_sender_display_name"`, `"last_msg_type"`, `"last_msg_sub_type"`, `"last_msg_kind_name"`, `"unread_count"`} {
			if bytes.Contains(output, []byte(field)) {
				t.Fatalf("会话元数据不得含正文或最近消息信息: %s", field)
			}
		}
		for i, file := range files {
			after, err := os.ReadFile(file)
			if err != nil || !bytes.Equal(before[i], after) {
				t.Fatalf("只读CLI改写了合成来源: %s (%v)", filepath.Base(file), err)
			}
		}
		return data
	}
	list := run("sessions", "--type-filter", "private", "--limit", "10")["sessions"].([]any)
	if len(list) != 3 || list[0].(map[string]any)["username"] != "custom_person_88" {
		t.Fatalf("可见会话顺序/范围无效: %#v", list)
	}
	for _, keyword := range []string{"Synthetic Friend", "wxid_friend", "friend"} {
		rows := run("sessions", "--keyword", keyword, "--type-filter", "private")["sessions"].([]any)
		if len(rows) != 1 {
			t.Fatalf("名称或身份关键词 %q未找到唯一会话: %#v", keyword, rows)
		}
		row := rows[0].(map[string]any)
		if row["username"] != "wxid_friend" || row["display_name"] != "Synthetic Friend" || row["chat_type"] != "private" || row["last_timestamp"] != float64(100) || row["sort_timestamp"] != float64(101) {
			t.Fatalf("必要会话协议丢失: %#v", row)
		}
	}
	cands := run("resolve-chat", "custom_person_88", "--type-filter", "private")["candidates"].([]any)
	if len(cands) != 1 {
		t.Fatalf("自定义username应按稳定标识唯一解析: %#v", cands)
	}
	ident := cands[0].(map[string]any)
	if ident["username"] != "custom_person_88" || ident["chat_type"] != "private" || ident["match"] != "username_exact" {
		t.Fatalf("自定义username身份解析无效: %#v", ident)
	}
	official := run("resolve-chat", "custom_official_77", "--type-filter", "official")["candidates"].([]any)
	if len(official) != 1 || official[0].(map[string]any)["chat_type"] != "official_account" {
		t.Fatalf("已验证自定义账号的会话类型应与列表一致: %#v", official)
	}
	tailEvents := run("tail", "custom_person_88", "--limit", "10")["events"].([]any)
	if len(tailEvents) != 1 || tailEvents[0].(map[string]any)["message"].(map[string]any)["id"].(map[string]any)["talker"] != "custom_person_88" {
		t.Fatalf("自定义username应可直接读取单会话文字: %#v", tailEvents)
	}
	for _, command := range []string{"tail", "watch"} {
		events := run(command, "--mode", "sessions", "--limit", "10")["events"].([]any)
		if len(events) != 4 || events[0].(map[string]any)["type"] != "session" || events[0].(map[string]any)["cursor"] == "" || events[0].(map[string]any)["session"].(map[string]any)["username"] != "wxid_friend" {
			t.Fatalf("全局会话事件协议无效: %#v", events)
		}
		foundCustom := false
		for _, event := range events {
			session := event.(map[string]any)["session"].(map[string]any)
			if session["username"] == "custom_person_88" {
				foundCustom = true
			}
		}
		if !foundCustom {
			t.Fatalf("全局会话事件缺少自定义username: %#v", events)
		}
	}
	// 加回合成正文列后，正文独有关键词仍不得找到任何会话。
	db, err := wcdb.OpenWithEncKeyWritable(filepath.Join(root, "db_storage", "session", "session.db"), strings.Repeat("11", 32), strings.Repeat("22", 16))
	if err != nil {
		t.Fatal(err)
	}
	err = db.Exec(`ALTER TABLE SessionTable ADD COLUMN summary TEXT; UPDATE SessionTable SET summary='synthetic_body_only_sentinel';`)
	db.Close()
	if err != nil {
		t.Fatal(err)
	}
	rows := run("sessions", "--keyword", "synthetic_body_only_sentinel")["sessions"].([]any)
	if len(rows) != 0 {
		t.Fatalf("关键词不得搜索正文: %#v", rows)
	}
	run("sessions")
	run("tail", "--mode", "sessions")
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Name() != "config.json" || entries[1].Name() != "db_storage" {
		t.Fatal("只读CLI创建了额外支持文件")
	}
}

// 联系人库缺失时，稳定会话身份仍应直接可读，不能退回需要 cache refresh 的索引。
func TestNotAloneCustomUsernameWithoutContactDB(t *testing.T) {
	lib := os.Getenv("NOTALONE_TEST_WCDB")
	if lib == "" {
		t.Fatal("合成WCDB来源缺失")
	}
	if err := wcdb.Bootstrap(lib); err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	cfg := &config.Config{SchemaVersion: 2, DBRoot: root, Wxid: "wxid_synthetic", Keys: map[string]string{}}
	notaloneTestDB(t, root, cfg, "session", "session.db", `CREATE TABLE SessionTable(username TEXT,last_timestamp INTEGER,sort_timestamp INTEGER,is_hidden INTEGER); INSERT INTO SessionTable VALUES('custom_person_88',106,107,0);`, strings.Repeat("22", 16))
	msgTable := "Msg_" + talkerHash("custom_person_88")
	notaloneTestDB(t, root, cfg, "message", "message_0.db", fmt.Sprintf(`CREATE TABLE %s(local_id INTEGER,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,message_content TEXT,source TEXT); INSERT INTO %s VALUES(1,900001,1,1,0,106,0,'synthetic custom message','');`, msgTable, msgTable), strings.Repeat("44", 16))
	configuration, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	configFile := filepath.Join(root, "config.json")
	if err := os.WriteFile(configFile, configuration, 0600); err != nil {
		t.Fatal(err)
	}
	cli := filepath.Join(filepath.Dir(lib), "..", "bin", "wechat-cli")
	run := func(args ...string) map[string]any {
		t.Helper()
		data, _ := notaloneRunCLI(t, root, cli, configFile, args...)
		return data
	}
	cands := run("resolve-chat", "custom_person_88", "--type-filter", "private")["candidates"].([]any)
	if len(cands) != 1 {
		t.Fatalf("联系人库缺失时自定义username仍应唯一解析: %#v", cands)
	}
	identity := cands[0].(map[string]any)
	if identity["username"] != "custom_person_88" || identity["display_name"] != "custom_person_88" {
		t.Fatalf("联系人库缺失时应回退到稳定username展示: %#v", identity)
	}
	tailEvents := run("tail", "custom_person_88", "--limit", "10")["events"].([]any)
	if len(tailEvents) != 1 || tailEvents[0].(map[string]any)["message"].(map[string]any)["id"].(map[string]any)["talker"] != "custom_person_88" {
		t.Fatalf("联系人库缺失时仍应直接读取单会话文字: %#v", tailEvents)
	}
}
