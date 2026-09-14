'use strict';

const http = require('http');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const openHost = require('../lib/wui-open-host');

function interfaceAddress(address, options) {
	return Object.assign({
		address: address,
		family: 'IPv4',
		internal: false
	}, options);
}

describe('WUI Open Server host selection', function() {
	it('selects the existing private and link-local IPv4 ranges', function() {
		[
			'10.0.0.0',
			'10.255.255.255',
			'172.16.0.0',
			'172.31.255.255',
			'192.168.0.0',
			'192.168.255.255',
			'169.254.0.0',
			'169.254.255.255'
		].forEach(address => {
			assert.strictEqual(openHost.isSelectablePrivateIPv4(interfaceAddress(address)), true);
		});
	});

	it('excludes CGNAT, public IPv4, and addresses outside the selected ranges', function() {
		[
			'100.64.0.0',
			'100.127.255.255',
			'8.8.8.8',
			'172.15.255.255',
			'172.32.0.0'
		].forEach(address => {
			assert.strictEqual(openHost.isSelectablePrivateIPv4(interfaceAddress(address)), false);
		});
	});

	it('excludes internal, loopback, and IPv6 interfaces', function() {
		assert.strictEqual(openHost.isSelectablePrivateIPv4(interfaceAddress('10.0.0.1', { internal: true })), false);
		assert.strictEqual(openHost.isSelectablePrivateIPv4(interfaceAddress('127.0.0.1', { internal: true })), false);
		assert.strictEqual(openHost.isSelectablePrivateIPv4(interfaceAddress('fe80::1', { family: 'IPv6' })), false);
	});

	it('preserves interface and address order when selecting the first candidate', function() {
		const result = openHost.resolveOpenServerHost(null, function() {
			return {
				public0: [ interfaceAddress('203.0.113.10') ],
				lan0: [ interfaceAddress('192.168.1.20'), interfaceAddress('10.0.0.20') ],
				lan1: [ interfaceAddress('172.16.0.20') ]
			};
		});

		assert.strictEqual(result.host, '192.168.1.20');
		assert.deepStrictEqual(result.addresses, [ '192.168.1.20', '10.0.0.20', '172.16.0.20' ]);
		assert.strictEqual(result.autoDetected, true);
	});

	it('uses an explicitly configured IPv4, IPv6, or hostname without auto-detection', function() {
		[ '192.0.2.10', '100.64.0.10', '2001:db8::10', 'chinachu.example.test' ].forEach(configuredHost => {
			let detectionCalled = false;
			const result = openHost.resolveOpenServerHost(configuredHost, function() {
				detectionCalled = true;
				return {};
			});

			assert.strictEqual(result.host, configuredHost);
			assert.strictEqual(result.autoDetected, false);
			assert.strictEqual(detectionCalled, false);
		});
	});

	it('can bind explicit IPv4, IPv6, and hostname loopback values', async function() {
		for (const configuredHost of [ '127.0.0.1', '::1', 'localhost' ]) {
			const result = openHost.resolveOpenServerHost(configuredHost);
			const server = http.createServer(function(req, res) {
				res.end('ok');
			});

			await new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(0, result.host, resolve);
			});

			await new Promise((resolve, reject) => {
				server.close(error => error ? reject(error) : resolve());
			});
		}
	});

	it('fails instead of returning a wildcard host when no private IPv4 exists', function() {
		assert.throws(function() {
			openHost.resolveOpenServerHost(null, function() {
				return {
					loopback: [ interfaceAddress('127.0.0.1', { internal: true }) ],
					public0: [ interfaceAddress('203.0.113.10') ],
					ipv6: [ interfaceAddress('fd00::10', { family: 'IPv6' }) ]
				};
			});
		}, /Configure `wuiOpenHost` explicitly/);
	});
});
