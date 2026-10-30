package main

import (
	"context"
	"testing"
)

func notaloneSyntheticFinalReadProfile(tables []notaloneTableSchema) notaloneReadProfile {
	return notaloneSyntheticReadProfile(tables,
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 0, State: notaloneMessageSent},
		notaloneStatusRule{LocalType: 1, Sender: "contact", Status: 0, State: notaloneMessageReceived},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 987, State: notaloneMessageSent},
		notaloneStatusRule{LocalType: 4294967297, Sender: "owner", Status: 987, State: notaloneMessageSent},
	)
}

func notaloneSyntheticFinalReadProfilePtr(tables []notaloneTableSchema) *notaloneReadProfile {
	profile := notaloneSyntheticFinalReadProfile(tables)
	return &profile
}

func notaloneSyntheticReadProfile(tables []notaloneTableSchema, rules ...notaloneStatusRule) notaloneReadProfile {
	return notaloneReadProfile{
		SchemaShapeFingerprint:  notaloneSnapshotShape(tables),
		StatusSemanticsVerified: true,
		StatusRules:             rules,
	}
}

func TestNotAloneStateClassificationUsesExactDirectionTypeAndStatus(t *testing.T) {
	profile := notaloneSyntheticReadProfile(nil,
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 2, State: notaloneMessageSent, RequiresServerID: true},
		notaloneStatusRule{LocalType: 1, Sender: "contact", Status: 2, State: notaloneMessagePending},
		notaloneStatusRule{LocalType: 1, Sender: "contact", Status: 3, State: notaloneMessageReceived, RequiresServerID: true},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 8, State: notaloneMessagePending},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 9, State: notaloneMessageFailed},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 4, State: notaloneMessageRecalled},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 5, State: notaloneMessageDeleted},
		notaloneStatusRule{LocalType: 10000, Sender: "unknown", Status: 4, State: notaloneMessageRecalled},
	)
	cases := []struct {
		name, sender, serverID string
		localType, status      int64
		wantState              notaloneMessageState
		wantHistory            bool
	}{
		{"sent", "owner", "100", 1, 2, notaloneMessageSent, true},
		{"same-status-contact-is-pending", "contact", "100", 1, 2, notaloneMessagePending, false},
		{"received", "contact", "101", 1, 3, notaloneMessageReceived, true},
		{"sent-without-assigned-server-id", "owner", "0", 1, 2, notaloneMessageSent, false},
		{"pending", "owner", "0", 1, 8, notaloneMessagePending, false},
		{"failed", "owner", "0", 1, 9, notaloneMessageFailed, false},
		{"recalled", "owner", "0", 1, 4, notaloneMessageRecalled, false},
		{"deleted", "owner", "0", 1, 5, notaloneMessageDeleted, false},
		{"unknown-sender-system-recall", "unknown", "0", 10000, 4, notaloneMessageRecalled, false},
		{"unknown-status", "owner", "0", 1, 99, notaloneMessageUnknown, false},
		{"unknown-high-type-bits", "owner", "100", 4294967297, 2, notaloneMessageUnknown, false},
		{"unknown-direction", "unknown", "100", 1, 2, notaloneMessageUnknown, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			serverID := tc.serverID
			decision := notaloneClassifyStatus(profile, tc.localType, tc.sender, tc.status, &serverID)
			if decision.State != tc.wantState || decision.HistoryEligible != tc.wantHistory {
				t.Fatalf("got state=%q eligible=%v; want state=%q eligible=%v", decision.State, decision.HistoryEligible, tc.wantState, tc.wantHistory)
			}
		})
	}
}

func TestNotAloneStatusRulesRejectDirectionContradictions(t *testing.T) {
	for _, rule := range []notaloneStatusRule{
		{LocalType: 1, Sender: "contact", Status: 2, State: notaloneMessageSent},
		{LocalType: 1, Sender: "owner", Status: 3, State: notaloneMessageReceived},
		{LocalType: 1, Sender: "unknown", Status: 2, State: notaloneMessageSent},
		{LocalType: 1, Sender: "unknown", Status: 3, State: notaloneMessageReceived},
	} {
		if notaloneStatusRulesValid([]notaloneStatusRule{rule}) {
			t.Fatalf("方向矛盾的最终状态规则不得认证：%#v", rule)
		}
	}
}

func TestNotAloneStateEvidenceIsSeparateFromRuleValue(t *testing.T) {
	profile := notaloneSyntheticReadProfile(nil, notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 2, State: notaloneMessageSent})
	serverID := "10"
	profile.StatusSemanticsVerified = false
	decision := notaloneClassifyStatus(profile, 1, "owner", 2, &serverID)
	if decision.State != notaloneMessageSent || decision.HistoryEligible {
		t.Fatalf("rule value and evidence must be separate: %#v", decision)
	}
}

func TestNotAloneSnapshotRequiresAttestedStateRulesAndNeverInheritsHighTypeBits(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	base := notaloneSyntheticFinalReadProfile(f.inspected.Tables)
	base.StatusSemanticsVerified = false
	if _, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, base); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("未认证规则不得建立可读快照：%v", err)
	}
	base = notaloneReadProfile{SchemaShapeFingerprint: notaloneSnapshotShape(f.inspected.Tables), StatusSemanticsVerified: true}
	if _, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, base); err == nil || err.Error() != "history_support_unverified" {
		t.Fatalf("缺规则的证据标记不得建立可读快照：%v", err)
	}
	if err := f.writers[0].Exec("UPDATE " + quoteIdent(f.table) + " SET local_type=4294967297,status=0,message_content='不可继承低32位规则'"); err != nil {
		t.Fatal(err)
	}
	profile := notaloneSyntheticReadProfile(f.inspected.Tables, notaloneStatusRule{LocalType: 1, Sender: "contact", Status: 0, State: notaloneMessageReceived})
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	page, err := snapshot.Page(context.Background(), "")
	if err != nil || len(page.Records) != 1 {
		t.Fatalf("合成页读取失败：%v", err)
	}
	if page.Records[0].StateAssurance != "unverified" || page.Records[0].Text != nil {
		t.Fatalf("未登记的高位type不可继承文字资格：%#v", page.Records[0])
	}
}

func TestNotAloneSnapshotReadsBodiesOnlyForAttestedSentOrReceivedStates(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	if err := f.writers[0].Exec(`DELETE FROM ` + quoteIdent(f.table) + `;
		INSERT INTO ` + quoteIdent(f.table) + `(local_id,server_id,local_type,real_sender_id,status,message_content) VALUES
		(1,10,1,1,2,'合成已发送'),(2,11,1,2,3,'合成已接收'),
		(3,0,1,1,8,'合成发送中'),(4,0,1,1,9,'合成发送失败'),
		(5,0,1,1,4,'合成已撤回'),(6,0,1,1,5,'合成已删除'),
		(7,12,1,1,99,'合成未知状态'),(8,13,1,3,2,'合成未知发送人');`); err != nil {
		t.Fatal(err)
	}
	profile := notaloneSyntheticReadProfile(f.inspected.Tables,
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 2, State: notaloneMessageSent, RequiresServerID: true},
		notaloneStatusRule{LocalType: 1, Sender: "contact", Status: 3, State: notaloneMessageReceived, RequiresServerID: true},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 8, State: notaloneMessagePending},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 9, State: notaloneMessageFailed},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 4, State: notaloneMessageRecalled},
		notaloneStatusRule{LocalType: 1, Sender: "owner", Status: 5, State: notaloneMessageDeleted},
	)
	snapshot, err := newNotaloneSnapshot(context.Background(), f.server, f.selected, f.inspected, profile)
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Close()
	page, err := snapshot.Page(context.Background(), "")
	if err != nil || len(page.Records) != 8 {
		t.Fatalf("合成页读取失败：%v", err)
	}
	for _, record := range page.Records {
		want := record.LocalID != nil && (*record.LocalID == "1" || *record.LocalID == "2")
		if want && (record.StateAssurance != "verified" || record.Text == nil) {
			t.Fatalf("sent/received文字应获准：%#v", record)
		}
		if !want && (record.StateAssurance != "unverified" || record.Text != nil) {
			t.Fatalf("非最终或不明状态不得取正文：%#v", record)
		}
	}
}
