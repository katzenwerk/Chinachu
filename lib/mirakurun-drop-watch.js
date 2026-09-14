'use strict';

const path = require('path');

function usesUnixSocket(client) {
	return client.host === '';
}

function getApiRequestPath(client, endpoint) {
	const basePath = client.basePath || '/api';
	let requestPath = path.posix.join('/', basePath, endpoint || '');

	requestPath = requestPath.replace(/\\/g, '/');

	if (requestPath.charAt(0) !== '/') {
		requestPath = '/' + requestPath;
	}

	return requestPath;
}

module.exports = {
	getApiRequestPath: getApiRequestPath,
	usesUnixSocket: usesUnixSocket
};
