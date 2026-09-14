'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const MirakurunClient = require('mirakurun').default;
const mirakurunConnection = require('../lib/mirakurun-connection');
const mirakurunDropWatch = require('../lib/mirakurun-drop-watch');

function configuredClient(mirakurunPath) {
	const client = new MirakurunClient();
	mirakurunConnection.configureClient(client, { mirakurunPath: mirakurunPath });
	return client;
}

describe('Operator Mirakurun DROP WATCH request selection', function() {
	it('uses TCP host/port despite the Mirakurun Client default socketPath', function() {
		const client = configuredClient('http://192.0.2.10:40772/reverse-proxy/');

		assert.strictEqual(client.socketPath, '/var/run/mirakurun.sock');
		assert.strictEqual(client.host, '192.0.2.10');
		assert.strictEqual(client.port, '40772');
		assert.strictEqual(client.basePath, '/reverse-proxy/api');
		assert.strictEqual(mirakurunDropWatch.usesUnixSocket(client), false);
		assert.strictEqual(mirakurunDropWatch.getApiRequestPath(client, '/tuners'), '/reverse-proxy/api/tuners');
	});

	it('uses socketPath for a standard Unix socket endpoint', function() {
		const client = configuredClient('http+unix://%2Ftmp%2Fmirakurun.sock/');

		assert.strictEqual(client.host, '');
		assert.strictEqual(client.socketPath, '/tmp/mirakurun.sock');
		assert.strictEqual(mirakurunDropWatch.usesUnixSocket(client), true);
		assert.strictEqual(mirakurunDropWatch.getApiRequestPath(client, '/tuners'), '/api/tuners');
	});

	it('uses socketPath and preserves basePath for a legacy Unix socket endpoint', function() {
		const client = configuredClient('http://unix:/tmp/mirakurun.sock:/reverse-proxy/');

		assert.strictEqual(client.host, '');
		assert.strictEqual(client.socketPath, '/tmp/mirakurun.sock');
		assert.strictEqual(client.basePath, '/reverse-proxy/api');
		assert.strictEqual(mirakurunDropWatch.usesUnixSocket(client), true);
		assert.strictEqual(mirakurunDropWatch.getApiRequestPath(client, '/tuners'), '/reverse-proxy/api/tuners');
	});

	it('wires getMirakurunJson to the Client-compatible transport decision', function() {
		const source = fs.readFileSync(path.resolve(__dirname, '..', 'app-operator.js'), 'utf8');

		assert.match(source, /mirakurunDropWatch\.usesUnixSocket\(mirakurun\)/);
		assert.match(source, /mirakurunDropWatch\.getApiRequestPath\(mirakurun, endpoint\)/);
		assert.doesNotMatch(source, /if\s*\(mirakurun\.socketPath\)/);
	});
});
