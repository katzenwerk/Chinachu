'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');

function capturePreviewCommand(scriptName, collectionName, program) {
	let command = null;
	const context = {
		Buffer: Buffer,
		child_process: {
			exec(value, options, callback) {
				command = value;
				callback(null, 'preview-image', '');
				return { kill() {} };
			}
		},
		chinachu: {
			getProgramById(id, collection) {
				assert.strictEqual(id, 'program-id');
				assert.strictEqual(collection, context.data[collectionName]);
				return program;
			}
		},
		clearTimeout() {},
		data: {
			recorded: [],
			recording: [],
			status: { feature: { previewer: true } }
		},
		define: { MATCH_DATA_FILE: '/not-used/match.json' },
		fs: {
			existsSync() { return true; },
			readFileSync() { throw new Error('unexpected match data read'); },
			writeFileSync() { throw new Error('unexpected match data write'); }
		},
		request: {
			param: { id: 'program-id' },
			query: { width: '480', height: '270' },
			type: 'jpg'
		},
		response: {
			end() {},
			error(code) { throw new Error('unexpected response error: ' + code); },
			head(code) { assert.strictEqual(code, 200); }
		},
		setTimeout() { return {}; },
		util: { log() {} }
	};

	vm.runInNewContext(
		fs.readFileSync(path.join(repositoryRoot, 'api', scriptName), 'utf8'),
		context,
		{ filename: scriptName }
	);

	return command;
}

function assertSelectsFirstVideoStream(command, routeName) {
	assert.match(
		command,
		/(?:^|\s)-map 0:v:0(?:\s|$)/,
		routeName + ' must select the first video stream by type when stream index 0 is non-video'
	);
	assert.doesNotMatch(
		command,
		/(?:^|\s)-map 0:0(?:\s|$)/,
		routeName + ' must not assume that input stream index 0 is video'
	);
}

describe('preview FFmpeg stream selection', function() {
	it('selects the first video stream for an in-progress recording even when stream 0 is non-video', function() {
		const command = capturePreviewCommand('script-recording-program-preview.vm.js', 'recording', {
			id: 'program-id',
			pid: 1234,
			recorded: '/recordings/in-progress.m2ts'
		});

		assertSelectsFirstVideoStream(command, 'recording preview');
	});

	it('selects the first video stream for a recorded program even when stream 0 is non-video', function() {
		const command = capturePreviewCommand('script-recorded-program-preview.vm.js', 'recorded', {
			id: 'program-id',
			recorded: '/recordings/completed.m2ts'
		});

		assertSelectsFirstVideoStream(command, 'recorded preview');
	});
});
