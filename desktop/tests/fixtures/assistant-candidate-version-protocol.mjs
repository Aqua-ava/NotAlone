// 原来源回归的合成后端按正式分页／身份回执投影；完整 HTTP 另用真实 JsonClient 验证。
export function candidateVersionProtocol(backend) {
  const snapshots = new Map();
  return { ...backend, getConnectionGeneration: () => backend.getConnectionGeneration(),
    requestJson: async (request) => {
      const url = new URL(request.path, 'http://localhost');
      if (!url.pathname.endsWith('/versions')) return backend.requestJson(request);
      const number = Number(url.searchParams.get('page'));
      const anchor = url.searchParams.get('through');
      let response;
      if (request.method === 'GET' && anchor && number > 0) response = snapshots.get(anchor);
      else response = await backend.requestJson({ ...request, path: url.pathname });
      if (!response || !Array.isArray(response.data?.versions)) return response;
      const value = response.data;
      if (request.method === 'POST' && url.searchParams.get('receipt') === '1') {
        const written = value.versions.at(-1);
        return { ...response, data: { session_id: value.session_id, candidate_id: value.candidate_id,
          version_id: written.version_id, version_number: written.version_number,
          edit_key: request.body.edit_key, parent_version_id: request.body.parent_version_id } };
      }
      if (!url.searchParams.has('page')) return response;
      snapshots.set(value.default_display_version_id, response);
      const { selected_version_id: _selected, ...header } = value;
      return { ...response, data: { ...header, versions: [value.versions[number]],
        page_number: number, version_count: value.versions.length,
        next_page: number + 1 < value.versions.length ? number + 1 : null } };
    } };
}
