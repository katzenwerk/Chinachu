'use strict';

const path = require('path');

const DEFAULT_PATH = 'http+unix://%2Fvar%2Frun%2Fmirakurun.sock/';
const STANDARD_UNIX_FORMAT = /^http\+unix:\/\/([^\/]+)(\/?.*)$/;
const LEGACY_UNIX_FORMAT = /^http:\/\/unix:([^:]+):?(.*)$/;

function resolvePath(config) {
	return config.mirakurunPath || config.schedulerMirakurunPath || DEFAULT_PATH;
}

function configureClient(client, config) {
	const mirakurunPath = resolvePath(config);

	if (/(?:\/|\+)unix:/.test(mirakurunPath) === true) {
		if (STANDARD_UNIX_FORMAT.test(mirakurunPath) === true) {
			client.socketPath = mirakurunPath.replace(STANDARD_UNIX_FORMAT, '$1').replace(/%2F/g, '/');
			client.basePath = path.join(mirakurunPath.replace(STANDARD_UNIX_FORMAT, '$2'), client.basePath);
		} else {
			client.socketPath = mirakurunPath.replace(LEGACY_UNIX_FORMAT, '$1');
			client.basePath = path.join(mirakurunPath.replace(LEGACY_UNIX_FORMAT, '$2'), client.basePath);
		}
	} else {
		const urlObject = new URL(mirakurunPath);
		client.host = urlObject.hostname;
		client.port = urlObject.port;
		client.basePath = path.join(urlObject.pathname, client.basePath);
	}

	return mirakurunPath;
}

module.exports = {
	DEFAULT_PATH: DEFAULT_PATH,
	configureClient: configureClient,
	resolvePath: resolvePath
};
