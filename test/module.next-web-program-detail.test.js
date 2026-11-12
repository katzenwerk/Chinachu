'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const test = require('node:test');

async function checkContextMenus() {
	// Minimal DOM for the existing menus: no browser, server, timers or real actions.
	class Element {
		constructor(tag, document) { this.tag = tag; this.document = document; this.children = []; this.style = {}; this.dataset = {}; this.listeners = new Map(); this.hidden = false; this.disabled = false; this.attributes = {}; }
		setAttribute(key, value) { this.attributes[key] = value; }
		set innerHTML(html) {
			this.children = [];
			for (const match of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>|<(?:div|hr)([^>]*role="separator"[^>]*)>/g)) {
				const attrs = match[1] ?? match[3], child = new Element(match[1] === undefined ? 'separator' : 'button', this.document);
				child.hidden = /\bhidden\b/.test(attrs); child.disabled = /\bdisabled\b/.test(attrs);
				child.dataset.action = /data-action="([^"]+)"/.exec(attrs)?.[1];
				child.textContent = (match[2] || '').replace(/<[^>]+>/g, '');
				this.append(child);
			}
		}
		append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
		contains(item) { return this === item || this.children.some(child => child.contains(item)); }
		querySelector(selector) { return selector.includes('separator') ? this.children.find(child => child.tag === 'separator') : this.children.find(child => child.dataset.action === /data-action="([^"]+)"/.exec(selector)?.[1]); }
		querySelectorAll() { return this.children.filter(child => child.tag === 'button'); }
		closest() { return this.tag === 'button' ? this : null; }
		getBoundingClientRect() { return { left: parseFloat(this.style.left) || 0, top: parseFloat(this.style.top) || 0, right: 200, bottom: 40, width: 200, height: this.children.filter(child => !child.hidden).length * 20 }; }
		focus() { this.document.activeElement = this; }
		blur() { this.document.activeElement = this.document.body; }
		remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
		addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
		removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
		emit(type, values = {}) { const event = { target: this, preventDefault() {}, stopPropagation() {}, ...values }; for (const listener of this.listeners.get(type) || []) listener(event); }
	}
	const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
	const modules = ['home-program-context-menu', 'recorded-context-menu', 'series-context-menu', 'rules-context-menu'];
	for (const name of modules) {
		const document = new Element('document'); document.document = document;
		document.createElement = tag => new Element(tag, document);
		document.body = document.createElement('body'); document.activeElement = document.body;
		const window = new Element('window', document); window.innerWidth = 800; window.innerHeight = 800;
		const requests = [], actions = [], details = [];
		const sandbox = { document, window, viewportCssPixels: value => `${value}px`,
			loadProgramActionContext: id => { const request = { id, ...deferred() }; requests.push(request); return request.promise; },
			reservationActionLabel: action => action || '', seriesCorrectionActions: () => [],
			isRecordedResultPlayable: () => true, openProgramDetailDialog: item => details.push(item) };
		const source = fs.readFileSync(path.join(__dirname, `../next-web/components/${name}.js`), 'utf8')
			.replace(/^import .*;\n/gm, '').replace(/export function /g, 'function ');
		vm.runInNewContext(source, sandbox);
		const factory = Object.values(sandbox).find(value => typeof value === 'function' && value.name.startsWith('create'));
		const menu = factory({ enableFilter: true, onAction: (action, item) => actions.push({ action, item }),
			prepareItem: name === modules[1] ? item => { const request = { id: item.id, ...deferred() }; requests.push(request); return request.promise; } : undefined,
			resolveRule: (item, context) => { assert.ok(context.detail.rules); return context.model.actions.rule; } });
		const root = document.body.children[0], submenu = document.body.children[1];
		const state = () => JSON.stringify(root.children.map(child => [child.dataset.action, child.hidden, child.disabled, child.textContent]));
		const item = id => ({ id, title: id, uid: id, enabled: true, program: {}, event: { key: id }, seriesId: 'syobocal:1' });
		const context = { detail: { rules: [] }, model: { actions: { reservation: 'skip', stopRecording: null, rule: { mode: 'create' } },
			media: { liveModel: null }, phase: { key: 'reserved' } }, seriesContext: null };
		const readyItem = id => name === modules[0] ? context : item(id);
		if (name === modules[0] || name === modules[1]) {
			const first = menu.open(item('first'), { x: 790, y: 790 });
			assert.strictEqual(root.hidden, true);
			const second = menu.open(item('second'), { x: 790, y: 790 });
			await Promise.resolve();
			requests[1].resolve(readyItem('second')); await second;
			assert.strictEqual(root.hidden, false);
			const shown = state(), position = JSON.stringify(root.style);
			requests[0].resolve(readyItem('first')); await first;
			assert.strictEqual(state(), shown); assert.strictEqual(JSON.stringify(root.style), position);
			root.emit('click', { target: root.querySelector('[data-action="detail"]') });
			assert.strictEqual(name === modules[0] ? details[0].id : actions[0].item.id, 'second');
			for (const cancel of [() => document.emit('keydown', { key: 'Escape' }),
				() => document.emit('pointerdown', { target: document.body }),
				() => window.emit('scroll', { target: document.body }), () => window.emit('resize')]) {
				const ready = menu.open(item('cancelled'), { x: 30, y: 30 }); cancel();
				await Promise.resolve();
				requests.at(-1).resolve(readyItem('cancelled')); await ready; assert.strictEqual(root.hidden, true);
			}
		}
		const opening = menu.open(item('final'), { x: 790, y: 790 });
		await Promise.resolve();
		if (requests.length) requests.at(-1).resolve(readyItem('final'));
		await opening;
		assert.strictEqual(root.hidden, false);
		assert.ok(parseFloat(root.style.left) >= 8 && parseFloat(root.style.left) <= 592);
		document.emit('keydown', { key: 'ArrowDown' });
		assert.strictEqual(document.activeElement, root.children.find(child => child.tag === 'button' && !child.disabled && !child.hidden));
		window.emit('scroll', { target: root }); assert.strictEqual(root.hidden, false);
		if (submenu) {
			const filter = root.querySelector('[data-action="filter"]'); filter.focus();
			document.emit('keydown', { key: 'ArrowRight' }); assert.strictEqual(submenu.hidden, false);
			window.emit('scroll', { target: submenu }); assert.strictEqual(root.hidden, false);
			document.emit('keydown', { key: 'ArrowLeft' }); assert.strictEqual(submenu.hidden, true);
			assert.strictEqual(document.activeElement, filter);
		}
		document.emit('keydown', { key: 'Escape' }); assert.strictEqual(root.hidden, true);
		menu.destroy(); assert.strictEqual(document.body.children.length, 0);
		if (name === modules[1]) {
			const direct = factory({ onAction() {} });
			direct.open(item('known'), { x: 30, y: 30 });
			assert.strictEqual(document.body.children[0].hidden, false); // Known items keep the synchronous path.
			direct.destroy();
		}
		for (const listeners of [...document.listeners.values(), ...window.listeners.values()]) assert.strictEqual(listeners.size, 0);
	}
	// Repeated opening requests share a pending detail read and reuse known series data.
	let reads = 0, pending = deferred();
	const service = { loadProgramDetail: () => { reads++; return pending.promise; },
		buildProgramDetailModel: () => ({ eventKey: 'known' }),
		loadSeriesProjection: () => { throw new Error('Known series information must not be fetched again'); } };
	const actionSource = fs.readFileSync(path.join(__dirname, '../next-web/services/program-actions.js'), 'utf8');
	vm.runInNewContext(actionSource.slice(actionSource.indexOf('const pendingActionDetails'), actionSource.indexOf('function validTitle')).replace('export async function ', 'async function '), service);
	const known = { eventKey: 'known' };
	const first = service.loadProgramActionContext('same', known), second = service.loadProgramActionContext('same', known);
	assert.strictEqual(reads, 1); pending.resolve({ program: {} });
	assert.strictEqual((await first).seriesContext, known); await second;
	pending = deferred(); const fresh = service.loadProgramActionContext('same', known);
	assert.strictEqual(reads, 2); pending.resolve({ program: {} }); await fresh;
	// Both recording menus use direct deletion without opening a detail dialog.
	for (const [page, marker] of [['series-page', 'const recordedContextMenu ='], ['conflicts-page', 'const historyMenu =']]) {
		const source = fs.readFileSync(path.join(__dirname, `../next-web/pages/${page}.js`), 'utf8');
		const begin = source.indexOf('    onAction(action, item) {', source.indexOf(marker));
		const end = source.indexOf('\n  });', begin);
		assert.ok(begin >= 0 && end > begin);
		const deletion = { calls: [], details: [], deleteRecordedFromContext: value => { deletion.calls.push(value); return Promise.resolve(null); },
			openProgramDetailDialog: value => deletion.details.push(value),
			showMenuError: error => { throw error; }, menuError: error => { throw error; } };
		vm.runInNewContext(`const handler = ({${source.slice(begin, end)}}).onAction; handler('delete', { key: 'event', recordedId: 'recorded' });`, deletion);
		assert.deepStrictEqual(JSON.parse(JSON.stringify(deletion.calls)), [{ key: 'event', recordedId: 'recorded' }]);
		assert.strictEqual(deletion.details.length, 0);
	}
}

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
	const cardSource = fs.readFileSync(path.join(__dirname, '../next-web/components/recorded-card.js'), 'utf8');
	const cardContext = vm.createContext({ savedTsResultInfo });
	vm.runInContext(section(cardSource, 'function savedTsCardSummary(', 'function toRecordedCardModel('), cardContext);
	for (const [field, heading, explanation] of [
		['ccErrorEvents', 'DROP疑い', '映像や音声が乱れている可能性があります。'],
		['pcrGapEvents', '時間飛び疑い', '映像や音声が途切れている可能性があります。'],
		['syncErrorEvents', '同期異常疑い', '映像や音声に異常がある可能性があります。']
	]) {
		assert.strictEqual(cardContext.savedTsCardSummary({ result: { completed: true, status: 'SUSPECT', [field]: 4 } }).description,
			`TS解析：${heading} 4件\n${explanation}`);
	}
	assert.strictEqual(cardContext.savedTsCardSummary({ result: { completed: true, status: 'SUSPECT',
		ccErrorEvents: 4, pcrGapEvents: 1, syncErrorEvents: 1 } }).description,
		'TS解析：DROP疑い 4件 / 時間飛び疑い 1件 / 同期異常疑い 1件\n映像や音声に異常がある可能性があります。');
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
	const { buildProgramDetailModel, seriesCorrectionActions } = await programDetailModel();
	const localActions = seriesCorrectionActions({ event: { key: 'local-fixture' }, seriesId: 'local:' + 'a'.repeat(24), manual: true, tidConfirmed: false });
	assert.deepStrictEqual(localActions.map(item => item.action), ['series-change', 'series-remove']);
	assert.strictEqual(localActions[0].label, 'シリーズを変更');
	assert.ok(seriesCorrectionActions({ event: { key: 'tid-fixture' }, seriesId: 'syobocal:1', tidConfirmed: true }).some(item => item.action === 'series-episode'));
	// The WUI must not override a resolved history with a recording whose ID or key conflicts.
	const clientSource = fs.readFileSync(path.join(__dirname, '../next-web/services/program-detail-client.js'), 'utf8');
	const identityCode = clientSource.slice(clientSource.indexOf('function validText('), clientSource.indexOf('function selectCurrentProgram('));
	const context = vm.createContext({});
	vm.runInContext(identityCode + '\nthis.selectByIdentity = findProgramByIdentity;', context);
	const candidate = { id: 'current-id', channel: { id: 'channel' }, start: 1000, seconds: 60 };
	const key = 'channel|1000|60';
	assert.strictEqual(context.selectByIdentity([candidate], 'old-id', key), null);
	assert.strictEqual(context.selectByIdentity([candidate], 'current-id', 'different|1000|60'), null);
	assert.strictEqual(context.selectByIdentity([candidate], 'current-id', key)?.id, 'current-id');
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
	assert.strictEqual(recorded.operatorRecording.tunerLabel, '割当不明');
	assert.strictEqual(recorded.operatorRecording.startLabel, '未取得');
	assert.strictEqual(recorded.operatorRecording.endLabel, '未取得');
	const actualStart = new Date(2026, 10, 11, 19, 59, 45, 280).getTime();
	const actualEnd = new Date(2026, 10, 11, 20, 29, 59, 830).getTime();
	const actual = buildProgramDetailModel(detail({ currentSource: 'recorded',
		program: { id: 'recorded-a', operatorRecordingStart: actualStart, operatorRecordingEnd: actualEnd,
			tuner: { name: 'dummy' }, mirakurunDrop: { tunerName: 'PT3 GR 1', tunerIndex: 0 } },
		match: { status: 'RECORDED' } }));
	assert.strictEqual(actual.operatorRecording.tunerLabel, 'PT3 GR 1');
	assert.match(actual.operatorRecording.startLabel, /19:59:45\.280$/);
	assert.match(actual.operatorRecording.endLabel, /20:29:59\.830$/);

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
	assert.strictEqual(deleted.recordingPath?.copyValue ?? null, null);
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
	await checkContextMenus();
	await checkMaintenanceState();
});
