'use strict';

const epgJobWatch = require('./mirakurun-epg-job-watch');

const DEFAULT_INTERVAL_MS = 1000 * 60 * 5;
const DEFAULT_PARENT_GRACE_MS = 1000 * 60 * 10;

function isTimestamp(value) {
	if (value === null || value === undefined || value === '') {
		return false;
	}
	const timestamp = Number(value);
	return Number.isFinite(timestamp) && timestamp > 0;
}

function findLatestSettledCycle(jobs, now, parentGraceMs) {
	if (!Array.isArray(jobs)) {
		throw new Error('Mirakurun jobs response is not an array');
	}

	const parents = jobs.filter(job => {
		return job &&
			job.key === epgJobWatch.PARENT_JOB_KEY &&
			job.id !== undefined && job.id !== null && job.id !== '' &&
			isTimestamp(job.startedAt) &&
			(job.finishedAt === undefined || job.finishedAt === null || isTimestamp(job.finishedAt));
	}).sort((a, b) => Number(b.startedAt) - Number(a.startedAt));

	if (parents.length === 0) {
		return null;
	}

	const parent = parents[0];
	if (!epgJobWatch.isParentFinished(parent) || !isTimestamp(parent.finishedAt)) {
		return null;
	}
	if (now - Number(parent.startedAt) < parentGraceMs) {
		return null;
	}

	const children = jobs.filter(job => epgJobWatch.isChildForCycle(job, parent));
	if (children.length === 0) {
		return null;
	}

	const summary = {
		total: children.length,
		completed: 0,
		skipped: 0,
		failed: 0,
		aborted: 0
	};
	let completedAt = 0;

	for (const child of children) {
		const state = epgJobWatch.getTerminalState(child);
		const finishedAt = Number(child.finishedAt);
		if (state === null || !isTimestamp(child.finishedAt)) {
			return null;
		}
		summary[state]++;
		completedAt = Math.max(completedAt, finishedAt);
	}

	if (completedAt === 0) {
		return null;
	}

	return {
		parentId: parent.id,
		parent: parent,
		childIds: children.map(child => child.id),
		completedAt: completedAt,
		summary: summary
	};
}

class MirakurunEpgReconciler {
	constructor(options) {
		options = options || {};
		if (typeof options.fetchJobs !== 'function') {
			throw new Error('fetchJobs is required');
		}
		if (typeof options.requestCycle !== 'function') {
			throw new Error('requestCycle is required');
		}

		this.fetchJobs = options.fetchJobs;
		this.requestCycle = options.requestCycle;
		this.logger = options.log || function () {};
		this.now = options.now || Date.now;
		this.setTimer = options.setTimeout || setTimeout;
		this.clearTimer = options.clearTimeout || clearTimeout;
		this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
		this.parentGraceMs = options.parentGraceMs || DEFAULT_PARENT_GRACE_MS;
		this.timer = null;
		this.inFlight = null;
		this.started = false;
		this.stopped = true;
	}

	start() {
		if (this.started && !this.stopped) {
			return this;
		}
		this.started = true;
		this.stopped = false;
		this.scheduleNext();
		return this;
	}

	stop() {
		this.stopped = true;
		this.started = false;
		if (this.timer !== null) {
			this.clearTimer(this.timer);
			this.timer = null;
		}
	}

	check() {
		if (this.stopped) {
			return Promise.resolve(null);
		}
		if (this.inFlight !== null) {
			return this.inFlight;
		}

		this.inFlight = this.runCheck().catch(error => {
			if (!this.stopped) {
				this.log('reconciliation failed: ' + this.errorMessage(error));
			}
			return null;
		}).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	async runCheck() {
		const jobs = await this.fetchJobs();
		if (this.stopped) {
			return null;
		}

		const cycle = findLatestSettledCycle(jobs, this.now(), this.parentGraceMs);
		if (cycle === null) {
			return null;
		}

		this.requestCycle(cycle.parentId, cycle.summary, {
			source: 'reconciliation',
			completedAt: cycle.completedAt
		});
		return cycle;
	}

	scheduleNext() {
		if (this.stopped || this.timer !== null) {
			return;
		}
		try {
			this.timer = this.setTimer(async () => {
				this.timer = null;
				await this.check();
				this.scheduleNext();
			}, this.intervalMs);
		} catch (error) {
			this.timer = null;
			this.log('reconciliation timer failed: ' + this.errorMessage(error));
		}
	}

	getState() {
		return {
			started: this.started,
			stopped: this.stopped,
			timerPending: this.timer !== null,
			checkPending: this.inFlight !== null
		};
	}

	errorMessage(error) {
		return error && error.message ? error.message : String(error);
	}

	log(message) {
		try {
			this.logger('EPG: ' + message);
		} catch (_) {}
	}
}

function createReconciler(options) {
	return new MirakurunEpgReconciler(options);
}

module.exports = {
	DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
	DEFAULT_PARENT_GRACE_MS: DEFAULT_PARENT_GRACE_MS,
	MirakurunEpgReconciler: MirakurunEpgReconciler,
	createReconciler: createReconciler,
	findLatestSettledCycle: findLatestSettledCycle
};
