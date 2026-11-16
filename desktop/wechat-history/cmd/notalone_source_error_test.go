package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func TestNotAloneProtocolBusySourceDoesNotBecomeSchemaChange(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if err = writer.Exec("BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	request := notaloneHistoryRequest{Operation: "inspect", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-schema-v1"}
	if _, err = h.handle(context.Background(), request); err == nil || err.Error() != "history_source_temporarily_unavailable" {
		t.Fatalf("来源暂时繁忙不能误报为结构或身份变化: %v", err)
	}
	if h.snapshot != nil || h.tail != nil || h.checkpointOfferedCursor != "" {
		t.Fatal("安全停读不能创建快照、增量或推进恢复点")
	}
	if err = writer.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), request)
	if err != nil || len(value.(notaloneInspection).Tables) != 1 {
		t.Fatalf("来源解锁后应可直接重试: %v", err)
	}
}

func TestNotAloneAccountBusySourceDoesNotBecomeIdentityFailure(t *testing.T) {
	h := notaloneProtocolFixture(t, true)
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/session/session.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if err = writer.Exec("BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	request := notaloneHistoryRequest{Operation: "metadata-account", Consent: "account-session-metadata-v1"}
	if _, err = h.handle(context.Background(), request); err == nil || err.Error() != "history_source_temporarily_unavailable" {
		t.Fatalf("账号库暂时繁忙不能误报为身份失败: %v", err)
	}
	if err = writer.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	if _, err = h.handle(context.Background(), request); err != nil {
		t.Fatalf("账号库解锁后应可直接重试: %v", err)
	}
}
