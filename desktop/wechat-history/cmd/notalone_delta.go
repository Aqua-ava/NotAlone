package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"sort"
	"strconv"
	"syscall"
)

type notaloneDeltaShardState struct {
	Pages notaloneDeltaPageState `json:"pages"`
	Names string                 `json:"names"`
}

func notaloneOpenDeltaFile(path string, optional bool) (*os.File, int64, error) {
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if optional && os.IsNotExist(err) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, notaloneFailure("history_delta_source_unavailable")
	}
	f := os.NewFile(uintptr(fd), path)
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() < 0 {
		f.Close()
		return nil, 0, notaloneFailure("history_delta_source_unavailable")
	}
	return f, st.Size(), nil
}

// 固定读者已打开；原始页只解析所选表的键与页归属，不把载荷作为正文使用。
func (n *notaloneSnapshot) initializeDelta(ctx context.Context, s *server, prior map[string]notaloneDeltaShardState, baseline map[notaloneTailIdentity]notaloneTailBaselineEntry, emitAbsent bool, newTablePartitions map[string]bool) error {
	if !n.profile.IncrementalTailVerified {
		return nil
	}
	n.deltaStates = make(map[string]notaloneDeltaShardState)
	n.deltaOnly = prior != nil
	n.deltaIDs = make(map[string][]int64)
	n.deltaEmitAbsent = emitAbsent
	n.deltaMissing = make(map[notaloneTailIdentity]bool)
	if n.deltaOnly {
		n.identityDigests = make(map[notaloneTailIdentity]notaloneTailBaselineEntry, len(baseline))
		for key, value := range baseline {
			n.identityDigests[key] = value
		}
	}
	for _, shard := range n.shards {
		if !shard.present {
			continue
		}
		before, e := notaloneSnapshotDataVersion(ctx, shard.observer)
		if e != nil || before != shard.observerPre {
			return notaloneFailure("history_snapshot_window_changed")
		}
		rootRows, e := shard.reader.QueryBounded(ctx, 1, "SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?", n.table)
		if e != nil || len(rootRows) != 1 {
			return notaloneFailure("history_schema_unavailable")
		}
		root, ok := rootRows[0]["rootpage"].(int64)
		if !ok || root < 1 || root > int64(^uint32(0)) {
			return notaloneFailure("history_schema_unavailable")
		}
		names, e := shard.reader.QueryBounded(ctx, 4, "SELECT rowid,user_name FROM Name2Id WHERE user_name IN (?,?) ORDER BY rowid", n.senderOwner, n.selected.Conversation)
		if e != nil {
			return notaloneFailure("history_identity_unverified")
		}
		encoded, _ := json.Marshal(names)
		namesHash := notaloneHash(string(encoded))
		var previous *notaloneDeltaPageState
		old, hasOld := prior[shard.partition]
		if n.deltaOnly && !hasOld && !newTablePartitions[shard.partition] {
			return notaloneFailure("history_checkpoint_invalid")
		}
		if hasOld {
			previous = &old.Pages
		}
		f, size, e := notaloneOpenDeltaFile(shard.path, false)
		if e != nil {
			return e
		}
		wal, walSize, e := notaloneOpenDeltaFile(shard.path+"-wal", true)
		if e != nil {
			f.Close()
			return e
		}
		shm, shmSize, e := notaloneOpenDeltaFile(shard.path+"-shm", true)
		if e != nil {
			f.Close()
			if wal != nil {
				wal.Close()
			}
			return e
		}
		header := make([]byte, 16)
		_, e = f.ReadAt(header, 0)
		var key []byte
		if e == nil && !bytes.Equal(header, []byte("SQLite format 3\x00")) {
			key, e = hex.DecodeString(s.cfg.Keys[hex.EncodeToString(header)])
			if e != nil || len(key) != 32 {
				f.Close()
				if wal != nil {
					wal.Close()
				}
				if shm != nil {
					shm.Close()
				}
				return notaloneFailure("history_delta_key_unavailable")
			}
		}
		var walReader io.ReaderAt
		if wal != nil {
			walReader = wal
		}
		var walIndexReader io.ReaderAt
		if shm != nil {
			walIndexReader = shm
		}
		var result *notaloneDeltaPageResult
		if e == nil {
			result, e = readNotaloneDeltaPages(ctx, f, size, walReader, walSize, uint32(root), key, previous,
				notaloneDeltaWALIndexReader{Reader: walIndexReader, Size: shmSize})
		}
		for index := range key {
			key[index] = 0
		}
		f.Close()
		if wal != nil {
			wal.Close()
		}
		if shm != nil {
			shm.Close()
		}
		after, versionErr := notaloneSnapshotDataVersion(ctx, shard.observer)
		if versionErr != nil || after != before {
			return notaloneFailure("history_snapshot_window_changed")
		}
		if e != nil {
			return e
		}
		if result == nil {
			return notaloneFailure("history_delta_source_unavailable")
		}
		n.deltaStates[shard.partition] = notaloneDeltaShardState{Pages: result.State, Names: namesHash}
		if !n.deltaOnly {
			continue
		}
		changed := map[int64]bool{}
		for _, id := range result.ChangedIDs {
			if id < 0 {
				return notaloneFailure("history_identity_unverified")
			}
			changed[id] = true
		}
		// 发送方字典发生实际变化时重新核验本联系人的既有行，不能沿用旧的正文资格。
		if old.Names != namesHash {
			for identity := range baseline {
				if identity.Partition == shard.partition {
					id, e := strconv.ParseInt(identity.LocalID, 10, 64)
					if e != nil {
						return notaloneFailure("history_checkpoint_invalid")
					}
					changed[id] = true
				}
			}
		}
		ids := make([]int64, 0, len(changed))
		for id := range changed {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		n.deltaIDs[shard.partition] = ids
		for _, id := range ids {
			identity := notaloneTailIdentity{Partition: shard.partition, Table: shard.instance, LocalID: strconv.FormatInt(id, 10)}
			if _, exists := baseline[identity]; exists {
				n.deltaMissing[identity] = true
			}
			delete(n.identityDigests, identity)
		}
	}
	// 跨分片原始页分析也必须落在同一个已固定的无提交窗口内。
	for _, shard := range n.shards {
		v, e := notaloneSnapshotDataVersion(ctx, shard.observer)
		if e != nil || v != shard.observerPre {
			return notaloneFailure("history_snapshot_window_changed")
		}
	}
	return n.checkLocked()
}
