(function() {
	
	if (!data.status.feature.configurator) return response.error(403);
	
	if (!fs.existsSync(define.CONFIG_FILE)) return response.error(410);
	
	switch (request.method) {
		case 'GET':
			response.head(200);
			response.end(fs.readFileSync(define.CONFIG_FILE));
			return;
		
		case 'PUT':
			if (!request.query.json) return response.error(400);
			
			var obj = {};
			
			try {
				obj = JSON.parse(request.query.json);
			} catch (e) {
				return response.error(400);
			}
			
			try {
				if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return response.error(400);
				// Refuse to replace a config that became invalid after the page was loaded.
				JSON.parse(fs.readFileSync(define.CONFIG_FILE, 'utf8'));
				delete obj.externalNotifications;
				var persistConfig = function () { wuiConfigStore.writeAtomic(define.CONFIG_FILE, obj); };
				if (request.query.notifications !== undefined) {
					if (typeof externalNotification.saveSettings !== 'function') return response.error(503);
					var settings = JSON.parse(request.query.notifications);
					var savedNotifications = externalNotification.saveSettings(define.REPOSITORY_ROOT, settings, persistConfig);
					obj.externalNotifications = savedNotifications;
				} else persistConfig();
				response.head(200);
				response.end(JSON.stringify(obj));
			} catch (error) {
				return response.error(error.statusCode === 400 || error instanceof SyntaxError ? 400 : 500);
			}
			return;
	}

})();