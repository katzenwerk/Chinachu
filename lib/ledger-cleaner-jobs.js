'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

function clone(value) {
	return value === null ? null : JSON.parse(JSON.stringify(value));
}

function createLedgerCleanerJobs(options) {
	options = options || {};
	let current = null;
	let currentWorker = null;
	let sequence = 0;

	function publicState() {
		return clone(current);
	}

	function runWorker(type, payload) {
		if (current && current.status === 'running') {
			const error = new Error('A ledger scan is already running.');
			error.statusCode = 409;
			throw error;
		}
		const id = String(++sequence) + '-' + Date.now().toString(36);
		current = {
			id,
			type,
			previewId: payload.previewId || null,
			status: 'running',
			startedAt: Date.now(),
			completedAt: null,
			progress: { phase: 'queued', files: 0, visitedDirectories: 0 },
			result: null,
			error: null
		};
		const worker = new Worker(path.join(__dirname, 'ledger-cleaner-worker.js'), {
			workerData: Object.assign({ rootDir: options.rootDir, action: type }, payload.workerData)
		});
		currentWorker = worker;
		worker.on('message', message => {
			if (!current || current.id !== id || !message) return;
			if (message.type === 'progress') current.progress = message.progress;
			if (message.type === 'result') {
				current.status = 'complete';
				current.completedAt = Date.now();
				current.result = message.result;
				current.progress = message.result.index ? { phase: 'complete', files: message.result.index.files,
					visitedDirectories: message.result.index.visitedDirectories } :
					{ phase: 'complete', files: 0, visitedDirectories: 0 };
			}
			if (message.type === 'error') {
				current.status = 'failed';
				current.completedAt = Date.now();
				current.error = message.error;
			}
		});
		worker.on('error', error => {
			if (!current || current.id !== id || current.status !== 'running') return;
			current.status = 'failed';
			current.completedAt = Date.now();
			current.error = { message: error.message, code: error.code || null };
		});
		worker.on('exit', code => {
			if (current && current.id === id && current.status === 'running') {
				current.status = 'failed';
				current.completedAt = Date.now();
				current.error = { message: 'Ledger cleaner worker exited before producing a result.', code: String(code) };
			}
			if (currentWorker === worker) currentWorker = null;
		});
		return publicState();
	}

	function start(request) {
		return runWorker('scan', { workerData: { request } });
	}

	function apply(previewId) {
		if (!current || current.type !== 'scan' || current.status !== 'complete' || !current.result || current.id !== previewId) {
			const error = new Error('A completed current preview is required.');
			error.statusCode = 409;
			throw error;
		}
		if (!current.result.applyAvailable || !current.result.index || !current.result.index.complete) {
			const error = new Error('This preview cannot be applied safely.');
			error.statusCode = 409;
			throw error;
		}
		const plan = current.result;
		return runWorker('apply', { previewId, workerData: { plan } });
	}

	return { get: publicState, start, apply };
}

module.exports = { createLedgerCleanerJobs };
