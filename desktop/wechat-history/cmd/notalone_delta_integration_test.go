package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func TestNotAloneDeltaIdleAndOldRowChangeDoNotReplayHistory(t *testing.T) {
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
	defer writer.Close()
	table := quoteIdent("Msg_" + talkerHash("friend-a"))
	if err = writer.Exec("PRAGMA journal_mode=WAL;BEGIN"); err != nil {
		t.Fatal(err)
	}
	for id := 2; id <= 1000; id++ {
		if err = writer.Exec(fmt.Sprintf("INSERT INTO %s(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(%d,0,1,1,1700000000,0,'%s')", table, id, strings.Repeat("合成", 300))); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Exec("COMMIT"); err != nil {
		t.Fatal(err)
	}
	r := notaloneHistoryRequest{Operation: "target", Account: h.selected.Account, Conversation: h.selected.Conversation, Consent: "selected-history-v1"}
	value, err := h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	target := value.(notaloneSnapshotTarget)
	r.Operation = "page"
	r.Target = target.Descriptor
	var last notaloneSnapshotPage
	for index := 0; index < 100; index++ {
		value, err = h.handle(context.Background(), r)
		if err != nil {
			t.Fatal(err)
		}
		last = value.(notaloneSnapshotPage)
		if last.Exhausted {
			break
		}
		r.Cursor = *last.CursorOut
	}
	if !last.Exhausted || last.ResumeCursor == nil || len(h.tail.baseline) != 1000 {
		t.Fatal("合成历史基线未完成")
	}
	initialFiles := mustReadNotaloneCheckpointDirectory(t, h.checkpointDirectory)
	if len(initialFiles) != 1 {
		t.Fatal("历史交接应保存唯一检查点")
	}
	initialStat, _ := initialFiles[0].Info()
	checkpointFile := filepath.Join(h.checkpointDirectory, initialFiles[0].Name())
	trustedBytes, readErr := os.ReadFile(checkpointFile)
	if readErr != nil {
		t.Fatal(readErr)
	}
	var forged notaloneSignedCheckpoint
	if json.Unmarshal(trustedBytes, &forged) != nil {
		t.Fatal("签名检查点不可解析")
	}
	forged.MAC = strings.Repeat("0", 64)
	forgedBytes, _ := json.Marshal(forged)
	if err = os.WriteFile(checkpointFile, forgedBytes, 0600); err != nil {
		t.Fatal(err)
	}
	resumeProbe := notaloneHistoryRequest{Operation: "resume-target", Account: r.Account, Conversation: r.Conversation, Consent: r.Consent, Target: target.Descriptor, Cursor: *last.ResumeCursor}
	if _, err = h.handle(context.Background(), resumeProbe); err == nil || err.Error() != "history_checkpoint_invalid" {
		t.Fatal("篡改检查点必须拒绝")
	}
	if err = os.WriteFile(checkpointFile, trustedBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(checkpointFile, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = h.handle(context.Background(), resumeProbe); err == nil || err.Error() != "history_checkpoint_invalid" {
		t.Fatal("宽松权限检查点必须拒绝")
	}
	if err = os.Chmod(checkpointFile, 0600); err != nil {
		t.Fatal(err)
	}
	initialStat, _ = os.Stat(checkpointFile)

	cursor := *last.ResumeCursor
	r.Operation = "tail"
	r.Cursor = cursor
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	idle := value.(notaloneTailPage)
	idleFiles := mustReadNotaloneCheckpointDirectory(t, h.checkpointDirectory)
	if len(idleFiles) != 1 {
		t.Fatal("空闲不得新增整份检查点")
	}
	idleStat, _ := idleFiles[0].Info()
	if !initialStat.ModTime().Equal(idleStat.ModTime()) {
		t.Fatal("空闲不得重写持久索引")
	}
	if !idle.CaughtUp || len(idle.Records) != 0 {
		t.Fatal("空闲增量不得分页遍历1000条历史")
	}
	if err = writer.Exec("UPDATE " + table + " SET message_content='旧消息变化' WHERE local_id=1"); err != nil {
		t.Fatal(err)
	}
	r.Cursor = idle.CursorOut
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	changed := value.(notaloneTailPage)
	if !changed.CaughtUp || len(changed.Records) != 1 || changed.Records[0].Text == nil || *changed.Records[0].Text != "旧消息变化" {
		t.Fatalf("应只投影变化页的旧消息：caughtUp=%v records=%d", changed.CaughtUp, len(changed.Records))
	}
	// 响应持久检查点已经建立，丢掉全部内存尾部仍能接续同一已接受点。
	cursor = changed.CursorOut
	h.resetTail()
	h.server.cfg.Keys[strings.Repeat("ff", 16)] = strings.Repeat("aa", 32) // 无关密钥缓存更新不得使本会话检查点失效。
	configBytes, marshalErr := json.Marshal(h.server.cfg)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if err = os.WriteFile(os.Getenv("WECHAT_CLI_CONFIG"), configBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err = writer.Exec("INSERT INTO " + table + "(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(0,0,1,1,1700000000,0,'低编号离线新增');DELETE FROM " + table + " WHERE local_id=500"); err != nil {
		t.Fatal(err)
	}
	r.Operation = "resume-target"
	r.Cursor = cursor
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	resumed := value.(notaloneSnapshotTarget)
	r.Operation = "page"
	r.Target = resumed.Descriptor
	r.Cursor = ""
	records := []notaloneSnapshotRecord{}
	for index := 0; index < 8; index++ {
		value, err = h.handle(context.Background(), r)
		if err != nil {
			t.Fatal(err)
		}
		last = value.(notaloneSnapshotPage)
		records = append(records, last.Records...)
		if last.Exhausted {
			break
		}
		r.Cursor = *last.CursorOut
	}
	if !last.Exhausted || last.ResumeCursor == nil || len(records) > 16 {
		t.Fatal("持久接续应只读变化页，不能重新输出1000条历史")
	}
	foundLow, foundDeleted := false, false
	for _, record := range records {
		if record.LocalID != nil {
			foundLow = foundLow || *record.LocalID == "0" && record.Text != nil && *record.Text == "低编号离线新增"
			foundDeleted = foundDeleted || *record.LocalID == "500" && record.Text == nil
		}
	}
	if !foundLow || !foundDeleted {
		t.Fatal("离线低编号新增或删除没有进入增量")
	}

	// 中途页已被业务接受后丢失进程，也从上一持久语义点重放变化，不退回全历史。
	if err = writer.Exec("UPDATE " + table + " SET message_content='中途页更新' WHERE local_id BETWEEN 1 AND 64"); err != nil {
		t.Fatal(err)
	}
	r.Operation = "tail"
	r.Target = resumed.Descriptor
	r.Cursor = *last.ResumeCursor
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	partial := value.(notaloneTailPage)
	if partial.CaughtUp || len(partial.Records) == 0 || len(partial.Records) > 16 || !strings.Contains(partial.CursorOut, ".") {
		t.Fatal("中途页必须保留可恢复状态令牌")
	}
	h.resetTail()
	r.Operation = "resume-target"
	r.Cursor = partial.CursorOut
	value, err = h.handle(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	restart := value.(notaloneSnapshotTarget)
	r.Operation = "page"
	r.Target = restart.Descriptor
	r.Cursor = ""
	updated := 0
	for index := 0; index < 12; index++ {
		value, err = h.handle(context.Background(), r)
		if err != nil {
			t.Fatal(err)
		}
		last = value.(notaloneSnapshotPage)
		for _, record := range last.Records {
			if record.Text != nil && *record.Text == "中途页更新" {
				updated++
			}
		}
		if last.Exhausted {
			break
		}
		r.Cursor = *last.CursorOut
	}
	if !last.Exhausted || updated != 64 {
		t.Fatalf("中途重启应接续64条变化，得到%d", updated)
	}
	for _, entry := range mustReadNotaloneCheckpointDirectory(t, h.checkpointDirectory) {
		data, e := os.ReadFile(filepath.Join(h.checkpointDirectory, entry.Name()))
		if e != nil {
			t.Fatal(e)
		}
		if strings.Contains(string(data), "合成") || strings.Contains(string(data), "旧消息变化") || strings.Contains(string(data), "低编号离线新增") {
			t.Fatal("检查点不得保存正文")
		}
		var shape map[string]json.RawMessage
		if json.Unmarshal(data, &shape) != nil {
			t.Fatal("检查点JSON不可读")
		}
	}
}
func mustReadNotaloneCheckpointDirectory(t *testing.T, dir string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	return entries
}
