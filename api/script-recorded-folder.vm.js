(function () {
  recordedFolderJobs.request(request.method === 'GET' ? { action: 'state' } : request.query || {})
    .then(function (result) { response.head(200); response.end(JSON.stringify(result)); })
    .catch(function (error) {
      response.head(error.statusCode || 500);
      response.end(JSON.stringify({ message: error.publicMessage || error.message || '振り分けを実行できません。' }));
    });
})();
