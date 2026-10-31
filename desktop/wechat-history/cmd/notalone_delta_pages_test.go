package main

import (
	"context"
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
