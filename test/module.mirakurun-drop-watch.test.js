'use strict';

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
	it('selects the correct DROP WATCH transport and request path for supported endpoints', function() {
		const cases = [
			{
				endpoint: 'http://192.0.2.10:40772/reverse-proxy/',
				check(client) {
					assert.strictEqual(client.socketPath, '/var/run/mirakurun.sock');
					assert.strictEqual(client.host, '192.0.2.10');
					assert.strictEqual(client.port, '40772');
					assert.strictEqual(mirakurunDropWatch.usesUnixSocket(client), false);
					assert.strictEqual(mirakurunDropWatch.getApiRequestPath(client, '/tuners'), '/reverse-proxy/api/tuners');
				}
			},
			{
				endpoint: 'http+unix://%2Ftmp%2Fmirakurun.sock/',
				check(client) {
					assert.strictEqual(client.host, '');
					assert.strictEqual(client.socketPath, '/tmp/mirakurun.sock');
					assert.strictEqual(mirakurunDropWatch.usesUnixSocket(client), true);
					assert.strictEqual(mirakurunDropWatch.getApiRequestPath(client, '/tuners'), '/api/tuners');
				}
			},
			{
				endpoint: 'http://unix:/tmp/mirakurun.sock:/reverse-proxy/',
				check(client) {
					assert.strictEqual(client.host, '');
					assert.strictEqual(client.socketPath, '/tmp/mirakurun.sock');
					assert.strictEqual(mirakurunDropWatch.usesUnixSocket(client), true);
					assert.strictEqual(mirakurunDropWatch.getApiRequestPath(client, '/tuners'), '/reverse-proxy/api/tuners');
				}
			}
		];

		for (const entry of cases) {
			entry.check(configuredClient(entry.endpoint));
		}
	});
});
