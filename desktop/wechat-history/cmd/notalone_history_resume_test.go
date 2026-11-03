package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func notalonePartialHistoryFixture(t *testing.T, count int) (*notaloneHistorySession, *wcdb.DB, string, notaloneSnapshotTarget) {
	t.Helper()
	h := notaloneProtocolFixture(t, true)
	h.certify = notaloneSyntheticTailCertification
	h.checkpointDirectory = t.TempDir()
	if err := os.Chmod(h.checkpointDirectory, 0700); err != nil {
		t.Fatal(err)
	}
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage/message/message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { writer.Close() })
	table := quoteIdent("Msg_" + talkerHash("friend-a"))
	if err = writer.Exec("PRAGMA journal_mode=WAL;BEGIN"); err != nil {
		t.Fatal(err)
	}
	for id := 2; id <= count; id++ {
		if err = writer.Exec(fmt.Sprintf("INSERT INTO %s(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(%d,0,1,1,1700000000,0,'合成正文%d')", table, id, id)); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Exec("COMMIT"); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"})
	if err != nil {
		t.Fatal(err)
	}
	return h, writer, table, value.(notaloneSnapshotTarget)
}

func notalonePartialHistoryPage(t *testing.T, h *notaloneHistorySession, target notaloneSnapshotTarget, cursor string, checkpoint bool) (notaloneSnapshotPage, string) {
	t.Helper()
	r := notaloneHistoryRequest{Operation: "page", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", Target: target.Descriptor, Cursor: cursor}
	if checkpoint {
		if err := json.Unmarshal([]byte(`{"checkpoint":true}`), &r); err != nil {
			t.Fatal(err)
		}
	}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	page := value.(notaloneSnapshotPage)
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		CheckpointCursor string `json:"checkpointCursor"`
	}
	if err = json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if checkpoint && !page.Exhausted && wire.CheckpointCursor == "" {
		t.Fatal("未完成历史页缺少持久恢复点")
	}
	return page, wire.CheckpointCursor
}

func notaloneResumePartialHistory(t *testing.T, h *notaloneHistorySession, target notaloneSnapshotTarget, cursor string, restart bool) (*notaloneHistorySession, notaloneSnapshotTarget) {
	t.Helper()
	if restart {
		h.close()
		next := newNotaloneHistorySession(h.server)
		next.program, next.sourceProcess, next.certify, next.checkpointDirectory = h.program, h.sourceProcess, h.certify, h.checkpointDirectory
		h = next
		t.Cleanup(h.close)
	} else {
		_, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "release-selection", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-metadata-v1"})
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resume-target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", Target: target.Descriptor, Cursor: cursor})
	if err != nil {
		t.Fatal(err)
	}
	resumed, ok := value.(notaloneSnapshotTarget)
	if !ok {
		t.Fatal("已接受历史片段必须可恢复")
	}
	return h, resumed
}

func TestNotAlonePartialHistoryResumesWithoutReplayingAcceptedRows(t *testing.T) {
	for _, restart := range []bool{false, true} {
		t.Run(fmt.Sprintf("restart=%v", restart), func(t *testing.T) {
			h, _, _, target := notalonePartialHistoryFixture(t, 48)
			page, checkpoint := notalonePartialHistoryPage(t, h, target, "", true)
			if page.Exhausted || len(page.Records) != 16 || page.ResumeCursor != nil {
				t.Fatal("第一页应只接受16条，不能冒充完成")
			}
			h, target = notaloneResumePartialHistory(t, h, target, checkpoint, restart)
			page, _ = notalonePartialHistoryPage(t, h, target, "", false)
			if len(page.Records) != 16 || page.Records[0].LocalID == nil || *page.Records[0].LocalID != "17" {
				t.Fatal("恢复必须从未接受的17号正文继续，不能重放前16条")
			}
		})
	}
}

func TestNotAloneCheckpointKeepsAcceptedTerminalParentBeforeTailResponseAcceptance(t *testing.T) {
	h, writer, table, target := notalonePartialHistoryFixture(t, 16)
	page, _ := notalonePartialHistoryPage(t, h, target, "", false)
	if !page.Exhausted || page.ResumeCursor == nil {
		t.Fatal("终页缺少增量恢复点")
	}
	parent := *page.ResumeCursor
	if err := writer.Exec("UPDATE " + table + " SET message_content='待接受增量' WHERE local_id=1"); err != nil {
		t.Fatal(err)
	}
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "tail", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", Target: target.Descriptor, Cursor: parent})
	if err != nil {
		t.Fatal(err)
	}
	if !value.(notaloneTailPage).CaughtUp {
		t.Fatal("合成增量应在一页内结束")
	}
	// 丢弃新响应；业务仍只持有终页父点。
	h, target = notaloneResumePartialHistory(t, h, target, parent, true)
	replayed, _ := notalonePartialHistoryPage(t, h, target, "", false)
	if len(replayed.Records) == 0 {
		t.Fatal("未接受增量必须可以从已接受父点重放")
	}
}

func TestNotAlonePartialHistoryRepeatedInterruptionsProjectEachUnchangedBodyOnce(t *testing.T) {
	for _, count := range []int{48, 1000} {
		t.Run(strconv.Itoa(count), func(t *testing.T) {
			h, _, _, target := notalonePartialHistoryFixture(t, count)
			seen := map[string]bool{}
			pages := 0
			for ; pages < count; pages++ {
				page, checkpoint := notalonePartialHistoryPage(t, h, target, "", true)
				for _, record := range page.Records {
					if record.LocalID == nil || record.Text == nil || seen[*record.LocalID] {
						t.Fatal("未变化正文在中断恢复中重复投影或丢失")
					}
					seen[*record.LocalID] = true
				}
				if page.Exhausted {
					break
				}
				h, target = notaloneResumePartialHistory(t, h, target, checkpoint, pages%2 == 0)
			}
			if len(seen) != count {
				t.Fatalf("正文覆盖=%d，期望=%d", len(seen), count)
			}
			t.Logf("合成消息=%d，恢复片段=%d，正文投影=%d，重复正文=0", count, pages+1, len(seen))
		})
	}
}

func TestNotAlonePartialHistoryRetainsChangedAndAbsentAcceptedRowsAcrossTwoRestarts(t *testing.T) {
	for _, resurrect := range []bool{false, true} {
		t.Run(fmt.Sprintf("resurrect=%v", resurrect), func(t *testing.T) {
			h, writer, table, target := notalonePartialHistoryFixture(t, 80)
			cursor, checkpoint := "", ""
			for pageNo := 0; pageNo < 3; pageNo++ {
				page, saved := notalonePartialHistoryPage(t, h, target, cursor, pageNo == 2)
				cursor = *page.CursorOut
				checkpoint = saved
			}
			if err := writer.Exec("UPDATE " + table + " SET message_content='已接受旧行更新' WHERE local_id=40;DELETE FROM " + table + " WHERE local_id=41;INSERT INTO " + table + "(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(0,0,1,1,1700000000,0,'低编号新增')"); err != nil {
				t.Fatal(err)
			}
			h, target = notaloneResumePartialHistory(t, h, target, checkpoint, true)
			first, next := notalonePartialHistoryPage(t, h, target, "", true)
			for _, record := range first.Records {
				if record.LocalID != nil && (*record.LocalID == "40" || *record.LocalID == "41") {
					t.Fatal("夹具必须把待更新与待删除身份留在下一片")
				}
			}
			if resurrect {
				if err := writer.Exec("INSERT INTO " + table + "(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(41,0,1,1,1700000000,0,'正常恢复出现')"); err != nil {
					t.Fatal(err)
				}
			}
			h, target = notaloneResumePartialHistory(t, h, target, next, true)
			records := append([]notaloneSnapshotRecord{}, first.Records...)
			cursor = ""
			for pageNo := 0; pageNo < 20; pageNo++ {
				page, _ := notalonePartialHistoryPage(t, h, target, cursor, false)
				records = append(records, page.Records...)
				if page.Exhausted {
					break
				}
				cursor = *page.CursorOut
			}
			low, changed, absent := false, false, false
			for _, record := range records {
				if record.LocalID == nil {
					continue
				}
				switch *record.LocalID {
				case "0":
					low = record.Text != nil && *record.Text == "低编号新增"
				case "40":
					changed = record.Text != nil && *record.Text == "已接受旧行更新"
				case "41":
					if resurrect {
						absent = record.Text != nil && *record.Text == "正常恢复出现"
					} else {
						absent = record.Text == nil
					}
				}
			}
			if !low || !changed || !absent {
				t.Fatalf("低ID新增=%v，旧行更新=%v，消失/再次出现=%v", low, changed, absent)
			}
		})
	}
}

func TestNotAlonePartialHistoryDoesNotReplayAcceptedTombstones(t *testing.T) {
	h, writer, table, target := notalonePartialHistoryFixture(t, 80)
	cursor, checkpoint := "", ""
	for index := 0; index < 3; index++ {
		page, saved := notalonePartialHistoryPage(t, h, target, cursor, index == 2)
		cursor = *page.CursorOut
		checkpoint = saved
	}
	if err := writer.Exec("DELETE FROM " + table + " WHERE local_id<=48"); err != nil {
		t.Fatal(err)
	}
	h, target = notaloneResumePartialHistory(t, h, target, checkpoint, true)
	cursor = ""
	deleted := map[string]bool{}
	for index := 0; index < 12; index++ {
		page, saved := notalonePartialHistoryPage(t, h, target, cursor, true)
		checkpoint = saved
		if page.Exhausted {
			t.Fatal("夹具应在部分墓碑页中断")
		}
		cursor = *page.CursorOut
		for _, record := range page.Records {
			if record.Text == nil && record.LocalID != nil {
				deleted[*record.LocalID] = true
			}
		}
		if len(deleted) > 0 {
			break
		}
	}
	if len(deleted) != 16 {
		t.Fatalf("应已接受16条删除，实际%d", len(deleted))
	}
	h, target = notaloneResumePartialHistory(t, h, target, checkpoint, true)
	cursor = ""
	for index := 0; index < 8; index++ {
		page, _ := notalonePartialHistoryPage(t, h, target, cursor, false)
		for _, record := range page.Records {
			if record.LocalID != nil && record.Text == nil {
				if deleted[*record.LocalID] {
					t.Fatal("已接受墓碑跨片重复")
				}
				deleted[*record.LocalID] = true
			}
		}
		if page.Exhausted {
			break
		}
		cursor = *page.CursorOut
	}
	if len(deleted) != 48 {
		t.Fatalf("删除覆盖=%d，期望48", len(deleted))
	}
}

func TestNotAlonePartialHistoryKeepsAcceptedParentAcrossRejectedOffers(t *testing.T) {
	h, _, _, target := notalonePartialHistoryFixture(t, 80)
	_, checkpoint := notalonePartialHistoryPage(t, h, target, "", true)
	parentTarget := target
	for attempt := 0; attempt < 4; attempt++ {
		h, target = notaloneResumePartialHistory(t, h, parentTarget, checkpoint, true)
		page, _ := notalonePartialHistoryPage(t, h, target, "", true)
		if page.Records[0].LocalID == nil || *page.Records[0].LocalID != "17" {
			t.Fatal("每次拒收后必须从同一父点重放待接受片段")
		}
	}
	h, target = notaloneResumePartialHistory(t, h, parentTarget, checkpoint, true)
	page, _ := notalonePartialHistoryPage(t, h, target, "", false)
	if *page.Records[0].LocalID != "17" {
		t.Fatal("连续未接受恢复点淘汰了已接受父点")
	}
}

func TestNotAlonePartialHistoryRejectsCorruptCheckpointAndCancelledPage(t *testing.T) {
	h, _, _, target := notalonePartialHistoryFixture(t, 48)
	page, checkpoint := notalonePartialHistoryPage(t, h, target, "", true)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := notaloneHistoryRequest{Operation: "page", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1", Target: target.Descriptor, Cursor: *page.CursorOut, Checkpoint: true}
	if _, err := h.handle(ctx, request); err == nil {
		t.Fatal("已取消页不能产生可接受恢复点")
	}
	h, target = notaloneResumePartialHistory(t, h, target, checkpoint, true)
	page, checkpoint = notalonePartialHistoryPage(t, h, target, "", true)
	path := h.checkpointPath(notaloneHash(h.selected.Account, h.selected.Conversation), checkpoint)
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(bytes), "合成正文") {
		t.Fatal("恢复点不得持久正文")
	}
	var signed notaloneSignedCheckpoint
	if json.Unmarshal(bytes, &signed) != nil {
		t.Fatal("检查点解析失败")
	}
	signed.MAC = strings.Repeat("0", 64)
	bytes, _ = json.Marshal(signed)
	if err = os.WriteFile(path, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	request.Operation, request.Target, request.Cursor, request.Checkpoint = "resume-target", target.Descriptor, checkpoint, false
	if _, err = h.handle(context.Background(), request); err == nil || err.Error() != "history_checkpoint_invalid" {
		t.Fatal("篡改检查点必须拒绝")
	}
}

func TestNotAlonePartialHistoryNormalEncryptedStateRestoreAfterUncheckpointedPage(t *testing.T) {
	h, writer, table, target := notalonePartialHistoryFixture(t, 48)
	_, checkpoint := notalonePartialHistoryPage(t, h, target, "", true)
	parentTarget := target
	if err := writer.Exec("UPDATE " + table + " SET status=99 WHERE local_id=1"); err != nil {
		t.Fatal(err)
	}
	h, target = notaloneResumePartialHistory(t, h, parentTarget, checkpoint, true)
	page, _ := notalonePartialHistoryPage(t, h, target, "", false)
	unknown := false
	for _, record := range page.Records {
		if record.LocalID != nil && *record.LocalID == "1" && record.Text == nil {
			unknown = true
		}
	}
	if !unknown {
		t.Fatal("夹具必须先交付未知状态，且不生成新持久点")
	}
	h.close()
	if err := writer.Exec("UPDATE " + table + " SET status=0 WHERE local_id=1;PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal(err)
	}
	h, target = notaloneResumePartialHistory(t, h, parentTarget, checkpoint, true)
	page, _ = notalonePartialHistoryPage(t, h, target, "", false)
	restored := false
	for _, record := range page.Records {
		if record.LocalID != nil && *record.LocalID == "1" && record.Text != nil && *record.Text == "private-body-sentinel" {
			restored = true
		}
	}
	if !restored {
		t.Fatal("正常加密SQL恢复和WAL回收后必须重新投影已接受的旧身份")
	}
}

func TestNotAlonePartialHistoryProjectionWorkloadBeforeAndAfterInterruption(t *testing.T) {
	for _, count := range []int{48, 1000} {
		for _, durable := range []bool{false, true} {
			t.Run(fmt.Sprintf("messages=%d/durable=%v", count, durable), func(t *testing.T) {
				h, _, _, target := notalonePartialHistoryFixture(t, count)
				first, checkpoint := notalonePartialHistoryPage(t, h, target, "", durable)
				projected := len(first.Records)
				if durable {
					h, target = notaloneResumePartialHistory(t, h, target, checkpoint, true)
				} else {
					h.close()
					next := newNotaloneHistorySession(h.server)
					next.program, next.sourceProcess, next.certify, next.checkpointDirectory = h.program, h.sourceProcess, h.certify, h.checkpointDirectory
					h = next
					t.Cleanup(h.close)
					if _, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
						t.Fatal(err)
					}
					value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"})
					if err != nil {
						t.Fatal(err)
					}
					target = value.(notaloneSnapshotTarget)
				}
				cursor := ""
				for index := 0; index < count; index++ {
					page, _ := notalonePartialHistoryPage(t, h, target, cursor, false)
					projected += len(page.Records)
					if page.Exhausted {
						break
					}
					cursor = *page.CursorOut
				}
				want := count + 16
				if durable {
					want = count
				}
				if projected != want {
					t.Fatalf("正文投影=%d，期望=%d", projected, want)
				}
				t.Logf("同一加密WCDB负载消息=%d，首16条后中断，持久片段=%v，累计正文投影=%d", count, durable, projected)
			})
		}
	}
}
