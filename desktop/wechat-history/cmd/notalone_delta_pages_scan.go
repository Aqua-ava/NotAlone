package main

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
)

const notaloneDeltaWALHeaderSize = 32
const notaloneDeltaWALFrameHeaderSize = 24

func notaloneDeltaScanWAL(ctx context.Context, wal io.ReaderAt, walSize int64, prior *notaloneDeltaPageState) (notaloneDeltaWALScan, error) {
	result := notaloneDeltaWALScan{
		Frames:    map[uint32]notaloneDeltaFrame{},
		AllFrames: map[uint32]notaloneDeltaFrame{},
		PageCount: 0,
	}
	if walSize == 0 {
		return result, nil
	}
	if wal == nil || walSize < notaloneDeltaWALHeaderSize {
		return result, errors.New("history_delta_wal_header_invalid")
	}
	var header [notaloneDeltaWALHeaderSize]byte
	if err := notaloneDeltaReadAt(ctx, wal, header[:], 0); err != nil {
		return result, err
	}
	magic := binary.BigEndian.Uint32(header[0:4])
	little := false
	switch magic {
	case notaloneDeltaWALMagicLE:
		little = true
	case notaloneDeltaWALMagicBE:
	default:
		return result, errors.New("history_delta_wal_magic_invalid")
	}
	if binary.BigEndian.Uint32(header[4:8]) != notaloneDeltaWALFormat {
		return result, errors.New("history_delta_wal_version_invalid")
	}
	pageSize := binary.BigEndian.Uint32(header[8:12])
	if pageSize != notaloneDeltaPageSize {
		return result, errors.New("history_delta_wal_page_size_invalid")
	}
	salt1 := binary.BigEndian.Uint32(header[16:20])
	salt2 := binary.BigEndian.Uint32(header[20:24])
	check1, check2, err := notaloneDeltaChecksum(header[:24], little, 0, 0)
	if err != nil {
		return result, err
	}
	stored1, stored2 := notaloneDeltaChecksumFields(header[24:32])
	if check1 != stored1 || check2 != stored2 {
		return result, errors.New("history_delta_wal_header_checksum_invalid")
	}
	headerDigest := notaloneDeltaHash(header[:])
	result.HasWAL = true
	result.State = notaloneDeltaWALState{
		HeaderDigest: headerDigest,
		Salt1:        salt1,
		Salt2:        salt2,
		CommitOffset: notaloneDeltaWALHeaderSize,
		Checksum1:    check1,
		Checksum2:    check2,
	}
	scanStart := int64(notaloneDeltaWALHeaderSize)
	rolling1, rolling2 := check1, check2
	result.LastCommitEnd = scanStart
	result.LastChecksum1 = check1
	result.LastChecksum2 = check2
	if prior != nil && prior.WAL.HeaderDigest == headerDigest && prior.WAL.Salt1 == salt1 && prior.WAL.Salt2 == salt2 {
		priorOffset := prior.WAL.CommitOffset
		frameSize := int64(notaloneDeltaWALFrameHeaderSize + notaloneDeltaPageSize)
		aligned := priorOffset >= notaloneDeltaWALHeaderSize && (priorOffset-notaloneDeltaWALHeaderSize)%frameSize == 0
		if aligned && priorOffset <= walSize {
			validBoundary := false
			if priorOffset == notaloneDeltaWALHeaderSize {
				validBoundary = prior.WAL.Checksum1 == check1 && prior.WAL.Checksum2 == check2
			} else {
				var previous [notaloneDeltaWALFrameHeaderSize]byte
				readErr := notaloneDeltaReadAt(ctx, wal, previous[:], priorOffset-frameSize)
				if readErr != nil {
					if ctx.Err() != nil {
						return result, ctx.Err()
					}
				} else {
					validBoundary = binary.BigEndian.Uint32(previous[4:8]) != 0 &&
						binary.BigEndian.Uint32(previous[8:12]) == salt1 && binary.BigEndian.Uint32(previous[12:16]) == salt2
					stored1, stored2 := notaloneDeltaChecksumFields(previous[16:24])
					validBoundary = validBoundary && stored1 == prior.WAL.Checksum1 && stored2 == prior.WAL.Checksum2
				}
			}
			if validBoundary {
				result.Continuous = true
				scanStart = priorOffset
				rolling1, rolling2 = prior.WAL.Checksum1, prior.WAL.Checksum2
				result.LastCommitEnd = priorOffset
				result.LastChecksum1, result.LastChecksum2 = rolling1, rolling2
				result.PageCount = prior.PageCount
			}
		}
	}
	frameSize := int64(notaloneDeltaWALFrameHeaderSize + notaloneDeltaPageSize)
	frameCount := (walSize - scanStart) / frameSize
	if frameCount > notaloneDeltaMaxWALBytes/frameSize {
		return result, errors.New("history_delta_wal_frame_limit")
	}
	latest := make(map[uint32]notaloneDeltaFrame)
	var frameHeader [notaloneDeltaWALFrameHeaderSize]byte
	page := make([]byte, notaloneDeltaPageSize)
	defer clear(page)

	for index := int64(0); index < frameCount; index++ {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		offset := scanStart + index*frameSize
		if err := notaloneDeltaReadAt(ctx, wal, frameHeader[:], offset); err != nil {
			return result, err
		}
		pageNumber := binary.BigEndian.Uint32(frameHeader[0:4])
		dbSizeAfter := binary.BigEndian.Uint32(frameHeader[4:8])
		if pageNumber == 0 || pageNumber > notaloneDeltaMaxPages ||
			binary.BigEndian.Uint32(frameHeader[8:12]) != salt1 || binary.BigEndian.Uint32(frameHeader[12:16]) != salt2 {
			return result, errors.New("history_delta_wal_frame_header_invalid")
		}
		if err := notaloneDeltaReadAt(ctx, wal, page, offset+notaloneDeltaWALFrameHeaderSize); err != nil {
			return result, err
		}
		sum1, sum2, checksumErr := notaloneDeltaChecksum(frameHeader[:8], little, rolling1, rolling2)
		if checksumErr != nil {
			return result, checksumErr
		}
		sum1, sum2, checksumErr = notaloneDeltaChecksum(page, little, sum1, sum2)
		if checksumErr != nil {
			return result, checksumErr
		}
		frameCheck1, frameCheck2 := notaloneDeltaChecksumFields(frameHeader[16:24])
		if sum1 != frameCheck1 || sum2 != frameCheck2 {
			return result, errors.New("history_delta_wal_frame_checksum_invalid")
		}
		rolling1, rolling2 = sum1, sum2
		frame := notaloneDeltaFrame{Page: pageNumber, Offset: offset}
		latest[pageNumber] = frame
		result.FramesRead++

		if dbSizeAfter != 0 {
			if dbSizeAfter > notaloneDeltaMaxPages {
				return result, errors.New("history_delta_wal_database_size_invalid")
			}
			result.PageCount = dbSizeAfter
			result.LastCommitEnd = offset + frameSize
			result.LastChecksum1 = rolling1
			result.LastChecksum2 = rolling2
			result.AllFrames = cloneNotaloneDeltaFrames(latest)
			result.Frames = cloneNotaloneDeltaFrames(latest)
		}
	}
	if walSize > scanStart && (walSize-scanStart)%frameSize != 0 {
		// A partial trailing frame is an uncommitted WAL append. Only complete,
		// checksum-valid commits above are visible to the SQLite reader.
	}
	result.State.CommitOffset = result.LastCommitEnd
	result.State.Checksum1 = result.LastChecksum1
	result.State.Checksum2 = result.LastChecksum2
	if result.Continuous {
		result.AllFrames = cloneNotaloneDeltaFrames(result.Frames)
	} else if len(result.Frames) == 0 {
		// A full tree audit below needs the latest effective WAL page image set.
		result.AllFrames = map[uint32]notaloneDeltaFrame{}
	}
	return result, nil
}

func cloneNotaloneDeltaFrames(source map[uint32]notaloneDeltaFrame) map[uint32]notaloneDeltaFrame {
	result := make(map[uint32]notaloneDeltaFrame, len(source))
	for number, frame := range source {
		result[number] = frame
	}
	return result
}

func notaloneDeltaCloneTrackedPages(source []notaloneDeltaTrackedPage) []notaloneDeltaTrackedPage {
	result := make([]notaloneDeltaTrackedPage, len(source))
	for i, page := range source {
		page.RowIDs = append([]int64(nil), page.RowIDs...)
		page.ChildPages = append([]uint32(nil), page.ChildPages...)
		page.OverflowPages = append([]uint32(nil), page.OverflowPages...)
		page.OverflowHeads = append([]notaloneDeltaOverflowOwner(nil), page.OverflowHeads...)
		result[i] = page
	}
	return result
}

func notaloneDeltaWalkFull(ctx context.Context, reader *notaloneDeltaPageReader, root uint32) (map[uint32]notaloneDeltaTrackedPage, error) {
	pages := make(map[uint32]notaloneDeltaTrackedPage)
	if err := notaloneDeltaWalkTreePage(ctx, reader, pages, root, 0); err != nil {
		return nil, err
	}
	return pages, nil
}

func notaloneDeltaWalkTreePage(ctx context.Context, reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage, number, parent uint32) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if number == 0 || number > reader.pageCount {
		return errors.New("history_delta_btree_child_invalid")
	}
	if _, exists := pages[number]; exists {
		return errors.New("history_delta_btree_cycle")
	}
	node, page, err := notaloneDeltaReadNode(reader, number)
	if err != nil {
		return err
	}
	page.Parent = parent
	pages[number] = page
	if node.kind == notaloneDeltaPageInterior {
		for _, child := range node.children {
			if err := notaloneDeltaWalkTreePage(ctx, reader, pages, child, number); err != nil {
				return err
			}
		}
		return nil
	}
	for _, owner := range page.OverflowHeads {
		chain, err := notaloneDeltaReadOverflowChain(reader, pages, number, owner.RowID, owner.HeadPage, owner.PageCount)
		if err != nil {
			return err
		}
		pages[number] = page
		page.OverflowPages = append(page.OverflowPages, chain...)
	}
	page.OverflowPages = notaloneDeltaUniquePageNumbers(page.OverflowPages)
	pages[number] = page
	return nil
}

func notaloneDeltaReadNode(reader *notaloneDeltaPageReader, number uint32) (notaloneDeltaNode, notaloneDeltaTrackedPage, error) {
	raw, err := reader.readRawPage(number)
	if err != nil {
		return notaloneDeltaNode{}, notaloneDeltaTrackedPage{}, err
	}
	hash := notaloneDeltaHash(raw)
	plain, err := notaloneDeltaDecryptPage(raw, number, &reader.crypto)
	clear(raw)
	if err != nil {
		return notaloneDeltaNode{}, notaloneDeltaTrackedPage{}, err
	}
	defer clear(plain)
	node, err := notaloneDeltaParseBtreeNode(plain, number, reader.pageCount, reader.reserveSize)
	if err != nil {
		return notaloneDeltaNode{}, notaloneDeltaTrackedPage{}, err
	}
	page := notaloneDeltaTrackedPage{Number: number, Hash: hash, Kind: node.kind,
		RowIDs: append([]int64(nil), node.rowIDs...), ChildPages: append([]uint32(nil), node.children...),
		OverflowHeads: append([]notaloneDeltaOverflowOwner(nil), node.overflowHeads...)}
	return node, page, nil
}

func notaloneDeltaReadOverflowChain(reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage, parent uint32,
	rowID int64, head uint32, pageCount uint32) ([]uint32, error) {
	if head == 0 || pageCount == 0 || pageCount > notaloneDeltaMaxPages {
		return nil, errors.New("history_delta_overflow_header_invalid")
	}
	chain := make([]uint32, 0, pageCount)
	seen := make(map[uint32]struct{}, pageCount)
	current := head
	for index := uint32(0); index < pageCount; index++ {
		if current == 0 || current > reader.pageCount {
			return nil, errors.New("history_delta_overflow_link_invalid")
		}
		if _, ok := seen[current]; ok {
			return nil, errors.New("history_delta_overflow_cycle")
		}
		if _, ok := pages[current]; ok {
			return nil, errors.New("history_delta_overflow_shared")
		}
		seen[current] = struct{}{}
		raw, err := reader.readRawPage(current)
		if err != nil {
			return nil, err
		}
		hash := notaloneDeltaHash(raw)
		plain, err := notaloneDeltaDecryptPage(raw, current, &reader.crypto)
		clear(raw)
		if err != nil {
			return nil, err
		}
		next := binary.BigEndian.Uint32(plain[:4])
		clear(plain)
		if index+1 == pageCount {
			if next != 0 {
				return nil, errors.New("history_delta_overflow_length_mismatch")
			}
		} else if next == 0 {
			return nil, errors.New("history_delta_overflow_length_mismatch")
		}
		pages[current] = notaloneDeltaTrackedPage{Number: current, Parent: parent, Hash: hash,
			Kind: notaloneDeltaPageOverflow, RowIDs: []int64{rowID}, OverflowNext: next}
		chain = append(chain, current)
		current = next
	}
	return chain, nil
}

func notaloneDeltaParseBtreeNode(page []byte, number, pageCount, reserveSize uint32) (notaloneDeltaNode, error) {
	if len(page) != notaloneDeltaPageSize || number == 0 {
		return notaloneDeltaNode{}, errors.New("history_delta_btree_page_invalid")
	}
	if reserveSize > notaloneDeltaPageSize-35 {
		return notaloneDeltaNode{}, errors.New("history_delta_btree_reserve_invalid")
	}
	header := 0
	if number == 1 {
		header = 100
	}
	if header+8 > len(page)-int(reserveSize) {
		return notaloneDeltaNode{}, errors.New("history_delta_btree_header_invalid")
	}
	kind := page[header]
	if kind != notaloneDeltaPageLeaf && kind != notaloneDeltaPageInterior {
		return notaloneDeltaNode{}, errors.New("history_delta_btree_kind_invalid")
	}
	headerSize := 8
	if kind == notaloneDeltaPageInterior {
		headerSize = 12
	}
	cellCount := int(binary.BigEndian.Uint16(page[header+3 : header+5]))
	cellStart := header + headerSize
	pointerEnd := cellStart + cellCount*2
	usableEnd := len(page) - int(reserveSize)
	if cellCount > notaloneDeltaMaxRowIDs || pointerEnd > usableEnd {
		return notaloneDeltaNode{}, errors.New("history_delta_btree_cells_invalid")
	}
	node := notaloneDeltaNode{kind: kind}
	if kind == notaloneDeltaPageInterior {
		node.children = make([]uint32, 0, cellCount+1)
		for index := 0; index < cellCount; index++ {
			ptr := int(binary.BigEndian.Uint16(page[cellStart+index*2 : cellStart+index*2+2]))
			if ptr < 0 || ptr+4 > usableEnd {
				return notaloneDeltaNode{}, errors.New("history_delta_btree_cell_invalid")
			}
			child := binary.BigEndian.Uint32(page[ptr : ptr+4])
			if child == 0 || child > pageCount {
				return notaloneDeltaNode{}, errors.New("history_delta_btree_child_invalid")
			}
			_, n, err := notaloneDeltaVarint(page, ptr+4, usableEnd)
			if err != nil {
				return notaloneDeltaNode{}, err
			}
			_ = n
			node.children = append(node.children, child)
		}
		rightmost := binary.BigEndian.Uint32(page[header+8 : header+12])
		if rightmost == 0 || rightmost > pageCount {
			return notaloneDeltaNode{}, errors.New("history_delta_btree_rightmost_invalid")
		}
		node.children = append(node.children, rightmost)
		return node, nil
	}
	node.rowIDs = make([]int64, 0, cellCount)
	node.overflowHeads = make([]notaloneDeltaOverflowOwner, 0)
	node.overflowCount = make(map[int64]uint32)
	seenIDs := make(map[int64]struct{}, cellCount)
	for index := 0; index < cellCount; index++ {
		ptr := int(binary.BigEndian.Uint16(page[cellStart+index*2 : cellStart+index*2+2]))
		if ptr < pointerEnd || ptr >= usableEnd {
			return notaloneDeltaNode{}, errors.New("history_delta_btree_cell_invalid")
		}
		payloadSize, payloadVarint, err := notaloneDeltaVarint(page, ptr, usableEnd)
		if err != nil {
			return notaloneDeltaNode{}, err
		}
		rowRaw, rowVarint, err := notaloneDeltaVarint(page, ptr+payloadVarint, usableEnd)
		if err != nil {
			return notaloneDeltaNode{}, err
		}
		rowID := int64(rowRaw)
		if _, ok := seenIDs[rowID]; ok {
			return notaloneDeltaNode{}, errors.New("history_delta_btree_duplicate_rowid")
		}
		seenIDs[rowID] = struct{}{}
		node.rowIDs = append(node.rowIDs, rowID)
		local := notaloneDeltaLocalPayloadSize(payloadSize, uint64(len(page)-int(reserveSize)))
		cellPayloadStart := ptr + payloadVarint + rowVarint
		if local > uint64(usableEnd-cellPayloadStart) {
			return notaloneDeltaNode{}, errors.New("history_delta_btree_payload_invalid")
		}
		if payloadSize > local {
			overflowPtr := cellPayloadStart + int(local)
			if overflowPtr+4 > usableEnd {
				return notaloneDeltaNode{}, errors.New("history_delta_overflow_pointer_invalid")
			}
			head := binary.BigEndian.Uint32(page[overflowPtr : overflowPtr+4])
			remaining := payloadSize - local
			perPage := uint64(len(page)-int(reserveSize)) - 4
			count := (remaining + perPage - 1) / perPage
			if count == 0 || count > notaloneDeltaMaxPages || head == 0 || head > pageCount {
				return notaloneDeltaNode{}, errors.New("history_delta_overflow_pointer_invalid")
			}
			node.overflowHeads = append(node.overflowHeads, notaloneDeltaOverflowOwner{RowID: rowID, HeadPage: head, PageCount: uint32(count)})
			node.overflowCount[rowID] = uint32(count)
		}
	}
	return node, nil
}

func notaloneDeltaLocalPayloadSize(payloadSize, usable uint64) uint64 {
	maxLocal := usable - 35
	minLocal := ((usable-12)*32)/255 - 23
	if payloadSize <= maxLocal {
		return payloadSize
	}
	local := minLocal + (payloadSize-minLocal)%(usable-4)
	if local > maxLocal {
		return minLocal
	}
	return local
}

func notaloneDeltaVarint(data []byte, offset, limit int) (uint64, int, error) {
	if offset < 0 || limit > len(data) || offset >= limit {
		return 0, 0, errors.New("history_delta_varint_bounds")
	}
	var value uint64
	for index := 0; index < 8; index++ {
		if offset+index >= limit {
			return 0, 0, errors.New("history_delta_varint_truncated")
		}
		b := data[offset+index]
		value = (value << 7) | uint64(b&0x7f)
		if b < 0x80 {
			return value, index + 1, nil
		}
	}
	if offset+8 >= limit {
		return 0, 0, errors.New("history_delta_varint_truncated")
	}
	value = (value << 8) | uint64(data[offset+8])
	return value, 9, nil
}

func notaloneDeltaUniquePageNumbers(values []uint32) []uint32 {
	seen := make(map[uint32]struct{}, len(values))
	result := make([]uint32, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
