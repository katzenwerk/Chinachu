'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const resolver = require('../lib/match-detail-resolver');

const start = Date.UTC(2026, 9, 12, 0, 0, 0);
const seconds = 1800;
const key = `channel-a|${start}|${seconds}`;

function program(overrides = {}) {
	return {
		id: 'program-a',
		programId: 'program-a',
		start,
		end: start + seconds * 1000,
		seconds,
		title: 'Source title',
		fullTitle: 'Source full title',
		detail: 'Source detail',
		channel: { id: 'channel-a', name: 'Channel A', type: 'GR' },
		...overrides
	};
}

function v2(overrides = {}) {
	return {
		schemaVersion: 2,
		key,
		status: 'RECORDED',
		start,
		end: start + seconds * 1000,
		fullTitle: 'Match title',
		ruleUid: null,
		recording: { recordedId: 'recorded-a', path: '/fixture/recorded-a.ts' },
		deletion: null,
		...overrides
	};
}

describe('Match detail resolver', function() {
	it('uses one external source according to status priority without mixing fields', function() {
		const recorded = program({ id: 'recorded-a', fullTitle: 'Recorded title', detail: 'Recorded detail' });
		const reserve = program({ fullTitle: 'Reserve title', detail: 'Reserve detail' });
		const result = resolver.resolveMatchDetail(v2(), { recorded: [recorded], reserves2: [reserve] });

		assert.strictEqual(result.resolution.source, 'recorded');
		assert.strictEqual(result.resolution.matchedBy, 'recordedId');
		assert.strictEqual(result.program.fullTitle, 'Recorded title');
		assert.strictEqual(result.program.detail, 'Recorded detail');
		assert.strictEqual(result.match.status, 'RECORDED');
	});

	it('falls through recorded, reserves2, and schedule without changing match status', function() {
		const missed = v2({ status: 'MISSED', recording: null });
		const fromReserve = resolver.resolveMatchDetail(missed, {
			reserves2: [program({ fullTitle: 'Reserve history' })]
		});
		assert.strictEqual(fromReserve.resolution.source, 'reserves2');
		assert.strictEqual(fromReserve.program.fullTitle, 'Reserve history');

		const fromSchedule = resolver.resolveMatchDetail(missed, {
			schedule: [{ id: 'channel-a', name: 'Channel A', type: 'GR', programs: [
				program({ channel: undefined, fullTitle: 'Schedule title' })
			] }]
		});
		assert.strictEqual(fromSchedule.resolution.source, 'schedule');
		assert.strictEqual(fromSchedule.program.fullTitle, 'Schedule title');
		assert.strictEqual(fromSchedule.match.status, 'MISSED');
	});

	it('returns minimal match detail when every external source is unavailable', function() {
		const result = resolver.resolveMatchDetail(v2({ status: 'RECORDED_UNTRACKED' }), {});

		assert.strictEqual(result.resolution.source, 'match');
		assert.strictEqual(result.resolution.matchedBy, 'minimal-match');
		assert.deepStrictEqual(result.program.channel, { id: 'channel-a' });
		assert.strictEqual(result.program.fullTitle, 'Match title');
		assert.strictEqual(result.program.recorded, undefined);
	});

	it('rejects a conflicting recorded ID even when another recording has the same canonical key', function() {
		const wrongById = program({ id: 'recorded-a', start: start + 60000, end: start + 1860000 });
		const correctByKey = program({ id: 'recorded-b', fullTitle: 'Correct key' });
		const result = resolver.resolveMatchDetail(v2(), { recorded: [wrongById, correctByKey] });

		assert.strictEqual(result.resolution.source, 'match');
		assert.strictEqual(result.resolution.matchedBy, 'minimal-match');
		assert.strictEqual(result.resolution.idConflict, true);
		assert.strictEqual(result.program.recorded, undefined);

		const missing = v2({
			recording: null,
			fileMissing: { recordedId: 'recorded-a', checkedAt: start + 1 }
		});
		const differentRecorded = program({
			id: 'recorded-b', recorded: '/fixture/recorded-b.ts',
			ruleUid: 'other-rule', savedTsAnalysis: { result: { status: 'OK' } }
		});
		const detailResolver = resolver.createDetailResolver({ recorded: [differentRecorded] });
		const missingDetail = detailResolver.resolve(missing);
		assert.strictEqual(missingDetail.resolution.source, 'match');
		assert.strictEqual(missingDetail.resolution.idConflict, true);
		assert.strictEqual(detailResolver.resolveRuleUid(missing), '');
		const page = resolver.buildPage([missing], detailResolver, { now: start + 36000000, results: 'missing' });
		assert.strictEqual(page.items[0].recordedId, 'recorded-a');
		assert.strictEqual(page.items[0].recordingPath, null);
		assert.strictEqual(page.items[0].savedTsAnalysis, null);
	});

	it('normalizes legacy and v2 entries and preserves explicit deletion separately from status', function() {
		const legacy = {
			key,
			status: 'RECORDED',
			program: program({ fullTitle: 'Legacy title' }),
			recordingResult: {
				id: 'legacy-recorded',
				path: '/fixture/legacy.ts',
				cleanupState: 'deleted',
				deletedAt: start + 86400000,
				cleanupReason: 'manual',
				snapshot: program({ id: 'legacy-recorded', recorded: '/fixture/legacy.ts' })
			}
		};
		const normalizedLegacy = resolver.normalizeMatchEntry(legacy);
		const normalizedV2 = resolver.normalizeMatchEntry(v2());

		assert.strictEqual(normalizedLegacy.schemaVersion, 2);
		assert.strictEqual(normalizedLegacy.status, 'RECORDED');
		assert.deepStrictEqual(normalizedLegacy.recording, { recordedId: 'legacy-recorded' });
		assert.deepStrictEqual(normalizedLegacy.deletion, {
			deletedAt: start + 86400000, reason: 'manual'
		});
		assert.deepStrictEqual(normalizedV2, v2({ recording: { recordedId: 'recorded-a' } }));
		assert.strictEqual(resolver.normalizeMatchEntry({
			key,
			status: 'MISSED',
			program: program()
		}).recording, null);

		const deleted = resolver.resolveMatchDetail(legacy, {
			recorded: [program({ id: 'legacy-recorded', fullTitle: 'Must not be selected' })],
			reserves2: [program({ fullTitle: 'Deleted reserve title' })]
		});
		assert.strictEqual(deleted.match.status, 'RECORDED');
		assert.strictEqual(deleted.resolution.source, 'reserves2');
		assert.strictEqual(deleted.program.fullTitle, 'Deleted reserve title');
		const legacyOnly = resolver.resolveMatchDetail(legacy, {});
		assert.strictEqual(legacyOnly.resolution.source, 'match');
		assert.strictEqual(legacyOnly.program.recorded, undefined);

		const resultDetail = resolver.resolveMatchDetail({
			key,
			status: 'RECORDED',
			recordingResult: {
				id: 'legacy-recorded', detail: 'Result detail',
				snapshot: {
					id: 'legacy-recorded', recorded: '/fixture/snapshot.ts',
					savedTsAnalysis: { registeredPath: '/fixture/snapshot.ts', file: { path: '/fixture/fingerprint.ts' } }
				}
			},
			savedTsAnalysis: { registeredPath: '/fixture/result.ts', file: { path: '/fixture/fingerprint.ts' } }
		}, {});
		assert.strictEqual(resultDetail.resolution.source, 'match');
		assert.strictEqual(resultDetail.program.snapshot.recorded, undefined);
		assert.strictEqual(resultDetail.program.snapshot.savedTsAnalysis.registeredPath, undefined);
		assert.strictEqual(resultDetail.program.snapshot.savedTsAnalysis.file.path, '/fixture/fingerprint.ts');
		assert.strictEqual(resultDetail.program.savedTsAnalysis.registeredPath, undefined);
		assert.strictEqual(resultDetail.program.savedTsAnalysis.file.path, '/fixture/fingerprint.ts');
	});

	it('does not join another programme when neither canonical key nor a unique safe ID matches', function() {
		const other = program({
			id: 'other', programId: 'other', channel: { id: 'channel-b', name: 'Channel B' }
		});
		const result = resolver.resolveMatchDetail(v2({
			status: 'MISSED', recording: null
		}), { reserves2: [other], reserves: [other], schedule: [other] });

		assert.strictEqual(result.resolution.source, 'match');
		assert.strictEqual(result.resolution.matchedBy, 'minimal-match');
		assert.strictEqual(result.program.fullTitle, 'Match title');

		const ambiguous = resolver.resolveMatchDetail({
			schemaVersion: 2,
			key: 'invalid-key',
			status: 'RECORDED',
			start,
			end: start + seconds * 1000,
			fullTitle: 'Ambiguous match',
			recording: { recordedId: 'shared-id', path: '/fixture/shared.ts' },
			deletion: null
		}, { recorded: [
			program({ id: 'shared-id', updatedAt: start + 1 }),
			program({ id: 'shared-id', updatedAt: start + 2 })
		] });
		assert.strictEqual(ambiguous.resolution.matchedBy, 'minimal-match');
	});

	it('parses canonical keys from the right and rejects malformed keys', function() {
		assert.deepStrictEqual(resolver.parseCanonicalKey(`channel|with|pipe|${start}|${seconds}`), {
			key: `channel|with|pipe|${start}|${seconds}`,
			channelId: 'channel|with|pipe', start, seconds, end: start + seconds * 1000
		});
		assert.strictEqual(resolver.parseCanonicalKey('channel-a|bad|1800'), null);
	});

	it('exposes the resolver through the opt-in match item API without changing the default item shape', function() {
		const item = v2();
		const recorded = program({ id: 'recorded-a', fullTitle: 'API recorded title' });
		const script = fs.readFileSync(path.resolve(__dirname, '../api/script-match.vm.js'), 'utf8');
		let statusCode = null;
		let body = null;
		const response = {
			head(code) { statusCode = code; },
			end(value) { body = value; },
			error(code) { throw new Error(`unexpected API error ${code}`); }
		};
		const context = {
			request: { query: { mode: 'item', key, resolve: '1' } },
			response,
			fs: {
				existsSync() { return true; },
				readFileSync(file) {
					return file === '/fixture/reserves2.json' ? '[]' : JSON.stringify([item]);
				}
			},
			define: { RESERVES2_DATA_FILE: '/fixture/reserves2.json' },
			data: { recorded: [recorded], reserves: [], schedule: [] },
			matchCache: { getItems() { return [item]; } },
			matchDetailResolver: resolver,
			Date,
			JSON,
			String,
			Number,
			isFinite,
			decodeURIComponent
		};

		vm.runInNewContext(script, context, { filename: 'api/script-match.vm.js' });
		const output = JSON.parse(body);
		assert.strictEqual(statusCode, 200);
		assert.strictEqual(output.resolution.source, 'recorded');
		assert.strictEqual(output.program.fullTitle, 'API recorded title');
		assert.strictEqual(output.match.status, 'RECORDED');

		statusCode = null;
		body = null;
		context.request.query = { mode: 'item', key };
		vm.runInNewContext(script, context, { filename: 'api/script-match.vm.js' });
		assert.strictEqual(statusCode, 200);
		assert.deepStrictEqual(JSON.parse(body), item);
	});

	it('builds compatible list DTOs from legacy and v2 entries without dropping minimal history', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const legacy = {
			key,
			status: 'RECORDED',
			program: program({ id: 'legacy-program', title: 'Legacy title' }),
			recordingResult: { id: 'legacy-recorded', recorded: '/fixture/legacy.ts' }
		};
		const missedKey = `channel-b|${start + 3600000}|${seconds}`;
		const missed = v2({
			key: missedKey,
			status: 'MISSED',
			start: start + 3600000,
			end: start + 5400000,
			fullTitle: 'Minimal missed',
			recording: null
		});
		const deleted = v2({ deletion: { deletedAt: now - 1000, reason: 'manual' } });
		const detailResolver = resolver.createDetailResolver({
			recorded: [program({ id: 'legacy-recorded', operatorActualSeconds: 1790 })],
			schedule: [program({
				id: 'schedule-missed',
				start: start + 3600000,
				end: start + 5400000,
				channel: { id: 'channel-b', name: 'Channel B', type: 'GR' },
				fullTitle: 'Schedule missed'
			})]
		});
		const list = resolver.buildList([legacy, missed, deleted], detailResolver, { now });

		assert.strictEqual(list.length, 3);
		assert.deepStrictEqual(list.map(item => item._matchKind), ['RECORDED', 'NG', 'DELETED']);
		assert.strictEqual(list[0].title, 'Legacy title');
		assert.strictEqual(list[0].operatorActualSeconds, 1790);
		assert.strictEqual(list[1].fullTitle, 'Schedule missed');
		assert.strictEqual(list[2]._recordedId, 'recorded-a');
		for (const item of list) {
			assert.strictEqual(item._listSlim, true);
			assert.ok(item._matchItem && typeof item._matchItem.key === 'string');
			assert.ok(item.channel && typeof item.channel.id === 'string');
			assert.ok(Object.hasOwn(item, 'flags'));
		}
	});

	it('counts summary status from match while resolving only recent display details', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const entries = [
			v2(),
			v2({ status: 'RECORDED', deletion: { deletedAt: now, reason: 'manual' } }),
			v2({ status: 'MISSED', recording: null }),
			v2({ status: 'SKIPPED_ONLY', recording: null }),
			v2({ status: 'RECORDED_UNTRACKED' })
		];
		const summary = resolver.buildSummary(entries, resolver.createDetailResolver({}), { now, limit: 2 });

		assert.deepStrictEqual(summary.counts, { recorded: 2, ng: 1 });
		assert.strictEqual(summary.items.length, 2);
		assert.strictEqual(summary.hasMore, true);
		assert.ok(summary.items.every(item => item.program.fullTitle === 'Match title'));
	});

	it('builds the new WUI page DTO without conflating status, abort, or deletion states', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const recorded = program({
			id: 'recorded-a',
			ruleUid: 'rule-recorded',
			recorded: '/fixture/current-recorded-a.ts',
			channel: { id: 'channel-a', name: 'Channel A', type: 'GR', hasLogoData: true },
			isManualReserved: true,
			operatorActualSeconds: 1700,
			operatorAbort: true,
			operatorAbortAt: start + 1700 * 1000,
			operatorAbortReason: 'manual-stop',
			mirakurunDrop: { dropTotal: 12, packetTotal: 10000, tunerName: 'Fixture tuner' }
		});
		const missed = v2({
			key: `channel-b|${start + 3600000}|${seconds}`,
			status: 'MISSED',
			start: start + 3600000,
			end: start + 5400000,
			fullTitle: 'Ｍｉｓｓｅｄ　Ｔｉｔｌｅ',
			recording: null
		});
		const skipped = v2({ status: 'SKIPPED_ONLY', recording: null });
		const untracked = v2({
			key: `channel-d|${start + 10800000}|${seconds}`,
			status: 'RECORDED_UNTRACKED',
			start: start + 10800000,
			end: start + 12600000
		});
		const deleted = v2({
			key: `channel-e|${start + 14400000}|${seconds}`,
			start: start + 14400000,
			end: start + 16200000,
			recording: { recordedId: 'deleted-a', path: '/fixture/deleted-a.ts' },
			deletion: { deletedAt: now - 1000, reason: 'manual' }
		});
		const missing = v2({
			key: `channel-c|${start + 7200000}|${seconds}`,
			start: start + 7200000,
			end: start + 9000000,
			deletion: { deletedAt: null, reason: 'recorded-missing' }
		});
		const lost = { ...missing, fileMissing: { recordedId: missing.recording.recordedId, path: '/legacy/missing.ts', checkedAt: now } };
		const lostPage = resolver.buildPage([lost], resolver.createDetailResolver({}), { now, results: 'missing' });
		assert.equal(lostPage.counts.missing, 1);
		assert.equal(lostPage.counts.deleted, 0);
		assert.equal(lostPage.items[0].deletion.reason, 'recorded-missing');
		assert.equal(lostPage.items[0].deletionKind, 'file-missing');
		assert.deepStrictEqual(lostPage.items[0].fileMissing, { recordedId: lost.fileMissing.recordedId, checkedAt: now });
		const reserved = v2({ status: 'RESERVED', start: now + 1000, end: now + 1801000, recording: null });
		const detailResolver = resolver.createDetailResolver({
			recorded: [recorded],
			reserves2: [program({
				start: start + 3600000,
				end: start + 5400000,
				channel: { id: 'channel-b', name: 'Ｔｅｓｔ　Ｃｈａｎｎｅｌ', type: 'GR' },
				fullTitle: 'Ｍｉｓｓｅｄ　Ｔｉｔｌｅ',
				ruleUid: 'rule-a',
				ruleId: 0,
				ruleIdSource: 'index'
			})]
		});
		const result = resolver.buildPage(
			[v2(), missed, skipped, deleted, missing, untracked, reserved],
			detailResolver,
			{ now, page: 1, limit: 50 }
		);

		assert.strictEqual(result.total, 6);
		assert.deepStrictEqual(result.counts, { recorded: 3, deleted: 1, missing: 0, missed: 1, skipped: 1 });
		assert.strictEqual(result.page, 1);
		assert.strictEqual(result.pageSize, 50);
		assert.strictEqual(result.totalPages, 1);
		assert.strictEqual(result.filterVersion, 3);
		assert.ok(result.items.every(item => item.status !== 'RESERVED'));
		const recordedItem = result.items.find(item => item.key === key && item.deletionKind === 'none');
		assert.strictEqual(recordedItem.status, 'RECORDED');
		assert.strictEqual(recordedItem.reservationType, 'manual');
		assert.strictEqual(recordedItem.operatorAbort, true);
		assert.strictEqual(recordedItem.operatorActualSeconds, 1700);
		assert.strictEqual(recordedItem.mirakurunDrop.dropTotal, 12);
		assert.strictEqual(recordedItem.channel.hasLogoData, true);
		assert.strictEqual(recordedItem.recordingPath, '/fixture/current-recorded-a.ts');
		const missedItem = result.items.find(item => item.status === 'MISSED');
		assert.strictEqual(missedItem.reservationType, 'rule');
		assert.strictEqual(missedItem.operatorAbort, null);
		assert.strictEqual(missedItem.mirakurunDrop, null);
		assert.strictEqual(result.items.find(item => item.status === 'SKIPPED_ONLY').operatorAbort, null);
		assert.strictEqual(result.items.find(item => item.status === 'RECORDED_UNTRACKED').reservationType, 'unknown');
		const deletedItem = result.items.find(item => item.deletion && item.deletion.reason === 'manual');
		assert.strictEqual(deletedItem.status, 'RECORDED');
		assert.strictEqual(deletedItem.deletionKind, 'explicit');
		assert.strictEqual(deletedItem.recordingPath, null); // match-only history cannot determine a file path.
		assert.strictEqual(result.items.find(item => item.status === 'MISSED').recordingPath, null);
		assert.strictEqual(result.items.find(item => item.status === 'SKIPPED_ONLY').recordingPath, null);
		assert.strictEqual(result.items.find(item => item.deletion && item.deletion.reason === 'recorded-missing').deletionKind, 'missing');
		const byRuleUid = resolver.buildPage(
			[v2(), missed, skipped, deleted, missing, untracked, reserved],
			detailResolver,
			{ now, page: 1, limit: 50, ruleUid: 'rule-recorded' }
		);
		assert.strictEqual(byRuleUid.total, 1);
		assert.strictEqual(byRuleUid.items[0].ruleUid, 'rule-recorded');
	});

	it('filters by ledger ruleUid before resolving details and resolves only the requested page', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const entries = [
			v2({ ruleUid: 'rule-a' }),
			v2({ key: `channel-b|${start + 3600000}|${seconds}`, start: start + 3600000,
				end: start + 5400000, ruleUid: 'rule-a' }),
			v2({ key: `channel-c|${start + 7200000}|${seconds}`, start: start + 7200000,
				end: start + 9000000, ruleUid: 'rule-b' })
		];
		let resolved = 0;
		let ruleResolved = 0;
		const detailResolver = {
			resolve(entry) { resolved++; return resolver.resolveMatchDetail(entry, {}); },
			resolveRuleUid() { ruleResolved++; return null; }
		};
		const result = resolver.buildPage(entries, detailResolver, {
			now, page: 1, limit: 1, ruleUid: 'rule-a'
		});

		assert.strictEqual(result.total, 2);
		assert.strictEqual(result.items.length, 1);
		assert.strictEqual(result.appliedRuleUid, 'rule-a');
		assert.strictEqual(resolved, 1);
		assert.strictEqual(ruleResolved, 0);
	});

	it('filters, normalizes, sorts, and pages match results deterministically', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const entries = [
			v2({ key: `channel-z|${start + 3600000}|${seconds}`, start: start + 3600000, end: start + 5400000, fullTitle: 'Other', recording: null }),
			v2({ key: `channel-b|${start}|${seconds}`, status: 'MISSED', fullTitle: 'Ｆｏｏ　番組', recording: null }),
			v2({ key: `channel-a|${start}|${seconds}`, status: 'MISSED', fullTitle: 'foo 番組', recording: null })
		];
		const detailResolver = resolver.createDetailResolver({});
		const filtered = resolver.buildPage(entries, detailResolver, {
			now, page: '1', limit: '1', search: 'foo 番組', status: 'missed'
		});

		assert.strictEqual(filtered.total, 2);
		assert.strictEqual(filtered.pageSize, 1);
		assert.strictEqual(filtered.totalPages, 2);
		assert.strictEqual(filtered.items[0].key, `channel-a|${start}|${seconds}`);
		const second = resolver.buildPage(entries, detailResolver, {
			now, page: 2, limit: 1, search: 'ＦＯＯ　番組', status: 'MISSED'
		});
		assert.strictEqual(second.items[0].key, `channel-b|${start}|${seconds}`);
		const sanitized = resolver.buildPage(entries, detailResolver, { now, page: 'bad', limit: 1000 });
		assert.strictEqual(sanitized.page, 1);
		assert.strictEqual(sanitized.pageSize, 200);
		const classified = resolver.buildPage([
			v2(),
			v2({ key: `channel-d|${start + 7200000}|${seconds}`, start: start + 7200000, end: start + 9000000,
				deletion: { deletedAt: now - 1000, reason: 'manual' } }),
			v2({ key: `channel-m|${start + 10800000}|${seconds}`, start: start + 10800000, end: start + 12600000,
				deletion: { deletedAt: null, reason: 'recorded-missing' } }),
			v2({ status: 'MISSED', recording: null }),
			v2({ status: 'SKIPPED_ONLY', recording: null })
		], detailResolver, { now, results: 'recorded,deleted' });
		assert.strictEqual(classified.total, 3);
		assert.deepStrictEqual(classified.counts, { recorded: 2, deleted: 1, missing: 0, missed: 0, skipped: 0 });
		assert.strictEqual(classified.items.filter(item => item.deletionKind === 'explicit').length, 1);
		assert.strictEqual(classified.items.filter(item => item.deletionKind === 'missing').length, 1);
		assert.strictEqual(resolver.buildPage(entries, detailResolver, { now, results: '' }).total, 0);
		assert.throws(() => resolver.buildPage(entries, detailResolver, { now, status: 'not-a-status' }), RangeError);
		assert.throws(() => resolver.buildPage(entries, detailResolver, { now, results: 'recorded,invalid' }), RangeError);
	});

	it('aggregates rule recording counts once without counting failures or duplicate history', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const secondStart = start + 3600000;
		const thirdStart = start + 7200000;
		const fourthStart = start + 10800000;
		const secondKey = `channel-b|${secondStart}|${seconds}`;
		const thirdKey = `channel-c|${thirdStart}|${seconds}`;
		const fourthKey = `channel-d|${fourthStart}|${seconds}`;
		const recordedA = program({ id: 'recorded-a', ruleUid: 'rule-a' });
		const deletedA = program({
			ruleUid: 'rule-a', start: secondStart, end: secondStart + seconds * 1000,
			channel: { id: 'channel-b', name: 'Channel B', type: 'GR' }
		});
		const recordedB = program({
			id: 'recorded-b', ruleUid: 'rule-b', start: thirdStart, end: thirdStart + seconds * 1000,
			channel: { id: 'channel-c', name: 'Channel C', type: 'GR' }
		});
		const detailResolver = resolver.createDetailResolver({
			recorded: [recordedA, recordedB],
			reserves2: [deletedA]
		});
		const entries = [
			v2(),
			v2(),
			v2({
				key: secondKey, start: secondStart, end: secondStart + seconds * 1000,
				recording: { recordedId: 'deleted-a', path: '/fixture/deleted-a.ts' },
				deletion: { deletedAt: now - 1000, reason: 'manual' }
			}),
			v2({
				key: thirdKey, start: thirdStart, end: thirdStart + seconds * 1000,
				recording: { recordedId: 'recorded-b', path: '/fixture/recorded-b.ts' }
			}),
			v2({
				key: fourthKey, start: fourthStart, end: fourthStart + seconds * 1000,
				recording: { recordedId: 'recorded-without-rule', path: '/fixture/no-rule.ts' }
			}),
			v2({ status: 'MISSED', recording: null }),
			v2({ status: 'SKIPPED_ONLY', recording: null })
		];
		const result = resolver.buildRuleRecordingCounts(entries, detailResolver, { now });

		assert.deepStrictEqual(result, {
			counts: { 'rule-a': 2, 'rule-b': 1 },
			counted: 3,
			withoutRuleUid: 1,
			total: 4
		});
	});

	it('serves mode=page while keeping legacy match API modes unchanged', function() {
		const now = start + 10 * 60 * 60 * 1000;
		const entries = [v2(), v2({ status: 'MISSED', recording: null }), v2({ status: 'RESERVED', recording: null })];
		const script = fs.readFileSync(path.resolve(__dirname, '../api/script-match.vm.js'), 'utf8');

		function invoke(query, sourceItems = entries) {
			let body = null;
			let code = null;
			vm.runInNewContext(script, {
				request: { query },
				response: {
					head(value) { code = value; },
					end(value) { body = value; },
					error(value) { code = value; }
				},
				fs: { existsSync() { return true; }, readFileSync() { return '[]'; } },
				define: { RESERVES2_DATA_FILE: '/fixture/reserves2.json' },
				data: { recorded: [], reserves: [], schedule: [] },
				matchCache: { getItems() { return sourceItems; } },
				matchDetailResolver: resolver,
				Date: { now() { return now; } },
				JSON,
				String,
				Number,
				Array,
				Math,
				isNaN,
				parseInt,
				decodeURIComponent
			}, { filename: 'api/script-match.vm.js' });
			return { code, body: body === null ? null : JSON.parse(body) };
		}

		const page = invoke({ mode: 'page', page: '1', limit: '1', status: 'RECORDED' });
		assert.strictEqual(page.code, 200);
		assert.strictEqual(page.body.total, 1);
		assert.deepStrictEqual(page.body.counts, { recorded: 1, deleted: 0, missing: 0, missed: 0, skipped: 0 });
		assert.strictEqual(page.body.items[0].status, 'RECORDED');
		assert.strictEqual(invoke({ mode: 'page', results: 'missed,skipped' }).body.total, 1);
		assert.strictEqual(invoke({ mode: 'page', ruleUid: 'unknown-rule' }).body.total, 0);
		assert.strictEqual(invoke({ mode: 'page', status: 'invalid' }).code, 400);
		assert.strictEqual(invoke({ mode: 'page', results: 'invalid' }).code, 400);
		assert.deepStrictEqual(invoke({ mode: 'rule-recording-counts' }).body, {
			counts: {}, counted: 0, withoutRuleUid: 1, total: 1
		});
		assert.deepStrictEqual(invoke({ mode: 'result-counts' }).body.counts, {
			recorded: 1, deleted: 0, missing: 0, missed: 1, skipped: 0
		});
		const item = invoke({ mode: 'item', id: 'recorded-a', resolve: '1', strict: '1' });
		assert.strictEqual(item.code, 200);
		assert.strictEqual(item.body.match.key, key);
		const duplicate = v2({
			key: `channel-z|${start + 3600000}|${seconds}`,
			start: start + 3600000,
			end: start + 5400000
		});
		const ambiguous = invoke(
			{ mode: 'item', id: 'recorded-a', resolve: '1', strict: '1' },
			[v2(), duplicate]
		);
		assert.strictEqual(ambiguous.code, 409);
		assert.strictEqual(ambiguous.body.code, 'ambiguous-history');
		assert.ok(Array.isArray(invoke({ mode: 'list' }).body));
		assert.ok(Object.hasOwn(invoke({ mode: 'summary' }).body, 'counts'));
	});

	it('does not turn match-only metadata into a recorded API file target', function() {
		const match = v2();
		const fromReserve = program({ id: 'reserve-a', fullTitle: 'Reserve metadata', recorded: undefined });
		const fallback = resolver.resolveRecordedProgram('recorded-a', [match], {
			recorded: [],
			reserves2: [fromReserve]
		});

		assert.strictEqual(fallback.source, null);
		assert.strictEqual(fallback.program, null);
		assert.strictEqual(fallback.resolution.error, 'recorded-not-found');

		const wrongRecorded = program({ id: 'recorded-a', start: start + 60000, end: start + 1860000 });
		const conflicted = resolver.resolveRecordedProgram('recorded-a', [match], { recorded: [wrongRecorded] });
		assert.strictEqual(conflicted.source, 'recorded');
		assert.strictEqual(conflicted.program.start, start + 60000);
	});

	it('does not select an ambiguous match entry for a recorded API fallback', function() {
		const duplicate = v2({
			key: `channel-b|${start + 60000}|${seconds}`,
			start: start + 60000,
			end: start + 60000 + seconds * 1000,
			fullTitle: 'Different programme with the same recorded ID'
		});
		const result = resolver.resolveRecordedProgram('recorded-a', [v2(), duplicate], {});

		assert.strictEqual(result.program, null);
		assert.strictEqual(result.source, null);
		assert.strictEqual(result.resolution.error, 'ambiguous-match-id');
	});

	it('prefers an exact recorded ID and rejects a duplicated legacy alias', function() {
		const exact = program({ id: 'recorded-exact', origId: 'shared-id', fullTitle: 'Exact' });
		const other = program({ id: 'recorded-other', origId: 'shared-id', fullTitle: 'Other' });
		assert.strictEqual(
			resolver.resolveRecordedProgram('recorded-exact', [], { recorded: [other, exact] }).program.fullTitle,
			'Exact'
		);
		const ambiguous = resolver.resolveRecordedProgram('shared-id', [], { recorded: [other, exact] });
		assert.strictEqual(ambiguous.program, null);
		assert.strictEqual(ambiguous.resolution.error, 'ambiguous-recorded-id');
	});

	it('rejects match-only preview history before probing its former recording path', function() {
		const script = fs.readFileSync(path.resolve(__dirname, '../api/script-recorded-program-preview.vm.js'), 'utf8');
		let errorCode = null;
		const matchFile = '/fixture/match.json';
		const reserves2File = '/fixture/reserves2.json';
		const context = {
			request: { param: { id: 'recorded-a' }, query: {} },
			response: {
				error(code) { errorCode = code; },
				head() { throw new Error('preview must not start without the current file'); },
				end() {}
			},
			fs: {
				existsSync(filename) {
					assert.ok(filename === matchFile || filename === reserves2File, 'must not probe a match recording path');
					return true;
				},
				readFileSync(filename) {
					if (filename === matchFile) return JSON.stringify([v2()]);
					if (filename === reserves2File) return JSON.stringify([program({ id: 'reserve-a' })]);
					throw new Error(`unexpected read ${filename}`);
				}
			},
			define: { MATCH_DATA_FILE: matchFile, RESERVES2_DATA_FILE: reserves2File },
			data: { recorded: [], reserves: [], schedule: [], status: { feature: { previewer: true } } },
			matchDetailResolver: resolver,
			child_process: {},
			JSON,
			String,
			Number,
			Array,
			Object,
			parseInt
		};

		vm.runInNewContext(script, context, { filename: 'api/script-recorded-program-preview.vm.js' });
		assert.strictEqual(errorCode, 404);
	});
});
