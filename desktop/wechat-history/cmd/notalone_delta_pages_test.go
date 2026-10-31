package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/r266-tech/wx-cli/v2/internal/config"
	"github.com/r266-tech/wx-cli/v2/internal/wcdb"
)

func notaloneDeltaPageFixture(t *testing.T) (string, []byte, uint32, *wcdb.DB) {
	t.Helper()
	root := t.TempDir()
	cfg := &config.Config{SchemaVersion: 2, Wxid: "synthetic-owner", DBRoot: root, Keys: map[string]string{}}
	const table = "Msg_delta_fixture"
	schema := "CREATE TABLE " + table + "(local_id INTEGER PRIMARY KEY AUTOINCREMENT, body BLOB);" +
		"WITH RECURSIVE sequence(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM sequence WHERE id<1200) " +
		"INSERT INTO " + table + "(local_id,body) SELECT id,zeroblob(48) FROM sequence;" +
		"INSERT INTO " + table + "(local_id,body) VALUES(1300,zeroblob(12000));"
	notaloneTestDB(t, root, cfg, "message", "message_0.db", schema, strings.Repeat("44", 16))
	dbPath := filepath.Join(root, "db_storage/message/message_0.db")
	db, err := wcdb.OpenWithKeyMapWritable(dbPath, cfg.Keys)
	if err != nil {
		t.Fatal("open synthetic WCDB fixture")
	}
	t.Cleanup(func() { db.Close() })
	if err = db.Exec("PRAGMA journal_mode=WAL"); err != nil {
		t.Fatal("enable WAL on synthetic fixture")
	}
	if err = db.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(49) WHERE local_id=1"); err != nil {
		t.Fatal("seed a committed synthetic WAL frame")
	}
	rows, err := db.QueryBounded(context.Background(), 1, "SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?", table)
	if err != nil || len(rows) != 1 {
		t.Fatalf("read synthetic table root page: %v", err)
	}
	rootPage, ok := rows[0]["rootpage"].(int64)
	if !ok || rootPage < 2 {
		t.Fatalf("invalid synthetic root page: %#v", rows[0]["rootpage"])
	}
	key, err := hex.DecodeString(cfg.Keys[strings.Repeat("44", 16)])
	if err != nil || len(key) != 32 {
		t.Fatal("synthetic raw key fixture invalid")
	}
	return dbPath, key, uint32(rootPage), db
}

func notaloneDeltaReaders(t *testing.T, dbPath string) (*os.File, int64, *os.File, int64) {
	t.Helper()
	db, err := os.Open(dbPath)
	if err != nil {
		t.Fatal("open synthetic database bytes")
	}
	dbInfo, err := db.Stat()
	if err != nil {
		db.Close()
		t.Fatal("stat synthetic database bytes")
	}
	wal, err := os.Open(dbPath + "-wal")
	if err != nil && !os.IsNotExist(err) {
		db.Close()
		t.Fatal("open synthetic WAL bytes")
	}
	var walSize int64
	if err == nil {
		info, statErr := wal.Stat()
		if statErr != nil {
			db.Close()
			wal.Close()
			t.Fatal("stat synthetic WAL bytes")
		}
		walSize = info.Size()
	}
	t.Cleanup(func() {
		_ = db.Close()
		if wal != nil {
			_ = wal.Close()
		}
	})
	return db, dbInfo.Size(), wal, walSize
}

func notaloneDeltaReadIndexFile(t *testing.T, dbPath string) (*os.File, int64) {
	t.Helper()
	shm, err := os.Open(dbPath + "-shm")
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0
		}
		t.Fatal("open synthetic WAL-index")
	}
	info, err := shm.Stat()
	if err != nil {
		shm.Close()
		t.Fatal("stat synthetic WAL-index")
	}
	t.Cleanup(func() { _ = shm.Close() })
	return shm, info.Size()
}

func TestNotAloneDeltaPagesTracksChangedEncryptedPagesWithoutPayload(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil)
	if err != nil {
		t.Fatalf("index encrypted synthetic table pages: %v", err)
	}
	if !baseline.Baseline || len(baseline.State.Pages) < 3 || !containsInt64(baseline.ChangedIDs, 1300) {
		t.Fatalf("initial encrypted page index did not include fixture rows: %#v", baseline)
	}
	stateJSON, err := json.Marshal(baseline.State)
	if err != nil || strings.Contains(string(stateJSON), "private-body-sentinel") || strings.Contains(string(stateJSON), "body") || strings.Contains(string(stateJSON), hex.EncodeToString(key)) {
		t.Fatalf("checkpoint contains payload or key material: %s (%v)", stateJSON, err)
	}
	noChanges, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, &baseline.State)
	if err != nil {
		t.Fatalf("resume unchanged encrypted WAL: %v", err)
	}
	if noChanges.FullAudit || len(noChanges.ChangedIDs) != 0 {
		t.Fatalf("unchanged WAL should yield an empty delta: %#v", noChanges)
	}
	countedNoChange := &notaloneDeltaCountingReaderAt{reader: wal}
	noChangeScan, err := notaloneDeltaScanWAL(context.Background(), countedNoChange, walSize, &baseline.State)
	if err != nil || !noChangeScan.Continuous || noChangeScan.FramesRead != 0 || countedNoChange.bytesRead > notaloneDeltaWALHeaderSize+notaloneDeltaWALFrameHeaderSize {
		t.Fatalf("idle WAL resume reread old frame bodies: frames=%d bytes=%d err=%v", noChangeScan.FramesRead, countedNoChange.bytesRead, err)
	}
	if err := writer.Exec("UPDATE Msg_delta_fixture SET body=substr(body,1,5000)||zeroblob(7000) WHERE local_id=1300"); err != nil {
		t.Fatal("mutate only overflow bytes in synthetic fixture")
	}
	pageOnlyDB, pageOnlySize, pageOnlyWAL, pageOnlyWALSize := notaloneDeltaReaders(t, dbPath)
	pageOnlyDelta, err := readNotaloneDeltaPages(context.Background(), pageOnlyDB, pageOnlySize, pageOnlyWAL, pageOnlyWALSize, rootPage, key, &noChanges.State)
	if err != nil {
		t.Fatalf("track changed overflow-only WAL page: %v", err)
	}
	if pageOnlyDelta.FullAudit || !containsInt64(pageOnlyDelta.ChangedIDs, 1300) {
		t.Fatalf("overflow-only change was not reported incrementally: %#v", pageOnlyDelta.ChangedIDs)
	}
	countedAppend := &notaloneDeltaCountingReaderAt{reader: pageOnlyWAL}
	appendScan, err := notaloneDeltaScanWAL(context.Background(), countedAppend, pageOnlyWALSize, &noChanges.State)
	if err != nil {
		t.Fatalf("scan appended WAL frames: %v", err)
	}
	allFrameCount := (pageOnlyWALSize - notaloneDeltaWALHeaderSize) / (notaloneDeltaWALFrameHeaderSize + notaloneDeltaPageSize)
	bytesExpected := int64(notaloneDeltaWALHeaderSize+notaloneDeltaWALFrameHeaderSize) + int64(appendScan.FramesRead)*(notaloneDeltaWALFrameHeaderSize+notaloneDeltaPageSize)
	if !appendScan.Continuous || appendScan.FramesRead == 0 || int64(appendScan.FramesRead) >= allFrameCount || countedAppend.bytesRead != bytesExpected {
		t.Fatalf("WAL resume read bytes beyond appended frames: appended=%d total=%d bytes=%d expected=%d", appendScan.FramesRead, allFrameCount, countedAppend.bytesRead, bytesExpected)
	}

	if err = writer.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(9000) WHERE local_id=2; DELETE FROM Msg_delta_fixture WHERE local_id=9; INSERT INTO Msg_delta_fixture(local_id,body) VALUES(0,zeroblob(64)),(2000,zeroblob(5000))"); err != nil {
		t.Fatal("mutate synthetic rows")
	}
	db2, dbSize2, wal2, walSize2 := notaloneDeltaReaders(t, dbPath)
	delta, err := readNotaloneDeltaPages(context.Background(), db2, dbSize2, wal2, walSize2, rootPage, key, &pageOnlyDelta.State)
	if err != nil {
		t.Fatalf("track changed encrypted WAL pages: %v", err)
	}
	for _, id := range []int64{0, 2, 9, 2000} {
		if !containsInt64(delta.ChangedIDs, id) {
			t.Errorf("changed row %d not reported: %#v", id, delta.ChangedIDs)
		}
	}
	if delta.FullAudit {
		t.Fatal("continuous WAL update unexpectedly audited every selected-table page")
	}
}

func TestNotAloneDeltaPagesAuditsSelectedTreeAfterWALReset(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil)
	if err != nil {
		t.Fatalf("index encrypted synthetic table pages: %v", err)
	}
	if err = writer.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(60) WHERE local_id=44"); err != nil {
		t.Fatal("mutate before checkpoint")
	}
	changedDB, changedSize, changedWAL, changedWALSize := notaloneDeltaReaders(t, dbPath)
	delta, err := readNotaloneDeltaPages(context.Background(), changedDB, changedSize, changedWAL, changedWALSize, rootPage, key, &baseline.State)
	if err != nil || delta.FullAudit || !containsInt64(delta.ChangedIDs, 44) {
		t.Fatalf("continuous WAL update was not tracked: %#v (%v)", delta, err)
	}
	if err = writer.Exec("PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		t.Fatal("truncate synthetic WAL checkpoint")
	}
	if err = writer.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(61) WHERE local_id=4"); err != nil {
		t.Fatal("mutate after WAL reset")
	}
	resetDB, resetSize, resetWAL, resetWALSize := notaloneDeltaReaders(t, dbPath)
	reset, err := readNotaloneDeltaPages(context.Background(), resetDB, resetSize, resetWAL, resetWALSize, rootPage, key, &delta.State)
	if err != nil {
		t.Fatalf("audit selected table after WAL reset: %v", err)
	}
	if !reset.FullAudit || !containsInt64(reset.ChangedIDs, 4) {
		t.Fatalf("WAL reset did not audit physical pages and report changed low ID: %#v", reset)
	}
}

func TestNotAloneDeltaPagesTracksPlainSQLitePages(t *testing.T) {
	root := t.TempDir()
	dbPath := filepath.Join(root, "plain.db")
	writer, err := wcdb.OpenPlain(dbPath, true)
	if err != nil {
		t.Fatal("create synthetic plain SQLite fixture")
	}
	t.Cleanup(func() { writer.Close() })
	if err = writer.Exec("CREATE TABLE Msg_plain(local_id INTEGER PRIMARY KEY, body BLOB); INSERT INTO Msg_plain VALUES(1,zeroblob(64)),(2,zeroblob(9000)); PRAGMA journal_mode=WAL; UPDATE Msg_plain SET body=zeroblob(65) WHERE local_id=1"); err != nil {
		t.Fatal("seed synthetic plain SQLite table and WAL")
	}
	rows, err := writer.QueryBounded(context.Background(), 1, "SELECT rootpage FROM sqlite_master WHERE type='table' AND name=?", "Msg_plain")
	if err != nil || len(rows) != 1 {
		t.Fatalf("read plain fixture root page: %v", err)
	}
	rootPage, ok := rows[0]["rootpage"].(int64)
	if !ok || rootPage < 2 {
		t.Fatalf("invalid plain fixture root page: %#v", rows[0]["rootpage"])
	}
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, uint32(rootPage), nil, nil)
	if err != nil {
		t.Fatalf("index plain SQLite table pages: %v", err)
	}
	if baseline.State.Format != notaloneDeltaPlainFormat || baseline.State.ReserveSize != 0 || !containsInt64(baseline.ChangedIDs, 2) {
		t.Fatalf("plain SQLite baseline format or row IDs invalid: %#v", baseline)
	}
	if err = writer.Exec("INSERT INTO Msg_plain(local_id,body) VALUES(0,zeroblob(48))"); err != nil {
		t.Fatal("insert low rowid into plain fixture")
	}
	db2, dbSize2, wal2, walSize2 := notaloneDeltaReaders(t, dbPath)
	delta, err := readNotaloneDeltaPages(context.Background(), db2, dbSize2, wal2, walSize2, uint32(rootPage), nil, &baseline.State)
	if err != nil {
		t.Fatalf("track plain SQLite WAL update: %v", err)
	}
	if delta.FullAudit || !containsInt64(delta.ChangedIDs, 0) {
		t.Fatalf("plain SQLite low-ID append was not incremental: %#v", delta)
	}
}

func TestNotAloneDeltaPagesTracksBtreeSplitAndMergeWithoutMissingRowIDs(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil)
	if err != nil {
		t.Fatalf("index baseline tree: %v", err)
	}
	baselineIDs := notaloneDeltaReadIDs(t, writer)
	baseLeaves, _ := notaloneDeltaTreeShape(baseline.State)
	if err = writer.Exec("WITH RECURSIVE seq(id) AS (VALUES(2001) UNION ALL SELECT id+1 FROM seq WHERE id<10000) INSERT INTO Msg_delta_fixture(local_id,body) SELECT id,zeroblob(128) FROM seq"); err != nil {
		t.Fatal("insert synthetic rows to split the B-tree")
	}
	splitDB, splitSize, splitWAL, splitWALSize := notaloneDeltaReaders(t, dbPath)
	split, err := readNotaloneDeltaPages(context.Background(), splitDB, splitSize, splitWAL, splitWALSize, rootPage, key, &baseline.State)
	if err != nil {
		t.Fatalf("track B-tree split: %v", err)
	}
	splitIDs := notaloneDeltaReadIDs(t, writer)
	added := notaloneDeltaIDDifference(splitIDs, baselineIDs)
	assertNotaloneDeltaContainsAll(t, split.ChangedIDs, added, "split")
	assertNotaloneDeltaSubset(t, split.ChangedIDs, notaloneDeltaIDUnion(baselineIDs, splitIDs), "split")
	splitLeaves, _ := notaloneDeltaTreeShape(split.State)
	if split.FullAudit || len(added) < 8000 || splitLeaves <= baseLeaves {
		t.Fatalf("insert batch did not exercise incremental B-tree growth: added=%d leaves=%d->%d fullAudit=%t", len(added), baseLeaves, splitLeaves, split.FullAudit)
	}

	if err = writer.Exec("DELETE FROM Msg_delta_fixture WHERE local_id<>1"); err != nil {
		t.Fatal("delete synthetic rows to merge the B-tree")
	}
	mergeDB, mergeSize, mergeWAL, mergeWALSize := notaloneDeltaReaders(t, dbPath)
	merged, err := readNotaloneDeltaPages(context.Background(), mergeDB, mergeSize, mergeWAL, mergeWALSize, rootPage, key, &split.State)
	if err != nil {
		t.Fatalf("track B-tree merge: %v", err)
	}
	mergedIDs := notaloneDeltaReadIDs(t, writer)
	deleted := notaloneDeltaIDDifference(splitIDs, mergedIDs)
	assertNotaloneDeltaContainsAll(t, merged.ChangedIDs, deleted, "merge")
	assertNotaloneDeltaSubset(t, merged.ChangedIDs, notaloneDeltaIDUnion(splitIDs, mergedIDs), "merge")
	mergedLeaves, mergedInteriors := notaloneDeltaTreeShape(merged.State)
	if merged.FullAudit || len(deleted) < 8000 || mergedLeaves >= splitLeaves || mergedInteriors > 1 {
		t.Fatalf("delete batch did not exercise incremental B-tree shrink: deleted=%d leaves=%d->%d interiors=%d fullAudit=%t", len(deleted), splitLeaves, mergedLeaves, mergedInteriors, merged.FullAudit)
	}
}

func TestNotAloneDeltaPagesIgnoresStaleWALGenerationSuffix(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	if err := writer.Exec("WITH RECURSIVE sequence(id) AS (VALUES(2001) UNION ALL SELECT id+1 FROM sequence WHERE id<3000) INSERT INTO Msg_delta_fixture(local_id,body) SELECT id,zeroblob(512) FROM sequence"); err != nil {
		t.Fatal("grow synthetic WAL before restart")
	}
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil)
	if err != nil {
		t.Fatalf("index encrypted synthetic table pages: %v", err)
	}
	if err := writer.Exec("PRAGMA wal_checkpoint(RESTART)"); err != nil {
		t.Fatal("checkpoint synthetic WAL before restart")
	}
	if err := writer.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(52) WHERE local_id=44"); err != nil {
		t.Fatal("write synthetic transaction after WAL restart")
	}
	changedDB, changedSize, changedWAL, changedWALSize := notaloneDeltaReaders(t, dbPath)
	shm, shmSize := notaloneDeltaReadIndexFile(t, dbPath)
	index := notaloneDeltaWALIndexReader{Reader: shm, Size: shmSize}
	frameSize := int64(notaloneDeltaWALFrameHeaderSize + notaloneDeltaPageSize)
	if changedWALSize <= notaloneDeltaWALHeaderSize+frameSize {
		t.Fatalf("SQLite did not preserve a stale suffix in the synthetic WAL: before=%d after=%d", walSize, changedWALSize)
	}
	counted := &notaloneDeltaCountingReaderAt{reader: changedWAL}
	boundedScan, err := notaloneDeltaScanWAL(context.Background(), counted, changedWALSize, &baseline.State, index)
	if err != nil {
		t.Fatalf("bound current WAL generation from SQLite index: %v", err)
	}
	if boundedScan.FramesRead == 0 || int64(counted.bytesRead) != int64(notaloneDeltaWALHeaderSize)+int64(boundedScan.FramesRead)*frameSize {
		t.Fatalf("scan crossed SQLite mxFrame into stale WAL suffix: frames=%d bytes=%d physical=%d", boundedScan.FramesRead, counted.bytesRead, changedWALSize)
	}
	delta, err := readNotaloneDeltaPages(context.Background(), changedDB, changedSize, changedWAL, changedWALSize, rootPage, key, &baseline.State, index)
	if err != nil {
		t.Fatalf("accept SQLite stale-generation WAL suffix: %v", err)
	}
	if !delta.FullAudit || !containsInt64(delta.ChangedIDs, 44) || delta.State.WAL.CommitOffset >= changedWALSize {
		t.Fatalf("WAL generation reset did not audit the committed prefix and changed row: fullAudit=%v changed=%v commitOffset=%d walSize=%d", delta.FullAudit, delta.ChangedIDs, delta.State.WAL.CommitOffset, changedWALSize)
	}
}

func TestNotAloneDeltaWALIndexAcceptsRetainedFieldsWhenMXFrameIsZero(t *testing.T) {
	dbPath, _, _, _ := notaloneDeltaPageFixture(t)
	_, _, wal, walSize := notaloneDeltaReaders(t, dbPath)
	shm, shmSize := notaloneDeltaReadIndexFile(t, dbPath)
	if shmSize < notaloneDeltaWALIndexDoubleHeaderSize {
		t.Fatal("synthetic SQLite WAL index is missing")
	}
	var walHeader [notaloneDeltaWALHeaderSize]byte
	if _, err := wal.ReadAt(walHeader[:], 0); err != nil {
		t.Fatal("read synthetic WAL header")
	}
	var raw [notaloneDeltaWALIndexDoubleHeaderSize]byte
	if _, err := shm.ReadAt(raw[:], 0); err != nil {
		t.Fatal("read synthetic SQLite WAL index")
	}
	committedFrames := binary.NativeEndian.Uint32(raw[16:20])
	if committedFrames == 0 || binary.NativeEndian.Uint32(raw[20:24]) == 0 {
		t.Fatal("synthetic WAL index does not contain a committed frame and page count")
	}
	keptPageCount := binary.NativeEndian.Uint32(raw[20:24])
	keptChecksum1 := binary.NativeEndian.Uint32(raw[24:28])
	keptChecksum2 := binary.NativeEndian.Uint32(raw[28:32])
	var endianProbe [2]byte
	binary.NativeEndian.PutUint16(endianProbe[:], 1)
	for _, test := range []struct {
		name      string
		mxFrame   uint32
		indexSize uint16
		wantError string
	}{
		{name: "retained page size and frame fields", mxFrame: 0, indexSize: uint16(notaloneDeltaPageSize)},
		{name: "zero page size and retained frame fields", mxFrame: 0, indexSize: 0},
		{name: "unknown nonzero page size remains rejected", mxFrame: 0, indexSize: 512, wantError: "history_snapshot_window_changed"},
		{name: "zero page size with committed frames remains rejected", mxFrame: committedFrames, indexSize: 0, wantError: "history_snapshot_window_changed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := raw
			binary.NativeEndian.PutUint16(candidate[14:16], test.indexSize)
			binary.NativeEndian.PutUint32(candidate[16:20], test.mxFrame)
			check1, check2, checksumErr := notaloneDeltaChecksum(candidate[:40], endianProbe[0] == 1, 0, 0)
			if checksumErr != nil {
				t.Fatalf("checksum synthetic WAL index: %v", checksumErr)
			}
			binary.NativeEndian.PutUint32(candidate[40:44], check1)
			binary.NativeEndian.PutUint32(candidate[44:48], check2)
			copy(candidate[notaloneDeltaWALIndexHeaderSize:], candidate[:notaloneDeltaWALIndexHeaderSize])
			state, parseErr := notaloneDeltaReadWALIndex(context.Background(), bytes.NewReader(candidate[:]), int64(len(candidate)), walHeader[:], walSize)
			if test.wantError != "" {
				if parseErr == nil || !strings.Contains(parseErr.Error(), test.wantError) {
					t.Fatalf("index page-size mismatch was not rejected as %s: %v", test.wantError, parseErr)
				}
				return
			}
			if parseErr != nil {
				t.Fatalf("accept empty WAL-index fields supported by SQLite: %v", parseErr)
			}
			if state.MXFrame != 0 || state.PageCount != keptPageCount || state.Checksum1 != keptChecksum1 || state.Checksum2 != keptChecksum2 || state.PageSize != notaloneDeltaPageSize {
				t.Fatalf("WAL-index reset fields were not preserved: got mxFrame=%d pageCount=%d checksum=(%d,%d) pageSize=%d, want pageCount=%d checksum=(%d,%d) pageSize=%d", state.MXFrame, state.PageCount, state.Checksum1, state.Checksum2, state.PageSize, keptPageCount, keptChecksum1, keptChecksum2, notaloneDeltaPageSize)
			}
		})
	}
}

func TestNotAloneDeltaWALIndexLeavesUncommittedFramesOutOfDelta(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	shm, shmSize := notaloneDeltaReadIndexFile(t, dbPath)
	index := notaloneDeltaWALIndexReader{Reader: shm, Size: shmSize}
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil, index)
	if err != nil {
		t.Fatalf("index committed synthetic baseline: %v", err)
	}
	if err := writer.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal("begin synthetic uncommitted transaction")
	}
	defer func() { _ = writer.Exec("ROLLBACK") }()
	if err := writer.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(51) WHERE local_id=44"); err != nil {
		t.Fatal("write uncommitted synthetic row")
	}
	uncommittedDB, uncommittedDBSize, uncommittedWAL, uncommittedWALSize := notaloneDeltaReaders(t, dbPath)
	uncommittedSHM, uncommittedSHMSize := notaloneDeltaReadIndexFile(t, dbPath)
	uncommittedIndex := notaloneDeltaWALIndexReader{Reader: uncommittedSHM, Size: uncommittedSHMSize}
	uncommitted, err := readNotaloneDeltaPages(context.Background(), uncommittedDB, uncommittedDBSize, uncommittedWAL, uncommittedWALSize, rootPage, key, &baseline.State, uncommittedIndex)
	if err != nil {
		t.Fatalf("ignore uncommitted WAL frames using mxFrame: %v", err)
	}
	if uncommitted.FullAudit || len(uncommitted.ChangedIDs) != 0 || uncommitted.State.WAL.CommitOffset != baseline.State.WAL.CommitOffset {
		t.Fatalf("uncommitted frame advanced the committed delta: fullAudit=%t changed=%v before=%d after=%d", uncommitted.FullAudit, uncommitted.ChangedIDs, baseline.State.WAL.CommitOffset, uncommitted.State.WAL.CommitOffset)
	}
	if err := writer.Exec("COMMIT"); err != nil {
		t.Fatal("commit synthetic row")
	}
	committedDB, committedDBSize, committedWAL, committedWALSize := notaloneDeltaReaders(t, dbPath)
	committedSHM, committedSHMSize := notaloneDeltaReadIndexFile(t, dbPath)
	committedIndex := notaloneDeltaWALIndexReader{Reader: committedSHM, Size: committedSHMSize}
	committed, err := readNotaloneDeltaPages(context.Background(), committedDB, committedDBSize, committedWAL, committedWALSize, rootPage, key, &baseline.State, committedIndex)
	if err != nil {
		t.Fatalf("track committed WAL frames: %v", err)
	}
	if committed.FullAudit || !containsInt64(committed.ChangedIDs, 44) || committed.State.WAL.CommitOffset <= baseline.State.WAL.CommitOffset {
		t.Fatalf("committed frame not delivered as an incremental delta: fullAudit=%t changed=%v before=%d after=%d", committed.FullAudit, committed.ChangedIDs, baseline.State.WAL.CommitOffset, committed.State.WAL.CommitOffset)
	}
}

func TestNotAloneDeltaPagesRejectsCorruptWALAndIgnoresPartialTail(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil)
	if err != nil {
		t.Fatalf("index baseline before WAL fault injection: %v", err)
	}
	shm, shmSize := notaloneDeltaReadIndexFile(t, dbPath)
	index := notaloneDeltaWALIndexReader{Reader: shm, Size: shmSize}
	for _, test := range []struct {
		name      string
		reader    io.ReaderAt
		wantError string
	}{
		{name: "committed frame salt", reader: &notaloneDeltaXORReaderAt{reader: wal, offset: notaloneDeltaWALHeaderSize + 8, xor: 1}, wantError: "history_delta_wal_frame_header_invalid"},
		{name: "committed frame page checksum", reader: &notaloneDeltaXORReaderAt{reader: wal, offset: notaloneDeltaWALHeaderSize + notaloneDeltaWALFrameHeaderSize + 17, xor: 1}, wantError: "history_delta_wal_frame_checksum_invalid"},
	} {
		t.Run("wal-index-bound-"+test.name, func(t *testing.T) {
			_, scanErr := readNotaloneDeltaPages(context.Background(), db, dbSize, test.reader, walSize, rootPage, key, nil, index)
			if scanErr == nil || !strings.Contains(scanErr.Error(), test.wantError) {
				t.Fatalf("corrupt committed WAL frame was not rejected as %s: %v", test.wantError, scanErr)
			}
		})
	}
	badIndex := notaloneDeltaWALIndexReader{Reader: &notaloneDeltaXORReaderAt{reader: shm, offset: notaloneDeltaWALIndexHeaderSize, xor: 1}, Size: shmSize}
	if _, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil, badIndex); err == nil || !strings.Contains(err.Error(), "history_snapshot_window_changed") {
		t.Fatalf("inconsistent double wal-index header was not rejected: %v", err)
	}
	if walSize < notaloneDeltaWALHeaderSize+notaloneDeltaWALFrameHeaderSize+notaloneDeltaPageSize {
		t.Fatalf("synthetic fixture has no complete WAL frame: size=%d", walSize)
	}
	for _, test := range []struct {
		name      string
		offset    int64
		wantError string
	}{
		{name: "header checksum", offset: 24, wantError: "history_delta_wal_header_checksum_invalid"},
		{name: "frame checksum", offset: notaloneDeltaWALHeaderSize + notaloneDeltaWALFrameHeaderSize + 17, wantError: "history_delta_wal_frame_checksum_invalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			corrupt := &notaloneDeltaXORReaderAt{reader: wal, offset: test.offset, xor: 1}
			_, scanErr := notaloneDeltaScanWAL(context.Background(), corrupt, walSize, nil)
			if scanErr == nil || !strings.Contains(scanErr.Error(), test.wantError) {
				t.Fatalf("corrupt WAL was not rejected as %s: %v", test.wantError, scanErr)
			}
		})
	}

	if err = writer.Exec("UPDATE Msg_delta_fixture SET body=zeroblob(72) WHERE local_id=1"); err != nil {
		t.Fatal("write synthetic transaction for partial tail")
	}
	partialDB, partialDBSize, partialWAL, partialWALSize := notaloneDeltaReaders(t, dbPath)
	frameSize := int64(notaloneDeltaWALFrameHeaderSize + notaloneDeltaPageSize)
	partialSize := baseline.State.WAL.CommitOffset + frameSize - 1
	if partialSize <= baseline.State.WAL.CommitOffset || partialSize >= partialWALSize {
		t.Fatalf("synthetic WAL lacks append tail for truncation: prior=%d partial=%d actual=%d", baseline.State.WAL.CommitOffset, partialSize, partialWALSize)
	}
	partial, err := readNotaloneDeltaPages(context.Background(), partialDB, partialDBSize, partialWAL, partialSize, rootPage, key, &baseline.State)
	if err != nil {
		t.Fatalf("ignore uncommitted partial WAL frame: %v", err)
	}
	if partial.FullAudit || len(partial.ChangedIDs) != 0 || partial.State.WAL.CommitOffset != baseline.State.WAL.CommitOffset {
		t.Fatalf("partial uncommitted WAL tail advanced the accepted state: changed=%v oldOffset=%d newOffset=%d", partial.ChangedIDs, baseline.State.WAL.CommitOffset, partial.State.WAL.CommitOffset)
	}
	complete, err := readNotaloneDeltaPages(context.Background(), partialDB, partialDBSize, partialWAL, partialWALSize, rootPage, key, &baseline.State)
	if err != nil {
		t.Fatalf("read completed synthetic WAL transaction: %v", err)
	}
	if complete.FullAudit || !containsInt64(complete.ChangedIDs, 1) {
		t.Fatalf("completed transaction was not reported after partial-tail retry: %v", complete.ChangedIDs)
	}
}

func TestNotAloneDeltaPagesReindexesOverflowPageReusedAsBtreeChild(t *testing.T) {
	dbPath, key, rootPage, writer := notaloneDeltaPageFixture(t)
	db, dbSize, wal, walSize := notaloneDeltaReaders(t, dbPath)
	baseline, err := readNotaloneDeltaPages(context.Background(), db, dbSize, wal, walSize, rootPage, key, nil)
	if err != nil {
		t.Fatalf("index baseline with overflow chain: %v", err)
	}
	priorOverflow := notaloneDeltaOverflowPageNumbers(baseline.State)
	if len(priorOverflow) == 0 {
		t.Fatal("synthetic baseline has no overflow page to recycle")
	}
	beforeIDs := notaloneDeltaReadIDs(t, writer)
	if err = writer.Exec("BEGIN IMMEDIATE; UPDATE Msg_delta_fixture SET body=zeroblob(64) WHERE local_id=1300; WITH RECURSIVE seq(id) AS (VALUES(2001) UNION ALL SELECT id+1 FROM seq WHERE id<10000) INSERT INTO Msg_delta_fixture(local_id,body) SELECT id,zeroblob(128) FROM seq; COMMIT"); err != nil {
		t.Fatal("shrink overflow row and split B-tree in one synthetic commit")
	}
	currentBtreePages := notaloneDeltaReadDBStatPages(t, writer)
	var reused []uint32
	for _, number := range priorOverflow {
		if kind, ok := currentBtreePages[number]; ok && (kind == "leaf" || kind == "internal") {
			reused = append(reused, number)
		}
	}
	if len(reused) == 0 {
		t.Fatalf("fixture did not reuse old overflow page as a B-tree child; prior=%v current tree pages=%d", priorOverflow, len(currentBtreePages))
	}

	currentDB, currentSize, currentWAL, currentWALSize := notaloneDeltaReaders(t, dbPath)
	delta, err := readNotaloneDeltaPages(context.Background(), currentDB, currentSize, currentWAL, currentWALSize, rootPage, key, &baseline.State)
	if err != nil {
		t.Fatalf("track page reused from overflow as B-tree child: %v", err)
	}
	currentIDs := notaloneDeltaReadIDs(t, writer)
	added := notaloneDeltaIDDifference(currentIDs, beforeIDs)
	assertNotaloneDeltaContainsAll(t, delta.ChangedIDs, added, "overflow-page reuse")
	if notaloneDeltaPriorValid(delta.State, rootPage, delta.State.SaltDigest, delta.State.Format, delta.State.ReserveSize) != true {
		t.Fatal("overflow-page reuse produced a state rejected by the next checkpoint validation")
	}
}

func notaloneDeltaOverflowPageNumbers(state notaloneDeltaPageState) []uint32 {
	var result []uint32
	for _, page := range state.Pages {
		if page.Kind == notaloneDeltaPageOverflow {
			result = append(result, page.Number)
		}
	}
	return result
}

func notaloneDeltaReadDBStatPages(t *testing.T, db *wcdb.DB) map[uint32]string {
	t.Helper()
	rows, err := db.QueryBounded(context.Background(), 20000, "SELECT pageno,pagetype FROM dbstat WHERE name=?", "Msg_delta_fixture")
	if err != nil {
		t.Fatalf("read synthetic B-tree page ownership: %v", err)
	}
	pages := make(map[uint32]string, len(rows))
	for _, row := range rows {
		page, pageOK := row["pageno"].(int64)
		kind, kindOK := row["pagetype"].(string)
		if !pageOK || !kindOK || page <= 0 || page > int64(^uint32(0)) {
			t.Fatalf("unexpected synthetic dbstat row shape: %#v", row)
		}
		pages[uint32(page)] = kind
	}
	return pages
}

func notaloneDeltaReadIDs(t *testing.T, db *wcdb.DB) map[int64]struct{} {
	t.Helper()
	rows, err := db.QueryBounded(context.Background(), 12000, "SELECT local_id FROM Msg_delta_fixture ORDER BY local_id")
	if err != nil {
		t.Fatalf("read synthetic row IDs: %v", err)
	}
	ids := make(map[int64]struct{}, len(rows))
	for _, row := range rows {
		id, ok := row["local_id"].(int64)
		if !ok {
			t.Fatalf("unexpected row ID type: %T", row["local_id"])
		}
		ids[id] = struct{}{}
	}
	return ids
}

func notaloneDeltaIDDifference(left, right map[int64]struct{}) map[int64]struct{} {
	result := map[int64]struct{}{}
	for id := range left {
		if _, ok := right[id]; !ok {
			result[id] = struct{}{}
		}
	}
	return result
}

func notaloneDeltaIDUnion(left, right map[int64]struct{}) map[int64]struct{} {
	result := make(map[int64]struct{}, len(left)+len(right))
	for id := range left {
		result[id] = struct{}{}
	}
	for id := range right {
		result[id] = struct{}{}
	}
	return result
}

func notaloneDeltaTreeShape(state notaloneDeltaPageState) (leaves, interiors int) {
	for _, page := range state.Pages {
		switch page.Kind {
		case notaloneDeltaPageLeaf:
			leaves++
		case notaloneDeltaPageInterior:
			interiors++
		}
	}
	return leaves, interiors
}

func assertNotaloneDeltaContainsAll(t *testing.T, changed []int64, expected map[int64]struct{}, phase string) {
	t.Helper()
	changedSet := make(map[int64]struct{}, len(changed))
	for _, id := range changed {
		changedSet[id] = struct{}{}
	}
	missing := 0
	var sample []int64
	for id := range expected {
		if _, ok := changedSet[id]; !ok {
			missing++
			if len(sample) < 5 {
				sample = append(sample, id)
			}
		}
	}
	if missing > 0 {
		t.Errorf("%s missed %d changed row IDs (sample %v)", phase, missing, sample)
	}
}

func assertNotaloneDeltaSubset(t *testing.T, changed []int64, allowed map[int64]struct{}, phase string) {
	t.Helper()
	extra := 0
	var sample []int64
	for _, id := range changed {
		if _, ok := allowed[id]; !ok {
			extra++
			if len(sample) < 5 {
				sample = append(sample, id)
			}
		}
	}
	if extra > 0 {
		t.Errorf("%s returned %d row IDs absent from both SQL snapshots (sample %v)", phase, extra, sample)
	}
}

type notaloneDeltaXORReaderAt struct {
	reader io.ReaderAt
	offset int64
	xor    byte
}

func (reader *notaloneDeltaXORReaderAt) ReadAt(buffer []byte, offset int64) (int, error) {
	count, err := reader.reader.ReadAt(buffer, offset)
	if reader.offset >= offset && reader.offset < offset+int64(count) {
		buffer[reader.offset-offset] ^= reader.xor
	}
	return count, err
}

func containsInt64(values []int64, target int64) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type notaloneDeltaCountingReaderAt struct {
	reader    io.ReaderAt
	bytesRead int64
}

func (reader *notaloneDeltaCountingReaderAt) ReadAt(buffer []byte, offset int64) (int, error) {
	count, err := reader.reader.ReadAt(buffer, offset)
	reader.bytesRead += int64(count)
	return count, err
}
