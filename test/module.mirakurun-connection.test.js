'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mirakurunConnection = require('../lib/mirakurun-connection');

function configure(endpoint, initialBasePath) {
	const client = { basePath: initialBasePath || '/api' };
	const selectedPath = mirakurunConnection.configureClient(client, { mirakurunPath: endpoint });

	return { client: client, selectedPath: selectedPath };
}

describe('Mirakurun connection configuration', function() {
	it('uses the default Unix socket when mirakurunPath is not configured', function() {
		const result = configure();

		assert.strictEqual(result.selectedPath, mirakurunConnection.DEFAULT_PATH);
		assert.deepStrictEqual(result.client, {
			basePath: '/api',
			socketPath: '/var/run/mirakurun.sock'
		});
	});

	it('configures an HTTP/TCP endpoint', function() {
		const result = configure('http://192.0.2.10:40772/');

		assert.strictEqual(result.selectedPath, 'http://192.0.2.10:40772/');
		assert.deepStrictEqual(result.client, {
			basePath: '/api',
			host: '192.0.2.10',
			port: '40772'
		});
	});

	it('preserves an HTTP/TCP pathname in the client basePath', function() {
		const result = configure('http://mirakurun.example.test:40772/reverse-proxy/');

		assert.deepStrictEqual(result.client, {
			basePath: '/reverse-proxy/api',
			host: 'mirakurun.example.test',
			port: '40772'
		});
	});

	it('configures the standard encoded Unix socket endpoint', function() {
		const result = configure('http+unix://%2Fvar%2Frun%2Fmirakurun.sock/');

		assert.deepStrictEqual(result.client, {
			basePath: '/api',
			socketPath: '/var/run/mirakurun.sock'
		});
	});

	it('preserves a standard Unix socket endpoint pathname in basePath', function() {
		const result = configure('http+unix://%2Fvar%2Frun%2Fmirakurun.sock/reverse-proxy/');

		assert.deepStrictEqual(result.client, {
			basePath: '/reverse-proxy/api',
			socketPath: '/var/run/mirakurun.sock'
		});
	});

	it('configures the legacy Unix socket endpoint and its pathname', function() {
		const result = configure('http://unix:/var/run/mirakurun.sock:/reverse-proxy/');

		assert.deepStrictEqual(result.client, {
			basePath: '/reverse-proxy/api',
			socketPath: '/var/run/mirakurun.sock'
		});
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

	it('is the only endpoint parser used by operator, scheduler, and WUI', function() {
		[ 'app-operator.js', 'app-scheduler.js', 'app-wui.js' ].forEach(fileName => {
			const source = fs.readFileSync(path.resolve(__dirname, '..', fileName), 'utf8');

			assert.match(source, /require\(['"]\.\/lib\/mirakurun-connection['"]\)/);
			assert.match(source, /mirakurunConnection\.configureClient\(mirakurun, config\)/);
			assert.doesNotMatch(source, /standardFormat|legacyFormat/);
		});
	});
});
