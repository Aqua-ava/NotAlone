package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
)

const notaloneCheckpointLimit = 64 << 20

type notaloneCheckpointIdentity struct {
	Identity notaloneTailIdentity      `json:"identity"`
	Entry    notaloneTailBaselineEntry `json:"entry"`
}
type notaloneCheckpoint struct {
	Format     string                             `json:"format"`
	Scope      string                             `json:"scope"`
	Root       string                             `json:"root"`
	Generation string                             `json:"generation"`
	Schema     string                             `json:"schema"`
	Profile    string                             `json:"profile"`
	Artifact   string                             `json:"artifact"`
	Target     notaloneSnapshotTarget             `json:"target"`
	Cursor     string                             `json:"cursor"`
	Baseline   []notaloneCheckpointIdentity       `json:"baseline"`
	States     map[string]notaloneDeltaShardState `json:"states"`
}

type notaloneSignedCheckpoint struct {
	Data json.RawMessage `json:"data"`
	MAC  string          `json:"mac"`
}

func notaloneCheckpointDigest(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && strings.ToLower(value) == value
}

func (h *notaloneHistorySession) checkpointBinding(report notaloneSupportReport, profile notaloneReadProfile) notaloneCheckpoint {
	p, _ := json.Marshal(profile)
	return notaloneCheckpoint{Format: "notalone-delta-checkpoint-v1", Scope: notaloneHash(h.selected.Account, h.selected.Conversation), Root: notaloneHash(filepath.Clean(h.server.cfg.DBRoot)), Generation: h.selected.SourceGeneration, Schema: h.inspected.SchemaFingerprint, Profile: notaloneHash(string(p)), Artifact: report.ArtifactSHA256}
}
func (h *notaloneHistorySession) checkpointMAC(data []byte) string {
	salts := make([]string, 0, len(h.server.cfg.Keys))
	for salt := range h.server.cfg.Keys {
		salts = append(salts, salt)
	}
	sort.Strings(salts)
	key := sha256.New()
	key.Write([]byte("notalone-private-delta-v1\x00"))
	for _, salt := range salts {
		key.Write([]byte(salt))
		key.Write([]byte{0})
		key.Write([]byte(h.server.cfg.Keys[salt]))
		key.Write([]byte{0})
	}
	secret := key.Sum(nil)
	defer func() {
		for index := range secret {
			secret[index] = 0
		}
	}()
	mac := hmac.New(sha256.New, secret)
	mac.Write(data)
	return hex.EncodeToString(mac.Sum(nil))
}
func (h *notaloneHistorySession) checkpointPath(scope, cursor string) string {
	return filepath.Join(h.checkpointDirectory, scope+"-"+notaloneHash(cursor)+".json")
}
func notaloneCheckpointDirectorySafe(directory string, create bool) error {
	if directory == "" || !filepath.IsAbs(directory) {
		return notaloneFailure("history_checkpoint_invalid")
	}
	if create {
		if e := os.Mkdir(directory, 0700); e != nil && !os.IsExist(e) {
			return notaloneFailure("history_checkpoint_unavailable")
		}
	}
	st, e := os.Lstat(directory)
	if e != nil {
		return e
	}
	stat, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 || st.Mode().Perm() != 0700 || stat.Uid != uint32(os.Geteuid()) {
		return notaloneFailure("history_checkpoint_invalid")
	}
	return nil
}
func (h *notaloneHistorySession) loadCheckpoint(report notaloneSupportReport, profile notaloneReadProfile, target, cursor string) (*notaloneCheckpoint, error) {
	if h.checkpointDirectory == "" {
		return nil, nil
	}
	if e := notaloneCheckpointDirectorySafe(h.checkpointDirectory, false); os.IsNotExist(e) {
		return nil, nil
	} else if e != nil {
		return nil, e
	}
	expected := h.checkpointBinding(report, profile)
	token := strings.SplitN(cursor, ".", 2)[0]
	if len(token) < 16 || len(token) > 128 {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	path := h.checkpointPath(expected.Scope, token)
	fd, e := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if os.IsNotExist(e) {
		return nil, nil
	}
	if e != nil {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	stat, ok := st.Sys().(*syscall.Stat_t)
	if !ok || !st.Mode().IsRegular() || st.Mode().Perm() != 0600 || stat.Uid != uint32(os.Geteuid()) || st.Size() < 1 || st.Size() > notaloneCheckpointLimit {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	data, e := io.ReadAll(io.LimitReader(f, notaloneCheckpointLimit+1))
	if e != nil || len(data) > notaloneCheckpointLimit {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	after, e := f.Stat()
	if e != nil || st.Size() != after.Size() || !st.ModTime().Equal(after.ModTime()) {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	unique := json.NewDecoder(bytes.NewReader(data))
	if notaloneUniqueJSON(unique) != nil {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	if _, e = unique.Token(); e != io.EOF {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	var signed notaloneSignedCheckpoint
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&signed) != nil {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	computed, _ := hex.DecodeString(h.checkpointMAC(signed.Data))
	provided, e := hex.DecodeString(signed.MAC)
	if e != nil || !hmac.Equal(computed, provided) {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	var value notaloneCheckpoint
	decoder = json.NewDecoder(bytes.NewReader(signed.Data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&value) != nil {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	if value.Format != expected.Format || value.Scope != expected.Scope || value.Root != expected.Root || value.Generation != expected.Generation || value.Schema != expected.Schema || value.Profile != expected.Profile || value.Artifact != expected.Artifact || value.Cursor != token || value.Target.Descriptor != target || len(value.Baseline) > notaloneTailIdentityLimit || len(value.States) > 128 {
		return nil, notaloneFailure("history_checkpoint_invalid")
	}
	tables := map[string]string{}
	for _, table := range value.Target.Tables {
		tables[table.Partition] = table.Instance
	}
	seen := map[notaloneTailIdentity]bool{}
	for _, item := range value.Baseline {
		id := item.Identity
		if tables[id.Partition] != id.Table || id.Table == "" || id.LocalID == "" || seen[id] || !notaloneCheckpointDigest(item.Entry.Digest) {
			return nil, notaloneFailure("history_checkpoint_invalid")
		}
		seen[id] = true
	}
	return &value, nil
}

func (h *notaloneHistorySession) saveCheckpoint(report notaloneSupportReport, profile notaloneReadProfile, target notaloneSnapshotTarget, cursor string, baseline map[notaloneTailIdentity]notaloneTailBaselineEntry, states map[string]notaloneDeltaShardState) error {
	if h.checkpointDirectory == "" {
		return nil
	}
	if len(states) == 0 || len(baseline) > notaloneTailIdentityLimit {
		return notaloneFailure("history_checkpoint_invalid")
	}
	if e := notaloneCheckpointDirectorySafe(h.checkpointDirectory, true); e != nil {
		return e
	}
	value := h.checkpointBinding(report, profile)
	value.Target = target
	value.Cursor = cursor
	value.States = states
	value.Baseline = []notaloneCheckpointIdentity{}
	for identity, entry := range baseline {
		value.Baseline = append(value.Baseline, notaloneCheckpointIdentity{identity, entry})
	}
	sort.Slice(value.Baseline, func(i, j int) bool {
		return notaloneTailIdentityLess(value.Baseline[i].Identity, value.Baseline[j].Identity)
	})
	data, e := json.Marshal(value)
	if e != nil {
		return notaloneFailure("history_checkpoint_invalid")
	}
	encoded, e := json.Marshal(notaloneSignedCheckpoint{Data: data, MAC: h.checkpointMAC(data)})
	if e != nil || len(encoded) > notaloneCheckpointLimit {
		return notaloneFailure("history_checkpoint_too_large")
	}
	pending, e := os.CreateTemp(h.checkpointDirectory, value.Scope+"-.pending-")
	if e != nil {
		return notaloneFailure("history_checkpoint_unavailable")
	}
	name := pending.Name()
	defer os.Remove(name)
	if _, e = pending.Write(encoded); e != nil {
		pending.Close()
		return notaloneFailure("history_checkpoint_unavailable")
	}
	if e = pending.Sync(); e != nil {
		pending.Close()
		return notaloneFailure("history_checkpoint_unavailable")
	}
	if pending.Close() != nil {
		return notaloneFailure("history_checkpoint_unavailable")
	}
	final := h.checkpointPath(value.Scope, cursor)
	if os.Rename(name, final) != nil {
		return notaloneFailure("history_checkpoint_unavailable")
	}
	directory, e := os.Open(h.checkpointDirectory)
	if e != nil {
		return notaloneFailure("history_checkpoint_unavailable")
	}
	e = directory.Sync()
	directory.Close()
	if e != nil {
		return notaloneFailure("history_checkpoint_unavailable")
	}
	// 保留最新两份交接点：本次响应尚未被业务事务接受时，上一已接受点仍可恢复。
	entries, _ := os.ReadDir(h.checkpointDirectory)
	type saved struct {
		name string
		at   int64
	}
	files := []saved{}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), value.Scope+"-") || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		st, e := entry.Info()
		if e == nil && st.Mode().IsRegular() && st.Mode().Perm() == 0600 {
			files = append(files, saved{entry.Name(), st.ModTime().UnixNano()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].at > files[j].at })
	for index := 2; index < len(files); index++ {
		_ = os.Remove(filepath.Join(h.checkpointDirectory, files[index].name))
	}
	return nil
}
