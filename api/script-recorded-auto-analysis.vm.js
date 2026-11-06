(function() {
  if (request.type !== 'json') return response.error(415);
  var action = request.method === 'GET' && String(request.query && request.query.monitor || '') === '1'
    ? 'monitor-status' : 'auto-status';
  if (request.method === 'POST') {
    action = request.query && request.query.action;
    if (action !== 'auto-pause' && action !== 'auto-resume') return response.error(400);
  } else if (request.method !== 'GET') {
    return response.error(405);
  }
  // Uses the authenticated WUI API and the existing private Operator IPC.
  storageRefreshIpc.request({ socketPath: define.RECORDED_THUMBNAIL_SOCKET, timeoutMs: 5000 },
    { maintenance: true, action: 'status', maintenanceAction: action })
    .then(function(result) {
      if (!result || (action === 'monitor-status' ? result.monitorVersion !== 1 : result.autoAnalysisVersion !== 1)) {
        response.head(503);
        response.end(JSON.stringify({ message: 'Operatorは自動TS解析に未対応です。' }));
        return;
      }
      response.head(200);
      response.end(JSON.stringify(result));
    }).catch(function(error) {
      var status = Number(error.statusCode);
      if (!status || status < 400 || status > 599) status = 503;
      response.head(status);
      response.end(JSON.stringify({ message: error.publicMessage || '自動TS解析の状態を取得できません。' }));
    });
})();
