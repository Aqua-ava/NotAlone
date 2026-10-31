package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
)

const (
	notaloneDeltaWALIndexHeaderSize       = 48
	notaloneDeltaWALIndexDoubleHeaderSize = 2 * notaloneDeltaWALIndexHeaderSize
	notaloneDeltaWALIndexVersion          = 3007000
)

// notaloneDeltaWALIndexReader 保存 SQLite WAL 索引的只读视图。
// 生产环境用 mxFrame 限定已提交代次，不把物理文件长度当作有效帧范围。
type notaloneDeltaWALIndexReader struct {
	Reader io.ReaderAt
	Size   int64
}

type notaloneDeltaWALIndexState struct {
	Header    [notaloneDeltaWALIndexDoubleHeaderSize]byte
	MXFrame   uint32
	PageCount uint32
	Checksum1 uint32
	Checksum2 uint32
	PageSize  uint32
}

func notaloneDeltaReadWALIndex(ctx context.Context, reader io.ReaderAt, size int64, walHeader []byte, walSize int64) (*notaloneDeltaWALIndexState, error) {
	if ctx == nil || reader == nil || size < notaloneDeltaWALIndexDoubleHeaderSize || len(walHeader) != notaloneDeltaWALHeaderSize || walSize < notaloneDeltaWALHeaderSize {
		return nil, errors.New("history_snapshot_unavailable")
	}
	var state notaloneDeltaWALIndexState
	if err := notaloneDeltaReadAt(ctx, reader, state.Header[:], 0); err != nil {
		return nil, errors.New("history_snapshot_unavailable")
	}
	first := state.Header[:notaloneDeltaWALIndexHeaderSize]
	second := state.Header[notaloneDeltaWALIndexHeaderSize:]
	if !bytes.Equal(first, second) {
		return nil, errors.New("history_snapshot_window_changed")
	}
	if first[12] != 1 || first[13] > 1 || !allZero(first[4:8]) || binary.NativeEndian.Uint32(first[0:4]) != notaloneDeltaWALIndexVersion {
		return nil, errors.New("history_snapshot_unavailable")
	}
	var endianProbe [2]byte
	binary.NativeEndian.PutUint16(endianProbe[:], 1)
	nativeLittle := endianProbe[0] == 1
	indexCheck1, indexCheck2, err := notaloneDeltaChecksum(first[:40], nativeLittle, 0, 0)
	if err != nil || indexCheck1 != binary.NativeEndian.Uint32(first[40:44]) || indexCheck2 != binary.NativeEndian.Uint32(first[44:48]) {
		return nil, errors.New("history_snapshot_unavailable")
	}
	walMagic := binary.BigEndian.Uint32(walHeader[0:4])
	walLittle := walMagic == notaloneDeltaWALMagicLE
	pageSize := binary.BigEndian.Uint32(walHeader[8:12])
	indexPageSize := binary.NativeEndian.Uint16(first[14:16])
	state.MXFrame = binary.NativeEndian.Uint32(first[16:20])
	if walMagic != notaloneDeltaWALMagicLE && walMagic != notaloneDeltaWALMagicBE {
		return nil, errors.New("history_delta_wal_magic_invalid")
	}
	pageSizeMatches := indexPageSize == uint16(pageSize)
	emptyPageSizeUnset := state.MXFrame == 0 && indexPageSize == 0
	if (first[13] == 0) != walLittle || (!pageSizeMatches && !emptyPageSizeUnset) ||
		!bytes.Equal(first[32:40], walHeader[16:24]) {
		return nil, errors.New("history_snapshot_window_changed")
	}
	state.PageCount = binary.NativeEndian.Uint32(first[20:24])
	state.Checksum1 = binary.NativeEndian.Uint32(first[24:28])
	state.Checksum2 = binary.NativeEndian.Uint32(first[28:32])
	state.PageSize = pageSize
	frameSize := int64(notaloneDeltaWALFrameHeaderSize + pageSize)
	completeFrames := uint64(0)
	if walSize >= notaloneDeltaWALHeaderSize {
		completeFrames = uint64((walSize - notaloneDeltaWALHeaderSize) / frameSize)
	}
	if uint64(state.MXFrame) > completeFrames || state.MXFrame > notaloneDeltaMaxWALBytes/uint32(frameSize) {
		return nil, errors.New("history_snapshot_window_changed")
	}
	if state.MXFrame == 0 {
		// SQLite 重启 WAL 时只把 mxFrame 置零；nPage 和帧校验和可保留旧值。
		return &state, nil
	}
	if state.PageCount == 0 || state.PageCount > notaloneDeltaMaxPages {
		return nil, errors.New("history_delta_wal_index_invalid")
	}
	return &state, nil
}
