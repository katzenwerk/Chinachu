(function() {
	var id = String(request.param.id || '');
	var thumbnailPath = recordedThumbnail.resolveOutputPath(define.RECORDED_THUMBNAIL_DIR, id);

	if (!thumbnailPath) return response.error(400);

	function sendJson(statusCode, value) {
		response.setHeader('Content-Type', 'application/json; charset=utf-8');
		response.head(statusCode);
		response.end(JSON.stringify(value || {}, null, '  '));
	}

	function requestOperator(action) {
		return storageRefreshIpc.request({
			socketPath: define.RECORDED_THUMBNAIL_SOCKET,
			timeoutMs: 5000
		}, { id: id, action: action });
	}

	function readThumbnailStat() {
		try {
			var value = fs.statSync(thumbnailPath);
			return value.isFile() && value.size > 0 ? value : null;
		} catch (error) {
			if (error && error.code === 'ENOENT') return null;
			throw error;
		}
	}

	switch (request.method) {
		case 'GET':
			if (request.type === 'json') {
				var statusStat;
				try {
					statusStat = readThumbnailStat();
				} catch (_) {
					return response.error(500);
				}
				if (statusStat) {
					return sendJson(200, {
						id: id,
						status: 'complete',
						available: true,
						reason: null,
						updatedAt: statusStat.mtime.getTime()
					});
				}
				requestOperator('status').then(function(result) {
					sendJson(200, result);
				}).catch(function(error) {
					var statusCode = Number(error && error.statusCode);
					if (!statusCode || statusCode < 400 || statusCode > 599) statusCode = 500;
					sendJson(statusCode, {
						error: error && error.code || 'thumbnail_status_failed',
						message: error && error.publicMessage || 'サムネイル生成状態を取得できませんでした。'
					});
				});
				return;
			}
			if (request.type !== 'jpg') return response.error(415);

			var stat;
			try {
				stat = readThumbnailStat();
			} catch (error) {
				return response.error(500);
			}
			if (!stat) return response.error(404);

			response.setHeader('Content-Type', 'image/jpeg');
			response.setHeader('Content-Length', stat.size);
			response.head(200);
			fs.createReadStream(thumbnailPath).pipe(response);
			return;

		case 'POST':
			if (request.type !== 'json') return response.error(415);
			var existingStat;
			try {
				existingStat = readThumbnailStat();
			} catch (_) {
				return response.error(500);
			}
			if (existingStat) {
				return sendJson(200, {
					id: id,
					status: 'complete',
					available: true,
					reason: null,
					updatedAt: existingStat.mtime.getTime()
				});
			}
			requestOperator('generate').then(function(result) {
				sendJson(result && result.status === 'complete' ? 200 : 202, result);
			}).catch(function(error) {
				var statusCode = Number(error && error.statusCode);
				if (!statusCode || statusCode < 400 || statusCode > 599) statusCode = 500;
				sendJson(statusCode, {
					id: id,
					status: error && error.code === 'recorded_file_missing' ? 'source-missing' : 'failed',
					available: false,
					reason: error && error.code || 'thumbnail_request_failed',
					error: error && error.code || 'thumbnail_request_failed',
					message: error && error.publicMessage || 'サムネイル生成を要求できませんでした。'
				});
			});
			return;
	}
})();
