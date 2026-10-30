package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestNotAloneReceivedTestMetadataLocksContactTextAndKeepsUnknownState(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 2)
	w := newNotaloneReceivedTestMetadataWatch()
	defer w.Close()
	run := func(action string) notaloneTestMetadataReport {
		t.Helper()
		report, err := w.observe(context.Background(), f.server, f.selected, f.inspected, action)
		if err != nil {
			t.Fatal(err)
		}
		return report
	}
	arm := run("arm")
	if arm.Format != "wechat-received-test-metadata-observation-v1" || arm.LockedCount != 0 || len(arm.Records) != 0 {
		t.Fatal(arm)
	}
	if noChange := run("next"); noChange.LockedCount != 0 || len(noChange.Records) != 0 {
		t.Fatalf("无新增时应保持空观察: %#v", noChange)
	}
	if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status,message_content) VALUES(4294967297,2,4,'received-private-sentinel')"); err != nil {
		t.Fatal(err)
	}
	locked := run("next")
	if locked.Format != "wechat-received-test-metadata-observation-v1" || locked.LockedCount != 1 || len(locked.Records) != 1 || locked.Records[0] == nil || locked.Records[0].LocalID == nil || locked.Records[0].OriginalType == nil || locked.Records[0].Sender != "contact" || locked.Records[0].StatusSemantics != "unverified" || locked.Records[0].NormalHistory || *locked.Records[0].OriginalType != "4294967297" {
		t.Fatalf("接收文字未按隔离元数据锁定: %#v", locked)
	}
	data, err := json.Marshal(locked)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "" || containsAny(string(data), "received-private-sentinel", "message_content", "source-secret") {
		t.Fatal("接收观察响应包含了正文或来源内容")
	}
	lockedID := *locked.Records[0].LocalID
	if err := f.writers[0].Exec("UPDATE " + quoteIdent(f.table) + " SET local_type=NULL,status=4 WHERE local_id=" + lockedID + ";DELETE FROM Name2Id WHERE rowid=2"); err != nil {
		t.Fatal(err)
	}
	current := run("current")
	if current.LockedCount != 1 || len(current.Records) != 1 || current.Records[0] == nil || current.Records[0].LocalID == nil || current.Records[0].Sender != "unknown" || current.Records[0].OriginalType != nil || current.Records[0].NormalHistory || current.Records[0].StatusSemantics != "unverified" || *current.Records[0].LocalID != lockedID {
		t.Fatalf("状态变化应保持原锁定身份并继续未核验: %#v", current)
	}
	if err := f.writers[0].Exec("UPDATE " + quoteIdent(f.table) + " SET local_id=local_id+100 WHERE local_id=" + lockedID); err != nil {
		t.Fatal(err)
	}
	if changedID := run("current"); changedID.LockedCount != 1 || len(changedID.Records) != 1 || changedID.Records[0] != nil {
		t.Fatalf("锁定行ID变化不得被当成同一记录: %#v", changedID)
	}
}

func TestNotAloneReceivedTestMetadataRejectsWrongDirectionAmbiguityAndType(t *testing.T) {
	for _, sample := range []struct {
		name, insert, want string
	}{
		{name: "owner", insert: "(1,1,4)", want: "history_test_sender_unverified"},
		{name: "other-sender", insert: "(1,3,4)", want: "history_test_sender_unverified"},
		{name: "unmapped-sender", insert: "(1,99,4)", want: "history_test_sender_unverified"},
		{name: "non-text-contact", insert: "(3,2,4)", want: "history_test_type_unverified"},
		{name: "multiple", insert: "(1,2,4),(1,2,4)", want: "history_test_new_rows_ambiguous"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			w := newNotaloneReceivedTestMetadataWatch()
			defer w.Close()
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
				t.Fatal(err)
			}
			if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status) VALUES" + sample.insert); err != nil {
				t.Fatal(err)
			}
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next"); err == nil || err.Error() != sample.want {
				t.Fatalf("无效接收样本未拒绝，want=%s err=%v", sample.want, err)
			}
			if !w.watch.closed || len(w.watch.locked) != 0 {
				t.Fatal("拒绝样本后watch必须终止且不锁定记录")
			}
		})
	}
}

func TestNotAloneReceivedTestMetadataRequiresUniqueSelectedContactMapping(t *testing.T) {
	for _, test := range []struct {
		name, change, want string
	}{
		{name: "duplicate", change: "INSERT INTO Name2Id(rowid,user_name) VALUES(4,'friend-a')", want: "history_test_sender_ambiguous"},
		{name: "missing", change: "UPDATE Name2Id SET user_name='renamed-contact' WHERE rowid=2", want: "history_test_sender_unverified"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newNotaloneSnapshotFixture(t, 1)
			if err := f.writers[0].Exec(test.change); err != nil {
				t.Fatal(err)
			}
			w := newNotaloneReceivedTestMetadataWatch()
			defer w.Close()
			if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err == nil || err.Error() != test.want {
				t.Fatalf("联系人映射校验未拒绝，want=%s err=%v", test.want, err)
			}
			if !w.watch.closed || w.watch.baseline != nil {
				t.Fatal("映射不唯一时不能留下可用baseline")
			}
		})
	}
}

func TestNotAloneReceivedTestMetadataRevalidatesContactMappingBeforeNext(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	w := newNotaloneReceivedTestMetadataWatch()
	defer w.Close()
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
		t.Fatal(err)
	}
	if err := f.writers[0].Exec("INSERT INTO Name2Id(rowid,user_name) VALUES(4,'friend-a');INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status) VALUES(1,2,4)"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next"); err == nil || err.Error() != "history_test_sender_ambiguous" {
		t.Fatalf("arm之后联系人映射变歧义仍可锁定: %v", err)
	}
	if !w.watch.closed || len(w.watch.locked) != 0 {
		t.Fatal("来源映射变化后观察器必须终止且不锁定")
	}
}

func TestNotAloneReceivedTestMetadataRejectsSecondNewTextAfterTwoLocks(t *testing.T) {
	f := newNotaloneSnapshotFixture(t, 1)
	w := newNotaloneReceivedTestMetadataWatch()
	defer w.Close()
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "arm"); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 2; index++ {
		if err := f.writers[0].Exec(fmt.Sprintf("INSERT INTO %s(local_type,real_sender_id,status) VALUES(1,2,4)", quoteIdent(f.table))); err != nil {
			t.Fatal(err)
		}
		if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next"); err != nil {
			t.Fatal(err)
		}
	}
	if err := f.writers[0].Exec("INSERT INTO " + quoteIdent(f.table) + "(local_type,real_sender_id,status) VALUES(1,2,4)"); err != nil {
		t.Fatal(err)
	}
	if _, err := w.observe(context.Background(), f.server, f.selected, f.inspected, "next"); err == nil || err.Error() != "history_request_invalid" {
		t.Fatalf("超过最多两条状态关联仍可观察: %v", err)
	}
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
