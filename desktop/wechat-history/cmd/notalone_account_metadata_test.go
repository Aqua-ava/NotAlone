package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func accountMetadataFixture(t *testing.T, verified bool) *notaloneHistorySession {
	t.Helper()
	h := newNotaloneHistorySession(notaloneHistoryFixture(t))
	t.Cleanup(h.close)
	h.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{"4.0.6", "29387"}, nil
	}
	for _, dir := range []string{"session", "contact"} {
		warm := "UPDATE SessionTable SET is_hidden=is_hidden"
		if dir == "contact" {
			warm = "UPDATE contact SET verify_flag=verify_flag"
		}
		if err := accountMetadataWriter(t, h, dir).Exec("PRAGMA journal_mode=WAL;" + warm); err != nil {
			t.Fatal(err)
		}
	}
	if verified {
		// 独立合成v9的完整声明；摘要列只放哨兵，不作为名单输入。
		session := accountMetadataWriter(t, h, "session")
		contact := accountMetadataWriter(t, h, "contact")
		if err := session.Exec(`DROP TABLE SessionTable;CREATE TABLE SessionTable(username TEXT PRIMARY KEY,type INTEGER,unread_count INTEGER,unread_first_msg_srv_id INTEGER,unread_first_pat_msg_local_id INTEGER,unread_first_pat_msg_sort_seq INTEGER,is_hidden INTEGER,summary TEXT,draft TEXT,status INTEGER,last_timestamp INTEGER,sort_timestamp INTEGER,last_clear_unread_timestamp INTEGER,last_msg_locald_id INTEGER,last_msg_type INTEGER,last_msg_sub_type INTEGER,last_msg_sender TEXT,last_sender_display_name TEXT,last_msg_ext_type INTEGER);CREATE INDEX session_type ON SessionTable(type);CREATE INDEX session_sender ON SessionTable(last_msg_sender);INSERT INTO SessionTable(username,is_hidden,summary,draft) VALUES('friend-a',0,'BODY_SENTINEL','DRAFT_SENTINEL'),('friend-b',0,'BODY_SENTINEL','DRAFT_SENTINEL');`); err != nil {
			t.Fatal(err)
		}
		if err := contact.Exec(`DROP TABLE contact;CREATE TABLE contact(id INTEGER PRIMARY KEY,username TEXT,local_type INTEGER,alias TEXT,encrypt_username TEXT,flag INTEGER,delete_flag INTEGER,verify_flag INTEGER,remark TEXT,remark_quan_pin TEXT,remark_pin_yin_initial TEXT,nick_name TEXT,pin_yin_initial TEXT,quan_pin TEXT,big_head_url TEXT,small_head_url TEXT,head_img_md5 TEXT,chat_room_notify INTEGER,is_in_chat_room INTEGER,description TEXT,extra_buffer BLOB,chat_room_type INTEGER);CREATE INDEX contact_kind ON contact(local_type);INSERT INTO contact(username,remark,nick_name,verify_flag) VALUES('friend-a','合成目标','',0),('friend-b','另一合成目标','',0);`); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	return h
}
func accountMetadataRequest() notaloneHistoryRequest {
	return notaloneHistoryRequest{Operation: "metadata-account", Consent: "account-session-metadata-v1"}
}
func accountMetadataWriter(t *testing.T, h *notaloneHistorySession, dir string) *wcdb.DB {
	t.Helper()
	db, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage", dir, dir+".db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	return db
}

func TestNotAloneAccountSchemaOnlyFixedMetadataDeclarations(t *testing.T) {
	h := accountMetadataFixture(t, false)
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "inspect-account-schema", Consent: "account-schema-v1"})
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneAccountSchemaReport)
	if report.Status != "unverified" || report.NormalHistory || len(report.Tables) != 2 || report.Tables[0].Role != "session" || report.Tables[1].Role != "contact" || report.SourceGeneration != h.selected.SourceGeneration {
		t.Fatal(report)
	}
	encoded, _ := json.Marshal(report)
	for _, forbidden := range []string{"合成目标", "friend-a", "private-body-sentinel", "last_timestamp\":0"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("结构诊断读取了记录")
		}
	}
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "inspect-account-schema", Consent: "account-schema-v1", Account: "injected"}); err == nil {
		t.Fatal("结构诊断接受调用者账号")
	}
}

func TestNotAloneAccountMetadataRequiresConfiguredAccountProof(t *testing.T) {
	h := accountMetadataFixture(t, false)
	value, err := h.handle(context.Background(), accountMetadataRequest())
	if err != nil {
		t.Fatal(err)
	}
	account := value.(notaloneAccountMetadataReport)
	if account.Status != "unverified" || account.Reason == nil || *account.Reason != "history_metadata_profile_unverified" || account.ConfiguredAccount != "unverified" || account.NormalHistory || account.SourceGeneration != h.selected.SourceGeneration || account.AccountKey != h.server.cfg.Wxid {
		t.Fatal(account)
	}
	_, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "metadata-sessions", Account: account.AccountKey, Consent: "private-session-list-metadata-v1"})
	if err == nil || err.Error() != "history_metadata_profile_unverified" {
		t.Fatalf("配置和持有实例不能认证元数据支持档：%v", err)
	}
}

func TestNotAloneAccountMetadataSyntheticIdentityDoesNotAuthorizeHistory(t *testing.T) {
	h := accountMetadataFixture(t, true)
	value, err := h.handle(context.Background(), accountMetadataRequest())
	if err != nil {
		t.Fatal(err)
	}
	account := value.(notaloneAccountMetadataReport)
	if account.Status != "verified" || account.Reason != nil || account.NormalHistory {
		t.Fatal(account)
	}
	value, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "metadata-sessions", Account: account.AccountKey, Consent: "private-session-list-metadata-v1"})
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notalonePrivateSessionMetadataReport)
	if len(report.Sessions) != 2 || report.Account.SourceGeneration != h.selected.SourceGeneration {
		t.Fatal(report)
	}
	encoded, _ := json.Marshal(report)
	for _, forbidden := range []string{"message_content", "private-body-sentinel", "source-secret", "last_timestamp", "sort_timestamp"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("读取了名单以外字段")
		}
	}
	_, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"})
	if err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("metadata资格不能放行正文：%v", err)
	}
}

func TestNotAloneAccountMetadataUnknownVersionAndInvalidRequests(t *testing.T) {
	h := accountMetadataFixture(t, true)
	h.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{"9.9.9", "1"}, nil
	}
	value, err := h.handle(context.Background(), accountMetadataRequest())
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneAccountMetadataReport)
	if report.Status != "unverified" || report.Reason == nil || *report.Reason != "history_program_version_uncertified" {
		t.Fatal(report)
	}
	for _, request := range []notaloneHistoryRequest{{Operation: "metadata-account", Consent: "wrong"}, {Operation: "metadata-account", Consent: "account-session-metadata-v1", Account: "injected"}, {Operation: "metadata-sessions", Consent: "private-session-list-metadata-v1", Account: "another-owner"}} {
		if _, err = h.handle(context.Background(), request); err == nil {
			t.Fatal("接受了非法许可/账号")
		}
	}
}

func TestNotAlonePrivateSessionsRejectsIncompleteOrDuplicateMetadata(t *testing.T) {
	for _, mode := range []string{"duplicate", "duplicate-contact", "missing-contact", "over-limit", "non-private", "non-private-no-contact", "hidden"} {
		t.Run(mode, func(t *testing.T) {
			h := accountMetadataFixture(t, true)
			session := accountMetadataWriter(t, h, "session")
			contact := accountMetadataWriter(t, h, "contact")
			var err error
			switch mode {
			case "duplicate":
				err = session.Exec("DROP TABLE SessionTable;CREATE TABLE SessionTable(username TEXT,is_hidden INTEGER);INSERT INTO SessionTable VALUES('friend-a',0),('friend-a',0)")
			case "duplicate-contact":
				err = contact.Exec("INSERT INTO contact(username,remark,nick_name,verify_flag) VALUES('friend-a','歧义身份','',0)")
			case "missing-contact":
				err = session.Exec("INSERT INTO SessionTable(username,is_hidden) VALUES('missing-person',0)")
			case "over-limit":
				err = session.Exec("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<5001) INSERT INTO SessionTable(username,is_hidden) SELECT 'synthetic-'||x,0 FROM n")
			case "non-private":
				err = contact.Exec("INSERT INTO contact(username,remark,nick_name,verify_flag) VALUES('group@chatroom','合成群','',0),('gh_synthetic','合成公众号','',0),('verified-person','认证号','',1)")
				if err == nil {
					err = session.Exec("INSERT INTO SessionTable(username,is_hidden) VALUES('group@chatroom',0),('gh_synthetic',0),('verified-person',0)")
				}
			case "non-private-no-contact":
				err = session.Exec("INSERT INTO SessionTable(username,is_hidden) VALUES('team@chatroom',0),('gh_synthetic',0),('biz_synthetic',0),('corp@openim',0),('bot@weclaw',0),('stranger@stranger',0),('brandsessionholder',0)")
			case "hidden":
				err = contact.Exec("INSERT INTO contact(username,remark,nick_name,verify_flag) VALUES('hidden-person','隐藏','',0),('unknown-hidden','未知隐藏状态','',0)")
				if err == nil {
					err = session.Exec("INSERT INTO SessionTable(username,is_hidden) VALUES('hidden-person',1),('unknown-hidden',NULL)")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "metadata-sessions", Account: h.server.cfg.Wxid, Consent: "private-session-list-metadata-v1"})
			if mode == "non-private" || mode == "non-private-no-contact" || mode == "hidden" {
				if err != nil || len(value.(notalonePrivateSessionMetadataReport).Sessions) != 2 {
					t.Fatalf("非私聊进入名单：%v %v", value, err)
				}
			} else if err == nil {
				t.Fatal("重复/缺元数据/超量不能当作完整名单")
			}
		})
	}
}

func TestNotAloneAccountMetadataProfileRequiresCompleteShape(t *testing.T) {
	baseline := []notaloneTableSchema{notaloneAccountMetadataExpected("session"), notaloneAccountMetadataExpected("contact")}
	if !notaloneAccountMetadataShapeVerified(baseline) {
		t.Fatal("profile自身声明不完整")
	}
	for _, mode := range []string{"column", "index-group", "index-partial", "primary-key", "autoincrement", "trigger", "role"} {
		t.Run(mode, func(t *testing.T) {
			encoded, _ := json.Marshal(baseline)
			var tables []notaloneTableSchema
			_ = json.Unmarshal(encoded, &tables)
			switch mode {
			case "column":
				tables[0].Columns[0].NotNull = true
			case "index-group":
				tables[0].Indexes[0].Columns[0].Name = "username"
			case "index-partial":
				tables[0].Indexes[0].Partial = true
			case "primary-key":
				tables[1].DeclaredPrimaryKey = []string{"username"}
			case "autoincrement":
				tables[1].AutoIncrement = true
			case "trigger":
				tables[1].TriggerFingerprints = []string{"unexpected"}
			case "role":
				tables[1].Role = "session"
			}
			if notaloneAccountMetadataShapeVerified(tables) {
				t.Fatal("仅字段存在不能提升metadata资格")
			}
		})
	}
}

func TestNotAloneAccountMetadataRejectsAccountOrSourceChange(t *testing.T) {
	for _, mode := range []string{"account", "source"} {
		t.Run(mode, func(t *testing.T) {
			h := accountMetadataFixture(t, true)
			if _, err := h.handle(context.Background(), accountMetadataRequest()); err != nil {
				t.Fatal(err)
			}
			if mode == "account" {
				copy := *h.server.cfg
				copy.Wxid = "another-owner"
				data, _ := json.Marshal(copy)
				if err := os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), data, 0600); err != nil {
					t.Fatal(err)
				}
			} else {
				file := filepath.Join(h.server.cfg.DBRoot, "db_storage", "session", "session.db")
				if err := os.Rename(file, file+".held"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := h.handle(context.Background(), accountMetadataRequest()); err == nil {
				t.Fatal("账号或来源改变仍接受旧证明")
			}
		})
	}
}
