package main

import (
	"context"
	"encoding/json"
	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"os"
	"path/filepath"
	"testing"
)

func notaloneProtocolFixture(t *testing.T, supported bool) *notaloneHistorySession {
	t.Helper()
	s := notaloneHistoryFixture(t)
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(s.cfg.DBRoot, "db_storage/message/message_0.db"), s.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	if err = writer.Exec(`CREATE TABLE Name2Id(user_name TEXT);INSERT INTO Name2Id(rowid,user_name) VALUES(1,'friend-a');UPDATE "Msg_` + talkerHash("friend-a") + `" SET server_id=0,local_type=1,real_sender_id=1,create_time=1700000000,status=0;`); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	h := newNotaloneHistorySession(s)
	t.Cleanup(h.close)
	h.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{"synthetic", "1"}, nil
	}
	if supported {
		h.certify = func(p notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
			return notaloneProfileCertification{Status: "supported", ProfileID: "synthetic-profile", ProgramVersion: p.Version, Build: p.Build, DeclaredPrimaryKey: []string{"local_id"}, StatusSemantics: "synthetic-final", Continuity: "synthetic-source", ReadProfile: &notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(tables), AllowedStatuses: []int64{0}}}
		}
	}
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	return h
}
func TestNotAloneHistoryProtocolGateAndTypedSnapshot(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	r := notaloneHistoryRequest{Operation: "support", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-schema-v1"}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if value.(notaloneSupportReport).Status != "unverified" {
		t.Fatal("未知真实状态不可升级")
	}
	r.Operation = "target"
	r.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("门禁失效:%v", err)
	}
	h.certify = func(p notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		return notaloneProfileCertification{Status: "supported", ProfileID: "synthetic-profile", ProgramVersion: p.Version, Build: p.Build, DeclaredPrimaryKey: []string{"local_id"}, StatusSemantics: "synthetic-final", Continuity: "synthetic-source", ReadProfile: &notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(tables), AllowedStatuses: []int64{0}}}
	}
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	target := value.(notaloneSnapshotTarget)
	r.Operation = "page"
	r.Target = "other"
	if _, err = h.handle(context.Background(), r); err == nil {
		t.Fatal("接受了外来目标")
	}
	r.Target = target.Descriptor
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	page := value.(notaloneSnapshotPage)
	if len(page.Records) != 1 || page.Records[0].Text == nil || *page.Records[0].Text != "private-body-sentinel" || !page.Exhausted {
		t.Fatal("合成正常消息或终页缺失")
	}
	held := h.snapshot
	h.close()
	if held.Check() == nil {
		t.Fatal("session关闭后reader仍活动")
	}
}
func TestNotAloneHistoryProtocolRejectsScopeBeforeHistory(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: "friend-b", Consent: "selected-history-v1"}
	if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_scope_unverified" {
		t.Fatalf("目标越界:%v", err)
	}
	r.Conversation = h.selected.Conversation
	r.Consent = "selected-schema-v1"
	if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_request_invalid" {
		t.Fatal("无历史许可仍读取")
	}
}

func TestNotAloneHistoryInitializationRejectsMissingRootBeforeDiscovery(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config.json")
	for _, root := range []string{"", "relative-root", "/absolute/../noncanonical"} {
		cfg := config.Config{SchemaVersion: 2, Wxid: "synthetic-owner", DBRoot: root, Keys: map[string]string{"contact/contact.db": "synthetic"}}
		bytes, _ := json.Marshal(cfg)
		if err := os.WriteFile(file, bytes, 0600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("WECHAT_CLI_CONFIG", file)
		h := newNotaloneHistorySession(&server{})
		_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"})
		h.close()
		if err == nil || err.Error() != "history_account_unavailable" || h.server.ok {
			t.Fatalf("不完整配置进入了目录发现或打开:%v", err)
		}
	}
}

func TestNotAloneHistoryFailedResolveReleasesMetadataGuards(t *testing.T) {
	h := newNotaloneHistorySession(notaloneHistoryFixture(t))
	defer h.close()
	for i := 0; i < 40; i++ {
		_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "不存在的合成名字", Consent: "selected-metadata-v1"})
		if err == nil || len(h.guards) != 0 || h.selected != nil {
			t.Fatalf("失败绑定保留了guard:%v %d", err, len(h.guards))
		}
	}
}
func TestNotAloneHistoryResolveReentryRejectsChangedAccountBeforeMetadata(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	cfg := *h.server.cfg
	cfg.Wxid = "different-owner"
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), data, 0600); err != nil {
		t.Fatal(err)
	}
	_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "不存在名字", Consent: "selected-metadata-v1"})
	if err == nil || err.Error() != "history_account_changed" {
		t.Fatalf("重新resolve先读取旧账号元数据:%v", err)
	}
}

func TestNotAloneHistoryFailedResolveThenAccountChangeRejectsBeforeMetadata(t *testing.T) {
	h := newNotaloneHistorySession(notaloneHistoryFixture(t))
	defer h.close()
	request := notaloneHistoryRequest{Operation: "resolve", DisplayName: "不存在的合成名字", Consent: "selected-metadata-v1"}
	if _, err := h.handle(context.Background(), request); err == nil {
		t.Fatal("应先未匹配")
	}
	cfg := *h.server.cfg
	cfg.Wxid = "changed-owner"
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := h.handle(context.Background(), request); err == nil || err.Error() != "history_account_changed" {
		t.Fatalf("失败重试读取旧账号元数据:%v", err)
	}
}
