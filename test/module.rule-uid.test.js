'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');
const ruleUid = require('../lib/rule-uid');
const ruleStore = require('../lib/rule-store');
const reservationStore = require('../lib/reservation-store');

function readRules(directory) {
	return JSON.parse(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8'));
}

function runApi(file, method, rules, query, num, headers = {}) {
	let finish;
	const completed = new Promise(resolve => { finish = resolve; });
	const response = {
		statusCode: null,
		body: '',
		head(code) { this.statusCode = code; },
		end(body) { this.body = body || ''; finish(this); },
		error(code) { this.statusCode = code; finish(this); }
	};
	const request = {
		method,
		query: query === undefined ? undefined : JSON.parse(JSON.stringify(query)),
		param: { num: String(num) },
		headers: Object.assign({ 'content-type': 'application/json' }, headers)
	};
	const sandbox = {
		request, response, data: { rules },
		define: { RULES_FILE: file, REPOSITORY_ROOT: path.dirname(file), NODE_EXECUTABLE: process.execPath },
		fs,
		path,
		ruleUid,
		ruleStore,
		child_process: {
			execFile(executable, args, options, callback) {
				if (method !== 'DELETE') throw new Error('unexpected child process');
				const uid = args[args.indexOf('--rule-uid') + 1];
				ruleStore.updateRules(file, currentRules => {
					currentRules.splice(ruleStore.findUniqueIndex(currentRules, uid), 1);
				});
				callback(null, '', '');
			}
		}
	};
	const route = num === undefined ? 'script-rules.vm.js' : 'script-rules-rule.vm.js';
	vm.runInNewContext(fs.readFileSync(path.join(repositoryRoot, 'api', route), 'utf8'), sandbox, route);
	return completed;
}

function runActionApi(file, rules, action, expectedRuleUid) {
	const response = {
		statusCode: null,
		body: '',
		head(code) { this.statusCode = code; },
		end(body) { this.body = body || ''; },
		error(code) { this.statusCode = code; }
	};
	const sandbox = {
		request: {
			method: 'PUT',
			param: { num: '0', action },
			headers: expectedRuleUid ? { 'x-chinachu-rule-uid': expectedRuleUid } : {}
		},
		response,
		data: { rules },
		define: { RULES_FILE: file, REPOSITORY_ROOT: repositoryRoot, NODE_EXECUTABLE: process.execPath },
		path,
		ruleStore,
		child_process: {
			execFile(executable, args, options, callback) {
				const uid = args[args.indexOf('--rule-uid') + 1];
				ruleStore.updateRules(file, currentRules => {
					const index = ruleStore.findUniqueIndex(currentRules, uid);
					if (args.includes('--disable')) currentRules[index].isDisabled = true;
					else delete currentRules[index].isDisabled;
				});
				callback(null, '', '');
			}
		}
	};
	vm.runInNewContext(fs.readFileSync(path.join(repositoryRoot, 'api', 'script-rules-rule-action.vm.js'), 'utf8'),
		sandbox, 'script-rules-rule-action.vm.js');
	return response;
}

function createCliFixture(rules) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-cli-'));
	fs.mkdirSync(path.join(directory, 'data'));
	fs.mkdirSync(path.join(directory, 'log'));
	fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(directory, 'lib'), 'dir');
	const nodeModules = path.join(directory, 'node_modules');
	fs.mkdirSync(nodeModules);
	['opts', 'dateformat', 'chinachu-common', 'easy-table'].forEach(name => {
		fs.symlinkSync(path.join(repositoryRoot, 'node_modules', name), path.join(nodeModules, name), 'dir');
	});
	const mirakurunModule = path.join(nodeModules, 'mirakurun');
	fs.mkdirSync(mirakurunModule);
	fs.writeFileSync(path.join(mirakurunModule, 'index.js'),
		"exports.default = class { constructor() { this.basePath = '/api'; } getTuners() { return Promise.resolve([]); } };\n");
	fs.copyFileSync(path.join(repositoryRoot, 'app-cli.js'), path.join(directory, 'app-cli.js'));
	fs.writeFileSync(path.join(directory, 'config.json'), '{}');
	fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify(rules));
	['schedule', 'reserves', 'recording', 'recorded'].forEach(name => {
		fs.writeFileSync(path.join(directory, 'data', name + '.json'), '[]');
	});
	return directory;
}

function runCli(directory, args) {
	return childProcess.spawnSync(process.execPath, ['app-cli.js', '-mode', 'rule', ...args], {
		cwd: directory, encoding: 'utf8'
	});
}

function runCliAsync(directory, args) {
	return new Promise(resolve => {
		const child = childProcess.spawn(process.execPath, ['app-cli.js', '-mode', 'rule', ...args], {
			cwd: directory, encoding: 'utf8'
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', chunk => { stdout += chunk; });
		child.stderr.on('data', chunk => { stderr += chunk; });
		child.on('close', status => resolve({ status, stdout, stderr }));
	});
}

describe('Stable rule UID lifecycle', function() {
	it('generates a UID for API-created rules and rejects a duplicate UID', async function() {
		const existing = [{ ruleUid: 'stable-a', title: 'A' }];
		const directory = createCliFixture(existing);
		const file = path.join(directory, 'rules.json');
		const originalSchedule = reservationStore.scheduleReservations;
		try {
			reservationStore.scheduleReservations = function() { throw new Error('WUI must calculate reservations in a child process'); };
			const created = await runApi(file, 'POST', existing, { title: 'new rule', recordingBoundaryPolicy: 'start', allowEndLack: true });
			assert.strictEqual(created.statusCode, 201);
			assert.strictEqual(JSON.parse(created.body).reservationUpdate.success, true, created.body);
			let saved = readRules(directory);
			assert.strictEqual(saved.length, 2);
			assert.strictEqual(saved[0].ruleUid, 'stable-a');
			assert.match(saved[1].ruleUid, /^[0-9a-f-]{36}$/);
			assert.strictEqual(saved[1].recordingHandoffProtected, false);
			assert.strictEqual('recordingBoundaryPolicy' in saved[1], false);
			assert.strictEqual('allowEndLack' in saved[1], false);
			assert.strictEqual('recordingHandoffProtected' in saved[0], false);

			const beforeDuplicate = fs.readFileSync(file, 'utf8');
			const duplicate = await runApi(file, 'POST', saved, { ruleUid: 'stable-a', title: 'duplicate' });
			assert.strictEqual(duplicate.statusCode, 409);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), beforeDuplicate);
		} finally {
			reservationStore.scheduleReservations = originalSchedule;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('edits the expected UID after an index shift while preserving its UID and title mode', async function() {
		// The editor, rule API and reservation builder enable only explicit protection.
		const modelSource = fs.readFileSync(path.join(repositoryRoot, 'next-web/services/rule-model.js'), 'utf8');
		const model = await import('data:text/javascript;base64,' + Buffer.from(modelSource).toString('base64'));
		const editorSource = fs.readFileSync(path.join(repositoryRoot, 'next-web/components/rule-editor-dialog.js'), 'utf8');
		const editor = vm.createContext({ structuredClone });
		vm.runInContext(editorSource.slice(editorSource.indexOf('const TEXT_ARRAY_FIELDS'),
			editorSource.indexOf('function pairedFields')), editor);
		const cases = [
			[{}, false], [{ recordingBoundaryPolicy: 'default' }, false],
			[{ recordingBoundaryPolicy: 'start' }, false], [{ recordingBoundaryPolicy: 'end' }, false],
			[{ allowEndLack: true }, false],
			[{ recordingHandoffProtected: true }, true], [{ recordingHandoffProtected: false }, false],
			[{ recordingHandoffProtected: false, recordingBoundaryPolicy: 'end', allowEndLack: true }, false],
			[{ recordingHandoffProtected: false, recordingBoundaryPolicy: 'start' }, false],
			[{ recordingHandoffProtected: true, recordingBoundaryPolicy: 'default', allowEndLack: false }, true]
		];
		for (const [legacy, expected] of cases) {
			assert.strictEqual(model.ruleHandoffProtected(legacy), expected);
			assert.strictEqual(reservationStore.isRecordingHandoffProtected(legacy), expected);
			const form = { elements: { isEnabled: { checked: true }, reserve_titles_mode: { value: 'or' },
				recordedDirId: { value: '' }, recorded_format: { value: '' }, recordingHandoffProtected: { checked: expected } },
				querySelectorAll: () => [] };
			const payload = editor.buildPayload(form, { ...legacy, ruleUid: 'handoff-rule', customSetting: { keep: true } });
			assert.strictEqual(payload.recordingHandoffProtected, expected);
			assert.strictEqual('recordingBoundaryPolicy' in payload, false);
			assert.strictEqual('allowEndLack' in payload, false);
			assert.strictEqual(payload.customSetting.keep, true);
			assert.strictEqual(payload.ruleUid, 'handoff-rule');
			const normalized = ruleStore.normalizeRecordingHandoff(structuredClone(payload));
			assert.deepStrictEqual(normalized, payload);
			const oldRule = { ...legacy, ruleUid: 'handoff-rule', customSetting: { keep: true } };
			assert.deepStrictEqual(ruleStore.normalizeRecordingHandoff(oldRule),
				{ ruleUid: 'handoff-rule', customSetting: { keep: true }, recordingHandoffProtected: expected });
			const rule = { ...legacy, ruleUid: 'handoff-rule', types: ['GR'] };
			const before = JSON.stringify(rule);
			const result = reservationStore.evaluateReservations([
				{ id: 'candidate', title: 'Fixture', start: 1000, end: 2000, seconds: 1,
					channel: { type: 'GR', channel: '1', sid: 1 } }
			], [{ types: ['GR'] }], [rule], {});
			assert.strictEqual(result.reserves[0].recordingHandoffProtected, expected);
			assert.strictEqual('allowEndLack' in result.reserves[0], false);
			assert.strictEqual('recordingBoundaryPolicy' in result.reserves[0], false);
			assert.strictEqual(JSON.stringify(rule), before);
		}
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-api-'));
		const file = path.join(directory, 'rules.json');
		try {
			const staleMemory = [
				{ ruleUid: 'stable-a', title: 'A' },
				{ ruleUid: 'stable-b', title: 'B', reserve_titles_mode: 'and', recordingBoundaryPolicy: 'end' }
			];
			fs.writeFileSync(file, JSON.stringify([{ ruleUid: 'inserted', title: 'X' }, ...staleMemory]));
			const response = await runApi(file, 'PUT', staleMemory, { ruleUid: 'caller-change', title: 'edited' }, 0,
				{ 'x-chinachu-rule-uid': 'stable-b' });

			assert.strictEqual(response.statusCode, 200);
			const saved = readRules(directory);
			assert.deepStrictEqual(saved.map(rule => [rule.ruleUid, rule.title]), [
				['inserted', 'X'], ['stable-a', 'A'], ['stable-b', 'edited']
			]);
			assert.strictEqual(saved[2].reserve_titles_mode, 'and');
			assert.strictEqual(saved[2].recordingHandoffProtected, false);
			assert.strictEqual('recordingBoundaryPolicy' in saved[2], false);
			assert.strictEqual('recordingHandoffProtected' in saved[1], false);

			const explicitOr = await runApi(file, 'PUT', saved, { title: 'edited again', reserve_titles_mode: 'or' }, 2,
				{ 'x-chinachu-rule-uid': 'stable-b' });
			assert.strictEqual(explicitOr.statusCode, 200);
			assert.strictEqual(readRules(directory)[2].reserve_titles_mode, 'or');
			assert.strictEqual(readRules(directory)[2].recordingHandoffProtected, false);
			const protectedRule = await runApi(file, 'PUT', readRules(directory),
				{ title: 'protected', recordingHandoffProtected: true, customSetting: { keep: true } }, 2,
				{ 'x-chinachu-rule-uid': 'stable-b' });
			assert.strictEqual(protectedRule.statusCode, 200);
			const retained = await runApi(file, 'PUT', readRules(directory),
				{ title: 'protected edited', recordingBoundaryPolicy: 'default', customSetting: { keep: true } }, 2,
				{ 'x-chinachu-rule-uid': 'stable-b' });
			assert.strictEqual(retained.statusCode, 200);
			assert.strictEqual(readRules(directory)[2].recordingHandoffProtected, true);
			assert.strictEqual(readRules(directory)[2].ruleUid, 'stable-b');
			assert.deepStrictEqual(readRules(directory)[2].customSetting, { keep: true });
			assert.strictEqual('recordingBoundaryPolicy' in readRules(directory)[2], false);
			const unprotected = await runApi(file, 'PUT', readRules(directory),
				{ title: 'unprotected', recordingHandoffProtected: false, recordingBoundaryPolicy: 'end', allowEndLack: true }, 2,
				{ 'x-chinachu-rule-uid': 'stable-b' });
			assert.strictEqual(unprotected.statusCode, 200);
			assert.strictEqual(readRules(directory)[2].recordingHandoffProtected, false);
			assert.strictEqual('allowEndLack' in readRules(directory)[2], false);
			assert.strictEqual('recordingBoundaryPolicy' in readRules(directory)[2], false);
			const invalid = await runApi(file, 'PUT', readRules(directory), { title: 'invalid', reserve_titles_mode: 'xor' }, 2,
				{ 'x-chinachu-rule-uid': 'stable-b' });
			assert.strictEqual(invalid.statusCode, 400);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('resolves DELETE by UID after an index shift and rejects unsafe requests', async function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-delete-'));
		const file = path.join(directory, 'rules.json');
		try {
			const staleMemory = [{ ruleUid: 'stable-a', title: 'A' }, { ruleUid: 'stable-b', title: 'B' }];
			fs.writeFileSync(file, JSON.stringify([{ ruleUid: 'inserted', title: 'X' }, ...staleMemory]));
			const shifted = await runApi(file, 'DELETE', staleMemory, undefined, 0, { 'x-chinachu-rule-uid': 'stable-b' });
			assert.strictEqual(shifted.statusCode, 200);
			assert.deepStrictEqual(readRules(directory).map(rule => rule.ruleUid), ['inserted', 'stable-a']);
			assert.deepStrictEqual(staleMemory.map(rule => rule.ruleUid), ['inserted', 'stable-a']);

			const missing = await runApi(file, 'DELETE', staleMemory, undefined, 0, { 'x-chinachu-rule-uid': 'missing' });
			assert.strictEqual(missing.statusCode, 404);
			const noUid = await runApi(file, 'DELETE', staleMemory, undefined, 0);
			assert.strictEqual(noUid.statusCode, 428);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('keeps CLI-created rule UIDs through edit, deletion, and index shift', function() {
		const directory = createCliFixture([{ title: 'first' }, { title: 'second' }]);
		try {
			let result = runCli(directory, ['-title', 'third']);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			let saved = readRules(directory);
			assert.strictEqual(saved.length, 3);
			assert.strictEqual(new Set(saved.map(rule => rule.ruleUid)).size, 3);
			const thirdUid = saved[2].ruleUid;

			result = runCli(directory, ['-n', '2', '-title', 'renamed']);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.strictEqual(readRules(directory)[2].ruleUid, thirdUid);

			result = runCli(directory, ['-n', '1', '--remove']);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			saved = readRules(directory);
			assert.deepStrictEqual(saved.map(rule => rule.reserve_titles && rule.reserve_titles[0]), [undefined, 'renamed']);
			assert.strictEqual(saved[1].ruleUid, thirdUid);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('toggles the expected UID through the action API after an index shift', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-toggle-'));
		const file = path.join(directory, 'rules.json');
		try {
			const staleMemory = [{ ruleUid: 'stable-a', title: 'A' }, { ruleUid: 'stable-b', title: 'B' }];
			fs.writeFileSync(file, JSON.stringify([{ ruleUid: 'inserted', title: 'X' }, ...staleMemory]));
			const disabled = runActionApi(file, staleMemory, 'disable', 'stable-b');
			assert.strictEqual(disabled.statusCode, 200);
			assert.strictEqual(readRules(directory)[2].isDisabled, true);
			const enabled = runActionApi(file, staleMemory, 'enable', 'stable-b');
			assert.strictEqual(enabled.statusCode, 200);
			assert.strictEqual(readRules(directory)[2].isDisabled, undefined);
			assert.strictEqual(runActionApi(file, staleMemory, 'disable', null).statusCode, 428);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('fails safely for missing or duplicate UIDs while preserving legacy index CLI', function() {
		const directory = createCliFixture([
			{ ruleUid: 'stable-a', title: 'A' },
			{ ruleUid: 'stable-b', title: 'B' }
		]);
		try {
			const beforeMissing = fs.readFileSync(path.join(directory, 'rules.json'), 'utf8');
			let result = runCli(directory, ['--remove', '--rule-uid', 'missing']);
			assert.strictEqual(result.status, ruleStore.CLI_EXIT_TARGET_CONFLICT);
			assert.strictEqual(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8'), beforeMissing);

			fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify([
				{ ruleUid: 'duplicate', title: 'A' }, { ruleUid: 'duplicate', title: 'B' }
			]));
			const beforeDuplicate = fs.readFileSync(path.join(directory, 'rules.json'), 'utf8');
			result = runCli(directory, ['--remove', '--rule-uid', 'duplicate']);
			assert.strictEqual(result.status, ruleStore.CLI_EXIT_TARGET_CONFLICT);
			assert.strictEqual(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8'), beforeDuplicate);

			fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify([
				{ ruleUid: 'stable-a', title: 'A' }, { ruleUid: 'stable-b', title: 'B' }
			]));
			const handoffRules = readRules(directory);
			for (const legacy of [{ allowEndLack: true }, { recordingBoundaryPolicy: 'start' }, { recordingBoundaryPolicy: 'end' },
				{ recordingHandoffProtected: true, recordingBoundaryPolicy: 'end' }]) {
				fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify([
					{ ...handoffRules[0], ...legacy, customSetting: { keep: true } }, handoffRules[1]
				]));
				const edited = runCli(directory, ['--enable', '--rule-uid', 'stable-a']);
				assert.strictEqual(edited.status, 0, edited.stdout + edited.stderr);
				const latest = readRules(directory);
				assert.strictEqual(latest[0].recordingHandoffProtected, legacy.recordingHandoffProtected === true);
				assert.strictEqual(latest[0].ruleUid, 'stable-a');
				assert.deepStrictEqual(latest[0].customSetting, { keep: true });
				assert.strictEqual('allowEndLack' in latest[0], false);
				assert.strictEqual('recordingBoundaryPolicy' in latest[0], false);
				assert.deepStrictEqual(latest[1], handoffRules[1]);
			}
			handoffRules[1].recordingHandoffProtected = false;
			handoffRules[1].recordingBoundaryPolicy = 'start';
			fs.writeFileSync(path.join(directory, 'rules.json'), JSON.stringify(handoffRules));
			result = runCli(directory, ['--disable', '--rule-uid', 'stable-b']);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.strictEqual(readRules(directory)[1].isDisabled, true);
			assert.strictEqual(readRules(directory)[1].recordingHandoffProtected, false);
			assert.strictEqual('recordingBoundaryPolicy' in readRules(directory)[1], false);
			result = runCli(directory, ['--enable', '--rule-uid', 'stable-b']);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.strictEqual(readRules(directory)[1].isDisabled, undefined);

			result = runCli(directory, ['--remove', '-n', '0']);
			assert.strictEqual(result.status, 0, result.stdout + result.stderr);
			assert.deepStrictEqual(readRules(directory).map(rule => rule.ruleUid), ['stable-b']);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('serializes concurrent delete, add, edit, and multiple delete operations', async function() {
		const deleteDirectory = createCliFixture([
			{ ruleUid: 'a', title: 'A' }, { ruleUid: 'b', title: 'B' }, { ruleUid: 'c', title: 'C' }
		]);
		try {
			let results = await Promise.all([
				runCliAsync(deleteDirectory, ['--remove', '--rule-uid', 'a']),
				runCliAsync(deleteDirectory, ['--remove', '--rule-uid', 'b'])
			]);
			assert.ok(results.every(result => result.status === 0), JSON.stringify(results));
			assert.deepStrictEqual(readRules(deleteDirectory).map(rule => rule.ruleUid), ['c']);
		} finally {
			fs.rmSync(deleteDirectory, { recursive: true, force: true });
		}

		const mixedDirectory = createCliFixture([
			{ ruleUid: 'a', title: 'A' }, { ruleUid: 'b', title: 'B' }, { ruleUid: 'c', title: 'C' }
		]);
		try {
			const results = await Promise.all([
				runCliAsync(mixedDirectory, ['--remove', '--rule-uid', 'a']),
				runCliAsync(mixedDirectory, ['--rule-uid', 'b', '-title', 'edited']),
				runCliAsync(mixedDirectory, ['-title', 'added'])
			]);
			assert.ok(results.every(result => result.status === 0), JSON.stringify(results));
			const saved = readRules(mixedDirectory);
			assert.deepStrictEqual(saved.filter(rule => rule.ruleUid === 'b').map(rule => rule.reserve_titles), [['edited']]);
			assert.strictEqual(saved.some(rule => rule.ruleUid === 'a'), false);
			assert.strictEqual(saved.some(rule => rule.ruleUid === 'c'), true);
			assert.strictEqual(saved.some(rule => rule.reserve_titles && rule.reserve_titles[0] === 'added'), true);
		} finally {
			fs.rmSync(mixedDirectory, { recursive: true, force: true });
		}
	});

	it('propagates a persistence failure without changing the previous valid JSON', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-atomic-'));
		const file = path.join(directory, 'rules.json');
		const originalWrite = reservationStore.writeArrayAtomic;
		try {
			fs.writeFileSync(file, JSON.stringify([{ ruleUid: 'stable-a', title: 'A' }]));
			const before = fs.readFileSync(file, 'utf8');
			reservationStore.writeArrayAtomic = function() { throw new Error('injected write failure'); };
			assert.throws(() => ruleStore.updateRules(file, rules => {
				rules.splice(0, 1);
			}), /injected write failure/);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
			assert.deepStrictEqual(readRules(directory), [{ ruleUid: 'stable-a', title: 'A' }]);
		} finally {
			reservationStore.writeArrayAtomic = originalWrite;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
