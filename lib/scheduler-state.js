'use strict';

const fs = require('fs');

const STATE_VERSION = 2;
const LEGACY_STATE_VERSION = 1;

function emptyState() {
	return {
		version: STATE_VERSION,
		lastSchedulerStartedAt: 0,
		lastSchedulerSuccessAt: 0,
		lastAppliedParentId: null,
		lastAppliedAt: 0
	};
}

function normalizeTimestamp(value) {
	const timestamp = Number(value);
	return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : 0;
}

function normalizeState(value, options) {
	options = options || {};
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('state is not an object');
	}
	if (value.version !== STATE_VERSION && !(options.allowLegacy && value.version === LEGACY_STATE_VERSION)) {
		throw new Error('unsupported state version');
	}

	const state = emptyState();
	state.lastSchedulerStartedAt = normalizeTimestamp(value.lastSchedulerStartedAt);
	state.lastSchedulerSuccessAt = normalizeTimestamp(value.lastSchedulerSuccessAt);
	state.lastAppliedParentId = typeof value.lastAppliedParentId === 'string' && value.lastAppliedParentId !== ''
		? value.lastAppliedParentId
		: null;
	state.lastAppliedAt = normalizeTimestamp(value.lastAppliedAt);
	return state;
}

class SchedulerStateStore {
	constructor(filePath, options) {
		options = options || {};
		if (!filePath) {
			throw new Error('state file path is required');
		}
		this.filePath = filePath;
		this.legacyFilePath = options.legacyFilePath || null;
	}

	load() {
		try {
			return normalizeState(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
		} catch (error) {
			if (!error || error.code !== 'ENOENT') {
				throw error;
			}
		}

		if (!this.legacyFilePath) {
			return emptyState();
		}

		let legacy;
		try {
			legacy = normalizeState(JSON.parse(fs.readFileSync(this.legacyFilePath, 'utf8')), { allowLegacy: true });
		} catch (error) {
			if (error && error.code === 'ENOENT') {
				return emptyState();
			}
			throw error;
		}

		this.save(legacy);
		return legacy;
	}

	save(value) {
		const state = normalizeState(value);
		const temporaryPath = this.filePath + '.tmp.' + process.pid;

		try {
			fs.writeFileSync(temporaryPath, JSON.stringify(state) + '\n', { mode: 0o600 });
			fs.renameSync(temporaryPath, this.filePath);
		} finally {
			try {
				fs.unlinkSync(temporaryPath);
			} catch (_) {}
		}
	}

	update(mutator) {
		const current = this.load();
		const next = mutator(Object.assign({}, current));
		const normalized = normalizeState(next || current);
		this.save(normalized);
		return normalized;
	}

	recordSchedulerSuccess(startedAt, successAt) {
		startedAt = normalizeTimestamp(startedAt);
		successAt = normalizeTimestamp(successAt);
		if (startedAt === 0 || successAt === 0 || successAt < startedAt) {
			throw new Error('invalid scheduler success timestamps');
		}

		return this.update(state => {
			if (successAt >= state.lastSchedulerSuccessAt) {
				state.lastSchedulerStartedAt = startedAt;
				state.lastSchedulerSuccessAt = successAt;
			}
			return state;
		});
	}

	recordAppliedParent(parentId, appliedAt) {
		appliedAt = normalizeTimestamp(appliedAt);
		if (typeof parentId !== 'string' || parentId === '' || appliedAt === 0) {
			throw new Error('invalid applied parent state');
		}

		return this.update(state => {
			if (appliedAt >= state.lastAppliedAt) {
				state.lastAppliedParentId = parentId;
				state.lastAppliedAt = appliedAt;
			}
			return state;
		});
	}
}

module.exports = {
	STATE_VERSION: STATE_VERSION,
	SchedulerStateStore: SchedulerStateStore,
	emptyState: emptyState,
	normalizeState: normalizeState
};
