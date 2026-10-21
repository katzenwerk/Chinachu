'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const bitrateStats = require('../lib/bitrate-stats');

function program(overrides) {
	return Object.assign({
		id: 'program-1',
		end: 180000,
		operatorRecordingStart: 0,
		operatorRecordingEnd: 180000,
		channel: {
			id: 'service-1',
			name: 'Service 1',
			type: 'GR',
			nid: 10,
			sid: 101
		}
	}, overrides || {});
}

function measurement(channelKey, programId, recordedAt, mbps) {
	return {
		channelKey: channelKey,
		channel: { id: channelKey, name: channelKey, type: 'GR', networkId: 10, serviceId: 101 },
		recording: {
			programId: programId,
			recordedAt: recordedAt,
			seconds: 100,
			bytes: Math.round(mbps * 1000000 / 8 * 100),
			mbps: mbps,
			source: 'recording'
		}
	};
}

describe('Channel bitrate statistics', function () {
	it('calculates recording bitrate from final bytes and media duration', function () {
		const result = bitrateStats.createRecordingMeasurement(program(), 225000000, 180);

		assert.ok(result);
		assert.strictEqual(result.channelKey, 'service-1');
		assert.deepStrictEqual(result.channel, {
			id: 'service-1',
			name: 'Service 1',
			type: 'GR',
			networkId: 10,
			serviceId: 101
		});
		assert.deepStrictEqual(result.recording, {
			programId: 'program-1',
			recordedAt: 180000,
			seconds: 180,
			bytes: 225000000,
			mbps: 10,
			source: 'recording'
		});
	});

	it('keeps the newest three samples per channel and rejects duplicate recordings', function () {
		const state = bitrateStats.newState();

		assert.strictEqual(bitrateStats.addMeasurement(state, measurement('service-1', 'p1', 1, 6), 1), true);
		assert.strictEqual(bitrateStats.addMeasurement(state, measurement('service-1', 'p2', 2, 8), 2), true);
		assert.strictEqual(bitrateStats.addMeasurement(state, measurement('service-2', 'q1', 3, 20), 3), true);
		assert.strictEqual(bitrateStats.addMeasurement(state, measurement('service-1', 'p3', 3, 10), 4), true);
		assert.strictEqual(bitrateStats.addMeasurement(state, measurement('service-1', 'p4', 4, 12), 5), true);
		assert.strictEqual(bitrateStats.addMeasurement(state, measurement('service-1', 'p4', 4, 12), 6), false);

		assert.deepStrictEqual(
			state.channels['service-1'].recordings.map(item => item.programId),
			[ 'p4', 'p3', 'p2' ]
		);
		assert.strictEqual(state.channels['service-1'].sampleCount, 3);
		assert.strictEqual(state.channels['service-1'].estimatedMbps, 13.2);
		assert.deepStrictEqual(
			state.channels['service-2'].recordings.map(item => item.programId),
			[ 'q1' ]
		);
		assert.strictEqual(state.channels['service-2'].sampleCount, 1);
		assert.strictEqual(state.channels['service-2'].estimatedMbps, 26);
	});

	it('excludes aborted, failed, shortened, resumed, too-short, and clearly early recordings', function () {
		const excludedPrograms = [
			program({ _operatorNg: 'NG RECORDING' }),
			program({ _operatorAbort: true }),
			program({ operatorAbort: true }),
			program({ _operatorEndLack: true }),
			program({ operatorEndLack: true }),
			program({ operatorResumePending: true }),
			program({ operatorInterruptedAt: 1000 }),
			program({ operatorResumedAt: 1000 }),
			program({ operatorInterruptionCount: 1 }),
			program({ end: 300000 })
		];

		excludedPrograms.forEach(value => {
			assert.strictEqual(bitrateStats.createRecordingMeasurement(value, 225000000, 180), null);
		});
		assert.strictEqual(bitrateStats.createRecordingMeasurement(program(), 225000000, 59), null);
		assert.strictEqual(bitrateStats.createRecordingMeasurement(program(), 0, 180), null);
	});

	it('atomically persists valid data and fails closed without replacing corrupt or old data', function () {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-bitrate-stats-'));
		const filename = path.join(directory, 'bitrate-stats.json');
		const first = measurement('service-1', 'p1', 1, 10);
		const second = measurement('service-1', 'p2', 2, 12);

		try {
			const created = bitrateStats.tryUpdateFile(filename, first, { nowMs: 10 });
			assert.strictEqual(created.updated, true);
			assert.strictEqual(created.error, undefined);
			assert.strictEqual(JSON.parse(fs.readFileSync(filename, 'utf8')).channels['service-1'].sampleCount, 1);

			fs.writeFileSync(filename, '{broken');
			const corrupt = bitrateStats.tryUpdateFile(filename, second, { nowMs: 20 });
			assert.strictEqual(corrupt.updated, false);
			assert.ok(corrupt.error);
			assert.strictEqual(fs.readFileSync(filename, 'utf8'), '{broken');

			fs.writeFileSync(filename, JSON.stringify(created.state));
			const failingFs = Object.create(fs);
			failingFs.renameSync = function () { throw new Error('rename failed'); };
			const failedWrite = bitrateStats.tryUpdateFile(filename, second, { fs: failingFs, nowMs: 30 });
			assert.strictEqual(failedWrite.updated, false);
			assert.match(failedWrite.error.message, /rename failed/);
			assert.deepStrictEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), created.state);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
