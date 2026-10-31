package main

import (
	"context"
	"encoding/binary"
	"errors"
	"sort"
)

func notaloneDeltaApplyWALFrames(ctx context.Context, reader *notaloneDeltaPageReader, root uint32, prior notaloneDeltaPageState, scan notaloneDeltaWALScan) (notaloneDeltaPageState, map[int64]struct{}, error) {
	if err := ctx.Err(); err != nil {
		return notaloneDeltaPageState{}, nil, err
	}
	pages := make(map[uint32]notaloneDeltaTrackedPage, len(prior.Pages)+len(scan.Frames))
	for _, page := range prior.Pages {
		pages[page.Number] = page
	}
	changed := map[int64]struct{}{}
	framePages := make([]uint32, 0, len(scan.Frames))
	for number := range scan.Frames {
		framePages = append(framePages, number)
	}
	sort.Slice(framePages, func(i, j int) bool {
		left, right := scan.Frames[framePages[i]], scan.Frames[framePages[j]]
		return left.Offset < right.Offset
	})
	interiors := make([]uint32, 0)
	for _, number := range framePages {
		if page, ok := pages[number]; ok && page.Kind == notaloneDeltaPageInterior {
			interiors = append(interiors, number)
		}
	}
	sort.SliceStable(interiors, func(i, j int) bool {
		return notaloneDeltaDepth(pages, root, interiors[i]) < notaloneDeltaDepth(pages, root, interiors[j])
	})
	visited := map[uint32]bool{}
	for _, number := range interiors {
		if err := ctx.Err(); err != nil {
			return notaloneDeltaPageState{}, nil, err
		}
		if err := notaloneDeltaApplyTreePage(ctx, reader, pages, changed, number, root, visited); err != nil {
			return notaloneDeltaPageState{}, nil, err
		}
	}
	for _, number := range framePages {
		if err := ctx.Err(); err != nil {
			return notaloneDeltaPageState{}, nil, err
		}
		old, tracked := pages[number]
		if tracked && old.Kind == notaloneDeltaPageOverflow {
			continue
		}
		if tracked && old.Kind == notaloneDeltaPageInterior {
			// The parent pass already processed it.
			continue
		}
		if !tracked {
			// A new target-table page must be linked from a changed interior,
			// which indexes it during the parent pass.
			continue
		}
		if err := notaloneDeltaApplyTreePage(ctx, reader, pages, changed, number, root, visited); err != nil {
			return notaloneDeltaPageState{}, nil, err
		}
	}
	if err := notaloneDeltaSweepUnreachable(ctx, pages, changed, root); err != nil {
		return notaloneDeltaPageState{}, nil, err
	}
	// Overflow pages can change independently of their leaf page. Rebuild only
	// the owning row's chain, using old metadata for unchanged pages and WAL
	// frames for the pages touched in this commit.
	for _, number := range framePages {
		if err := ctx.Err(); err != nil {
			return notaloneDeltaPageState{}, nil, err
		}
		page, ok := pages[number]
		if !ok || page.Kind != notaloneDeltaPageOverflow || len(page.RowIDs) != 1 {
			continue
		}
		owner := page.RowIDs[0]
		leafNumber, head, count, found := notaloneDeltaFindOverflowOwner(pages, owner)
		if !found {
			return notaloneDeltaPageState{}, nil, errors.New("history_delta_overflow_owner_missing")
		}
		changed[owner] = struct{}{}
		if err := notaloneDeltaRefreshOverflowChain(reader, pages, leafNumber, owner, head, count); err != nil {
			return notaloneDeltaPageState{}, nil, err
		}
	}
	state := notaloneDeltaPageState{
		Format:      reader.format,
		PageSize:    notaloneDeltaPageSize,
		ReserveSize: reader.reserveSize,
		RootPage:    root,
		SaltDigest:  prior.SaltDigest,
		PageCount:   reader.pageCount,
		WAL:         scan.State,
		Pages:       notaloneDeltaSortedPages(pages),
	}
	if len(state.Pages) == 0 {
		return notaloneDeltaPageState{}, nil, errors.New("history_delta_tree_empty")
	}
	return state, changed, nil
}

func notaloneDeltaDepth(pages map[uint32]notaloneDeltaTrackedPage, root, number uint32) int {
	depth := 0
	seen := map[uint32]bool{}
	for number != root {
		if seen[number] {
			return int(^uint(0) >> 1)
		}
		seen[number] = true
		page, ok := pages[number]
		if !ok || page.Parent == 0 {
			return int(^uint(0) >> 1)
		}
		number = page.Parent
		depth++
	}
	return depth
}

func notaloneDeltaApplyTreePage(ctx context.Context, reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage,
	changed map[int64]struct{}, number, root uint32, visiting map[uint32]bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if visiting[number] {
		return errors.New("history_delta_btree_cycle")
	}
	visiting[number] = true
	defer delete(visiting, number)
	old := pages[number]
	node, current, err := notaloneDeltaReadNode(reader, number)
	if err != nil {
		return err
	}
	current.Parent = old.Parent
	if current.Hash == old.Hash && current.Kind == old.Kind {
		return nil
	}
	if old.Kind == notaloneDeltaPageLeaf {
		for _, id := range old.RowIDs {
			changed[id] = struct{}{}
		}
	}
	pages[number] = current
	if node.kind == notaloneDeltaPageInterior {
		for _, child := range node.children {
			childPage, exists := pages[child]
			if exists {
				childPage.Parent = number
				pages[child] = childPage
				continue
			}
			if _, hasFrame := reader.walFrames[child]; !hasFrame {
				return errors.New("history_delta_new_child_frame_missing")
			}
			if err := notaloneDeltaAddTreePage(ctx, reader, pages, changed, child, number, visiting); err != nil {
				return err
			}
		}
		return nil
	}
	if node.kind != notaloneDeltaPageLeaf {
		return errors.New("history_delta_tree_page_kind_invalid")
	}
	for _, id := range node.rowIDs {
		changed[id] = struct{}{}
	}
	if err := notaloneDeltaSetLeafOverflows(reader, pages, number, &current, node); err != nil {
		return err
	}
	pages[number] = current
	_ = root
	return nil
}

func notaloneDeltaAddTreePage(ctx context.Context, reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage,
	changed map[int64]struct{}, number, parent uint32, visiting map[uint32]bool) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if visiting[number] {
		return errors.New("history_delta_btree_cycle")
	}
	if _, exists := pages[number]; exists {
		page := pages[number]
		if page.Parent != parent {
			page.Parent = parent
			pages[number] = page
		}
		return nil
	}
	visiting[number] = true
	defer delete(visiting, number)
	node, page, err := notaloneDeltaReadNode(reader, number)
	if err != nil {
		return err
	}
	page.Parent = parent
	pages[number] = page
	if node.kind == notaloneDeltaPageInterior {
		for _, child := range node.children {
			if err := notaloneDeltaAddTreePage(ctx, reader, pages, changed, child, number, visiting); err != nil {
				return err
			}
		}
		return nil
	}
	if node.kind != notaloneDeltaPageLeaf {
		return errors.New("history_delta_new_child_kind_invalid")
	}
	for _, id := range node.rowIDs {
		changed[id] = struct{}{}
	}
	if err := notaloneDeltaSetLeafOverflows(reader, pages, number, &page, node); err != nil {
		return err
	}
	pages[number] = page
	return nil
}

func notaloneDeltaSetLeafOverflows(reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage, leaf uint32,
	page *notaloneDeltaTrackedPage, node notaloneDeltaNode) error {
	old := pages[leaf]
	keep := map[uint32]struct{}{}
	for _, owner := range node.overflowHeads {
		chain, err := notaloneDeltaBuildOverflowChain(reader, pages, leaf, owner)
		if err != nil {
			return err
		}
		for _, number := range chain {
			keep[number] = struct{}{}
			page.OverflowPages = append(page.OverflowPages, number)
		}
	}
	for _, number := range old.OverflowPages {
		if _, ok := keep[number]; ok {
			continue
		}
		if oldOverflow, ok := pages[number]; ok && oldOverflow.Kind == notaloneDeltaPageOverflow {
			delete(pages, number)
		}
	}
	page.OverflowHeads = append([]notaloneDeltaOverflowOwner(nil), node.overflowHeads...)
	page.OverflowPages = notaloneDeltaUniquePageNumbers(page.OverflowPages)
	return nil
}

func notaloneDeltaBuildOverflowChain(reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage, leaf uint32,
	owner notaloneDeltaOverflowOwner) ([]uint32, error) {
	if owner.HeadPage == 0 || owner.PageCount == 0 || owner.PageCount > notaloneDeltaMaxPages {
		return nil, errors.New("history_delta_overflow_header_invalid")
	}
	result := make([]uint32, 0, owner.PageCount)
	seen := map[uint32]bool{}
	current := owner.HeadPage
	for index := uint32(0); index < owner.PageCount; index++ {
		if current == 0 || current > reader.pageCount || seen[current] {
			return nil, errors.New("history_delta_overflow_link_invalid")
		}
		seen[current] = true
		old, exists := pages[current]
		frame, changed := reader.walFrames[current]
		_ = frame
		var hash string
		var next uint32
		if exists && old.Kind == notaloneDeltaPageOverflow && len(old.RowIDs) == 1 && old.RowIDs[0] == owner.RowID && !changed {
			hash, next = old.Hash, old.OverflowNext
		} else {
			if !exists && !changed {
				return nil, errors.New("history_delta_new_overflow_frame_missing")
			}
			raw, err := reader.readRawPage(current)
			if err != nil {
				return nil, err
			}
			hash = notaloneDeltaHash(raw)
			plain, err := notaloneDeltaDecryptPage(raw, current, &reader.crypto)
			clear(raw)
			if err != nil {
				return nil, err
			}
			next = binary.BigEndian.Uint32(plain[:4])
			clear(plain)
		}
		if index+1 == owner.PageCount {
			if next != 0 {
				return nil, errors.New("history_delta_overflow_length_mismatch")
			}
		} else if next == 0 {
			return nil, errors.New("history_delta_overflow_length_mismatch")
		}
		pages[current] = notaloneDeltaTrackedPage{Number: current, Parent: leaf, Hash: hash,
			Kind: notaloneDeltaPageOverflow, RowIDs: []int64{owner.RowID}, OverflowNext: next}
		result = append(result, current)
		current = next
	}
	return result, nil
}

func notaloneDeltaSweepUnreachable(ctx context.Context, pages map[uint32]notaloneDeltaTrackedPage, changed map[int64]struct{}, root uint32) error {
	if _, ok := pages[root]; !ok {
		return errors.New("history_delta_root_missing")
	}
	seen := make(map[uint32]bool, len(pages))
	var visit func(uint32) error
	visit = func(number uint32) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if seen[number] {
			return errors.New("history_delta_btree_cycle")
		}
		seen[number] = true
		page, ok := pages[number]
		if !ok {
			return errors.New("history_delta_btree_child_missing")
		}
		for _, child := range page.ChildPages {
			if err := visit(child); err != nil {
				return err
			}
		}
		for _, overflow := range page.OverflowPages {
			if _, exists := pages[overflow]; !exists {
				return errors.New("history_delta_overflow_page_missing")
			}
			seen[overflow] = true
		}
		return nil
	}
	if err := visit(root); err != nil {
		return err
	}
	for number, page := range pages {
		if seen[number] {
			continue
		}
		notaloneDeltaAddPageOwners(page, changed)
		delete(pages, number)
	}
	return nil
}

func notaloneDeltaFindOverflowOwner(pages map[uint32]notaloneDeltaTrackedPage, rowID int64) (uint32, uint32, uint32, bool) {
	for number, page := range pages {
		if page.Kind != notaloneDeltaPageLeaf {
			continue
		}
		for _, owner := range page.OverflowHeads {
			if owner.RowID == rowID {
				return number, owner.HeadPage, owner.PageCount, true
			}
		}
	}
	return 0, 0, 0, false
}

func notaloneDeltaRefreshOverflowChain(reader *notaloneDeltaPageReader, pages map[uint32]notaloneDeltaTrackedPage,
	leaf uint32, owner int64, head, count uint32) error {
	leafPage, ok := pages[leaf]
	if !ok || leafPage.Kind != notaloneDeltaPageLeaf {
		return errors.New("history_delta_overflow_leaf_missing")
	}
	ownerInfo := notaloneDeltaOverflowOwner{RowID: owner, HeadPage: head, PageCount: count}
	chain, err := notaloneDeltaBuildOverflowChain(reader, pages, leaf, ownerInfo)
	if err != nil {
		return err
	}
	keep := make(map[uint32]struct{}, len(chain))
	for _, number := range chain {
		keep[number] = struct{}{}
	}
	for _, oldNumber := range leafPage.OverflowPages {
		old, exists := pages[oldNumber]
		if exists && old.Kind == notaloneDeltaPageOverflow && len(old.RowIDs) == 1 && old.RowIDs[0] == owner {
			if _, ok := keep[oldNumber]; !ok {
				delete(pages, oldNumber)
			}
		}
	}
	var all []uint32
	for _, oldNumber := range leafPage.OverflowPages {
		old, exists := pages[oldNumber]
		if exists && !(old.Kind == notaloneDeltaPageOverflow && len(old.RowIDs) == 1 && old.RowIDs[0] == owner) {
			all = append(all, oldNumber)
		}
	}
	all = append(all, chain...)
	leafPage.OverflowPages = notaloneDeltaUniquePageNumbers(all)
	pages[leaf] = leafPage
	return nil
}

func notaloneDeltaUniqueIDs(values []int64) []int64 {
	seen := make(map[int64]struct{}, len(values))
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
