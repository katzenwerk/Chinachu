'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mirakurunConnection = require('../lib/mirakurun-connection');

function configure(endpoint, initialBasePath) {
	const client = { basePath: initialBasePath || '/api' };
	const selectedPath = mirakurunConnection.configureClient(client, { mirakurunPath: endpoint });

	return { client: client, selectedPath: selectedPath };
}

describe('Mirakurun connection configuration', function() {
	it('resolves supported TCP and Unix endpoint formats to the expected transport and API path', function() {
		const cases = [
			{
				endpoint: undefined,
				selectedPath: mirakurunConnection.DEFAULT_PATH,
				client: { basePath: '/api', socketPath: '/var/run/mirakurun.sock' }
			},
			{
				endpoint: 'http://192.0.2.10:40772/',
				selectedPath: 'http://192.0.2.10:40772/',
				client: { basePath: '/api', host: '192.0.2.10', port: '40772' }
			},
			{
				endpoint: 'http://mirakurun.example.test:40772/reverse-proxy/',
				client: { basePath: '/reverse-proxy/api', host: 'mirakurun.example.test', port: '40772' }
			},
			{
				endpoint: 'http+unix://%2Fvar%2Frun%2Fmirakurun.sock/',
				client: { basePath: '/api', socketPath: '/var/run/mirakurun.sock' }
			},
			{
				endpoint: 'http+unix://%2Fvar%2Frun%2Fmirakurun.sock/reverse-proxy/',
				client: { basePath: '/reverse-proxy/api', socketPath: '/var/run/mirakurun.sock' }
			},
			{
				endpoint: 'http://unix:/var/run/mirakurun.sock:/reverse-proxy/',
				client: { basePath: '/reverse-proxy/api', socketPath: '/var/run/mirakurun.sock' }
			}
		];

		for (const entry of cases) {
			const result = configure(entry.endpoint);
			if (entry.selectedPath) assert.strictEqual(result.selectedPath, entry.selectedPath);
			assert.deepStrictEqual(result.client, entry.client, String(entry.endpoint));
		}
	});

	it('keeps mirakurunPath, schedulerMirakurunPath, and default selection order', function() {
		assert.strictEqual(mirakurunConnection.resolvePath({
			mirakurunPath: 'http://primary.example.test:40772/',
			schedulerMirakurunPath: 'http://legacy.example.test:40772/'
		}), 'http://primary.example.test:40772/');
		assert.strictEqual(mirakurunConnection.resolvePath({
			schedulerMirakurunPath: 'http://legacy.example.test:40772/'
		}), 'http://legacy.example.test:40772/');
		assert.strictEqual(mirakurunConnection.resolvePath({
			mirakurunPath: '',
			schedulerMirakurunPath: 'http://legacy.example.test:40772/'
		}), 'http://legacy.example.test:40772/');
		assert.strictEqual(mirakurunConnection.resolvePath({}), mirakurunConnection.DEFAULT_PATH);
	});
});
