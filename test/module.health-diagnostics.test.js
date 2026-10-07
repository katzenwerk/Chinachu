'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const vm = require('vm');

const health = require('../lib/health-diagnostics');
const ruleUid = require('../lib/rule-uid');
const schedulerState = require('../lib/scheduler-state');

function fixture(options) {
	options = options || {};
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-health-'));
	const data = path.join(root, 'data');
	fs.mkdirSync(data);
	const files = {
		config: path.join(root, 'config.json'),
		rules: path.join(root, 'rules.json'),
		schedulerState: path.join(data, 'scheduler-state.json'),
		recording: path.join(data, 'recording.json')
	};
	fs.writeFileSync(files.config, options.config === undefined ? '{}' : options.config);
	fs.writeFileSync(files.rules, options.rules === undefined ? '[]' : options.rules);
	if (!options.missingSchedulerState) {
		fs.writeFileSync(files.schedulerState, options.schedulerState === undefined
			? JSON.stringify(Object.assign(schedulerState.emptyState(), {
				lastSchedulerStartedAt: 900,
				lastSchedulerSuccessAt: 1000
			}))
			: options.schedulerState);
	}
	fs.writeFileSync(files.recording, options.recording === undefined ? '[]' : options.recording);

	return {
		root: root,
		files: files,
		collector: health.createHealthDiagnostics({
			rootDir: root,
			paths: files,
			packageVersion: '0.10.7-test',
			nodeVersion: 'v24.test',
			now: () => 5000,
			cacheMs: options.cacheMs === undefined ? 5000 : options.cacheMs,
			mirakurunTimeoutMs: 50,
			commitResolver: () => options.commit === undefined ? 'a'.repeat(40) : options.commit,
			validateRules: ruleUid.validateRuleUids,
			fetchMirakurunStatus: options.fetchMirakurunStatus || (() => Promise.resolve({ version: '4.1.3' }))
		})
	};
}

test('reports zero recordings, scheduler success, JSON checks, and optional commit without conflating matching', async () => {
	const f = fixture();
	const report = await f.collector.collect();

	assert.strictEqual(report.basic.status, 'normal');
	assert.strictEqual(report.basic.data.commit, 'a'.repeat(40));
	assert.strictEqual(report.scheduler.status, 'normal');
	assert.strictEqual(report.scheduler.data.lastSuccessAt, 1000);
	assert.strictEqual(report.scheduler.data.elapsedMs, 4000);
	assert.strictEqual(report.recording.status, 'normal');
	assert.strictEqual(report.recording.data.count, 0);
	assert.strictEqual(report.json.config.status, 'normal');
	assert.strictEqual(report.json.rules.status, 'normal');
	assert.strictEqual(report.mirakurun.data.version, '4.1.3');
	assert.strictEqual(report.notMeasured.matchingSuccess.includes('未実装'), true);
	assert.strictEqual(Object.hasOwn(report.scheduler.data, 'matchingSuccessAt'), false);
});

test('distinguishes missing scheduler state from invalid JSON and unreadable recording values', async () => {
	const missing = fixture({ missingSchedulerState: true });
	const missingReport = await missing.collector.collect();
	assert.strictEqual(missingReport.scheduler.status, 'unknown');
	assert.strictEqual(missingReport.scheduler.code, 'missing');
	assert.strictEqual(missingReport.scheduler.data.lastSuccessAt, null);

	const invalid = fixture({
		config: '{',
		rules: '{}',
		schedulerState: '{',
		recording: '{}'
	});
	const invalidReport = await invalid.collector.collect();
	assert.strictEqual(invalidReport.json.config.code, 'invalid-json');
	assert.strictEqual(invalidReport.json.rules.code, 'invalid-type');
	assert.strictEqual(invalidReport.scheduler.code, 'invalid-json');
	assert.strictEqual(invalidReport.recording.code, 'invalid-type');
	assert.strictEqual(invalidReport.recording.data.count, null);

	const unsupported = fixture({
		schedulerState: JSON.stringify({ version: 999 })
	});
	const unsupportedReport = await unsupported.collector.collect();
	assert.strictEqual(unsupportedReport.scheduler.code, 'invalid-format');
	assert.strictEqual(unsupportedReport.scheduler.data.lastSuccessAt, null);

	const originalRead = unsupported.collector.fs.readFileSync.bind(unsupported.collector.fs);
	unsupported.collector.fs = Object.assign({}, unsupported.collector.fs, {
		readFileSync(filePath) {
			if (filePath === unsupported.files.schedulerState || filePath === unsupported.files.recording) {
				const error = new Error('private path detail');
				error.code = 'EACCES';
				throw error;
			}
			return originalRead.apply(null, arguments);
		}
	});
	const unreadableReport = await unsupported.collector.collect({ force: true });
	assert.strictEqual(unreadableReport.scheduler.status, 'unknown');
	assert.strictEqual(unreadableReport.scheduler.code, 'unreadable');
	assert.strictEqual(unreadableReport.scheduler.data.lastSuccessAt, null);
	assert.strictEqual(unreadableReport.recording.status, 'unknown');
	assert.strictEqual(unreadableReport.recording.code, 'unreadable');
	assert.strictEqual(unreadableReport.recording.data.count, null);
	assert.doesNotMatch(JSON.stringify(unreadableReport), /private path detail/);
});

test('isolates rule UID and Mirakurun failures while returning the remaining diagnostics', async () => {
	const f = fixture({
		rules: JSON.stringify([{ ruleUid: 'duplicate' }, { ruleUid: 'duplicate' }]),
		fetchMirakurunStatus: () => Promise.reject(new Error('secret endpoint detail'))
	});
	const report = await f.collector.collect();

	assert.strictEqual(report.json.rules.status, 'error');
	assert.strictEqual(report.json.rules.code, 'invalid-format');
	assert.strictEqual(report.mirakurun.status, 'error');
	assert.strictEqual(report.mirakurun.code, 'unavailable');
	assert.doesNotMatch(JSON.stringify(report), /secret endpoint detail/);
	assert.strictEqual(report.recording.data.count, 0);
});

test('bounds a Mirakurun check even when the provider does not settle', async () => {
	const f = fixture({
		fetchMirakurunStatus: () => new Promise(() => {})
	});
	const report = await f.collector.collect();
	assert.strictEqual(report.mirakurun.status, 'error');
	assert.strictEqual(report.mirakurun.code, 'timeout');
});

test('coalesces concurrent refreshes and serves a short-lived cached snapshot', async () => {
	let calls = 0;
	let resolveStatus;
	const statusPromise = new Promise(resolve => { resolveStatus = resolve; });
	const f = fixture({
		fetchMirakurunStatus: () => {
			calls++;
			return statusPromise;
		}
	});

	const first = f.collector.collect({ force: true });
	const second = f.collector.collect({ force: true });
	assert.strictEqual(first, second);
	resolveStatus({ version: '4.1.3' });
	const report = await first;
	assert.strictEqual(calls, 1);
	assert.strictEqual(await f.collector.collect(), report);
	assert.strictEqual(calls, 1);
});

test('diagnostics API returns the shared report and accepts an explicit refresh without changing status API', async () => {
	const script = fs.readFileSync(path.join(__dirname, '../api/script-diagnostics.vm.js'), 'utf8');
	const expected = { schemaVersion: 1, checkedAt: 123 };
	let force = null;
	let statusCode = null;
	let body = null;
	const context = {
		request: { query: { refresh: '1' } },
		response: {
			head(code) { statusCode = code; },
			end(value) { body = value; },
			error() { throw new Error('unexpected API error'); }
		},
		healthDiagnostics: {
			collect(options) {
				force = options.force;
				return Promise.resolve(expected);
			}
		},
		JSON: JSON
	};

	await vm.runInNewContext(script, context, { filename: 'script-diagnostics.vm.js' });
	assert.strictEqual(force, true);
	assert.strictEqual(statusCode, 200);
	assert.deepStrictEqual(JSON.parse(body), expected);

	const statusScript = fs.readFileSync(path.join(__dirname, '../api/script-status.vm.js'), 'utf8');
	assert.doesNotMatch(statusScript, /healthDiagnostics|diagnostics/);
});

test('Status page keeps diagnostics on a separate API and renders compact panels with an explicit recheck', () => {
	const source = fs.readFileSync(path.join(__dirname, '../web/page/dashboard/status.js'), 'utf8');
	const css = fs.readFileSync(path.join(__dirname, '../web/chinachu.css'), 'utf8');
	let requestUrl = null;
	let requestOptions = null;
	let draws = 0;
	const context = {
		P: {},
		Class: {
			create(parent, properties) { return properties; }
		},
		Ajax: {
			Request: function(url, options) {
				requestUrl = url;
				requestOptions = options;
				return { transport: { abort() {} } };
			}
		}
		};
	vm.runInNewContext(source, context, { filename: 'dashboard/status.js' });
	const page = Object.assign({}, context.P, {
		diagnostics: null,
		diagnosticsLoading: false,
		diagnosticsRequest: null,
		diagnosticsDetailsOpen: true,
		draw() { draws++; }
	});

	page.loadDiagnostics(true);
	assert.strictEqual(requestUrl, './api/diagnostics.json?refresh=1');
	assert.ok(requestOptions);
	requestOptions.onSuccess({ responseText: { evalJSON: () => ({ schemaVersion: 1 }) } });
	requestOptions.onComplete();
	assert.strictEqual(page.diagnostics.schemaVersion, 1);
	assert.strictEqual(page.diagnosticsLoading, false);
	assert.strictEqual(page.diagnosticsRequest, null);
	assert.strictEqual(page.diagnosticsDetailsOpen, true);
	assert.strictEqual(draws, 2);
	assert.strictEqual(page.statusLabel('normal'), '正常');
	assert.strictEqual(page.statusLabel('unknown'), '未確認');
	page.view = { content: { down: () => ({ open: true }) } };
	assert.strictEqual(page.captureDiagnosticsDetailsState(), true);
	page.view.content.down = () => ({ open: false });
	assert.strictEqual(page.captureDiagnosticsDetailsState(), false);
	const counts = page.diagnosticsIssueCounts({
		json: {
			config: { status: 'warning' },
			rules: { status: 'error' },
			schedulerState: { status: 'normal' }
		}
	});
	assert.strictEqual(counts.warning, 1);
	assert.strictEqual(counts.error, 1);
	assert.match(source, /createPanel\('稼働状態'/);
	assert.match(source, /createPanel\('実行環境'/);
	assert.match(source, /new Element\('details'/);
	assert.match(source, /details\.open = this\.diagnosticsDetailsOpen === true/);
	assert.match(source, /health-details-count-error/);
	assert.match(source, /label: 'Matching成功情報'[\s\S]*value: '未計測'/);
	assert.match(source, /label: 'Scheduler trigger source'[\s\S]*value: '未計測'/);
	assert.doesNotMatch(source, /sakura\.ui\.Alert|Health \/ Diagnostics|Scheduler成功をMatching成功として扱いません/);
	assert.match(css, /\.health-status-page/);
	assert.match(css, /\.health-panel-grid[^\n]*grid-template-columns: repeat\(4/);
	assert.match(css, /\.health-metric-label[^\n]*font-size: 13px/);
	assert.match(css, /\.health-metric-value[^\n]*font-size: 18px/);
	assert.match(css, /@media \(max-width: 560px\)/);
	assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.health-metric-value[^\n]*font-size: 16px/);
});
