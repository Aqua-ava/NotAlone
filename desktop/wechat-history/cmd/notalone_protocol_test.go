package main

import (
	"context"
	"encoding/json"
	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
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
	if err = writer.Exec("INSERT INTO Name2Id(rowid,user_name) VALUES(2,'" + s.selfWxid() + "')"); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	h := newNotaloneHistorySession(s)
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) {
		path, err := os.Executable()
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		path, err = filepath.EvalSymlinks(path)
		if err != nil {
			return notaloneProcessIdentity{}, err
		}
		return readNotaloneProcessIdentity(os.Getpid(), path)
	}
	t.Cleanup(h.close)
	h.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{"synthetic", "1"}, nil
	}
	if supported {
		h.certify = func(p notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
			return notaloneProfileCertification{Status: "supported", ProfileID: "synthetic-profile", ProgramVersion: p.Version, Build: p.Build, DeclaredPrimaryKey: []string{"local_id"}, StatusSemantics: "synthetic-final", Continuity: "synthetic-source", ReadProfile: notaloneSyntheticFinalReadProfilePtr(tables)}
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
	support := value.(notaloneSupportReport)
	if support.Status != "unverified" {
		t.Fatal("未知真实状态不可升级")
	}
	for _, capability := range []string{"incrementalTail", "private-history-boundary-v1"} {
		if support.Capabilities[capability] != "unverified" {
			t.Fatalf("真实profile缺少增量/边界认证时必须保持unverified: %s=%s", capability, support.Capabilities[capability])
		}
	}
	r.Operation = "target"
	r.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("门禁失效:%v", err)
	}
	h.certify = func(p notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		return notaloneProfileCertification{Status: "supported", ProfileID: "synthetic-profile", ProgramVersion: p.Version, Build: p.Build, DeclaredPrimaryKey: []string{"local_id"}, StatusSemantics: "synthetic-final", Continuity: "synthetic-source", ReadProfile: notaloneSyntheticFinalReadProfilePtr(tables)}
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

func TestNotAloneHistoryGuardSurvivesExhaustedSnapshot(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	target := value.(notaloneSnapshotTarget)
	r.Operation, r.Target = "page", target.Descriptor
	value, err = h.handle(context.Background(), r)
	if err != nil || !value.(notaloneSnapshotPage).Exhausted {
		t.Fatalf("合成快照未结束: %v", err)
	}
	r.Operation, r.Target = "target", ""
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatalf("来源未变化时应允许下一快照: %v", err)
	}
	r.Operation, r.Target = "page", value.(notaloneSnapshotTarget).Descriptor
	if _, err = h.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(h.server.cfg.DBRoot, "db_storage", "message", "message_0.db")
	if err = os.Rename(file, file+".away"); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file+".away", file); err != nil {
		t.Fatal(err)
	}
	r.Operation, r.Target = "target", ""
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_source_changed" {
		t.Fatalf("快照结束后替换来源未被持续守卫拒绝: %v", err)
	}
	guard := h.messageGuard
	h.close()
	if guard.Check() == nil {
		t.Fatal("原生会话关闭后守卫仍活动")
	}
}

func TestNotAloneHistoryGuardReportsIdleLoss(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	if _, err := h.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(h.server.cfg.DBRoot, "db_storage", "message", "message_0.db")
	if err := os.Rename(file, file+".away"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-h.messageMonitor.Lost():
	case <-time.After(2 * time.Second):
		t.Fatal("空闲时来源变化没有主动通知")
	}
}

func TestNotAloneHistoryProtocolStopsWhenIdleGuardIsLost(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	input, writer := io.Pipe()
	reader, output := io.Pipe()
	done := make(chan struct{})
	go func() { runNotaloneHistorySession(h, input, output); _ = output.Close(); close(done) }()
	t.Cleanup(func() { _ = writer.Close(); _ = reader.Close() })
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	encoded, _ := json.Marshal(r)
	if _, err := writer.Write(append(encoded, '\n')); err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.NewDecoder(reader).Decode(&response); err != nil || response["ok"] != true {
		t.Fatalf("合成目标未成功: %v", err)
	}
	file := filepath.Join(h.server.cfg.DBRoot, "db_storage", "message", "message_0.db")
	if err := os.Rename(file, file+".away"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("空闲来源失证后原生协议未退出")
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

func TestNotAloneHistoryMetadataProtocolNeverGrantsNormalHistory(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	request := notaloneHistoryRequest{Operation: "observe-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-message-metadata-v1", Kind: "text"}
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneMetadataReport)
	if report.Record == nil || report.Record.NormalHistory || report.Record.StatusSemantics != "unverified" || report.Status != "unverified" {
		t.Fatal("元数据观察授予了普通消息资格")
	}
	data, _ := json.Marshal(report)
	for _, forbidden := range []string{"private-body-sentinel", `"body":`, `"source":`, `"text":`} {
		if strings.Contains(string(data), forbidden) {
			t.Fatal("观察泄漏正文或来源内容")
		}
	}
	request.Kind = ""
	request.Operation = "target"
	request.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), request); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("观察绕过了正文门禁:%v", err)
	}
}
func TestNotAloneHistoryMetadataProtocolRejectsBeforeSourceAccess(t *testing.T) {
	for _, request := range []notaloneHistoryRequest{
		{Operation: "observe-metadata", Account: "a", Conversation: "b", Consent: "wrong", Kind: "text"},
		{Operation: "observe-metadata", Account: "a", Conversation: "b", Consent: "selected-message-metadata-v1", Kind: "all"},
		{Operation: "observe-metadata", Account: "a", Conversation: "b", Consent: "selected-message-metadata-v1", Kind: "text", Target: "injected"},
		{Operation: "resolve", Consent: "selected-metadata-v1", DisplayName: "x", Kind: "text"},
		{Operation: "observe-test-metadata", Account: "a", Conversation: "b", Consent: "wrong", Kind: "arm"},
		{Operation: "observe-test-metadata", Account: "a", Conversation: "b", Consent: "selected-test-lifecycle-metadata-v1", Kind: "all"},
		{Operation: "observe-test-metadata", Account: "a", Conversation: "b", Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm", Target: "injected"},
		{Operation: "observe-received-test-metadata", Account: "a", Conversation: "b", Consent: "wrong", Kind: "arm"},
		{Operation: "observe-received-test-metadata", Account: "a", Conversation: "b", Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"},
		{Operation: "observe-received-test-metadata", Account: "a", Conversation: "b", Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "all"},
		{Operation: "observe-received-test-metadata", Account: "a", Conversation: "b", Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "arm", Target: "injected"},
		{Operation: "observe-received-test-metadata", Account: "a", Conversation: "b", Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "arm", Cursor: "injected"},
		{Operation: "observe-received-test-metadata", Account: "a", Conversation: "b", Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "arm", DisplayName: "injected"},
	} {
		h := newNotaloneHistorySession(&server{})
		_, err := h.handle(context.Background(), request)
		h.close()
		if err == nil || err.Error() != "history_request_invalid" {
			t.Fatalf("错误许可/类型先访问了来源:%v", err)
		}
	}
}

func TestNotAloneReceivedTestMetadataProtocolUsesSeparateWatchAndKeepsHistoryGate(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	received := notaloneHistoryRequest{Operation: "observe-received-test-metadata", Account: h.selected.Account,
		Conversation: h.selected.Conversation, Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "arm"}
	value, err := h.handle(context.Background(), received)
	if err != nil {
		t.Fatal(err)
	}
	report, ok := value.(notaloneTestMetadataReport)
	if !ok || report.Format != "wechat-received-test-metadata-observation-v1" || report.Status != "unverified" || report.LockedCount != 0 || len(report.Records) != 0 {
		t.Fatalf("接收观察报告不符合隔离合同: %#v", value)
	}
	if h.receivedTestMetadata == nil || h.testMetadata != nil || h.messageGuard == nil || h.messageMonitor == nil {
		t.Fatal("接收模式没有独立watch或双队列来源守卫")
	}

	owner := notaloneHistoryRequest{Operation: "observe-test-metadata", Account: h.selected.Account,
		Conversation: h.selected.Conversation, Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"}
	value, err = h.handle(context.Background(), owner)
	if err != nil {
		t.Fatal(err)
	}
	ownerReport := value.(notaloneTestMetadataReport)
	if ownerReport.Format != "wechat-test-metadata-observation-v1" || h.testMetadata == nil || h.testMetadata == h.receivedTestMetadata.watch {
		t.Fatal("owner与received协议状态或响应格式发生混用")
	}

	received.Kind = "next"
	value, err = h.handle(context.Background(), received)
	if err != nil {
		t.Fatal(err)
	}
	if value.(notaloneTestMetadataReport).Format != "wechat-received-test-metadata-observation-v1" {
		t.Fatal("接收next误用了owner响应格式")
	}
	received.Kind = ""
	received.Operation = "target"
	received.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), received); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("接收观察绕过了正文门禁: %v", err)
	}
}

func TestNotAloneReceivedTestMetadataProcessExitBetweenPhasesLatchesSession(t *testing.T) {
	for _, action := range []string{"next", "current"} {
		t.Run(action, func(t *testing.T) {
			h := notaloneProtocolFixture(t, false)
			identity, stopProcess := notaloneStartCatIdentity(t)
			defer stopProcess()
			h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) { return identity, nil }
			r := notaloneHistoryRequest{Operation: "observe-received-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation,
				Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "arm"}
			if _, err := h.handle(context.Background(), r); err != nil {
				t.Fatalf("合成arm失败: %v", err)
			}
			if h.messageGuard == nil || h.messageMonitor == nil || h.receivedTestMetadata == nil {
				t.Fatal("接收观察器没有绑定双队列微信进程守卫")
			}
			stopProcess()
			select {
			case <-h.guardLost:
			case <-time.After(2 * time.Second):
				t.Fatal("进程退出未锁存来源失效")
			}
			r.Kind = action
			if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_source_changed" {
				t.Fatalf("旧原生客户端在进程退出后继续接收观察: %v", err)
			}
		})
	}
}

func TestNotAloneReceivedTestMetadataProcessExitDuringNextDoesNotReturnReport(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	identity, stopProcess := notaloneStartCatIdentity(t)
	defer stopProcess()
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) { return identity, nil }
	r := notaloneHistoryRequest{Operation: "observe-received-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation,
		Consent: "selected-received-test-lifecycle-metadata-v1", Kind: "arm"}
	if _, err := h.handle(context.Background(), r); err != nil {
		t.Fatalf("合成arm失败: %v", err)
	}
	h.receivedTestMetadata.watch.beforeCapture = func(context.Context, *notaloneSnapshot) error {
		stopProcess()
		return nil
	}
	r.Kind = "next"
	if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_source_changed" {
		t.Fatalf("next期间源进程退出仍返回报告: %v", err)
	}
}

func TestNotAloneHistoryTestMetadataProtocolKeepsHistoryGate(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	r := notaloneHistoryRequest{Operation: "observe-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	report := value.(notaloneTestMetadataReport)
	if report.Status != "unverified" || report.LockedCount != 0 || len(report.Records) != 0 {
		t.Fatal(report)
	}
	r.Kind = "next"
	if _, err = h.handle(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	r.Kind = ""
	r.Operation = "target"
	r.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("开发诊断不能授予正文资格:%v", err)
	}
}

func TestNotAloneTestMetadataRejectsUnverifiedProcessBeforeArm(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) {
		return notaloneProcessIdentity{}, os.ErrNotExist
	}
	r := notaloneHistoryRequest{Operation: "observe-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation,
		Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"}
	if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_source_unverified" {
		t.Fatalf("未确认源进程却开启状态观察: %v", err)
	}
	if h.testMetadata != nil || h.messageGuard != nil || h.messageMonitor != nil {
		t.Fatal("源进程未认证时留下了观察器或守卫")
	}
}

func TestNotAloneTestMetadataRejectsSamePIDWithStaleStartTime(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	identity, stopProcess := notaloneStartCatIdentity(t)
	defer stopProcess()
	stale := identity
	if stale.startMicros > 0 {
		stale.startMicros--
	} else {
		stale.startSeconds--
	}
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) { return stale, nil }
	r := notaloneHistoryRequest{Operation: "observe-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation,
		Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"}
	if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_source_unverified" {
		t.Fatalf("同PID的过期启动身份通过守卫: %v", err)
	}
	if h.testMetadata != nil || h.messageGuard != nil || h.messageMonitor != nil {
		t.Fatal("过期启动身份留下了观察器或守卫")
	}
}

func TestNotAloneTestMetadataProcessExitBetweenPhasesLatchesSession(t *testing.T) {
	for _, action := range []string{"next", "current"} {
		t.Run(action, func(t *testing.T) {
			h := notaloneProtocolFixture(t, false)
			identity, stopProcess := notaloneStartCatIdentity(t)
			defer stopProcess()
			h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) { return identity, nil }
			r := notaloneHistoryRequest{Operation: "observe-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation,
				Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"}
			if _, err := h.handle(context.Background(), r); err != nil {
				t.Fatalf("合成arm失败: %v", err)
			}
			if h.messageGuard == nil || h.messageMonitor == nil {
				t.Fatal("状态观察器没有绑定微信进程守卫")
			}
			stopProcess()
			select {
			case <-h.guardLost:
			case <-time.After(2 * time.Second):
				t.Fatal("进程退出未锁存来源失效")
			}
			r.Kind = action
			if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_source_changed" {
				t.Fatalf("旧原生客户端在进程退出后继续观察: %v", err)
			}
		})
	}
}

func TestNotAloneTestMetadataProcessExitDuringNextDoesNotReturnReport(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	identity, stopProcess := notaloneStartCatIdentity(t)
	defer stopProcess()
	h.sourceProcess = func(context.Context) (notaloneProcessIdentity, error) { return identity, nil }
	r := notaloneHistoryRequest{Operation: "observe-test-metadata", Account: h.selected.Account, Conversation: h.selected.Conversation,
		Consent: "selected-test-lifecycle-metadata-v1", Kind: "arm"}
	if _, err := h.handle(context.Background(), r); err != nil {
		t.Fatalf("合成arm失败: %v", err)
	}
	h.testMetadata.beforeCapture = func(context.Context, *notaloneSnapshot) error {
		stopProcess()
		return nil
	}
	r.Kind = "next"
	if _, err := h.handle(context.Background(), r); err == nil || err.Error() != "history_source_changed" {
		t.Fatalf("next期间源进程退出仍返回报告: %v", err)
	}
}

func notaloneStartCatIdentity(t *testing.T) (notaloneProcessIdentity, func()) {
	t.Helper()
	command := exec.Command("/bin/cat")
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stdout = io.Discard
	if err = command.Start(); err != nil {
		_ = stdin.Close()
		t.Fatal(err)
	}
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			_ = stdin.Close()
			if command.Process != nil {
				_ = command.Process.Signal(syscall.SIGTERM)
			}
			_ = command.Wait()
		})
	}
	path, err := filepath.EvalSymlinks("/bin/cat")
	if err != nil {
		stop()
		t.Fatal(err)
	}
	deadline := time.NewTimer(2 * time.Second)
	tick := time.NewTicker(time.Millisecond)
	defer deadline.Stop()
	defer tick.Stop()
	for {
		identity, identityErr := readNotaloneProcessIdentity(command.Process.Pid, path)
		if identityErr == nil {
			return identity, stop
		}
		select {
		case <-tick.C:
		case <-deadline.C:
			stop()
			t.Fatalf("无法核对合成cat进程身份: %v", identityErr)
		}
	}
}
