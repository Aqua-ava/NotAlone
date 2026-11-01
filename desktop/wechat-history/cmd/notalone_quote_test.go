package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/klauspost/compress/zstd"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

const (
	notaloneQuoteTestRawType      = int64(244813135921)
	notaloneQuoteTestLocalID      = int64(9007199254740993)
	notaloneQuoteTestServerID     = int64(9223372036854775806)
	notaloneQuoteTestXMLByteLimit = 256 << 10
)

type notaloneQuoteTestRow struct {
	rawType     int64
	senderID    int64
	status      int64
	serverID    int64
	setServerID bool
	createAt    any
	content     []byte
	typeCode    int64
}

func notaloneQuoteTestXML(reply, referenceType, referenceServerID, referenceAuthor, referenceDisplay, referenceContent string) []byte {
	return []byte(fmt.Sprintf(`<msg><appmsg><title>%s</title><refermsg><type>%s</type><svrid>%s</svrid><fromusr>%s</fromusr><displayname>%s</displayname><content>%s</content></refermsg></appmsg></msg>`, reply, referenceType, referenceServerID, referenceAuthor, referenceDisplay, referenceContent))
}

func notaloneQuoteProtocolFixture(t *testing.T, row notaloneQuoteTestRow, withCheckpoint ...bool) (*notaloneHistorySession, notaloneHistoryRequest) {
	t.Helper()
	if os.Getenv("NOTALONE_TEST_WCDB") == "" {
		t.Skip("需要显式合成WCDB制品")
	}
	server := notaloneHistoryFixture(t)
	table := `"Msg_` + talkerHash("friend-a") + `"`
	dbPath := filepath.Join(server.cfg.DBRoot, "db_storage", "message", "message_0.db")
	db, err := wcdb.OpenWithKeyMapWritable(dbPath, server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	createAtSQL := "NULL"
	if value, ok := row.createAt.(int64); ok {
		createAtSQL = fmt.Sprint(value)
	}
	serverID := notaloneQuoteTestServerID
	if row.setServerID {
		serverID = row.serverID
	}
	query := fmt.Sprintf(`CREATE TABLE Name2Id(user_name TEXT);
INSERT INTO Name2Id(rowid,user_name) VALUES(1,'synthetic-owner'),(2,'friend-a'),(3,'other-person');
ALTER TABLE %s ADD COLUMN WCDB_CT_message_content INTEGER NOT NULL DEFAULT 0;
UPDATE %s SET local_id=%d,server_id=%d,local_type=%d,real_sender_id=%d,create_time=%s,status=%d,message_content=x'%s',WCDB_CT_message_content=%d WHERE local_id=1;`,
		table, table, notaloneQuoteTestLocalID, serverID, row.rawType, row.senderID, createAtSQL, row.status, hex.EncodeToString(row.content), row.typeCode)
	if err = db.Exec(query); err != nil {
		db.Close()
		t.Fatal(err)
	}
	db.Close()

	h := newNotaloneHistorySession(server)
	if len(withCheckpoint) > 1 {
		t.Fatal("checkpoint测试开关只能出现一次")
	}
	if len(withCheckpoint) == 1 && withCheckpoint[0] {
		h.checkpointDirectory = t.TempDir()
		if err := os.Chmod(h.checkpointDirectory, 0700); err != nil {
			t.Fatal(err)
		}
	}
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
	h.program = func(context.Context) (notaloneProgramVersion, error) {
		return notaloneProgramVersion{Version: "4.0.6", Build: "29387"}, nil
	}
	h.certify = func(program notaloneProgramVersion, tables []notaloneTableSchema) notaloneProfileCertification {
		shape := notaloneSnapshotShape(tables)
		return notaloneProfileCertification{
			Status: "unverified", ProfileID: "wechat-4.0.6-29387-observed-states-v1",
			ProgramVersion: program.Version, Build: program.Build, DeclaredPrimaryKey: []string{"local_id"},
			StatusSemantics: "observed_subset_only", Continuity: "synthetic-source",
			SchemaShapeFingerprint: shape, Capabilities: notaloneSyntheticRuntimeCapabilities(),
			ReadProfile: &notaloneReadProfile{SchemaShapeFingerprint: shape, StatusSemanticsVerified: true,
				StatusRules: notalone40629387ObservedStatusRules()},
		}
	}
	t.Cleanup(h.close)
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "resolve", DisplayName: "合成目标", Consent: "selected-metadata-v1"}); err != nil {
		t.Fatal(err)
	}
	account, conversation := h.selected.Account, h.selected.Conversation
	if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "support", Account: account, Conversation: conversation, Consent: "selected-schema-v1"}); err != nil {
		t.Fatal(err)
	}
	targetValue, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "target", Account: account, Conversation: conversation, Consent: "selected-history-v1"})
	if err != nil {
		t.Fatal(err)
	}
	target := targetValue.(notaloneSnapshotTarget)
	if len(target.Tables) != 1 {
		t.Fatalf("预期一个合成分片表：%#v", target.Tables)
	}
	return h, notaloneHistoryRequest{
		Operation: "quote-read", Consent: "selected-quote-v1", Account: account, Conversation: conversation,
		Target: target.Descriptor, Partition: target.Tables[0].Partition, Table: target.Tables[0].Instance,
		LocalID: fmt.Sprint(notaloneQuoteTestLocalID), ServerID: fmt.Sprint(serverID), SentAt: "1700000000000",
	}
}

func notaloneQuoteTestResponse(t *testing.T, value any) map[string]any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err = json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestNotAloneQuoteReadReturnsOnlyVerifiedExactReference(t *testing.T) {
	raw := notaloneQuoteTestXML("我晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先去吃饭吗？")
	h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
	})
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("已验证引用消息应能读取：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	digest := sha256.Sum256(raw)
	want := map[string]any{
		"format": "wechat-quote-message-v1", "accountKey": "synthetic-owner", "conversationKey": "friend-a",
		"sourceGeneration": h.selected.SourceGeneration, "partition": request.Partition, "table": request.Table,
		"localId": request.LocalID, "serverId": request.ServerID, "sentAt": request.SentAt,
		"replyText": "我晚点到", "referencedText": "先去吃饭吗？", "referencedSender": "我",
		"referencedSenderRole": "owner", "referencedType": "1", "referencedServerId": "1841310816813489186",
		"contentSha256": hex.EncodeToString(digest[:]),
	}
	for key, expected := range want {
		if response[key] != expected {
			t.Fatalf("引用wire字段 %s=%#v，期望 %#v", key, response[key], expected)
		}
	}
	encoded, _ := json.Marshal(response)
	for _, forbidden := range []string{string(raw), h.server.cfg.DBRoot, "message_content", "source-secret"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("响应泄漏原始XML、路径或列名：%q", forbidden)
		}
	}
}

func TestNotAloneQuoteReadAfterResumeKeepsDeltaTargetAndPageCursor(t *testing.T) {
	raw := notaloneQuoteTestXML("晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先吃饭吗？")
	h, quoteRequest := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
	}, true)
	initialTarget := h.snapshot.Target()
	pageRequest := notaloneHistoryRequest{Operation: "page", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: initialTarget.Descriptor}
	var completed notaloneSnapshotPage
	for index := 0; index < 8; index++ {
		value, err := h.handle(context.Background(), pageRequest)
		if err != nil {
			t.Fatalf("合成历史分页应完成：%v", err)
		}
		completed = value.(notaloneSnapshotPage)
		if completed.Exhausted {
			break
		}
		if completed.CursorOut == nil {
			t.Fatal("未完成历史分页必须返回游标")
		}
		pageRequest.Cursor = *completed.CursorOut
	}
	if !completed.Exhausted || completed.ResumeCursor == nil || h.snapshot != nil || h.tail == nil {
		t.Fatalf("历史完成后应形成持久增量检查点：page=%#v snapshot=%v tail=%v", completed, h.snapshot != nil, h.tail != nil)
	}
	resumeRequest := notaloneHistoryRequest{Operation: "resume-target", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: initialTarget.Descriptor, Cursor: *completed.ResumeCursor}
	value, err := h.handle(context.Background(), resumeRequest)
	if err != nil {
		t.Fatalf("历史检查点应恢复为增量目标：%v", err)
	}
	resumedTarget := value.(notaloneSnapshotTarget)
	if resumedTarget.Descriptor == "" || !notaloneSameSnapshotInstances(initialTarget, resumedTarget) || h.snapshot == nil || h.snapshotMode != "normal" || !h.snapshot.deltaOnly {
		t.Fatalf("恢复后目标必须保留同一来源分片并成为delta快照：sameInstances=%v mode=%q deltaOnly=%v",
			notaloneSameSnapshotInstances(initialTarget, resumedTarget), h.snapshotMode, h.snapshot != nil && h.snapshot.deltaOnly)
	}
	pageTargetBefore := h.snapshot.Target().Descriptor
	pageCursorBefore := h.snapshot.expectedCursor
	pageStartedBefore := h.snapshot.started
	deltaStatesBefore, err := json.Marshal(h.snapshot.deltaStates)
	if err != nil {
		t.Fatal(err)
	}
	quoteRequest.Target = resumedTarget.Descriptor
	value, err = h.handle(context.Background(), quoteRequest)
	if err != nil {
		t.Fatalf("已授权的历史引用应能在恢复delta目标后读取：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	if response["replyText"] != "晚点到" || response["referencedText"] != "先吃饭吗？" {
		t.Fatalf("恢复后引用文字不符：%#v", response)
	}
	deltaStatesAfter, err := json.Marshal(h.snapshot.deltaStates)
	if err != nil {
		t.Fatal(err)
	}
	if h.snapshot == nil || h.snapshot.Target().Descriptor != pageTargetBefore || h.snapshot.expectedCursor != pageCursorBefore ||
		h.snapshot.started != pageStartedBefore || string(deltaStatesAfter) != string(deltaStatesBefore) {
		t.Fatal("quote读取不得改变恢复的delta target、状态或分页游标")
	}
	pageRequest = notaloneHistoryRequest{Operation: "page", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: resumedTarget.Descriptor}
	value, err = h.handle(context.Background(), pageRequest)
	if err != nil {
		t.Fatalf("quote读取后原delta分页首游标仍应有效：%v", err)
	}
	page := value.(notaloneSnapshotPage)
	if page.Target != resumedTarget.Descriptor || !page.Exhausted || len(page.Records) != 0 {
		t.Fatalf("未变化delta分页不应重放已完成历史：%#v", page)
	}
}

func TestNotAloneQuoteReadAfterCompletedHistoryAndTailKeepsTargetAndCursor(t *testing.T) {
	raw := notaloneQuoteTestXML("晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先吃饭吗？")
	h, quoteRequest := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
	}, true)
	target := h.snapshot.Target()
	pageRequest := notaloneHistoryRequest{Operation: "page", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: target.Descriptor}
	value, err := h.handle(context.Background(), pageRequest)
	if err != nil {
		t.Fatalf("合成历史分页应完成：%v", err)
	}
	completed := value.(notaloneSnapshotPage)
	if !completed.Exhausted || completed.ResumeCursor == nil || h.snapshot != nil || h.tail == nil {
		t.Fatalf("历史完成后应交接到活动增量目标：page=%#v snapshot=%v tail=%v", completed, h.snapshot != nil, h.tail != nil)
	}
	cursor := *completed.ResumeCursor
	for index := 0; index < 2; index++ {
		for _, operation := range []string{"inspect", "support"} {
			consent := "selected-schema-v1"
			if operation == "inspect" {
				consent = "selected-schema-v1"
			}
			if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: operation, Consent: consent, Account: quoteRequest.Account, Conversation: quoteRequest.Conversation}); err != nil {
				t.Fatalf("活动增量时%s复核应成功：%v", operation, err)
			}
		}
		value, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "tail", Consent: "selected-history-v1", Account: quoteRequest.Account,
			Conversation: quoteRequest.Conversation, Target: target.Descriptor, Cursor: cursor})
		if err != nil {
			t.Fatalf("活动增量轮询应成功：%v", err)
		}
		page := value.(notaloneTailPage)
		if page.Target != target.Descriptor || !page.CaughtUp || page.CursorOut == "" {
			t.Fatalf("无变化时增量应保留目标并推进空闲游标：%#v", page)
		}
		cursor = page.CursorOut
	}
	for _, operation := range []string{"inspect", "support"} {
		if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: operation, Consent: "selected-schema-v1", Account: quoteRequest.Account, Conversation: quoteRequest.Conversation}); err != nil {
			t.Fatalf("引用前%s复核应成功：%v", operation, err)
		}
	}
	if h.snapshot != nil || h.snapshotMode != "normal" || h.tail == nil {
		t.Fatalf("应处于历史snapshot已释放、活动tail仍持有目标的真实状态：snapshot=%v mode=%q tail=%v", h.snapshot != nil, h.snapshotMode, h.tail != nil)
	}
	tailTarget, tailCursor, checkpointToken := h.tail.target.Descriptor, h.tail.expectedCursor, h.tail.checkpointToken
	tailStates, err := json.Marshal(h.tail.states)
	if err != nil {
		t.Fatal(err)
	}
	quoteRequest.Target = tailTarget
	value, err = h.handle(context.Background(), quoteRequest)
	if err != nil {
		t.Fatalf("活动tail期间已授权旧引用应可读取：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	if response["replyText"] != "晚点到" || response["referencedText"] != "先吃饭吗？" {
		t.Fatalf("活动tail期间引用文字不符：%#v", response)
	}
	tailStatesAfter, err := json.Marshal(h.tail.states)
	if err != nil {
		t.Fatal(err)
	}
	if h.tail.target.Descriptor != tailTarget || h.tail.expectedCursor != tailCursor || h.tail.checkpointToken != checkpointToken || string(tailStatesAfter) != string(tailStates) {
		t.Fatal("quote读取不得改变活动delta目标、游标或持久状态")
	}
	value, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "tail", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: tailTarget, Cursor: cursor})
	if err != nil {
		t.Fatalf("quote读取后原活动tail游标仍应有效：%v", err)
	}
	continued := value.(notaloneTailPage)
	if continued.Target != tailTarget || !continued.CaughtUp || continued.CursorIn != cursor {
		t.Fatalf("quote读取不得消费原tail游标：%#v", continued)
	}
}

func TestNotAloneQuoteReadDuringPartialTailPreservesDeltaPageCursor(t *testing.T) {
	raw := notaloneQuoteTestXML("晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先吃饭吗？")
	h, quoteRequest := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
	}, true)
	target := h.snapshot.Target()
	value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "page", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: target.Descriptor})
	if err != nil {
		t.Fatal(err)
	}
	completed := value.(notaloneSnapshotPage)
	if !completed.Exhausted || completed.ResumeCursor == nil || h.snapshot != nil || h.tail == nil {
		t.Fatalf("合成历史页应完成并交接增量游标：%#v", completed)
	}
	writer, err := wcdb.OpenWithKeyMapWritable(filepath.Join(h.server.cfg.DBRoot, "db_storage", "message", "message_0.db"), h.server.cfg.Keys)
	if err != nil {
		t.Fatal(err)
	}
	table := quoteIdent("Msg_" + talkerHash("friend-a"))
	for id := 2; id < 22; id++ {
		query := fmt.Sprintf("INSERT INTO %s(local_id,server_id,local_type,real_sender_id,create_time,status,message_content) VALUES(%d,%d,1,1,1700000001,2,'delta-%d')", table, id, 1000+id, id)
		if err = writer.Exec(query); err != nil {
			writer.Close()
			t.Fatal(err)
		}
	}
	writer.Close()
	for _, operation := range []string{"inspect", "support"} {
		if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: operation, Consent: "selected-schema-v1", Account: quoteRequest.Account, Conversation: quoteRequest.Conversation}); err != nil {
			t.Fatalf("新增消息后%s复核应成功：%v", operation, err)
		}
	}
	value, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "tail", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: target.Descriptor, Cursor: *completed.ResumeCursor})
	if err != nil {
		t.Fatalf("第一次增量页应成功：%v", err)
	}
	partial := value.(notaloneTailPage)
	if partial.CaughtUp || partial.CursorOut == "" || h.tail == nil || h.tail.snapshot == nil {
		t.Fatalf("20条变化应保留一个正在分页的delta snapshot：page=%#v tailSnapshot=%v", partial, h.tail != nil && h.tail.snapshot != nil)
	}
	snapshot := h.tail.snapshot
	originalCloser := notaloneQuoteSnapshotCloser
	closeCalls := 0
	notaloneQuoteSnapshotCloser = func(*notaloneSnapshot) error {
		closeCalls++
		return notaloneFailure("synthetic_borrowed_snapshot_close")
	}
	defer func() { notaloneQuoteSnapshotCloser = originalCloser }()
	pageCursor, pageCount, shardIndex := snapshot.expectedCursor, snapshot.pages, snapshot.shardIndex
	tailCursor, tailTarget := h.tail.expectedCursor, h.tail.target.Descriptor
	for _, operation := range []string{"inspect", "support"} {
		if _, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: operation, Consent: "selected-schema-v1", Account: quoteRequest.Account, Conversation: quoteRequest.Conversation}); err != nil {
			t.Fatalf("部分增量页后%s复核应成功：%v", operation, err)
		}
	}
	quoteRequest.Target = tailTarget
	value, err = h.handle(context.Background(), quoteRequest)
	if err != nil {
		t.Fatalf("活动delta snapshot中已授权旧引用应可读：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	if response["replyText"] != "晚点到" || response["referencedText"] != "先吃饭吗？" {
		t.Fatalf("活动delta snapshot引用内容不符：%#v", response)
	}
	if h.tail.snapshot != snapshot || h.tail.target.Descriptor != tailTarget || h.tail.expectedCursor != tailCursor ||
		snapshot.expectedCursor != pageCursor || snapshot.pages != pageCount || snapshot.shardIndex != shardIndex || closeCalls != 0 {
		t.Fatal("quote读取不得推进正在运行的delta page、snapshot游标或目标")
	}
	value, err = h.handle(context.Background(), notaloneHistoryRequest{Operation: "tail", Consent: "selected-history-v1", Account: quoteRequest.Account,
		Conversation: quoteRequest.Conversation, Target: tailTarget, Cursor: partial.CursorOut})
	if err != nil {
		t.Fatalf("quote读取后delta分页原游标仍应有效：%v", err)
	}
	continued := value.(notaloneTailPage)
	if continued.Target != tailTarget || !continued.CaughtUp || continued.CursorIn != partial.CursorOut || h.tail.snapshot != nil {
		t.Fatalf("quote读取不得消费或替换delta分页状态：%#v", continued)
	}
}

func TestNotAloneQuoteTemporarySnapshotCloseFailureFailsClosedAndBorrowedNormalSnapshotStaysOpen(t *testing.T) {
	t.Run("temporary close failure clears successful quote", func(t *testing.T) {
		raw := notaloneQuoteTestXML("晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先吃饭吗？")
		h, quoteRequest := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
			rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
		}, true)
		target := h.snapshot.Target()
		value, err := h.handle(context.Background(), notaloneHistoryRequest{Operation: "page", Consent: "selected-history-v1", Account: quoteRequest.Account,
			Conversation: quoteRequest.Conversation, Target: target.Descriptor})
		if err != nil || !value.(notaloneSnapshotPage).Exhausted || h.snapshot != nil || h.tail == nil {
			t.Fatalf("应先完成合成历史并保留活动tail：page=%#v err=%v", value, err)
		}
		originalCloser := notaloneQuoteSnapshotCloser
		closeCalls := 0
		notaloneQuoteSnapshotCloser = func(snapshot *notaloneSnapshot) error {
			closeCalls++
			if err := snapshot.Close(); err != nil {
				return err
			}
			return notaloneFailure("synthetic_quote_close_failure")
		}
		defer func() { notaloneQuoteSnapshotCloser = originalCloser }()
		value, err = h.handle(context.Background(), quoteRequest)
		if err == nil || err.Error() != "history_quote_source_changed" || closeCalls != 1 || h.life.Err() == nil {
			t.Fatalf("临时snapshot清理失败必须source_changed并关闭协议scope：value=%#v err=%v closeCalls=%d", value, err, closeCalls)
		}
		response, ok := value.(notaloneQuoteReadResponse)
		if !ok || response.ReplyText != "" || response.ReferencedText != nil || response.ContentSHA256 != "" {
			t.Fatalf("清理失败不得发布已解析引用正文：%#v", value)
		}
	})
	t.Run("normal snapshot is borrowed", func(t *testing.T) {
		raw := notaloneQuoteTestXML("晚点到", "1", "1841310816813489186", "synthetic-owner", "我", "先吃饭吗？")
		h, quoteRequest := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
			rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
		})
		borrowed := h.snapshot
		originalCloser := notaloneQuoteSnapshotCloser
		closeCalls := 0
		notaloneQuoteSnapshotCloser = func(*notaloneSnapshot) error {
			closeCalls++
			return notaloneFailure("synthetic_borrowed_snapshot_close")
		}
		defer func() { notaloneQuoteSnapshotCloser = originalCloser }()
		value, err := h.handle(context.Background(), quoteRequest)
		if err != nil || closeCalls != 0 || h.snapshot != borrowed || h.life.Err() != nil {
			t.Fatalf("借用的normal snapshot不应关闭：err=%v closeCalls=%d", err, closeCalls)
		}
		response := notaloneQuoteTestResponse(t, value)
		if response["replyText"] != "晚点到" || response["referencedText"] != "先吃饭吗？" || borrowed.Check() != nil {
			t.Fatalf("借用snapshot读完应仍可用：%#v", response)
		}
	})
}

func TestNotAloneQuoteReadRequiresExactRawTypeRoleAndStatus(t *testing.T) {
	otherType49 := int64((19 << 32) | 49)
	cases := []struct {
		name     string
		rawType  int64
		senderID int64
		status   int64
		wantCode string
	}{
		{name: "other 49 subtype", rawType: otherType49, senderID: 1, status: 2, wantCode: "history_quote_unavailable"},
		{name: "unmatched owner status", rawType: notaloneQuoteTestRawType, senderID: 1, status: 3, wantCode: "history_quote_state_unverified"},
		{name: "unmatched status", rawType: notaloneQuoteTestRawType, senderID: 1, status: 99, wantCode: "history_quote_state_unverified"},
		{name: "wrong owner status", rawType: notaloneQuoteTestRawType, senderID: 1, status: 4, wantCode: "history_quote_state_unverified"},
		{name: "wrong contact status", rawType: notaloneQuoteTestRawType, senderID: 2, status: 2, wantCode: "history_quote_state_unverified"},
		{name: "unmapped author", rawType: notaloneQuoteTestRawType, senderID: 3, status: 2, wantCode: "history_quote_association_unverified"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
				rawType: test.rawType, senderID: test.senderID, status: test.status, createAt: int64(1700000000),
				content: []byte("正文不得读取或解析"),
			})
			if _, err := h.handle(context.Background(), request); err == nil || err.Error() != test.wantCode {
				t.Fatalf("应拒绝且返回固定错误 %s，实际：%v", test.wantCode, err)
			}
		})
	}
}

func TestNotAloneQuoteReadRejectsMismatchedExactAssociation(t *testing.T) {
	mutations := []struct {
		name   string
		change func(*notaloneHistoryRequest)
	}{
		{name: "target", change: func(request *notaloneHistoryRequest) { request.Target = "different-target" }},
		{name: "partition", change: func(request *notaloneHistoryRequest) { request.Partition = strings.Repeat("a", 64) }},
		{name: "table", change: func(request *notaloneHistoryRequest) { request.Table = strings.Repeat("b", 64) }},
		{name: "server id", change: func(request *notaloneHistoryRequest) { request.ServerID = "0" }},
		{name: "sent at", change: func(request *notaloneHistoryRequest) { request.SentAt = "1700000000001" }},
	}
	for _, mutation := range mutations {
		t.Run(mutation.name, func(t *testing.T) {
			raw := notaloneQuoteTestXML("回复", "1", "9", "synthetic-owner", "我", "引用")
			h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
				rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: raw,
			})
			mutation.change(&request)
			if _, err := h.handle(context.Background(), request); err == nil || err.Error() != "history_quote_association_unverified" {
				t.Fatalf("错绑的引用位置必须返回固定关联错误：%v", err)
			}
		})
	}
}

func TestNotAloneQuoteReadRejectsNonCanonicalRequestBeforeConfigAccess(t *testing.T) {
	h := newNotaloneHistorySession(&server{})
	_, err := h.handle(context.Background(), notaloneHistoryRequest{
		Operation: "quote-read", Consent: "selected-quote-v1", Account: "owner", Conversation: "contact",
		Target: "fixed-target", Partition: strings.Repeat("a", 64), Table: strings.Repeat("b", 64),
		LocalID: "01", ServerID: "0",
	})
	if err == nil || err.Error() != "history_quote_request_invalid" {
		t.Fatalf("非规范ID应先于本机配置读取拒绝：%v", err)
	}
}

func TestNotAloneQuoteReadAcceptsNullSentAtAndDoesNotExpandMedia(t *testing.T) {
	raw := notaloneQuoteTestXML("这张照片真好看", "3", "0", "friend-a", "联系人", "<msg><img md5=\"not-a-real-image\"/></msg>")
	h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 2, status: 4, setServerID: true, serverID: 0, createAt: nil, content: raw,
	})
	request.SentAt = ""
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("来源时间为null时空串应绑定null并接受引用媒体占位：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	if response["sentAt"] != nil || response["serverId"] != "0" || response["replyText"] != "这张照片真好看" || response["referencedText"] != nil ||
		response["referencedType"] != "3" || response["referencedServerId"] != nil || response["referencedSenderRole"] != "contact" {
		t.Fatalf("引用媒体应只保留占位且时间null：%#v", response)
	}
}

func TestNotAloneQuoteReadEmitsExplicitNullWireFields(t *testing.T) {
	raw := notaloneQuoteTestXML("回复标题", "", "", "", "", "")
	h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
		rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, setServerID: true, serverID: 0, createAt: nil, content: raw,
	})
	request.SentAt = ""
	value, err := h.handle(context.Background(), request)
	if err != nil {
		t.Fatalf("无可解析引用细节时仍应保留合法引用回复：%v", err)
	}
	response := notaloneQuoteTestResponse(t, value)
	for _, key := range []string{"sentAt", "referencedText", "referencedSender", "referencedType", "referencedServerId"} {
		if _, exists := response[key]; !exists || response[key] != nil {
			t.Fatalf("wire的可空字段 %s 必须显式为null：%#v", key, response)
		}
	}
	if response["replyText"] != "回复标题" || response["referencedSenderRole"] != "unknown" {
		t.Fatalf("回复文字及未知引用作者标记错误：%#v", response)
	}
}

func TestNotAloneQuoteReadRejectsMalformedOversizedAndCompressedXML(t *testing.T) {
	compressor, err := zstd.NewWriter(nil, zstd.WithEncoderConcurrency(1))
	if err != nil {
		t.Fatal(err)
	}
	compressedXML := notaloneQuoteTestXML("压缩回复", "1", "1841310816813489186", "synthetic-owner", "我", "压缩引用")
	compressed := compressor.EncodeAll(compressedXML, nil)
	oversizedCompressed := compressor.EncodeAll([]byte(`<msg>`+strings.Repeat("x", notaloneQuoteTestXMLByteLimit)+`</msg>`), nil)
	compressor.Close()
	cases := []struct {
		name     string
		content  []byte
		typeCode int64
		wantCode string
	}{
		{name: "malformed", content: []byte(`<msg><appmsg><refermsg></appmsg></msg>`), wantCode: "history_quote_metadata_invalid"},
		{name: "oversized", content: []byte(`<msg>` + strings.Repeat("x", notaloneQuoteTestXMLByteLimit) + `</msg>`), wantCode: "history_quote_too_large"},
		{name: "compressed oversized", content: oversizedCompressed, typeCode: notaloneImageXMLZstdContentType, wantCode: "history_quote_too_large"},
		{name: "zstd content type mismatch", content: compressed, wantCode: "history_quote_metadata_invalid"},
		{name: "bounded zstd", content: compressed, typeCode: notaloneImageXMLZstdContentType},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			h, request := notaloneQuoteProtocolFixture(t, notaloneQuoteTestRow{
				rawType: notaloneQuoteTestRawType, senderID: 1, status: 2, createAt: int64(1700000000), content: test.content, typeCode: test.typeCode,
			})
			value, readErr := h.handle(context.Background(), request)
			if test.wantCode != "" {
				if readErr == nil || readErr.Error() != test.wantCode {
					t.Fatalf("坏XML应返回固定错误 %s，实际：%v", test.wantCode, readErr)
				}
				return
			}
			if readErr != nil {
				t.Fatalf("有界zstd引用XML应可读：%v", readErr)
			}
			response := notaloneQuoteTestResponse(t, value)
			if got := response["referencedText"]; got != "压缩引用" {
				t.Fatalf("压缩引用解析错误：%#v", got)
			}
			digest := sha256.Sum256(compressedXML)
			if response["contentSha256"] != hex.EncodeToString(digest[:]) {
				t.Fatalf("摘要应绑定精确解码XML：%#v", response["contentSha256"])
			}
		})
	}
}
