(function() {
  if (request.method !== 'POST') return response.error(405);
  if (request.type !== 'json' || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return response.error(415);
  var files = recordedMaintenanceFiles.createFiles(define.REPOSITORY_ROOT, config);
  files.registerAnalysis(String(request.param.id || ''), request.query).then(function(result) {
    response.head(200);
    response.end(JSON.stringify(result));
  }).catch(function(error) {
    var status = Number(error.statusCode);
    if (status < 400 || status > 599 || !status) status = 409;
    response.head(status);
    response.end(JSON.stringify({ error: error.code || 'analysis_registration_failed',
      message: error.publicMessage || '解析結果を登録できません。対象ファイル・台帳・権限を確認してください。' }));
  });
})();
