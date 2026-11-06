'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const VIDEO_FILTER = 'bwdif=mode=send_frame:parity=auto:deint=all,scale=480:270,setsar=1';
const ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function resolveOutputPath(outputDir, recordedId) {
	const id = String(recordedId || '');
	if (!ID_PATTERN.test(id) || id === '.' || id === '..') return null;
	return path.join(outputDir, id + '.jpg');
}

function removeStoredThumbnail(outputDir, recordedId, fileSystem) {
	fileSystem = fileSystem || fs;
	const outputPath = resolveOutputPath(outputDir, recordedId);
	if (!outputPath) return { removed: false, reason: 'invalid-recorded-id', outputPath: null };
	try {
		fileSystem.unlinkSync(outputPath);
		return { removed: true, reason: null, outputPath: outputPath };
	} catch (error) {
		if (error && error.code === 'ENOENT') return { removed: false, reason: 'not-found', outputPath: outputPath };
		throw error;
	}
}

function createGenerator(options) {
	options = options || {};
	const outputDir = path.resolve(options.outputDir);
	const command = options.command || 'ffmpeg';
	const spawn = options.spawn || childProcess.spawn;
	const fileSystem = options.fs || fs;
	const log = typeof options.log === 'function' ? options.log : function () {};
	const getRunDelay = typeof options.getRunDelay === 'function' ? options.getRunDelay : function () { return 0; };
	const onIdle = typeof options.onIdle === 'function' ? options.onIdle : function () {};
	const onStatus = typeof options.onStatus === 'function' ? options.onStatus : function () {};
	const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
	const maxPending = Number.isInteger(options.maxPending) && options.maxPending >= 0 ? options.maxPending : 4;
	const maxQueueAgeMs = Number(options.maxQueueAgeMs) > 0 ? Number(options.maxQueueAgeMs) : 60000;
	const maxStatusEntries = Number.isInteger(options.maxStatusEntries) && options.maxStatusEntries > 0 ? options.maxStatusEntries : 256;
	const queue = [];
	const scheduledIds = new Set();
	const discardedIds = new Set();
	const cancelledIds = new Set();
	const statuses = new Map();
	let active = null;
	let stopped = false;
	let temporarySequence = 0;
	let resumeTimer = null;

	function setStatus(id, status, reason) {
		const value = {
			id: id,
			status: status,
			available: status === 'complete',
			reason: reason || null,
			updatedAt: Date.now()
		};
		statuses.delete(id);
		statuses.set(id, value);
		while (statuses.size > maxStatusEntries) statuses.delete(statuses.keys().next().value);
		onStatus(id, Object.assign({}, value));
		return Object.assign({}, value);
	}

	function removeTemporary(filePath) {
		try {
			fileSystem.unlinkSync(filePath);
		} catch (error) {
			if (error.code !== 'ENOENT') log('WARNING: Thumbnail temporary file cleanup failed: ' + filePath + ' (' + error.message + ')');
		}
	}

	function finish(job) {
		if (active && active.job === job) active = null;
		scheduledIds.delete(job.id);
		if (!stopped) {
			onIdle();
			runNext();
		}
	}

	async function publish(job, temporaryPath) {
		try {
			if (job.validate) await job.validate();
			if (stopped || discardedIds.has(job.id) || cancelledIds.has(job.id)) throw new Error('thumbnail request cancelled');
			const stat = fileSystem.statSync(temporaryPath);
			if (!stat.isFile() || stat.size <= 0) throw new Error('empty thumbnail output');
			if (!job.replace && fileSystem.existsSync(job.outputPath)) {
				removeTemporary(temporaryPath);
				return 'existing';
			}
			fileSystem.renameSync(temporaryPath, job.outputPath);
			log('THUMBNAIL: ' + job.outputPath);
			return 'generated';
		} catch (error) {
			removeTemporary(temporaryPath);
			log('WARNING: Thumbnail publish failed: ' + job.outputPath + ' (' + error.message + ')');
			return 'failed';
		}
	}

	function run(job) {
		setStatus(job.id, 'processing');
		try {
			fileSystem.mkdirSync(outputDir, { recursive: true });
		} catch (error) {
			log('WARNING: Thumbnail directory creation failed: ' + outputDir + ' (' + error.message + ')');
			setStatus(job.id, 'failed', 'output-unavailable');
			finish(job);
			return;
		}

		if (!job.replace && fileSystem.existsSync(job.outputPath)) {
			setStatus(job.id, 'complete');
			finish(job);
			return;
		}

		const seekSeconds = Number.isFinite(job.durationSeconds) && job.durationSeconds > 0 ? job.durationSeconds * 0.35 : null;
		const temporaryPath = job.outputPath + '.tmp-' + process.pid + '-' + (++temporarySequence);
		const args = [
			'-hide_banner', '-loglevel', 'error', '-threads', '1', '-filter_threads', '1'
		];
		if (seekSeconds !== null) args.push('-ss', seekSeconds.toFixed(3));
		args.push(
			'-i', job.inputPath,
			'-map', '0:v:0',
			'-frames:v', '1',
			'-vf', VIDEO_FILTER,
			'-an', '-c:v', 'mjpeg', '-threads', '1', '-q:v', '3',
			'-f', 'image2', '-y', temporaryPath
		);
		let child;
		let settled = false;
		let timedOut = false;
		let stderr = '';
		let processError = null;

		async function complete(code, error) {
			if (settled) return;
			settled = true;
			if (active && active.timer) clearTimeout(active.timer);
				if (discardedIds.has(job.id)) {
				removeTemporary(temporaryPath);
				try { removeStoredThumbnail(outputDir, job.id, fileSystem); } catch (removeError) {
					log('WARNING: Deleted thumbnail cleanup failed: ' + job.outputPath + ' (' + removeError.message + ')');
				}
					discardedIds.delete(job.id);
					setStatus(job.id, 'source-missing', 'recorded-file-deleted');
				} else if (cancelledIds.has(job.id)) {
					removeTemporary(temporaryPath);
					cancelledIds.delete(job.id);
					setStatus(job.id, 'source-missing', 'recorded-file-deleted');
			} else if (!stopped && !timedOut && !error && code === 0) {
				const outcome = await publish(job, temporaryPath);
				setStatus(job.id, outcome === 'generated' || outcome === 'existing' ? 'complete' : 'failed',
					outcome === 'failed' ? 'publish-failed' : null);
			} else {
				removeTemporary(temporaryPath);
				if (!stopped) {
					const detail = error ? error.message : stderr.trim() || 'exit code ' + code;
					log('WARNING: Thumbnail generation failed: ' + job.inputPath + ' (' + detail + ')');
					setStatus(job.id, 'failed', timedOut ? 'timeout' : 'ffmpeg-failed');
				}
			}
			finish(job);
		}

		try {
			child = spawn(command, args, { stdio: [ 'ignore', 'ignore', 'pipe' ] });
			active = { job: job, child: child, temporaryPath: temporaryPath, timer: null };
			if (child.pid) {
				try { os.setPriority(child.pid, 19); } catch (error) {
					log('WARNING: Thumbnail priority adjustment failed: ' + error.message);
				}
			}
			if (child.stderr) child.stderr.on('data', chunk => {
				stderr = (stderr + chunk.toString()).slice(-8192);
			});
			child.once('error', error => {
				processError = error;
				if (!child.pid) complete(null, error);
			});
			child.once('close', code => complete(code, processError));
			active.timer = setTimeout(() => {
				timedOut = true;
				log('WARNING: Thumbnail generation timed out: ' + job.inputPath);
				try { child.kill('SIGKILL'); } catch (_) {}
			}, timeoutMs);
		} catch (error) {
			complete(null, error);
		}
	}

	function expireQueuedJobs() {
		const now = Date.now();
		let expired = false;
		for (let index = queue.length - 1; index >= 0; index--) {
			const job = queue[index];
			if (now - job.queuedAt >= maxQueueAgeMs) {
				queue.splice(index, 1);
				scheduledIds.delete(job.id);
				log('WARNING: Thumbnail job expired in queue: ' + job.id);
				setStatus(job.id, 'failed', 'queue-expired');
				expired = true;
			}
		}
		return expired;
	}

	function runNext() {
		if (resumeTimer !== null) clearTimeout(resumeTimer);
		resumeTimer = null;
		if (stopped || active) return;
		const expired = expireQueuedJobs();
		if (queue.length > 0) {
			const job = queue[0];
			const delay = getRunDelay(job);
			if (delay > 0) {
				const expiresAt = Math.min(...queue.map(value => value.queuedAt + maxQueueAgeMs));
				resumeTimer = setTimeout(() => {
					resumeTimer = null;
					runNext();
				}, Math.max(1, Math.min(delay, expiresAt - Date.now(), 0x7fffffff)));
				return;
			}
			queue.shift();
			run(job);
			return;
		}
		if (expired) onIdle();
	}

	function enqueue(input) {
		input = input || {};
		const id = String(input.id || '');
		const outputPath = resolveOutputPath(outputDir, id);
		if (!outputPath || typeof input.inputPath !== 'string' || input.inputPath.trim() === '') {
			return { accepted: false, reason: 'invalid' };
		}
		if (stopped) return { accepted: false, reason: 'stopped' };
		expireQueuedJobs();
		if (fileSystem.existsSync(outputPath) && input.replace !== true) {
			setStatus(id, 'complete');
			return { accepted: false, reason: 'existing', outputPath: outputPath };
		}
		if (scheduledIds.has(id)) {
			const current = statuses.get(id);
			return { accepted: false, reason: current && current.status || 'queued', outputPath: outputPath };
		}
		if (queue.length >= maxPending && (active || queue.length > 0)) {
			log('WARNING: Thumbnail queue is full, skip: ' + id);
			setStatus(id, 'failed', 'queue-full');
			return { accepted: false, reason: 'queue-full', outputPath: outputPath };
		}

		const now = Date.now();
		const job = {
			id: id,
			replace: input.replace === true,
			validate: typeof input.validate === 'function' ? input.validate : null,
			inputPath: input.inputPath,
			durationSeconds: Number(input.durationSeconds),
			outputPath: outputPath,
			queuedAt: now,
			requestedAt: Number.isFinite(input.requestedAt) && input.requestedAt > 0 && input.requestedAt <= now ? input.requestedAt : now
		};
		scheduledIds.add(id);
		setStatus(id, 'queued');
		queue.push(job);
		queue.sort((left, right) => left.requestedAt - right.requestedAt || left.queuedAt - right.queuedAt);
		runNext();
		return { accepted: true, reason: active && active.job === job ? 'processing' : 'queued', outputPath: outputPath };
	}

	function stop() {
		stopped = true;
		if (resumeTimer !== null) clearTimeout(resumeTimer);
		resumeTimer = null;
		while (queue.length > 0) {
			const queued = queue.shift();
			scheduledIds.delete(queued.id);
			setStatus(queued.id, 'failed', 'operator-stopping');
		}
		if (!active) return;
		const current = active;
		setStatus(current.job.id, 'failed', 'operator-stopping');
		if (current.timer) clearTimeout(current.timer);
		removeTemporary(current.temporaryPath);
		try { current.child.kill('SIGKILL'); } catch (error) {
			log('WARNING: Thumbnail FFmpeg stop failed: ' + error.message);
		}
	}

	function getState() {
		return { active: active ? active.job.id : null, pending: queue.length,
			pendingSince: queue.length ? queue[0].requestedAt : null, stopped: stopped };
	}

	function getPendingJobs() {
		return queue.slice(0, 5).map(job => ({ id: job.id, queuedAt: job.queuedAt, requestedAt: job.requestedAt }));
	}

	function getStatus(recordedId) {
		const id = String(recordedId || '');
		const outputPath = resolveOutputPath(outputDir, id);
		if (!outputPath) return null;
		if (scheduledIds.has(id) && statuses.has(id)) return Object.assign({}, statuses.get(id));
		if (fileSystem.existsSync(outputPath)) return setStatus(id, 'complete');
		return statuses.has(id) ? Object.assign({}, statuses.get(id)) : {
			id: id,
			status: 'not-generated',
			available: false,
			reason: null,
			updatedAt: null
		};
	}

	function markSourceMissing(recordedId) {
		const id = String(recordedId || '');
		if (!resolveOutputPath(outputDir, id)) return null;
		return setStatus(id, 'source-missing', 'recorded-file-missing');
	}

	function discard(recordedId) {
		const id = String(recordedId || '');
		const outputPath = resolveOutputPath(outputDir, id);
		if (!outputPath) return { removed: false, cancelled: false, reason: 'invalid-recorded-id' };
		let cancelled = false;
		for (let index = queue.length - 1; index >= 0; index--) {
			if (queue[index].id !== id) continue;
			queue.splice(index, 1);
			scheduledIds.delete(id);
			cancelled = true;
		}
		if (active && active.job.id === id) {
			discardedIds.add(id);
			cancelled = true;
			try { active.child.kill('SIGKILL'); } catch (_) {}
		}
		const removed = removeStoredThumbnail(outputDir, id, fileSystem);
		if (!active || active.job.id !== id) discardedIds.delete(id);
		setStatus(id, 'source-missing', 'recorded-file-deleted');
		return { removed: removed.removed, cancelled: cancelled, reason: removed.reason };
	}

	function cancel(recordedId) {
		const id = String(recordedId || '');
		const outputPath = resolveOutputPath(outputDir, id);
		if (!outputPath) return { removed: false, cancelled: false, reason: 'invalid-recorded-id' };
		let cancelled = false;
		for (let index = queue.length - 1; index >= 0; index--) {
			if (queue[index].id !== id) continue;
			queue.splice(index, 1);
			scheduledIds.delete(id);
			cancelled = true;
		}
		if (active && active.job.id === id) {
			cancelledIds.add(id);
			cancelled = true;
			try { active.child.kill('SIGKILL'); } catch (_) {}
		}
		if (!active || active.job.id !== id) cancelledIds.delete(id);
		setStatus(id, 'source-missing', 'recorded-file-deleted');
		return { removed: false, cancelled: cancelled, reason: null };
	}

	return { enqueue: enqueue, stop: stop, resume: runNext, getState: getState, getPendingJobs: getPendingJobs, getStatus: getStatus, markSourceMissing: markSourceMissing,
		discard: discard, cancel: cancel };
}

module.exports = {
	VIDEO_FILTER: VIDEO_FILTER,
	resolveOutputPath: resolveOutputPath,
	removeStoredThumbnail: removeStoredThumbnail,
	createGenerator: createGenerator
};
