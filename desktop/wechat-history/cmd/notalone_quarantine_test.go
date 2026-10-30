package main

import (
	"context"
	"testing"
)

func TestNotaloneQuarantineProtocolDoesNotOpenNormalHistory(t *testing.T) {
	h := notaloneProtocolFixture(t, false)
	h.certify = func(p notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		return notaloneProfileCertification{Status: "unverified", ProfileID: "synthetic-quarantine", StatusSemantics: "unverified", Continuity: "unverified", Capabilities: map[string]string{"programVersion": "supported", "exactSchema": "supported", "declaredLocalKey": "supported"}, ReadProfile: &notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(tables)}}
	}
	r := notaloneHistoryRequest{Operation: "quarantine-target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	if _, err := h.handle(context.Background(), r); err == nil {
		t.Fatal("没有独立隔离同意仍取得目标")
	}
	r.Consent = "selected-quarantine-history-v1"
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	r.Operation = "quarantine-page"
	r.Target = value.(notaloneSnapshotTarget).Descriptor
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	page := value.(notaloneSnapshotPage)
	if len(page.Records) == 0 || page.Records[0].Text == nil || page.Records[0].StateAssurance != "unverified" {
		t.Fatal("隔离协议未保留待核验文字")
	}
	r.Operation = "target"
	r.Target = ""
	r.Consent = "selected-history-v1"
	if _, err = h.handle(context.Background(), r); err == nil || err.Error() != "history_support_unverified" {
		t.Fatal("隔离授权提升了普通历史资格")
	}
}

func TestNotaloneQuarantineSnapshotKeepsTextWithoutCertifyingState(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec("UPDATE " + quoteIdent(f.table) + " SET status=99,message_content='合成待核验文字';INSERT INTO " + quoteIdent(f.table) + "(local_id,local_type,status,message_content) VALUES(2,3,99,'不得读取的图片载荷')"); err != nil {
		t.Fatal(err)
	}
	n, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), OpaqueStatusPolicy: "quarantine-text-v1"})
	if err != nil {
		t.Fatal(err)
	}
	defer n.Close()
	page, err := n.Page(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Records) != 2 {
		t.Fatalf("记录数错误: %d", len(page.Records))
	}
	for _, row := range page.Records {
		if row.StateAssurance != "unverified" {
			t.Fatal("隔离导入伪造了状态认证")
		}
		if row.Kind == "text" && (row.Text == nil || *row.Text != "合成待核验文字") {
			t.Fatal("未保存获准隔离的文字")
		}
		if row.Kind != "text" && row.Text != nil {
			t.Fatal("隔离导入读取了媒体载荷")
		}
	}
}
