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

func TestNotAloneReleaseSelectionSwitchesWithoutReusingSnapshot(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	ctx := context.Background()
	account, generation := h.selected.Account, h.selected.SourceGeneration
	// 第二位联系人具有独立消息内容，用协议读取结果检查隔离。
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	err = writer.Exec(`CREATE TABLE "Msg_` + talkerHash("friend-b") + `"(local_id INTEGER PRIMARY KEY AUTOINCREMENT,server_id INTEGER,local_type INTEGER,sort_seq INTEGER,real_sender_id INTEGER,create_time INTEGER,status INTEGER,message_content BLOB,source BLOB);INSERT INTO "Msg_` + talkerHash("friend-b") + `" VALUES(1,0,1,0,3,1700000000,0,'friend-b-only',NULL);INSERT INTO Name2Id(rowid,user_name) VALUES(3,'friend-b');`)
	writer.Close()
	if err != nil {
		t.Fatal(err)
	}
	targetRequest := notaloneHistoryRequest{Operation: "target", Account: account, Conversation: "friend-a", Consent: "selected-history-v1"}
	value, err := h.handle(ctx, targetRequest)
	if err != nil {
		t.Fatal(err)
	}
	oldTarget := value.(notaloneSnapshotTarget)
	messageGuard, metadataGuard := h.messageGuard, h.guards[0]
	release := notaloneHistoryRequest{Operation: "release-selection", Account: account, Conversation: "friend-a", Consent: "selected-metadata-v1"}
	wrong := release
	wrong.Conversation = "friend-b"
	if _, err := h.handle(ctx, wrong); err == nil {
		t.Fatal("其他联系人不得释放当前范围")
	}
	value, err = h.handle(ctx, release)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(value)
	if string(encoded) != `{"released":true}` {
		t.Fatalf("释放响应错误：%s", encoded)
	}
	if h.messageGuard != messageGuard || h.guards[0] != metadataGuard || messageGuard.Check() != nil || metadataGuard.Check() != nil {
		t.Fatal("切换丢失账号级守卫")
	}
	if _, err := h.handle(ctx, targetRequest); err == nil {
		t.Fatal("释放后仍可读取旧范围")
	}
	value, err = h.handle(ctx, notaloneHistoryRequest{Operation: "resolve", DisplayName: "friend-b", Consent: "selected-metadata-v1"})
	if err != nil {
		t.Fatal(err)
	}
	if value.(notaloneResolved).SourceGeneration != generation {
		t.Fatal("切换改变账号来源代次")
	}
	targetRequest.Conversation = "friend-b"
	value, err = h.handle(ctx, targetRequest)
	if err != nil {
		t.Fatal(err)
	}
	newTarget := value.(notaloneSnapshotTarget)
	pageRequest := targetRequest
	pageRequest.Operation = "page"
	pageRequest.Target = oldTarget.Descriptor
	if _, err = h.handle(ctx, pageRequest); err == nil {
		t.Fatal("接受旧联系人目标")
	}
	pageRequest.Target = newTarget.Descriptor
	value, err = h.handle(ctx, pageRequest)
	if err != nil {
		t.Fatal(err)
	}
	page := value.(notaloneSnapshotPage)
	if len(page.Records) != 1 || page.Records[0].Text == nil || *page.Records[0].Text != "friend-b-only" {
		t.Fatalf("跨联系人内容隔离失败：%#v", page)
	}
	release.Conversation = "friend-b"
	if _, err = h.handle(ctx, release); err != nil {
		t.Fatal(err)
	}
	if _, err = h.handle(ctx, notaloneHistoryRequest{Operation: "resolve", DisplayName: "friend-a", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	pageRequest.Conversation = "friend-a"
	pageRequest.Target = oldTarget.Descriptor
	if _, err = h.handle(ctx, pageRequest); err == nil {
		t.Fatal("回到同联系人后旧目标复活")
	}
}

func TestNotAloneReleaseSelectionRejectsInvalidPermissionAndChangedAccount(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	request := notaloneHistoryRequest{Operation: "release-selection", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-metadata-v1"}
	invalid := request
	invalid.Consent = "selected-history-v1"
	if _, err := h.handle(context.Background(), invalid); err == nil {
		t.Fatal("接受错误许可")
	}
	invalid = request
	invalid.ResourceToken = "forbidden"
	if _, err := h.handle(context.Background(), invalid); err == nil {
		t.Fatal("接受额外资源范围")
	}
	configPath := os.Getenv("WECHAT_CLI_CONFIG")
	if err := os.WriteFile(configPath, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.handle(context.Background(), request); err == nil || err.Error() != "history_account_changed" {
		t.Fatalf("账号变化未拒绝：%v", err)
	}
}

func TestNotAloneAllSessionsMetadataIncludesGroupAndSearchWithoutBodies(t *testing.T) {
	h := accountMetadataFixture(t, true)
	session := accountMetadataWriter(t, h, "session")
	if err := session.Exec(`INSERT INTO SessionTable(username,is_hidden,summary,sort_timestamp) VALUES('missing@chatroom',0,'NEVER_READ_BODY',900),('hidden@chatroom',1,'NEVER_READ_BODY',999);`); err != nil {
		t.Fatal(err)
	}
	request := notaloneHistoryRequest{Operation: "metadata-sessions-all", Account: h.selected.Account, Consent: "all-session-list-metadata-v1", Limit: 100}
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneAllSessionMetadataReport)
	if len(report.Sessions) != 3 || report.Sessions[0].Username != "missing@chatroom" || report.Sessions[0].DisplayName != "missing@chatroom" || report.Sessions[0].Kind != "group" {
		t.Fatalf("缺失群昵称影响名单：%#v", report.Sessions)
	}
	encoded, _ := json.Marshal(report)
	if strings.Contains(string(encoded), "NEVER_READ_BODY") || strings.Contains(string(encoded), "BODY_SENTINEL") || strings.Contains(string(encoded), "summary") {
		t.Fatal("身份名单泄漏正文")
	}
	request.Keyword = "另一 合成目标"
	request.Limit = 1
	value, err = h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	report = value.(notaloneAllSessionMetadataReport)
	if len(report.Sessions) != 1 || report.Sessions[0].Username != "friend-b" {
		t.Fatalf("定向名称过滤失败：%#v", report.Sessions)
	}
	request.Consent = "private-session-list-metadata-v1"
	if _, err = h.handle(context.Background(), request); err == nil {
		t.Fatal("私聊许可扩大到全部类型")
	}
	request.Consent = "all-session-list-metadata-v1"
	request.Account = "other-owner"
	if _, err = h.handle(context.Background(), request); err == nil {
		t.Fatal("未核对账号")
	}
}

func TestNotAloneReleaseSelectionInvalidatesImageTokenAndObservationBaseline(t *testing.T) {
	fixture := newNotaloneImageProtocolFixtureWithImage(t, "", notaloneTinyPNG(t, 3, 2))
	h := fixture.history
	value, err := h.handle(context.Background(), fixture.request)
	if err != nil {
		t.Fatal(err)
	}
	token := value.(notaloneImageOpenResponse).ResourceToken
	h.testMetadata = newNotaloneTestMetadataWatch()
	h.receivedTestMetadata = newNotaloneReceivedTestMetadataWatch()
	sent, received := h.testMetadata, h.receivedTestMetadata
	release := notaloneHistoryRequest{Operation: "release-selection", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-metadata-v1"}
	if _, err = h.handle(context.Background(), release); err != nil {
		t.Fatal(err)
	}
	if sent.life.Err() == nil || received.watch.life.Err() == nil {
		t.Fatal("切换后仍保留观察基线")
	}
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: release.Conversation, Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "image-read", ResourceToken: token}); err == nil || err.Error() != "history_image_token_invalid" {
		t.Fatalf("旧图片token未失效：%v", err)
	}
}

func TestNotAloneAllSessionsRejectsMalformedAndDuplicateContactMetadata(t *testing.T) {
	for _, kind := range []string{"invalid-name", "duplicate-identity"} {
		t.Run(kind, func(t *testing.T) {
			h := accountMetadataFixture(t, true)
			contact := accountMetadataWriter(t, h, "contact")
			statement := `UPDATE contact SET remark=char(10) WHERE username='friend-b'`
			if kind == "duplicate-identity" {
				statement = `INSERT INTO contact(username,remark,nick_name,verify_flag) VALUES('friend-b','冲突','','0')`
			}
			if err := contact.Exec(statement); err != nil {
				t.Fatal(err)
			}
			_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "metadata-sessions-all", Account: h.selected.Account, Consent: "all-session-list-metadata-v1", Limit: 100})
			if err == nil {
				t.Fatal("无效身份被跳过，可能造成错误唯一匹配")
			}
		})
	}
}
