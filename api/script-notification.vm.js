(function () {
  if (!data.status.feature.configurator) return response.error(403);
  var root = define.REPOSITORY_ROOT;
  function reply(value) {
    response.head(200);
    response.end(JSON.stringify(value));
  }
  try {
    if (request.method === 'GET') return reply(externalNotification.publicSettings(externalNotification.read(root)));
    if (request.method === 'PUT') return reply(externalNotification.update(root, request.query));
    if (request.method === 'POST') {
      var name = request.query.route;
      if (!['slack', 'pushover', 'mail'].includes(name)) return response.error(400);
      if (typeof externalNotification.testConnection !== 'function') return response.error(503);
      externalNotification.testConnection(root, name, request.query.values).then(function (results) {
        reply({ ok: results.length === 1 && results[0].ok });
      }).catch(function (error) { response.error(error.statusCode === 400 ? 400 : 500); });
      return;
    }
    response.error(405);
  } catch (error) {
    response.error(error.statusCode === 400 ? 400 : 500);
  }
})();
