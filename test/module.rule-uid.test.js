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

function readRules(directory) {
	return JSON.parse(fs.readFileSync(path.join(directory, 'rules.json'), 'utf8'));
}

function runApi(file, method, rules, query, num) {
	const response = {
		statusCode: null,
		body: '',
		head(code) { this.statusCode = code; },
		end(body) { this.body = body || ''; },
		error(code) { this.statusCode = code; }
	};
	const request = {
		method,
		query: query === undefined ? undefined : JSON.parse(JSON.stringify(query)),
		param: { num: String(num) },
		headers: { 'content-type': 'application/json' }
	};
	const sandbox = {
		request, response, data: { rules },
		define: { RULES_FILE: file },
		fs,
		ruleUid,
		child_process: { exec() { throw new Error('unexpected child process'); } }
	};
	const route = num === undefined ? 'script-rules.vm.js' : 'script-rules-rule.vm.js';
	vm.runInNewContext(fs.readFileSync(path.join(repositoryRoot, 'api', route), 'utf8'), sandbox, route);
	return response;
}

function createCliFixture(rules) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-cli-'));
	fs.mkdirSync(path.join(directory, 'data'));
	fs.mkdirSync(path.join(directory, 'log'));
	fs.mkdirSync(path.join(directory, 'web'));
	fs.symlinkSync(path.join(repositoryRoot, 'lib'), path.join(directory, 'lib'), 'dir');
	fs.symlinkSync(path.join(repositoryRoot, 'node_modules'), path.join(directory, 'node_modules'), 'dir');
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

describe('Stable rule UID lifecycle', function() {
	it('generates a UID for API-created rules and rejects a duplicate UID', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-api-'));
		const file = path.join(directory, 'rules.json');
		try {
			const existing = [{ ruleUid: 'stable-a', title: 'A' }];
			fs.writeFileSync(file, JSON.stringify(existing));

			const created = runApi(file, 'POST', existing, { title: 'new rule' });
			assert.strictEqual(created.statusCode, 201);
			let saved = readRules(directory);
			assert.strictEqual(saved.length, 2);
			assert.strictEqual(saved[0].ruleUid, 'stable-a');
			assert.match(saved[1].ruleUid, /^[0-9a-f-]{36}$/);

			const beforeDuplicate = fs.readFileSync(file, 'utf8');
			const duplicate = runApi(file, 'POST', saved, { ruleUid: 'stable-a', title: 'duplicate' });
			assert.strictEqual(duplicate.statusCode, 409);
			assert.strictEqual(fs.readFileSync(file, 'utf8'), beforeDuplicate);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('preserves the existing UID through API edits', function() {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chinachu-rule-uid-api-'));
		const file = path.join(directory, 'rules.json');
		try {
			const existing = [{ ruleUid: 'stable-a', title: 'A' }];
			fs.writeFileSync(file, JSON.stringify(existing));
			const response = runApi(file, 'PUT', existing, { ruleUid: 'caller-change', title: 'edited' }, 0);

			assert.strictEqual(response.statusCode, 200);
			const saved = readRules(directory);
			assert.strictEqual(saved[0].title, 'edited');
			assert.strictEqual(saved[0].ruleUid, 'stable-a');
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
});
