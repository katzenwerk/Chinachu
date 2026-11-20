(function () {
  if (!/^\/api\/recording-history\.json(?:\?|$)/.test(request.url)) return response.error(400);
  try {
    var directory = path.join(path.dirname(define.CONFIG_FILE), 'data', 'csv');
    var filename = request.query && request.query.file;
    var result = filename
      ? Object.assign({ filename: filename }, recordingHistoryCsv.readFile(directory, filename))
      : { files: recordingHistoryCsv.listFiles(directory) };
    response.head(200);
    response.end(JSON.stringify(result));
  } catch (error) {
    util.log(error);
    response.head(error.statusCode || (error.code === 'ENOENT' ? 404 : 500));
    response.end(JSON.stringify({ error: 'csv_read_failed', message: 'CSVを読み取れません。ファイルの形式・文字コード・読み取り権限を確認してください。' }));
  }
})();
