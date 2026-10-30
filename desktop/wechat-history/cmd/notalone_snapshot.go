package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

// 仅由受版本管理且有真实结构依据的profile装配；RPC不能提供此结构。
type notaloneReadProfile struct {
	SchemaShapeFingerprint    string
	StatusSemanticsVerified   bool
	IncrementalTailVerified   bool
	BoundarySemanticsVerified bool
	VerifiedTerminalAbsence   bool
	StatusRules               []notaloneStatusRule
	OpaqueStatusPolicy        string
}
type notaloneMessageState string

const (
	notaloneMessageSent     notaloneMessageState = "sent"
	notaloneMessageReceived notaloneMessageState = "received"
	notaloneMessagePending  notaloneMessageState = "pending"
	notaloneMessageFailed   notaloneMessageState = "failed"
	notaloneMessageRecalled notaloneMessageState = "recalled"
	notaloneMessageDeleted  notaloneMessageState = "deleted"
	notaloneMessageUnknown  notaloneMessageState = "unknown"
)

// 规则由可信的本机profile编译；local_type按完整整数匹配，未登记的高位不会继承低32位kind。
type notaloneStatusRule struct {
	LocalType        int64
	Sender           string
	Status           int64
	State            notaloneMessageState
	RequiresServerID bool
}

type notaloneStatusDecision struct {
	State           notaloneMessageState
	RuleMatched     bool
	StateVerified   bool
	HistoryEligible bool
}

func notaloneKnownMessageState(state notaloneMessageState) bool {
	switch state {
	case notaloneMessageSent, notaloneMessageReceived, notaloneMessagePending, notaloneMessageFailed, notaloneMessageRecalled, notaloneMessageDeleted:
		return true
	default:
		return false
	}
}

func notaloneStatusRulesValid(rules []notaloneStatusRule) bool {
	if len(rules) == 0 || len(rules) > 256 {
		return false
	}
	type tuple struct {
		localType int64
		sender    string
		status    int64
	}
	seen := make(map[tuple]struct{}, len(rules))
	for _, rule := range rules {
		if !notaloneKnownMessageState(rule.State) {
			return false
		}
		if rule.State == notaloneMessageSent && rule.Sender != "owner" || rule.State == notaloneMessageReceived && rule.Sender != "contact" {
			return false
		}
		if rule.Sender != "owner" && rule.Sender != "contact" && !(rule.Sender == "unknown" && rule.State != notaloneMessageSent && rule.State != notaloneMessageReceived) {
			return false
		}
		key := tuple{localType: rule.LocalType, sender: rule.Sender, status: rule.Status}
		if _, exists := seen[key]; exists {
			return false
		}
		seen[key] = struct{}{}
	}
	return true
}

func notaloneStatusProfileValid(profile notaloneReadProfile) bool {
	hasRules := len(profile.StatusRules) > 0
	if hasRules != profile.StatusSemanticsVerified {
		return false
	}
	if hasRules {
		return profile.OpaqueStatusPolicy == "" && notaloneStatusRulesValid(profile.StatusRules)
	}
	return !profile.StatusSemanticsVerified && (profile.OpaqueStatusPolicy == "snapshot-opaque-v1" || profile.OpaqueStatusPolicy == "quarantine-text-v1")
}

// 状态值分类与来源证据分开：命中规则只给出候选语义；未经认证的规则永远没有普通历史资格。
func notaloneClassifyStatus(profile notaloneReadProfile, localType int64, sender string, status int64, serverID *string) notaloneStatusDecision {
	decision := notaloneStatusDecision{State: notaloneMessageUnknown}
	for _, rule := range profile.StatusRules {
		if rule.LocalType != localType || rule.Sender != sender || rule.Status != status {
			continue
		}
		decision.State, decision.RuleMatched = rule.State, true
		if !profile.StatusSemanticsVerified {
			return decision
		}
		if rule.RequiresServerID && !notaloneAllocatedServerID(serverID) {
			return decision
		}
		decision.StateVerified = true
		if rule.State != notaloneMessageSent && rule.State != notaloneMessageReceived {
			return decision
		}
		decision.HistoryEligible = true
		return decision
	}
	return decision
}

func notaloneAllocatedServerID(serverID *string) bool {
	if serverID == nil {
		return false
	}
	value, err := strconv.ParseInt(*serverID, 10, 64)
	return err == nil && value > 0
}

type notaloneSnapshotTable struct {
	Partition string `json:"partition"`
	Instance  string `json:"instance"`
}
type notaloneSnapshotTarget struct {
	Protocol         string                  `json:"protocol"`
	Descriptor       string                  `json:"descriptor"`
	Partitions       []string                `json:"partitions"`
	Tables           []notaloneSnapshotTable `json:"tables"`
	SourceGeneration string                  `json:"sourceGeneration"`
}
type notaloneSnapshotRecord struct {
	Partition      string  `json:"partition"`
	Table          string  `json:"table"`
	LocalID        *string `json:"localId"`
	ServerID       *string `json:"serverId"`
	Sender         string  `json:"sender"`
	Kind           string  `json:"kind"`
	Text           *string `json:"text"`
	OriginalType   string  `json:"originalType"`
	Status         *string `json:"status"`
	MessageState   string  `json:"messageState,omitempty"`
	StateAssurance string  `json:"stateAssurance"`
	SentAt         *string `json:"sentAt"`
	TimePrecision  *string `json:"timePrecision"`
	OrderScheme    *string `json:"orderScheme"`
	OrderKey       *string `json:"orderKey"`
}
type notaloneSnapshotPage struct {
	Target              string                   `json:"target"`
	CursorIn            *string                  `json:"cursorIn"`
	CursorOut           *string                  `json:"cursorOut"`
	ResumeCursor        *string                  `json:"resumeCursor,omitempty"`
	Records             []notaloneSnapshotRecord `json:"records"`
	CompletedPartitions []string                 `json:"completedPartitions"`
	Exhausted           bool                     `json:"exhausted"`
}
type notaloneSnapshotShard struct {
	reader       *wcdb.DB
	observer     *wcdb.DB
	path         string
	partition    string
	instance     string
	observerPre  int64
	observerPost int64
	pinned       bool
	present      bool
	lastID       *int64
	done         bool
}
type notaloneSnapshot struct {
	mu                sync.Mutex
	life              context.Context
	cancel            context.CancelFunc
	closed            bool
	closeErr          error
	guard             *notaloneSourceGuard
	shards            []*notaloneSnapshotShard
	checkedPartitions []string
	selected          notaloneResolved
	senderOwner       string
	profile           notaloneReadProfile
	table             string
	schemaFingerprint string
	target            notaloneSnapshotTarget
	identityDigests   map[notaloneTailIdentity]notaloneTailBaselineEntry
	shardIndex        int
	expectedCursor    string
	started           bool
	pages             int
}

// 结构能力只比较列、完整索引列组、自动主键和触发器数量；实例编号不构成schema。
func notaloneSnapshotShape(tables []notaloneTableSchema) string {
	shapes := map[string]bool{}
	for _, table := range tables {
		indexes := []string{}
		for _, index := range table.Indexes {
			shape := struct {
				Unique  bool
				Origin  string
				Partial bool
				Columns []notaloneIndexColumn
			}{index.Unique, index.Origin, index.Partial, index.Columns}
			encoded, _ := json.Marshal(shape)
			indexes = append(indexes, string(encoded))
		}
		sort.Strings(indexes)
		shape := struct {
			Columns       []notaloneColumn
			PrimaryKey    []string
			AutoIncrement bool
			Indexes       []string
			TriggerCount  int
		}{table.Columns, table.DeclaredPrimaryKey, table.AutoIncrement, indexes, len(table.TriggerFingerprints)}
		encoded, _ := json.Marshal(shape)
		shapes[string(encoded)] = true
	}
	ordered := make([]string, 0, len(shapes))
	for shape := range shapes {
		ordered = append(ordered, shape)
	}
	sort.Strings(ordered)
	encoded, _ := json.Marshal(ordered)
	return notaloneHash(string(encoded))
}
func notaloneSnapshotNonce() (string, error) {
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		return "", notaloneFailure("history_nonce_unavailable")
	}
	return base64.RawURLEncoding.EncodeToString(random), nil
}
func notaloneSnapshotFiles(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, notaloneFailure("history_shards_unavailable")
	}
	files := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && msgShardRE.MatchString(entry.Name()) {
			files = append(files, filepath.Join(directory, entry.Name()))
		}
	}
	if len(files) == 0 || len(files) > 128 {
		return nil, notaloneFailure("history_shards_unavailable")
	}
	sort.Strings(files)
	return files, nil
}

// 实例身份必须与结构检查使用同一完整公式，旧版的文件+表名摘要不能升级为新证明。
func notaloneSnapshotInstanceMatches(schema notaloneTableSchema, table string) bool {
	_, versionErr := strconv.ParseUint(schema.SchemaVersion, 10, 32)
	rootPage, rootErr := strconv.ParseUint(schema.RootPage, 10, 32)
	return versionErr == nil && rootErr == nil && rootPage > 0 && len(schema.SQLFingerprint) == 64 &&
		schema.Target == notaloneHash(schema.Partition, table, schema.SchemaVersion, schema.RootPage, schema.SQLFingerprint)
}

func newNotaloneSnapshot(ctx context.Context, s *server, selected notaloneResolved, inspected notaloneInspection, profile notaloneReadProfile) (snapshot *notaloneSnapshot, err error) {
	if ctx == nil || s == nil || s.cfg == nil || selected.Account == "" || selected.Conversation == "" || selected.SourceGeneration == "" || selected.Account != s.cfg.Wxid || inspected.SourceGeneration != selected.SourceGeneration || inspected.ScopeDigest != notaloneHash(selected.Account, selected.Conversation) || inspected.SchemaFingerprint == "" || len(inspected.Tables) == 0 || len(inspected.CheckedPartitions) == 0 {
		return nil, notaloneFailure("history_scope_unverified")
	}
	if profile.SchemaShapeFingerprint == "" || profile.SchemaShapeFingerprint != notaloneSnapshotShape(inspected.Tables) || !notaloneStatusProfileValid(profile) {
		return nil, notaloneFailure("history_support_unverified")
	}
	if ctx.Err() != nil {
		return nil, notaloneFailure("history_snapshot_cancelled")
	}
	if wcdb.BootstrapBounded(s.wcdbPath) != nil {
		return nil, notaloneFailure("history_native_unavailable")
	}
	directory := filepath.Join(s.cfg.DBRoot, "db_storage", "message")
	files, err := notaloneSnapshotFiles(directory)
	if err != nil {
		return nil, err
	}
	guard, err := newNotaloneSourceGuard(directory, files)
	if err != nil {
		return nil, notaloneFailure("history_source_unverified")
	}
	life, cancel := context.WithTimeout(ctx, 2*time.Minute)
	// 目录账号身份继续用于scope；sender使用锁定上游selfWxid的账号名规范。
	n := &notaloneSnapshot{life: life, cancel: cancel, guard: guard, selected: selected, senderOwner: s.selfWxid(), profile: profile, table: "Msg_" + talkerHash(selected.Conversation), schemaFingerprint: inspected.SchemaFingerprint, checkedPartitions: append([]string(nil), inspected.CheckedPartitions...)}
	if profile.IncrementalTailVerified {
		n.identityDigests = make(map[notaloneTailIdentity]notaloneTailBaselineEntry)
	}
	defer func() {
		if err != nil {
			_ = n.Close()
		}
	}()
	checked := map[string]bool{}
	for _, partition := range inspected.CheckedPartitions {
		if checked[partition] {
			return nil, notaloneFailure("history_inspection_invalid")
		}
		checked[partition] = true
	}
	expected := map[string]notaloneTableSchema{}
	for _, schema := range inspected.Tables {
		if _, exists := expected[schema.Partition]; exists || !notaloneSnapshotInstanceMatches(schema, n.table) || len(schema.DeclaredPrimaryKey) != 1 || schema.DeclaredPrimaryKey[0] != "local_id" {
			return nil, notaloneFailure("history_identity_unverified")
		}
		expected[schema.Partition] = schema
	}
	if len(checked) != len(files) {
		return nil, notaloneFailure("history_shards_changed")
	}
	for _, file := range files {
		partition, e := guard.FileFingerprint(file)
		if e != nil || !checked[partition] {
			return nil, notaloneFailure("history_shards_changed")
		}
		reader, e := s.openDBNoRefresh("message", filepath.Base(file))
		if e != nil {
			return nil, notaloneFailure("history_shard_unavailable")
		}
		shard := &notaloneSnapshotShard{reader: reader, path: file, partition: partition}
		n.shards = append(n.shards, shard)
		shard.observer, e = s.openDBNoRefresh("message", filepath.Base(file))
		if e != nil {
			return nil, notaloneFailure("history_shard_unavailable")
		}
		presence, e := reader.QueryBounded(life, 2, "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?", n.table)
		if e != nil {
			return nil, notaloneFailure("history_schema_unavailable")
		}
		schema, hasExpected := expected[partition]
		shard.present = len(presence) == 1
		if shard.present != hasExpected {
			return nil, notaloneFailure("history_schema_changed")
		}
		if shard.present {
			actual, e := inspectNotaloneTable(life, reader, n.table, partition)
			if e != nil {
				return nil, e
			}
			a, _ := json.Marshal(actual)
			b, _ := json.Marshal(schema)
			if string(a) != string(b) {
				return nil, notaloneFailure("history_schema_changed")
			}
			shard.instance = actual.Target
		}
	}
	// 独立observer的共同无提交窗口固定所有reader；后续提交不移动既有切面。
	before := make([]int64, len(n.shards))
	for index, shard := range n.shards {
		version, e := notaloneSnapshotDataVersion(life, shard.observer)
		if e != nil {
			return nil, e
		}
		shard.observerPre = version
		before[index] = version
	}
	for _, shard := range n.shards {
		if _, e := shard.reader.QueryBounded(life, 1, "BEGIN"); e != nil {
			return nil, notaloneFailure("history_snapshot_unavailable")
		}
		query := "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?"
		args := []any{n.table}
		if shard.present {
			query = "SELECT 1 AS present FROM " + quoteIdent(n.table) + " LIMIT 1"
			args = nil
		}
		rows, e := shard.reader.QueryBounded(life, 1, query, args...)
		if e != nil {
			return nil, notaloneFailure("history_snapshot_unavailable")
		}
		if !shard.present && len(rows) != 0 {
			return nil, notaloneFailure("history_schema_changed")
		}
		shard.pinned = true
	}
	for index, shard := range n.shards {
		after, e := notaloneSnapshotDataVersion(life, shard.observer)
		if e != nil || after != before[index] {
			return nil, notaloneFailure("history_snapshot_window_changed")
		}
		shard.observerPost = after
	}
	// 获取窗口前的结构检查不能代替reader实际固定后的表实例；同名DDL也要失效。
	for _, shard := range n.shards {
		if shard.present {
			actual, e := inspectNotaloneTable(life, shard.reader, n.table, shard.partition)
			if e != nil {
				return nil, e
			}
			a, _ := json.Marshal(actual)
			b, _ := json.Marshal(expected[shard.partition])
			if string(a) != string(b) {
				return nil, notaloneFailure("history_schema_changed")
			}
		}
	}
	if guard.Check() != nil {
		return nil, notaloneFailure("history_source_changed")
	}
	descriptor, e := notaloneSnapshotNonce()
	if e != nil {
		return nil, e
	}
	n.target = notaloneSnapshotTarget{Protocol: "private-history-v1", Descriptor: descriptor, Partitions: []string{}, Tables: []notaloneSnapshotTable{}, SourceGeneration: selected.SourceGeneration}
	for _, shard := range n.shards {
		if shard.present {
			n.target.Partitions = append(n.target.Partitions, shard.partition)
			n.target.Tables = append(n.target.Tables, notaloneSnapshotTable{Partition: shard.partition, Instance: shard.instance})
		} else {
			shard.done = true
		}
	}
	go func() { <-life.Done(); _ = n.Close() }()
	return n, nil
}
func notaloneSnapshotDataVersion(ctx context.Context, db *wcdb.DB) (int64, error) {
	rows, err := db.QueryBounded(ctx, 1, "PRAGMA data_version")
	if err != nil || len(rows) != 1 {
		return 0, notaloneFailure("history_snapshot_unavailable")
	}
	version, ok := rows[0]["data_version"].(int64)
	if !ok {
		return 0, notaloneFailure("history_snapshot_unavailable")
	}
	return version, nil
}
func (n *notaloneSnapshot) Target() notaloneSnapshotTarget {
	n.mu.Lock()
	defer n.mu.Unlock()
	result := n.target
	result.Partitions = append([]string(nil), result.Partitions...)
	result.Tables = append([]notaloneSnapshotTable(nil), result.Tables...)
	return result
}
func (n *notaloneSnapshot) Check() error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if err := n.checkLocked(); err != nil {
		_ = n.closeLocked()
		return err
	}
	return nil
}
func (n *notaloneSnapshot) checkLocked() error {
	if n.closed {
		return notaloneFailure("history_snapshot_closed")
	}
	if n.life.Err() != nil {
		return notaloneFailure("history_snapshot_cancelled")
	}
	if n.guard.Check() != nil {
		return notaloneFailure("history_source_changed")
	}
	return nil
}
func (n *notaloneSnapshot) Page(ctx context.Context, cursor string) (page notaloneSnapshotPage, err error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	defer func() {
		if err != nil {
			page = notaloneSnapshotPage{}
			_ = n.closeLocked()
		}
	}()
	if err = n.checkLocked(); err != nil {
		return page, err
	}
	if ctx == nil || ctx.Err() != nil {
		return page, notaloneFailure("history_snapshot_cancelled")
	}
	pageLimit := 1000
	if n.profile.IncrementalTailVerified {
		pageLimit = (notaloneTailIdentityLimit+15)/16 + len(n.shards) + 1
	}
	if n.pages >= pageLimit {
		return page, notaloneFailure("history_page_budget_exhausted")
	}
	if (!n.started && cursor != "") || (n.started && (cursor == "" || cursor != n.expectedCursor)) {
		return page, notaloneFailure("history_cursor_invalid")
	}
	op, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(n.life, cancel)
	defer func() { stop(); cancel() }()
	page = notaloneSnapshotPage{Target: n.target.Descriptor, Records: []notaloneSnapshotRecord{}, CompletedPartitions: []string{}}
	if cursor != "" {
		value := cursor
		page.CursorIn = &value
	}
	for n.shardIndex < len(n.shards) && len(page.Records) < 16 {
		shard := n.shards[n.shardIndex]
		if shard.done {
			n.shardIndex++
			continue
		}
		remaining := 16 - len(page.Records)
		query := "SELECT local_id,server_id,local_type,real_sender_id,create_time,status FROM " + quoteIdent(n.table)
		args := []any{}
		if shard.lastID != nil {
			query += " WHERE local_id>?"
			args = append(args, *shard.lastID)
		}
		query += " ORDER BY local_id LIMIT ?"
		args = append(args, int64(remaining+1))
		rows, e := shard.reader.QueryBounded(op, remaining+1, query, args...)
		if e != nil {
			return page, notaloneFailure("history_page_read_failed")
		}
		exhausted := len(rows) <= remaining
		if !exhausted {
			rows = rows[:remaining]
		}
		records, e := n.projectRows(op, shard, rows)
		if e != nil {
			return page, e
		}
		if n.identityDigests != nil {
			if err := n.recordIdentityDigests(shard, records); err != nil {
				return page, err
			}
		}
		page.Records = append(page.Records, records...)
		if len(rows) > 0 {
			id, ok := rows[len(rows)-1]["local_id"].(int64)
			if !ok {
				return page, notaloneFailure("history_identity_unverified")
			}
			shard.lastID = &id
		}
		if exhausted {
			shard.done = true
			page.CompletedPartitions = append(page.CompletedPartitions, shard.partition)
			n.shardIndex++
		}
	}
	for n.shardIndex < len(n.shards) && n.shards[n.shardIndex].done {
		n.shardIndex++
	}
	page.Exhausted = n.shardIndex == len(n.shards)
	if !page.Exhausted {
		nonce, e := notaloneSnapshotNonce()
		if e != nil {
			return page, e
		}
		next := n.target.Descriptor + "." + nonce
		page.CursorOut = &next
		n.expectedCursor = next
	}
	if op.Err() != nil {
		return page, notaloneFailure("history_snapshot_cancelled")
	}
	if err = n.checkLocked(); err != nil {
		return page, err
	}
	n.pages++
	n.started = true
	if page.Exhausted {
		if closeErr := n.closeLocked(); closeErr != nil {
			return page, closeErr
		}
	}
	return page, nil
}
func (n *notaloneSnapshot) projectRows(ctx context.Context, shard *notaloneSnapshotShard, rows []wcdb.Row) ([]notaloneSnapshotRecord, error) {
	quarantine := n.profile.OpaqueStatusPolicy == "quarantine-text-v1"
	records := make([]notaloneSnapshotRecord, 0, len(rows))
	bodyIDs := []any{}
	bodyIndexes := map[int64]int{}
	for _, row := range rows {
		status, knownStatus := row["status"].(int64)
		rawType, knownType := row["local_type"].(int64)
		originalType := "unknown"
		kind := "other"
		if knownType {
			originalType = strconv.FormatInt(rawType, 10)
			kind = notaloneSnapshotKind(rawType)
		}
		record := notaloneSnapshotRecord{Partition: shard.partition, Table: shard.instance, LocalID: notaloneSnapshotDecimal(row["local_id"]), ServerID: notaloneSnapshotDecimal(row["server_id"]), Sender: "unknown", Kind: kind, OriginalType: originalType, Status: notaloneSnapshotDecimal(row["status"])}
		if senderID, ok := row["real_sender_id"].(int64); (n.profile.StatusSemanticsVerified || quarantine) && ok {
			names, e := shard.reader.QueryBounded(ctx, 1, "SELECT user_name FROM Name2Id WHERE rowid=? LIMIT 1", senderID)
			if e == nil && len(names) == 1 {
				switch rowString(names[0], "user_name") {
				case n.senderOwner:
					record.Sender = "owner"
				case n.selected.Conversation:
					record.Sender = "contact"
				}
			}
		}
		decision := notaloneStatusDecision{State: notaloneMessageUnknown}
		if knownType && knownStatus {
			decision = notaloneClassifyStatus(n.profile, rawType, record.Sender, status, record.ServerID)
		}
		allowed := decision.HistoryEligible
		record.StateAssurance = "unverified"
		if decision.StateVerified && (decision.State == notaloneMessageSent || decision.State == notaloneMessageReceived || decision.State == notaloneMessageRecalled) {
			record.StateAssurance = "verified"
			record.MessageState = string(decision.State)
		}
		if sent, ok := row["create_time"].(int64); ok && sent >= 0 && sent <= 253402300799 {
			ms := strconv.FormatInt(sent*1000, 10)
			precision := "second"
			record.SentAt = &ms
			record.TimePrecision = &precision
		}
		records = append(records, record)
		// 正文列表必须同时符合已认证的最终状态；隔离入口仅保留其独立授权的文字路径。
		if kind == "text" && knownType && record.LocalID != nil && (allowed || quarantine) {
			id := row["local_id"].(int64)
			bodyIDs = append(bodyIDs, id)
			bodyIndexes[id] = len(records) - 1
		}
	}
	if len(bodyIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(bodyIDs)), ",")
		// CASE短路保证非文字不求取正文；字节界限在native分配之前执行，不读source/XML。
		query := fmt.Sprintf("SELECT local_id,CASE WHEN (local_type & 4294967295)=1 THEN CASE WHEN length(CAST(message_content AS BLOB))<=? THEN message_content ELSE NULL END ELSE NULL END AS body FROM %s WHERE local_id IN (%s) ORDER BY local_id", quoteIdent(n.table), placeholders)
		args := append([]any{int64(notaloneTextByteLimit)}, bodyIDs...)
		bodies, e := shard.reader.QueryBounded(ctx, len(bodyIDs), query, args...)
		if e != nil {
			return nil, notaloneFailure("history_page_read_failed")
		}
		for _, body := range bodies {
			id, ok := body["local_id"].(int64)
			if !ok {
				continue
			}
			index, found := bodyIndexes[id]
			if !found {
				continue
			}
			text, e := decodeNotaloneText(body["body"])
			if e == nil {
				records[index].Text = text
			}
		}
	}
	return records, nil
}
func notaloneSnapshotDecimal(value any) *string {
	v, ok := value.(int64)
	if !ok {
		return nil
	}
	result := strconv.FormatInt(v, 10)
	return &result
}
func notaloneSnapshotKind(value int64) string {
	switch uint64(value) & 0xffffffff {
	case 1:
		return "text"
	case 3:
		return "image"
	case 34:
		return "voice"
	case 43, 62:
		return "video"
	case 47:
		return "sticker"
	case 49:
		return "file"
	default:
		return "other"
	}
}
func (n *notaloneSnapshot) closeLocked() error {
	if n.closed {
		return n.closeErr
	}
	n.closed = true
	n.cancel()
	failed := false
	for _, shard := range n.shards {
		if shard.reader != nil {
			shard.reader.Close()
			shard.reader = nil
		}
		if shard.observer != nil {
			shard.observer.Close()
			shard.observer = nil
		}
	}
	if n.guard.Close() != nil {
		failed = true
	}
	if failed {
		n.closeErr = notaloneFailure("history_snapshot_close_failed")
	}
	return n.closeErr
}
func (n *notaloneSnapshot) Close() error {
	if n == nil {
		return nil
	}
	n.cancel()
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.closeLocked()
}

// boundaryEvidence 要求调用者持有 n.mu；统一从已固定的observer和reader中返回获取窗口证据。
func (n *notaloneSnapshot) boundaryEvidence() ([]notaloneBoundaryPartition, bool, bool, error) {
	if err := n.checkLocked(); err != nil {
		return nil, false, false, err
	}
	evidence := make([]notaloneBoundaryPartition, 0, len(n.target.Tables))
	instances := make(map[string]string, len(n.target.Tables))
	for _, table := range n.target.Tables {
		if table.Partition == "" || table.Instance == "" || instances[table.Partition] != "" {
			return nil, false, false, notaloneFailure("history_boundary_instance_changed")
		}
		instances[table.Partition] = table.Instance
	}
	namespaceContinuity := n.guard != nil && n.guard.Check() == nil
	instanceContinuity := true
	for _, shard := range n.shards {
		instance, inTarget := instances[shard.partition]
		if !shard.present {
			if inTarget {
				instanceContinuity = false
			}
			continue
		}
		if !inTarget || instance != shard.instance || shard.reader == nil || shard.observer == nil || shard.observerPre < 0 || shard.observerPost < 0 {
			instanceContinuity = false
			continue
		}
		actual, err := inspectNotaloneTable(n.life, shard.reader, n.table, shard.partition)
		if err != nil || actual.Target != instance {
			instanceContinuity = false
		}
		evidence = append(evidence, notaloneBoundaryPartition{
			Partition: shard.partition, Instance: instance,
			PreSample: strconv.FormatInt(shard.observerPre, 10), PostSample: strconv.FormatInt(shard.observerPost, 10),
			ReaderCompleted: false,
		})
	}
	if err := n.checkLocked(); err != nil {
		return nil, false, false, err
	}
	return evidence, namespaceContinuity && n.guard.Check() == nil, instanceContinuity, nil
}
