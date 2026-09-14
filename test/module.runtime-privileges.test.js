'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const runtimePrivileges = require('../lib/runtime-privileges');

function createProcessFixture(options) {
	const calls = [];
	const fixture = {
		platform: options.platform || 'linux',
		getuid: () => options.uid,
		initgroups: (uid, gid) => calls.push([ 'initgroups', uid, gid ]),
		setgid: gid => calls.push([ 'setgid', gid ]),
		setuid: uid => calls.push([ 'setuid', uid ])
	};
	return { calls, fixture };
}

describe('Runtime privilege drop', function() {
	it('initializes supplementary groups before setgid and setuid for root', function() {
		const { calls, fixture } = createProcessFixture({ uid: 0 });

		assert.strictEqual(runtimePrivileges.dropPrivileges(fixture, { uid: 'chinachu', gid: 'video' }), true);
		assert.deepStrictEqual(calls, [
			[ 'initgroups', 'chinachu', 'video' ],
			[ 'setgid', 'video' ],
			[ 'setuid', 'chinachu' ]
		]);
	});

	it('uses video as the compatible gid fallback', function() {
		const { calls, fixture } = createProcessFixture({ uid: 0 });

		runtimePrivileges.dropPrivileges(fixture, { uid: 1000 });
		assert.deepStrictEqual(calls[0], [ 'initgroups', 1000, 'video' ]);
		assert.deepStrictEqual(calls[1], [ 'setgid', 'video' ]);
	});

	it('does not use config uid/gid when already non-root', function() {
		const { calls, fixture } = createProcessFixture({ uid: 1000 });

		assert.strictEqual(runtimePrivileges.dropPrivileges(fixture, { uid: 'other', gid: 'video' }), false);
		assert.deepStrictEqual(calls, []);
	});

	it('rejects a root privilege drop without config uid', function() {
		const { fixture } = createProcessFixture({ uid: 0 });
		assert.throws(() => runtimePrivileges.dropPrivileges(fixture, { gid: 'video' }), /uid.*required/);
	});
});
