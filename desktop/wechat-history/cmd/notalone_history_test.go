package main

import (
	"context"
	"encoding/json"
	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func init() {
	if p := os.Getenv("NOTALONE_TEST_WCDB"); p != "" {
		if err := wcdb.BootstrapBounded(p); err != nil {
			panic(err)
		}
	}
}
func TestNotAloneHistorySchemaOnlyTargetStructure(t *testing.T) {
	p := os.Getenv("NOTALONE_TEST_WCDB")
	if p == "" {
		t.Skip("需要显式WCDB")
	}
	db, err := wcdb.OpenPlain(filepath.Join(t.TempDir(), "synthetic.db"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Exec(`CREATE TABLE Msg_target(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,message_content BLOB,source BLOB);CREATE INDEX misleading_SERVERID ON Msg_target(server_id);INSERT INTO Msg_target(message_content,source) VALUES('private-body-sentinel','private-source-sentinel');CREATE TABLE unrelated(secret TEXT);INSERT INTO unrelated VALUES('private-other-sentinel');`); err != nil {
		t.Fatal(err)
	}
	report, err := inspectNotaloneTable(context.Background(), db, "Msg_target", "opaque-partition")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(report)
	for _, secret := range []string{"private-body-sentinel", "private-source-sentinel", "private-other-sentinel", "Msg_target", "misleading_SERVERID"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("结构投影泄露%s", secret)
		}
	}
	if !report.AutoIncrement || len(report.DeclaredPrimaryKey) != 1 || report.DeclaredPrimaryKey[0] != "local_id" {
		t.Fatalf("主键合同错误：%#v", report)
	}
	if len(report.Indexes) != 1 || report.Indexes[0].Unique {
		t.Fatal("索引名称不证明唯一")
	}
}

func TestNotAloneHistoryScopeRejectsUnknownFieldsAndOtherTarget(t *testing.T) {
	s := notaloneHistoryFixture(t)
	session := newNotaloneHistorySession(s)
	if _, err := session.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := session.handle(context.Background(), notaloneHistoryRequest{Operation: "inspect", Account: "synthetic-owner", Conversation: "friend-b", Consent: "selected-schema-v1"}); err == nil {
		t.Fatal("不能扩大到另一目标")
	}
	result, err := session.handle(context.Background(), notaloneHistoryRequest{Operation: "inspect", Account: "synthetic-owner", Conversation: "friend-a", Consent: "selected-schema-v1"})
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(result)
	if strings.Contains(string(encoded), "private-body-sentinel") || strings.Contains(string(encoded), "friend-a") || strings.Contains(string(encoded), "synthetic-owner") {
		t.Fatal("结构响应泄露行值或身份")
	}
	var out strings.Builder
	runNotaloneHistoryWithServer(s, strings.NewReader(`{"op":"inspect","sql":"select * from anything"}`+"\n"), &out)
	if !strings.Contains(out.String(), "history_request_invalid") {
		t.Fatal("未知字段未拒绝")
	}
}
func notaloneHistoryFixture(t *testing.T) *server {
	t.Helper()
	root := t.TempDir()
	cfg := &config.Config{SchemaVersion: 2, Wxid: "synthetic-owner", DBRoot: root, Keys: map[string]string{}}
	notaloneTestDB(t, root, cfg, "session", "session.db", `CREATE TABLE SessionTable(username TEXT PRIMARY KEY,last_timestamp INTEGER,sort_timestamp INTEGER,is_hidden INTEGER);INSERT INTO SessionTable VALUES('friend-a',0,0,0),('friend-b',0,0,0);`, strings.Repeat("22", 16))
	notaloneTestDB(t, root, cfg, "contact", "contact.db", `CREATE TABLE contact(username TEXT PRIMARY KEY,remark TEXT,nick_name TEXT,verify_flag INTEGER);INSERT INTO contact VALUES('friend-a','合成目标','',0),('friend-b','另一合成目标','',0);`, strings.Repeat("33", 16))
	notaloneTestDB(t, root, cfg, "message", "message_0.db", `CREATE TABLE "Msg_`+talkerHash("friend-a")+`"(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,message_content BLOB,source BLOB);INSERT INTO "Msg_`+talkerHash("friend-a")+`"(message_content) VALUES('private-body-sentinel');`, strings.Repeat("44", 16))
	data, _ := json.Marshal(cfg)
	configFile := filepath.Join(root, "synthetic-config.json")
	if err := os.WriteFile(configFile, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WECHAT_CLI_CONFIG", configFile)
	return &server{cfg: cfg, ok: true, wcdbPath: os.Getenv("NOTALONE_TEST_WCDB")}
}

func TestNotAloneHistoryRejectsConsentBeforeSourceAccess(t *testing.T) {
	session := newNotaloneHistorySession(&server{})
	_, err := session.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "目标", Consent: "wrong"})
	if err == nil || err.Error() != "history_request_invalid" {
		t.Fatalf("许可无效时应先拒绝而不读取配置：%v", err)
	}
}

func TestNotAloneHistorySchemaAutoincrementIsNotAComment(t *testing.T) {
	db, err := wcdb.OpenPlain(filepath.Join(t.TempDir(), "syntax.db"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Exec(`CREATE TABLE Msg_noauto(local_id INTEGER PRIMARY KEY,"AUTOINCREMENT" TEXT DEFAULT 'AUTOINCREMENT' /* AUTOINCREMENT */);`); err != nil {
		t.Fatal(err)
	}
	report, err := inspectNotaloneTable(context.Background(), db, "Msg_noauto", "p")
	if err != nil {
		t.Fatal(err)
	}
	if report.AutoIncrement {
		t.Fatal("注释、默认值或列名不能证明自动分配规则")
	}
}

func TestNotAloneHistoryTableInstanceChangesAfterSameNameRecreate(t *testing.T) {
	db, err := wcdb.OpenPlain(filepath.Join(t.TempDir(), "instance.db"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ddl := `CREATE TABLE Msg_same(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER);`
	if err = db.Exec(ddl); err != nil {
		t.Fatal(err)
	}
	before, err := inspectNotaloneTable(context.Background(), db, "Msg_same", "same-file")
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Exec(`DROP TABLE Msg_same;` + ddl); err != nil {
		t.Fatal(err)
	}
	after, err := inspectNotaloneTable(context.Background(), db, "Msg_same", "same-file")
	if err != nil {
		t.Fatal(err)
	}
	if before.Target == after.Target {
		t.Fatal("同名重建不得沿用表实例身份")
	}
}
