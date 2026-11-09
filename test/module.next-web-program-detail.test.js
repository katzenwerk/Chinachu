'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const test = require('node:test');

async function checkMaintenanceState() {
	const source = fs.readFileSync(path.join(__dirname, '../next-web/components/recorded-maintenance-dialog.js'), 'utf8');
	function section(text, start, end) {
		const begin = text.indexOf(start), finish = text.indexOf(end, begin);
		assert.ok(begin >= 0 && finish > begin);
		return text.slice(begin, finish);
	}
	function dialogState() {
		const timers = new Map(), alerts = [];
		let sequence = 0, close;
		const context = vm.createContext({
			state: null, pendingInput: null, disposed: false, error: '', timer: null, failures: {}, analysisOpen: null,
			id: 'recorded-a', controller: { signal: {}, abort() {} }, STEP_LABELS: { failed: '失敗' },
			render() {}, updated: async () => {}, pending: false,
			dialog: { addEventListener(event, fn) { assert.strictEqual(event, 'close'); close = fn; }, remove() {} },
			document: { createElement: () => ({ setAttribute() {} }) },
			body: { append: message => alerts.push(message.textContent) },
			window: { clearTimeout: id => timers.delete(id), setTimeout(fn, delay) {
				assert.strictEqual(delay, 1500); timers.set(++sequence, fn); return sequence;
			} }
		});
		vm.runInContext(section(source, '  function accept(', '  async function updated(') +
			section(source, '  function planPoll(', '  async function perform(') +
			section(source, '    function progress(', '    function row(') +
			section(source, "  dialog.addEventListener('close'", '  document.body.append(dialog)'), context);
		return { context, timers, alerts, close: () => close() };
	}
	const queued = { job: { action: 'run', status: 'queued', createdAt: 1,
		tasks: { ts: { selected: true } }, stages: {}, waitReason: 'recording' } };
	const first = dialogState(), c = first.context;
	c.loadRecordedMaintenance = async () => { throw new Error('通信エラー'); };
	await c.poll(); // Initial acquisition can fail before a job state is known.
	assert.strictEqual(first.timers.size, 1);
	c.loadRecordedMaintenance = async () => queued;
	await first.timers.values().next().value();
	assert.strictEqual(c.error, '');
	assert.strictEqual(c.progress('ts'), '実行待ち（録画中）');
	c.loadRecordedMaintenance = async () => { throw new Error('通信エラー'); };
	await first.timers.values().next().value();
	assert.strictEqual(first.timers.size, 1);
	c.loadRecordedMaintenance = async () => queued;
	await first.timers.values().next().value();
	assert.strictEqual(c.error, '');
	for (const [reason, label] of [['recording-transition', '録画開始・終了付近の保護'],
		['post-processing', '先行する後処理の完了待ち'], [null, null]]) {
		c.accept({ job: { ...queued.job, waitReason: reason } });
		assert.strictEqual(c.progress('ts'), label ? `実行待ち（${label}）` : '実行待ち');
	}
	const failed = { job: { ...queued.job, status: 'failed', message: '待機期限切れ',
		stages: { ts: { state: 'failed', message: '解析失敗理由' } } } };
	const reopened = dialogState();
	reopened.context.loadRecordedMaintenance = async () => failed;
	await reopened.context.poll();
	assert.strictEqual(reopened.context.failures.ts, '解析失敗理由');
	vm.runInContext(section(source, "    if (error || state?.job?.status === 'failed'", '    if (refreshError)'), reopened.context);
	assert.deepStrictEqual(reopened.alerts, ['待機期限切れ']);
	assert.strictEqual(reopened.timers.size, 0);
	let respond;
	c.loadRecordedMaintenance = () => new Promise(resolve => { respond = resolve; });
	const inFlight = c.poll();
	first.close(); respond(queued); await inFlight;
	assert.strictEqual(first.timers.size, 0);
	assert.strictEqual(c.disposed, true);

	// Read the actual status callback and serializer without running Operator or any jobs.
	const operator = fs.readFileSync(path.join(__dirname, '../app-operator.js'), 'utf8');
	const backend = vm.createContext({ shutdownStarted: false, recording: [], activeRecordingOutputs: new Set(),
		guard: 0, postProcessingDelay: () => backend.guard,
		recordedMaintenance: { isBusy: () => false }, matchLedgerProcess: null,
		activeDurationProbes: new Set(), pendingRecordedLedgerWrites: 0,
		recordedThumbnailGenerator: { getState: () => ({ active: null }) } });
	vm.runInContext('options = { ' + section(operator, '\tdelay: ts => {', '\tprobe:') + '};', backend);
	assert.strictEqual(backend.options.waitReason(true), null);
	backend.recording.push({});
	assert.strictEqual(backend.options.delay(true), 0);
	assert.strictEqual(backend.options.waitReason(true), null);
	assert.strictEqual(backend.options.waitReason(false), null);
	backend.recording.length = 0; backend.guard = 1000;
	assert.strictEqual(backend.options.delay(false), 1000);
	assert.strictEqual(backend.options.waitReason(true), null);
	assert.strictEqual(backend.options.waitReason(false), 'recording-transition');
	backend.guard = 0; backend.matchLedgerProcess = {};
	assert.strictEqual(backend.options.waitReason(true), 'post-processing');
	Object.assign(backend, { saved: () => ({}), thumb: () => ({ getStatus: () => ({}) }), files: { roots: () => [] } });
	const maintenance = fs.readFileSync(path.join(__dirname, '../lib/recorded-maintenance.js'), 'utf8');
	vm.runInContext(section(maintenance, '  function snapshot(', '  function state('), backend);
	const target = { identity: 'fixture' };
	assert.strictEqual(backend.snapshot(target, { ...queued.job, target }).job.waitReason, 'post-processing');
	assert.strictEqual(backend.snapshot(target, { ...failed.job, target }).job.waitReason, null);

	// Automatic TS selection and five-minute recording-limit calculation use
	// ledger metadata only; no actual recording files are opened.
	const auto = require('../lib/recorded-auto-analysis');
	const now = Date.UTC(2026, 10, 7);
	const available = [
		{ id: 'older', recorded: '/recordings/older.ts', end: now - 2000 },
		{ id: 'newer', recorded: '/recordings/newer.ts', end: now - 1000 },
		{ id: 'done', recorded: '/recordings/done.ts', end: now - 3000,
			savedTsAnalysis: { result: { status: 'NO_FINDINGS', completed: true } } }
	];
	const automatic = auto.summarize(available, now);
	assert.deepStrictEqual(automatic.counts, { completed: 1, remaining: 2, failed: 0, suspect: 0 });
	assert.strictEqual(automatic.candidate.id, 'newer');
	assert.strictEqual(auto.summarize(available, now, entry => entry.id === 'newer').candidate.id, 'older');
	const active = [{ id: 'active', end: now + 120000 }];
	assert.strictEqual(auto.peakRecordings(active,
		[{ id: 'next', start: now + 120000, end: now + 240000 }], () => false, now), 1);
	assert.strictEqual(auto.peakRecordings(active,
		[{ id: 'next', start: now + 60000, end: now + 240000 }], () => false, now), 2);

	// Render saved JSON into a minimal DOM; no API requests or media access.
	const warningSource = fs.readFileSync(path.join(__dirname, '../next-web/services/recorded-result-warnings.js'), 'utf8');
	const { savedTsResultInfo } = await import('data:text/javascript;base64,' + Buffer.from(warningSource).toString('base64'));
	const summaryContext = vm.createContext({ savedTsResultInfo, document: { createElement: tag => ({
		tag, children: [], textContent: '', append(...nodes) { this.children.push(...nodes); }, setAttribute() {}
	}) } });
	vm.runInContext(section(source, 'const STEP_LABELS', 'export function openRecordedMaintenanceDialog').replaceAll('export function', 'function'), summaryContext);
	const nodes = (node, includeDetails = true) => !includeDetails && node.tag === 'details' ? [] :
		[node, ...node.children.flatMap(child => nodes(child, includeDetails))];
	const text = (node, includeDetails = true) => nodes(node, includeDetails).map(node => node.textContent).join(' ');
	assert.strictEqual(summaryContext.createSavedTsSummary(null), null);
	const normal = { result: { status: 'NO_FINDINGS', completed: true, ccErrorEvents: 0, pcrGapEvents: 0,
		teiPackets: 0, syncErrorEvents: 0, invalidHeaderPackets: 0 } };
	const normalView = summaryContext.createSavedTsSummary(normal);
	assert.match(text(normalView, false), /異常未検出.*CC異常 0件.*GAP候補 0件.*TEI 0件/);
	assert.strictEqual(nodes(normalView).filter(node => node.tag === 'table').length, 0);
	const analysis = { registeredPath: '/recordings/private.ts', result: { ...normal.result, status: 'SUSPECT', ccErrorEvents: 4,
		pcrGapEvents: 5, ccErrorsByPid: { 256: 4 }, ccSamples: [{ pid: 256, byteOffset: 0, previousCc: 0, expectedCc: 1, actualCc: 2 }],
		pcrGapSamples: [{ fromPcr: '00:02:03.400', deltaMs: 2456, rateRatio: 0.12345, lowData: true, beforeMs: 123400 }], packets: 123 } };
	const before = JSON.stringify(analysis);
	const view = summaryContext.createSavedTsSummary(analysis);
	assert.strictEqual(JSON.stringify(analysis), before);
	assert.match(text(view, false), /要確認.*全9件中、詳細2件.*0→2（期待1・差1）.*00:02:03.400.*2.46秒（低データ量疑い）/);
	assert.match(text(view), /GAP補足.*12.3%.*疑いあり/);
	assert.ok(!text(view).includes(analysis.registeredPath));
	assert.ok(!text(view, false).includes('直前CC'));
	assert.ok(nodes(view).filter(node => node.tag === 'details').every(node => !node.open));
	const ccTable = nodes(view).find(node => node.tag === 'table' && node.children[0].textContent.startsWith('CC異常の発生箇所'));
	assert.strictEqual(ccTable.children[2].children.length, 1);
	assert.match(text(ccTable), /全4件中、詳細1件.*0x0100.*0 bytes/);
	assert.match(text(view), /"packets": 123/);
	assert.match(text(view), /"beforeMs": 123400/);
	const ccOnly = summaryContext.createSavedTsSummary({ result: { ...analysis.result, pcrGapEvents: 0, pcrGapSamples: [] } });
	assert.strictEqual(nodes(ccOnly, false).filter(node => node.tag === 'table').length, 1);
	const gapsOnly = summaryContext.createSavedTsSummary({ result: { ...analysis.result, ccErrorEvents: 0, ccSamples: [], ccErrorsByPid: {} } });
	assert.strictEqual(nodes(gapsOnly, false).filter(node => node.tag === 'table').length, 1);
	const unknown = summaryContext.createSavedTsSummary({ result: { completed: false, pcrGapEvents: 2 } });
	assert.match(text(unknown, false), /CC異常 不明.*GAP候補 2件.*TEI 不明.*異常の発生位置は保存されていません。/);
	assert.strictEqual(nodes(unknown).filter(node => node.tag === 'table').length, 0);
	c.accept({ analysis }); assert.strictEqual(c.analysisOpen, true);
	c.analysisOpen = false; c.accept({ analysis }); assert.strictEqual(c.analysisOpen, false);
}

async function programDetailModel() {
	const dependencySource = fs.readFileSync(path.join(__dirname, '../next-web/services/recorded-result-warnings.js'), 'utf8');
	const dependencyUrl = 'data:text/javascript;base64,' + Buffer.from(dependencySource).toString('base64');
	const source = fs.readFileSync(path.join(__dirname, '../next-web/services/program-detail-model.js'), 'utf8')
		.replace("'./recorded-result-warnings.js'", JSON.stringify(dependencyUrl));
	return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
}

function detail(overrides = {}) {
	const start = Date.now() + 3600000;
	return {
		program: {
			id: 'program-a', title: '番組A', start, end: start + 1800000, seconds: 1800,
			channel: { id: 'GR_1', name: '放送局', type: 'GR' },
			...overrides.program
		},
		match: overrides.match || null,
		resolution: overrides.resolution || null,
		currentSource: overrides.currentSource || 'schedule',
		rules: overrides.rules || [],
		historyAmbiguous: false
	};
}

test('common programme detail maps reservation, rule and recorded actions without merging phase/file/history state', async function () {
	const { buildProgramDetailModel } = await programDetailModel();
	const future = buildProgramDetailModel(detail());
	assert.strictEqual(future.phase.key, 'program');
	assert.strictEqual(future.actions.reservation, 'reserve');
	assert.strictEqual(future.actions.rule.mode, 'create');

	const manual = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { isManualReserved: true }
	}));
	assert.strictEqual(manual.actions.reservation, 'unreserve');

	const ruled = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { ruleUid: 'stable-rule' },
		rules: [{ ruleUid: 'stable-rule' }]
	}));
	assert.strictEqual(ruled.actions.reservation, 'skip');
	assert.strictEqual(ruled.actions.rule.mode, 'edit');
	assert.strictEqual(ruled.actions.rule.ruleUid, 'stable-rule');
	assert.strictEqual(ruled.actions.rule.index, 0);
	assert.strictEqual(ruled.actions.rule.rule.ruleUid, 'stable-rule');
	assert.strictEqual(ruled.actions.rule.pending, false);
	const legacyRuled = buildProgramDetailModel(detail({ currentSource: 'reserves', program: { ruleId: 0 } }));
	assert.strictEqual(legacyRuled.actions.rule.mode, 'unavailable');

	const skipped = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { isSkip: true, ruleUid: 'stable-rule' },
		rules: [{ ruleUid: 'stable-rule' }]
	}));
	assert.strictEqual(skipped.phase.key, 'skipped');
	assert.strictEqual(skipped.actions.reservation, 'unskip');

	const skippedHistory = buildProgramDetailModel(detail({
		currentSource: null,
		program: { isSkip: false },
		match: { status: 'SKIPPED_ONLY' }
	}));
	assert.strictEqual(skippedHistory.phase.key, 'missed');
	assert.strictEqual(skippedHistory.phase.reason.key, 'skipped');

	const recorded = buildProgramDetailModel(detail({
		currentSource: 'recorded',
		program: { id: 'recorded-a', recorded: '/recordings/a.m2ts' },
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' } },
		resolution: { source: 'recorded' }
	}));
	assert.strictEqual(recorded.phase.key, 'recorded');
	assert.strictEqual(recorded.fileState.key, 'unknown');
	assert.strictEqual(recorded.matchStatus, 'RECORDED');
	assert.strictEqual(recorded.media.playable, true);
	assert.strictEqual(recorded.actions.deleteRecording.recordedId, 'recorded-a');

	const lowStorageAbort = buildProgramDetailModel(detail({
		currentSource: 'recorded',
		program: {
			id: 'recorded-a', recorded: '/recordings/a.m2ts',
			operatorAbort: true, operatorAbortReason: 'LOW STORAGE'
		},
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' } },
		resolution: { source: 'recorded' }
	}));
	assert.strictEqual(lowStorageAbort.phase.key, 'aborted');
	assert.strictEqual(lowStorageAbort.phase.reason.key, 'storage-low');
	assert.strictEqual(lowStorageAbort.media.playable, true);
	assert.strictEqual(lowStorageAbort.actions.deleteRecording.recordedId, 'recorded-a');

	const deleted = buildProgramDetailModel(detail({
		currentSource: null,
		program: { id: 'recorded-a', recorded: '/recordings/a.m2ts' },
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' }, deletion: { reason: 'manual' } },
		resolution: { source: 'reserves2' }
	}));
	assert.strictEqual(deleted.phase.key, 'deleted');
	assert.strictEqual(deleted.phase.reason.key, 'manual-delete');
	assert.strictEqual(deleted.fileState.key, 'deleted');
	assert.strictEqual(deleted.matchStatus, 'RECORDED');
	assert.strictEqual(deleted.media.playable, false);
	assert.strictEqual(deleted.media.thumbnailUrl, '/api/recorded/recorded-a/thumbnail.jpg');
	assert.strictEqual(deleted.actions.deleteRecording, null);
	assert.strictEqual(deleted.actions.recordedMaintenance, null);
	const lostDetail = detail({ program: { id: 'recorded-a', recorded: '/recordings/a.m2ts' },
		match: { status: 'RECORDED', recording: { recordedId: 'recorded-a', path: '/recordings/a.m2ts' },
			deletion: { reason: 'recorded-missing' }, fileMissing: { recordedId: 'recorded-a', path: '/recordings/a.m2ts', checkedAt: Date.now() } },
		currentSource: 'recorded' });
	const lost = buildProgramDetailModel(lostDetail);
	assert.strictEqual(lost.phase.key, 'file-missing');
	assert.strictEqual(lost.media.playable, false);
	assert.strictEqual(lost.media.downloadUrl, null);
	assert.strictEqual(lost.media.canCreateThumbnail, false);
	assert.strictEqual(lost.fileState.key, 'file-missing');
	assert.ok(lost.recordingWarnings.some(warning => warning.key === 'file-missing'));
	assert.ok(lost.recordingWarnings.some(warning => warning.key === 'recorded-unknown'));


	const start = Date.now() + 60000;
	const liveDetail = detail({ program: { start, end: start + 60000 } });
	assert.strictEqual(buildProgramDetailModel(liveDetail, start - 1).media.liveModel, null);
	assert.strictEqual(buildProgramDetailModel(liveDetail, start).media.liveModel.liveChannel.id, 'GR_1');
	assert.strictEqual(buildProgramDetailModel(liveDetail, start + 30000).media.liveModel.liveChannel.id, 'GR_1');
	assert.strictEqual(buildProgramDetailModel(liveDetail, start + 60000).media.liveModel, null);
	const liveReserved = buildProgramDetailModel(detail({
		currentSource: 'reserves',
		program: { start, end: start + 60000, isManualReserved: true }
	}), start + 1);
	assert.strictEqual(liveReserved.media.liveModel.liveChannel.id, 'GR_1');
	const liveRecording = buildProgramDetailModel(detail({
		currentSource: 'recording',
		program: { start, end: start + 60000, recorded: '/recordings/live.m2ts', pid: 1 }
	}), start + 1);
	assert.strictEqual(liveRecording.media.liveModel.liveChannel.id, 'GR_1');

	const pendingRule = buildProgramDetailModel({ ...detail(), preferredRuleUid: 'created-rule', rules: [{ ruleUid: 'created-rule' }] });
	assert.strictEqual(pendingRule.phase.key, 'program');
	assert.strictEqual(pendingRule.actions.rule.mode, 'edit');
	assert.strictEqual(pendingRule.actions.rule.pending, true);
	await checkMaintenanceState();
});
