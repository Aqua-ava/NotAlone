package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
	"github.com/r266-tech/wx-cli/v2/internal/wxkind"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

type notaloneHistoryRequest struct {
	Operation    string `json:"op"`
	Account      string `json:"account,omitempty"`
	Conversation string `json:"conversation,omitempty"`
	DisplayName  string `json:"displayName,omitempty"`
	Consent      string `json:"consent,omitempty"`
	Target       string `json:"target,omitempty"`
	Cursor       string `json:"cursor,omitempty"`
	Kind         string `json:"kind,omitempty"`
}
type notaloneResolved struct {
	Account          string `json:"accountKey"`
	Conversation     string `json:"conversationKey"`
	DisplayName      string `json:"displayName"`
	SourceGeneration string `json:"sourceGeneration"`
}
type notaloneInspection struct {
	Format            string                `json:"format"`
	Status            string                `json:"status"`
	ScopeDigest       string                `json:"scopeDigest"`
	SourceGeneration  string                `json:"sourceGeneration"`
	SchemaFingerprint string                `json:"schemaFingerprint"`
	Tables            []notaloneTableSchema `json:"tables"`
	CheckedPartitions []string              `json:"checkedPartitions"`
}
type notaloneMetadataReport struct {
	Format            string                       `json:"format"`
	Status            string                       `json:"status"`
	ScopeDigest       string                       `json:"scopeDigest"`
	SourceGeneration  string                       `json:"sourceGeneration"`
	SchemaFingerprint string                       `json:"schemaFingerprint"`
	Kind              string                       `json:"kind"`
	CheckedPartitions []string                     `json:"checkedPartitions"`
	Record            *notaloneMetadataObservation `json:"record"`
}
type notaloneHistorySession struct {
	server               *server
	selected             *notaloneResolved
	guards               []*notaloneSourceGuard
	life                 context.Context
	cancel               context.CancelFunc
	snapshot             *notaloneSnapshot
	snapshotMode         string
	tail                 *notaloneTailSession
	messageGuard         *notaloneSourceGuard
	messageMonitor       *notaloneSourceGuard
	guardLost            chan struct{}
	guardLostOnce        sync.Once
	inspected            *notaloneInspection
	supportReport        *notaloneSupportReport
	supportProfile       *notaloneReadProfile
	program              func(context.Context) (notaloneProgramVersion, error)
	sourceProcess        func(context.Context) (notaloneProcessIdentity, error)
	certify              func(notaloneProgramVersion, []notaloneTableSchema) notaloneProfileCertification
	testMetadata         *notaloneTestMetadataWatch
	receivedTestMetadata *notaloneReceivedTestMetadataWatch
	accountGeneration    string
}

func newNotaloneHistorySession(s *server) *notaloneHistorySession {
	life, cancel := context.WithCancel(context.Background())
	return &notaloneHistorySession{server: s, life: life, cancel: cancel, program: readNotaloneProgramVersion, sourceProcess: selectedNotaloneWechatProcess, certify: certifyNotaloneProfile, guardLost: make(chan struct{})}
}
func (h *notaloneHistorySession) close() {
	h.cancel()
	h.resetTail()
	if h.testMetadata != nil {
		_ = h.testMetadata.Close()
	}
	if h.receivedTestMetadata != nil {
		_ = h.receivedTestMetadata.Close()
	}
	if h.snapshot != nil {
		_ = h.snapshot.Close()
		h.snapshot = nil
	}
	if h.messageGuard != nil {
		_ = h.messageGuard.Close()
		h.messageGuard = nil
	}
	if h.messageMonitor != nil {
		_ = h.messageMonitor.Close()
		h.messageMonitor = nil
	}
	for _, g := range h.guards {
		_ = g.Close()
	}
	h.guards = nil
}

// 在一个原生会话内跨快照持有目录及分片守卫；进程结束后不声称连续。
func (h *notaloneHistorySession) ensureMessageGuard() error {
	if h.messageGuard != nil {
		if h.messageGuard.Check() != nil {
			return notaloneFailure("history_source_changed")
		}
		return nil
	}
	if h.sourceProcess == nil {
		return notaloneFailure("history_source_unverified")
	}
	process, err := h.sourceProcess(h.life)
	if err != nil {
		return notaloneFailure("history_source_unverified")
	}
	directory := filepath.Join(h.server.cfg.DBRoot, "db_storage", "message")
	files, err := notaloneSnapshotFiles(directory)
	if err != nil {
		return err
	}
	guard, err := newNotaloneSourceGuard(directory, files)
	if err != nil {
		return notaloneFailure("history_source_unverified")
	}
	// 事件通知使用独立队列，不能消耗读前核验使用的守卫事件。
	monitor, err := newNotaloneSourceGuard(directory, files)
	if err != nil {
		_ = guard.Close()
		return notaloneFailure("history_source_unverified")
	}
	if guard.WatchProcess(process) != nil || monitor.WatchProcess(process) != nil || monitor.StartMonitor() != nil || guard.Check() != nil {
		_ = monitor.Close()
		_ = guard.Close()
		return notaloneFailure("history_source_unverified")
	}
	h.messageGuard = guard
	h.messageMonitor = monitor
	go func() {
		select {
		case <-monitor.Lost():
			if h.life.Err() == nil {
				h.guardLostOnce.Do(func() { close(h.guardLost) })
			}
		case <-h.life.Done():
		}
	}()
	return nil
}

var notaloneIdentity = regexp.MustCompile(`^[A-Za-z0-9_.@-]{1,255}$`)

// 仅使用现有schema2配置；不运行探钥、Keychain授权、缓存刷新或路径RPC。
func (h *notaloneHistorySession) initialize() error {
	// 缺少既有账号或根目录时直接拒绝，绝不走上游自动账号目录发现。
	if !h.server.ok {
		cfg, err := config.Load()
		if err != nil || cfg.SchemaVersion != 2 || !cfg.Ready() || !notaloneIdentity.MatchString(cfg.Wxid) || !filepath.IsAbs(cfg.DBRoot) || filepath.Clean(cfg.DBRoot) != cfg.DBRoot {
			return notaloneFailure("history_account_unavailable")
		}
		library, err := findWCDB()
		if err != nil {
			return notaloneFailure("history_native_unavailable")
		}
		h.server.cfg = cfg
		h.server.wcdbPath = library
		h.server.ok = true
	}
	cfg := h.server.cfg
	if cfg == nil || cfg.SchemaVersion != 2 || !cfg.Ready() || !notaloneIdentity.MatchString(cfg.Wxid) || !filepath.IsAbs(cfg.DBRoot) || filepath.Clean(cfg.DBRoot) != cfg.DBRoot {
		return notaloneFailure("history_account_unavailable")
	}
	if err := wcdb.BootstrapBounded(h.server.wcdbPath); err != nil {
		return notaloneFailure("history_native_unavailable")
	}
	return nil
}
func (h *notaloneHistorySession) currentAccount() error {
	current, err := config.Load()
	if err != nil || current.Wxid != h.server.cfg.Wxid || current.DBRoot != h.server.cfg.DBRoot || !current.Ready() {
		return notaloneFailure("history_account_changed")
	}
	oldKeys, _ := json.Marshal(h.server.cfg.Keys)
	newKeys, _ := json.Marshal(current.Keys)
	if string(oldKeys) != string(newKeys) {
		return notaloneFailure("history_account_changed")
	}
	for _, g := range h.guards {
		if g.Check() != nil {
			return notaloneFailure("history_source_changed")
		}
	}
	return nil
}
func (h *notaloneHistorySession) resolve(ctx context.Context, name string) (notaloneResolved, error) {
	result := notaloneResolved{}
	if name == "" || len(name) > 255 || strings.ContainsAny(name, "\x00\r\n") {
		return result, notaloneFailure("history_request_invalid")
	}
	contact, err := h.server.openDBNoRefresh("contact", "contact.db")
	if err != nil {
		return result, notaloneFailure("history_metadata_unavailable")
	}
	defer contact.Close()
	rows, err := contact.QueryBounded(ctx, 16, `SELECT username,verify_flag,COALESCE(NULLIF(remark,''),NULLIF(nick_name,''),username) AS display_name FROM contact WHERE COALESCE(NULLIF(remark,''),NULLIF(nick_name,''),username)=? OR username=? LIMIT 16`, name, name)
	if err != nil || len(rows) != 1 {
		return result, notaloneFailure("history_target_ambiguous")
	}
	username := rowString(rows[0], "username")
	if !notaloneIdentity.MatchString(username) || agentChatType(username, wxkind.ClassifyUsername(username), rowInt64(rows[0], "verify_flag") != 0) != "private" {
		return result, notaloneFailure("history_target_not_private")
	}
	session, err := h.server.openDBNoRefresh("session", "session.db")
	if err != nil {
		return result, notaloneFailure("history_metadata_unavailable")
	}
	defer session.Close()
	sessions, err := session.QueryBounded(ctx, 2, "SELECT username FROM SessionTable WHERE username=? AND COALESCE(is_hidden,0)=0 LIMIT 2", username)
	if err != nil || len(sessions) != 1 {
		return result, notaloneFailure("history_target_unverified")
	}
	result = notaloneResolved{Account: h.server.cfg.Wxid, Conversation: username, DisplayName: rowString(rows[0], "display_name")}
	return result, nil
}
func (h *notaloneHistorySession) bindMetadata(ctx context.Context, name string) (result notaloneResolved, err error) {
	base := len(h.guards)
	alreadyBound := h.accountGeneration != ""
	defer func() {
		if !alreadyBound && err != nil {
			for _, guard := range h.guards[base:] {
				_ = guard.Close()
			}
			h.guards = h.guards[:base]
			h.selected = nil
			h.accountGeneration = ""
		}
	}()
	generation, err := h.bindAccountMetadata(ctx)
	if err != nil {
		return result, err
	}
	result, err = h.resolve(ctx, name)
	if err != nil {
		return result, err
	}
	if h.selected != nil && (h.selected.Account != result.Account || h.selected.Conversation != result.Conversation || h.selected.DisplayName != result.DisplayName) {
		return result, notaloneFailure("history_scope_changed")
	}
	result.SourceGeneration = generation
	if h.selected == nil {
		h.selected = &result
	}
	return result, h.currentAccount()
}
func (h *notaloneHistorySession) inspect(ctx context.Context) (notaloneInspection, error) {
	result := notaloneInspection{Format: "wechat-message-schema-v1", Status: "unverified", ScopeDigest: notaloneHash(h.selected.Account, h.selected.Conversation), SourceGeneration: h.selected.SourceGeneration, Tables: []notaloneTableSchema{}, CheckedPartitions: []string{}}
	directory := filepath.Join(h.server.cfg.DBRoot, "db_storage", "message")
	entries, err := os.ReadDir(directory)
	if err != nil {
		return result, notaloneFailure("history_shards_unavailable")
	}
	var files []string
	for _, entry := range entries {
		if !entry.IsDir() && msgShardRE.MatchString(entry.Name()) {
			files = append(files, filepath.Join(directory, entry.Name()))
		}
	}
	if len(files) == 0 || len(files) > 128 {
		return result, notaloneFailure("history_shards_unavailable")
	}
	sort.Strings(files)
	guard, err := newNotaloneSourceGuard(directory, files)
	if err != nil {
		return result, notaloneFailure("history_source_unverified")
	}
	defer guard.Close()
	table := "Msg_" + talkerHash(h.selected.Conversation)
	for _, file := range files {
		if guard.Check() != nil {
			return result, notaloneFailure("history_source_changed")
		}
		db, e := h.server.openDBNoRefresh("message", filepath.Base(file))
		if e != nil {
			return result, notaloneFailure("history_shard_unavailable")
		}
		partition, e := guard.FileFingerprint(file)
		if e != nil {
			db.Close()
			return result, notaloneFailure("history_source_changed")
		}
		present, e := db.QueryBounded(ctx, 2, "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?", table)
		if e != nil {
			db.Close()
			return result, notaloneFailure("history_schema_unavailable")
		}
		if len(present) > 0 {
			schema, e := inspectNotaloneTable(ctx, db, table, partition)
			if e != nil {
				db.Close()
				return result, e
			}
			result.Tables = append(result.Tables, schema)
		}
		db.Close()
		result.CheckedPartitions = append(result.CheckedPartitions, partition)
	}
	if len(result.Tables) == 0 {
		return result, notaloneFailure("history_target_table_missing")
	}
	if guard.Check() != nil || h.currentAccount() != nil {
		return result, notaloneFailure("history_source_changed")
	}
	encoded, _ := json.Marshal(result.Tables)
	result.SchemaFingerprint = notaloneHash(string(encoded), strings.Join(result.CheckedPartitions, "|"))
	return result, nil
}

type notaloneSupportReport struct {
	Protocol             string            `json:"protocol"`
	ProfileID            string            `json:"profileId"`
	AdapterVersion       string            `json:"adapterVersion"`
	Status               string            `json:"status"`
	Reason               *string           `json:"reason"`
	AccountKey           string            `json:"accountKey"`
	ConversationKey      string            `json:"conversationKey"`
	SourceGeneration     string            `json:"sourceGeneration"`
	ProgramVersion       string            `json:"programVersion"`
	Build                string            `json:"build"`
	ArtifactSHA256       string            `json:"artifactSha256"`
	SchemaFingerprint    string            `json:"schemaFingerprint"`
	DeclaredPrimaryKey   []string          `json:"declaredPrimaryKey"`
	ServerAliasSemantics string            `json:"serverAliasSemantics"`
	Identity             string            `json:"identity"`
	StatusSemantics      string            `json:"statusSemantics"`
	Continuity           string            `json:"continuity"`
	Capabilities         map[string]string `json:"capabilities,omitempty"`
}

func notaloneFileHash(file string) (string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", notaloneFailure("history_artifact_unverified")
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}
func (h *notaloneHistorySession) support(ctx context.Context) (notaloneSupportReport, *notaloneReadProfile, error) {
	result := notaloneSupportReport{Protocol: "private-history-v1", AdapterVersion: "1", Status: "unverified", AccountKey: h.selected.Account, ConversationKey: h.selected.Conversation, SourceGeneration: h.selected.SourceGeneration, ServerAliasSemantics: "unverified", Identity: "source-table-local-v1", DeclaredPrimaryKey: []string{}}
	if h.supportReport != nil && h.supportProfile != nil {
		if err := h.currentAccount(); err != nil {
			return result, nil, err
		}
		if err := h.ensureMessageGuard(); err != nil {
			return result, nil, err
		}
		if h.snapshot != nil {
			if err := h.snapshot.Check(); err != nil {
				return result, nil, err
			}
		}
		if h.inspected == nil || h.supportReport.SourceGeneration != h.selected.SourceGeneration || h.supportReport.AccountKey != h.selected.Account || h.supportReport.ConversationKey != h.selected.Conversation {
			return result, nil, notaloneFailure("history_scope_changed")
		}
		return cloneNotaloneSupportReport(*h.supportReport), cloneNotaloneReadProfile(h.supportProfile), nil
	}
	inspected, err := h.inspect(ctx)
	if err != nil {
		return result, nil, err
	}
	program, err := h.program(ctx)
	if err != nil {
		return result, nil, err
	}
	certification := h.certify(program, inspected.Tables)
	result.ProfileID = certification.ProfileID
	result.ProgramVersion = certification.ProgramVersion
	result.Build = certification.Build
	if certification.Status == "unsupported" {
		result.Status = "unsupported"
	}
	result.SchemaFingerprint = inspected.SchemaFingerprint
	result.DeclaredPrimaryKey = certification.DeclaredPrimaryKey
	result.StatusSemantics = certification.StatusSemantics
	result.Continuity = certification.Continuity
	result.Capabilities = cloneNotaloneCapabilityMap(certification.Capabilities)
	if certification.Reason != "" {
		reason := certification.Reason
		result.Reason = &reason
	}
	executable, err := os.Executable()
	if err != nil {
		return result, nil, notaloneFailure("history_artifact_unverified")
	}
	result.ArtifactSHA256, err = notaloneFileHash(executable)
	if err != nil {
		return result, nil, err
	}
	library, err := notaloneFileHash(h.server.wcdbPath)
	if err != nil || library != "4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d" {
		reason := "history_artifact_unverified"
		result.Status = "unverified"
		result.Reason = &reason
		if result.Capabilities == nil {
			result.Capabilities = map[string]string{}
		}
		result.Capabilities["incrementalTail"] = "unverified"
		result.Capabilities["private-history-boundary-v1"] = "unverified"
		return result, nil, nil
	}
	if h.inspected != nil && h.inspected.SchemaFingerprint != inspected.SchemaFingerprint {
		return result, nil, notaloneFailure("history_schema_changed")
	}
	if result.Capabilities == nil {
		result.Capabilities = map[string]string{}
	}
	result.Capabilities["incrementalTail"] = "unverified"
	result.Capabilities["private-history-boundary-v1"] = "unverified"
	h.inspected = &inspected
	if !notaloneRuntimeReadCandidate(program, inspected, certification) {
		return result, cloneNotaloneReadProfile(certification.ReadProfile), nil
	}
	if err := h.ensureMessageGuard(); err != nil {
		return result, nil, err
	}
	profile := *certification.ReadProfile
	profile.IncrementalTailVerified = true
	profile.VerifiedTerminalAbsence = certification.ProfileID == "wechat-4.0.6-29387-observed-states-v1" &&
		program.Version == "4.0.6" && program.Build == "29387" && notalone40629387ObservedStatusRulesMatch(profile.StatusRules)
	snapshot, err := newNotaloneSnapshot(h.life, h.server, *h.selected, inspected, profile)
	if err != nil {
		return result, nil, err
	}
	proof, proofErr := snapshot.FixedSnapshotProof(inspected)
	if proofErr != nil {
		_ = snapshot.Close()
		return result, nil, proofErr
	}
	if proof.Status != "verified" || proof.Format != notaloneFixedSnapshotProofFormat || proof.Scope != "single-fixed-snapshot" ||
		proof.AuthorizesSubsequentRead || proof.ExpectedPartitionCount == 0 || proof.ExpectedPartitionCount != proof.CompletedPartitionCount {
		_ = snapshot.Close()
		return result, nil, notaloneFailure("history_snapshot_proof_incomplete")
	}
	if err := h.currentAccount(); err != nil {
		_ = snapshot.Close()
		return result, nil, err
	}
	if err := h.ensureMessageGuard(); err != nil {
		_ = snapshot.Close()
		return result, nil, err
	}
	for _, capability := range []string{"statusSemantics", "sourceLifecycle", "restartContinuity", "recoveryMapping", "snapshotBarrier", "partitionCoverage", "normalHistory", "incrementalTail"} {
		result.Capabilities[capability] = "supported"
	}
	result.Status = "supported"
	result.StatusSemantics = "observed_subset_only"
	result.Continuity = "same-source-instances-normal-use-v1"
	result.Reason = nil
	h.snapshot = snapshot
	h.snapshotMode = "normal"
	h.supportReport = ptrNotaloneSupportReport(cloneNotaloneSupportReport(result))
	h.supportProfile = &profile
	return result, cloneNotaloneReadProfile(&profile), nil
}

func cloneNotaloneCapabilityMap(value map[string]string) map[string]string {
	if value == nil {
		return nil
	}
	clone := make(map[string]string, len(value))
	for key, item := range value {
		clone[key] = item
	}
	return clone
}

func cloneNotaloneSupportReport(value notaloneSupportReport) notaloneSupportReport {
	value.DeclaredPrimaryKey = append([]string(nil), value.DeclaredPrimaryKey...)
	value.Capabilities = cloneNotaloneCapabilityMap(value.Capabilities)
	if value.Reason != nil {
		reason := *value.Reason
		value.Reason = &reason
	}
	return value
}

func ptrNotaloneSupportReport(value notaloneSupportReport) *notaloneSupportReport { return &value }

func cloneNotaloneReadProfile(value *notaloneReadProfile) *notaloneReadProfile {
	if value == nil {
		return nil
	}
	clone := *value
	clone.StatusRules = append([]notaloneStatusRule(nil), value.StatusRules...)
	return &clone
}
func (h *notaloneHistorySession) handle(ctx context.Context, r notaloneHistoryRequest) (any, error) {
	if r.Operation != "observe-metadata" && r.Operation != "observe-test-metadata" && r.Operation != "observe-received-test-metadata" && r.Kind != "" {
		return nil, notaloneFailure("history_request_invalid")
	}
	switch r.Operation {
	case "inspect-account-schema":
		if r.Consent != "account-schema-v1" || r.Account != "" || r.Conversation != "" || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "metadata-account":
		if r.Consent != "account-session-metadata-v1" || r.Account != "" || r.Conversation != "" || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "metadata-sessions":
		if r.Consent != "private-session-list-metadata-v1" || !notaloneIdentity.MatchString(r.Account) || r.Conversation != "" || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "resolve":
		if r.Consent != "selected-metadata-v1" || r.DisplayName == "" || r.Account != "" || r.Conversation != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "boundary-snapshot":
		if r.Consent != "selected-history-boundary-v1" || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "observe-metadata":
		if r.Consent != "selected-message-metadata-v1" || !validNotaloneMetadataKind(r.Kind) || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "observe-test-metadata":
		if r.Consent != "selected-test-lifecycle-metadata-v1" || !validNotaloneTestMetadataAction(r.Kind) || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "observe-received-test-metadata":
		if r.Consent != "selected-received-test-lifecycle-metadata-v1" || !validNotaloneTestMetadataAction(r.Kind) || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "verify-snapshot-metadata":
		if r.Consent != "selected-snapshot-metadata-v1" || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || r.Target != "" || r.Cursor != "" {
			return nil, notaloneFailure("history_request_invalid")
		}
	case "inspect", "support", "target", "page", "tail", "quarantine-target", "quarantine-page":
		consent := "selected-schema-v1"
		if r.Operation == "target" || r.Operation == "page" || r.Operation == "tail" {
			consent = "selected-history-v1"
		}
		if r.Operation == "quarantine-target" || r.Operation == "quarantine-page" {
			consent = "selected-quarantine-history-v1"
		}
		isPage := r.Operation == "page" || r.Operation == "quarantine-page" || r.Operation == "tail"
		if r.Consent != consent || !notaloneIdentity.MatchString(r.Account) || !notaloneIdentity.MatchString(r.Conversation) || r.DisplayName != "" || (!isPage && (r.Target != "" || r.Cursor != "")) || (isPage && r.Target == "") {
			return nil, notaloneFailure("history_request_invalid")
		}
	default:
		return nil, notaloneFailure("history_operation_unsupported")
	}
	if err := h.initialize(); err != nil {
		return nil, err
	}
	if err := h.currentAccount(); err != nil {
		return nil, err
	}
	if r.Operation == "inspect-account-schema" {
		return h.inspectAccountSchema(ctx)
	}
	if r.Operation == "metadata-account" {
		return h.metadataAccount(ctx)
	}
	if r.Operation == "metadata-sessions" {
		if r.Account != h.server.cfg.Wxid {
			return nil, notaloneFailure("history_scope_unverified")
		}
		return h.metadataSessions(ctx)
	}
	if r.Operation == "resolve" {
		return h.bindMetadata(ctx, r.DisplayName)
	}
	if h.selected == nil || r.Account != h.selected.Account || r.Conversation != h.selected.Conversation {
		return nil, notaloneFailure("history_scope_unverified")
	}
	if err := h.currentAccount(); err != nil {
		return nil, err
	}
	if _, err := h.bindMetadata(ctx, h.selected.Conversation); err != nil {
		return nil, err
	}
	if r.Operation == "inspect" {
		return h.inspect(ctx)
	}
	if r.Operation == "verify-snapshot-metadata" {
		return h.verifyFixedSnapshotMetadata(ctx)
	}
	if r.Operation == "boundary-snapshot" {
		return h.boundarySnapshot(ctx)
	}
	if r.Operation == "observe-test-metadata" {
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		inspection, err := h.inspect(ctx)
		if err != nil {
			return nil, err
		}
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		if h.testMetadata == nil {
			h.testMetadata = newNotaloneTestMetadataWatch()
		}
		report, observeErr := h.testMetadata.observe(ctx, h.server, *h.selected, inspection, r.Kind)
		if observeErr != nil {
			if err := h.ensureMessageGuard(); err != nil {
				return nil, err
			}
			return nil, observeErr
		}
		if err = h.currentAccount(); err != nil {
			return nil, err
		}
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		return report, nil
	}
	if r.Operation == "observe-received-test-metadata" {
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		inspection, err := h.inspect(ctx)
		if err != nil {
			return nil, err
		}
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		if h.receivedTestMetadata == nil {
			h.receivedTestMetadata = newNotaloneReceivedTestMetadataWatch()
		}
		report, observeErr := h.receivedTestMetadata.observe(ctx, h.server, *h.selected, inspection, r.Kind)
		if observeErr != nil {
			if err := h.ensureMessageGuard(); err != nil {
				return nil, err
			}
			return nil, observeErr
		}
		if err = h.currentAccount(); err != nil {
			return nil, err
		}
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		return report, nil
	}
	if r.Operation == "observe-metadata" {
		inspection, err := h.inspect(ctx)
		if err != nil {
			return nil, err
		}
		observation, err := observeNotaloneMessageMetadata(ctx, h.server, *h.selected, inspection, r.Kind)
		if err != nil {
			return nil, err
		}
		if err = h.currentAccount(); err != nil {
			return nil, err
		}
		return notaloneMetadataReport{Format: "wechat-message-metadata-observation-v1", Status: "unverified", ScopeDigest: inspection.ScopeDigest, SourceGeneration: inspection.SourceGeneration, SchemaFingerprint: inspection.SchemaFingerprint, Kind: r.Kind, CheckedPartitions: inspection.CheckedPartitions, Record: observation}, nil
	}

	if (r.Operation == "target" || r.Operation == "page" || r.Operation == "tail" || r.Operation == "quarantine-target" || r.Operation == "quarantine-page") && h.messageGuard != nil {
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
	}
	report, profile, err := h.support(ctx)
	if err != nil {
		return nil, err
	}
	if r.Operation == "support" {
		return report, nil
	}
	if r.Operation == "tail" {
		return h.tailPage(ctx, r, report, profile)
	}
	mode := "normal"
	if r.Operation == "quarantine-target" || r.Operation == "quarantine-page" {
		// 独立、明确同意的隔离读取只依赖已核验结构，不授予普通历史或状态语义。
		if profile == nil || report.Capabilities["programVersion"] != "supported" || report.Capabilities["exactSchema"] != "supported" || report.Capabilities["declaredLocalKey"] != "supported" {
			return nil, notaloneFailure("history_support_unverified")
		}
		profile = &notaloneReadProfile{SchemaShapeFingerprint: profile.SchemaShapeFingerprint, OpaqueStatusPolicy: "quarantine-text-v1"}
		mode = "quarantine"
	} else if report.Status != "supported" || profile == nil {
		return nil, notaloneFailure("history_support_unverified")
	}
	if r.Operation == "target" || r.Operation == "quarantine-target" {
		if err := h.ensureMessageGuard(); err != nil {
			return nil, err
		}
		if mode == "normal" && h.snapshot != nil && h.snapshotMode == "normal" {
			if err := h.snapshot.Check(); err != nil {
				return nil, err
			}
			return h.snapshot.Target(), nil
		}
		if h.snapshot != nil {
			if closeErr := h.snapshot.Close(); closeErr != nil {
				return nil, notaloneFailure("history_snapshot_close_failed")
			}
			h.snapshot = nil
		}
		h.resetTail()
		snapshot, err := newNotaloneSnapshot(h.life, h.server, *h.selected, *h.inspected, *profile)
		if err != nil {
			return nil, err
		}
		if mode == "normal" {
			proof, proofErr := snapshot.FixedSnapshotProof(*h.inspected)
			if proofErr != nil || proof.Status != "verified" || proof.ExpectedPartitionCount == 0 || proof.ExpectedPartitionCount != proof.CompletedPartitionCount {
				_ = snapshot.Close()
				if proofErr != nil {
					return nil, proofErr
				}
				return nil, notaloneFailure("history_snapshot_proof_incomplete")
			}
		}
		if err := h.ensureMessageGuard(); err != nil {
			_ = snapshot.Close()
			return nil, err
		}
		h.snapshot = snapshot
		h.snapshotMode = mode
		return snapshot.Target(), nil
	}
	if h.snapshot == nil || h.snapshotMode != mode || r.Target != h.snapshot.Target().Descriptor {
		return nil, notaloneFailure("history_target_invalid")
	}
	page, err := h.snapshot.Page(ctx, r.Cursor)
	if err != nil {
		_ = h.snapshot.Close()
		h.snapshot = nil
		return nil, err
	}
	if err := h.ensureMessageGuard(); err != nil {
		_ = h.snapshot.Close()
		h.snapshot = nil
		return nil, err
	}
	if r.Operation == "page" && page.Exhausted && profile.IncrementalTailVerified && report.Capabilities["incrementalTail"] == "supported" {
		if h.snapshot.identityDigests == nil {
			_ = h.snapshot.Close()
			h.snapshot = nil
			return nil, notaloneFailure("history_tail_unsupported")
		}
		target := h.snapshot.Target()
		tail, tailErr := newNotaloneTailSession(target, *h.selected, *h.inspected, *profile, h.snapshot.identityDigests)
		if tailErr != nil {
			_ = h.snapshot.Close()
			h.snapshot = nil
			return nil, tailErr
		}
		h.resetTail()
		h.tail = tail
		if closeErr := h.snapshot.Close(); closeErr != nil {
			h.resetTail()
			h.snapshot = nil
			return nil, notaloneFailure("history_snapshot_close_failed")
		}
		h.snapshot = nil
		resume := tail.expectedCursor
		page.ResumeCursor = &resume
	}
	return page, nil
}
func runNotaloneHistoryWithServer(s *server, input io.Reader, output io.Writer) {
	runNotaloneHistorySession(newNotaloneHistorySession(s), input, output)
}
func runNotaloneHistorySession(session *notaloneHistorySession, input io.Reader, output io.Writer) {
	defer session.close()
	if closer, ok := input.(io.Closer); ok {
		defer closer.Close()
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), 131072)
	encoder := json.NewEncoder(output)
	lines, stop := make(chan string), make(chan struct{})
	defer close(stop)
	go func() {
		defer close(lines)
		for scanner.Scan() {
			select {
			case lines <- scanner.Text():
			case <-stop:
				return
			}
		}
	}()
	for {
		var line string
		select {
		case <-session.guardLost:
			return
		case <-session.life.Done():
			return
		case value, ok := <-lines:
			if !ok {
				return
			}
			line = value
		}
		request := notaloneHistoryRequest{}
		decoder := json.NewDecoder(strings.NewReader(line))
		decoder.DisallowUnknownFields()
		err := decoder.Decode(&request)
		var data any
		if err == nil {
			var extra any
			if decoder.Decode(&extra) != io.EOF {
				err = notaloneFailure("history_request_invalid")
			}
		}
		select {
		case <-session.guardLost:
			return
		default:
		}
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			data, err = session.handle(ctx, request)
			cancel()
		}
		select {
		case <-session.guardLost:
			return
		default:
		}
		if err != nil {
			code := err.Error()
			if !strings.HasPrefix(code, "history_") {
				code = "history_request_invalid"
			}
			if encoder.Encode(map[string]any{"ok": false, "error": map[string]string{"code": code}}) != nil {
				return
			}
		} else {
			if encoder.Encode(map[string]any{"ok": true, "data": data}) != nil {
				return
			}
		}
	}
}
func runNotaloneHistory(input io.Reader, output io.Writer) {
	runNotaloneHistoryWithServer(&server{}, input, output)
}
