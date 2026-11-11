(function() {
  if (request.type !== 'json') return response.error(415);
  var id = String(request.param.id || '');
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return response.error(400);
  var input = request.method === 'GET' ? { action: 'state' } : request.query || {};
  // Old Operators recognize only status/generate: keep the outer action read-only
  // so an unsupported maintenance request can never fall through to generation.
  var message = { maintenance: true, id: id, action: 'status', maintenanceAction: input.action, tasks: input.tasks, redo: input.redo,
    path: input.path, token: input.token, confirm: input.confirm, selectedIds: input.selectedIds, percent: input.percent };
  // Uses the existing authenticated API dispatcher and private Operator socket.
  storageRefreshIpc.request({ socketPath: define.RECORDED_THUMBNAIL_SOCKET, timeoutMs: 5000 }, message)
    .then(function(result) {
      if (!result || result.maintenanceVersion !== 1) {
        response.head(503);
        response.end(JSON.stringify({ message: 'Operatorはこの状態確認機能に未対応です。ソース変更の反映が必要です。' }));
        return;
      }
      response.head(result.job && result.job.status === 'queued' ? 202 : 200);
      response.end(JSON.stringify(result));
    }).catch(function(error) {
      var status = Number(error.statusCode);
      if (status < 400 || status > 599 || !status) status = 503;
      response.head(status);
      response.end(JSON.stringify({ error: error.code || 'maintenance_unavailable',
        message: error.publicMessage || '状態確認を利用できません。Operatorの対応状況を確認してください。' }));
    });
})();
