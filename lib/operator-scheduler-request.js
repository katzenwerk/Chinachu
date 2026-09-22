'use strict';

class OperatorSchedulerRequest {
	constructor(options) {
		options = options || {};
		if (typeof options.isSchedulerRunning !== 'function') {
			throw new Error('isSchedulerRunning is required');
		}
		if (typeof options.startScheduler !== 'function') {
			throw new Error('startScheduler is required');
		}

		this.isSchedulerRunning = options.isSchedulerRunning;
		this.startScheduler = options.startScheduler;
		this.isShuttingDown = options.isShuttingDown || function () { return false; };
		this.getSchedulerStartedAt = options.getSchedulerStartedAt || function () { return 0; };
		this.logger = options.log || function () {};
		this.stateStore = options.stateStore || null;
		this.state = this.loadState();
		this.finalizedParentIds = new Set();
		if (this.state.lastAppliedParentId) {
			this.finalizedParentIds.add(this.state.lastAppliedParentId);
		}
		this.activeParentIds = new Set();
		this.pending = false;
		this.pendingParentIds = new Set();
	}

	requestEpgCycle(parentId, summary, metadata) {
		metadata = metadata || {};
		this.refreshState();
		if (this.hasTrackedParent(parentId)) {
			return false;
		}

		const failed = Number(summary && summary.failed) || 0;
		const aborted = Number(summary && summary.aborted) || 0;
		if (failed !== 0 || aborted !== 0) {
			this.finalizedParentIds.add(parentId);
			this.logEpg(
				this.sourceLabel(metadata, 'scheduler skipped') + ': parent=' + parentId +
				' failed=' + failed +
				' aborted=' + aborted
			);
			return false;
		}

		const completedAt = Number(metadata.completedAt);
		if (Number.isFinite(completedAt) && completedAt <= this.state.lastSchedulerStartedAt) {
			this.finalizedParentIds.add(parentId);
			return false;
		}

		if (this.isShuttingDown()) {
			this.logEpg(this.sourceLabel(metadata, 'scheduler skipped') + ': parent=' + parentId + ' reason=operator-shutdown');
			return false;
		}

		if (this.isSchedulerRunning()) {
			const schedulerStartedAt = Number(this.getSchedulerStartedAt());
			if (Number.isFinite(completedAt) && completedAt > 0 && schedulerStartedAt >= completedAt) {
				this.activeParentIds.add(parentId);
				this.logEpg('reconciliation recovered: parent=' + parentId + ' scheduler=running');
				return true;
			}
			if (!this.pending) {
				this.pending = true;
				this.logEpg(this.sourceLabel(metadata, 'scheduler pending') + ': parent=' + parentId);
			}
			this.pendingParentIds.add(parentId);
			return true;
		}

		this.logEpg(this.sourceLabel(metadata, 'scheduler requested') + ': parent=' + parentId);
		return this.startSafely([ parentId ]);
	}

	onSchedulerExit(result) {
		result = result || {};
		const successful = result.successful === true;
		const finishedAt = Number(result.finishedAt) || Date.now();
		const completedParentIds = Array.from(this.activeParentIds);
		this.activeParentIds.clear();

		if (successful) {
			completedParentIds.forEach(parentId => this.finalizedParentIds.add(parentId));
			if (completedParentIds.length !== 0) {
				this.saveAppliedParent(completedParentIds[completedParentIds.length - 1], finishedAt);
			} else {
				this.refreshState();
			}
		}

		if (!this.pending) {
			return false;
		}

		const parentIds = Array.from(this.pendingParentIds);
		this.pending = false;
		this.pendingParentIds.clear();

		if (this.isShuttingDown()) {
			return false;
		}

		this.logEpg('scheduler requested: parent=' + parentIds[0] + ' pending=true');
		return this.startSafely(parentIds);
	}

	startSafely(parentIds) {
		parentIds.forEach(parentId => this.activeParentIds.add(parentId));
		try {
			if (this.startScheduler() === false) {
				throw new Error('scheduler did not start');
			}
			return true;
		} catch (error) {
			parentIds.forEach(parentId => this.activeParentIds.delete(parentId));
			this.logEpg(
				'scheduler request failed: parent=' + parentIds[0] +
				' error=' + (error && error.message ? error.message : String(error))
			);
			return false;
		}
	}

	hasTrackedParent(parentId) {
		return this.finalizedParentIds.has(parentId) ||
			this.activeParentIds.has(parentId) ||
			this.pendingParentIds.has(parentId);
	}

	loadState() {
		const fallback = {
			version: 2,
			lastSchedulerStartedAt: 0,
			lastSchedulerSuccessAt: 0,
			lastAppliedParentId: null,
			lastAppliedAt: 0
		};
		if (!this.stateStore) {
			return fallback;
		}
		try {
			return this.stateStore.load();
		} catch (error) {
			this.logEpg('scheduler state load failed: ' + this.errorMessage(error));
			return fallback;
		}
	}

	refreshState() {
		if (!this.stateStore || typeof this.stateStore.load !== 'function') {
			return this.state;
		}
		try {
			this.state = this.stateStore.load();
			if (this.state.lastAppliedParentId) {
				this.finalizedParentIds.add(this.state.lastAppliedParentId);
			}
		} catch (error) {
			this.logEpg('scheduler state load failed: ' + this.errorMessage(error));
		}
		return this.state;
	}

	saveAppliedParent(parentId, appliedAt) {
		if (!this.stateStore) {
			return;
		}
		try {
			if (typeof this.stateStore.recordAppliedParent === 'function') {
				this.state = this.stateStore.recordAppliedParent(parentId, appliedAt);
				return;
			}
			this.state.lastAppliedParentId = parentId;
			this.state.lastAppliedAt = appliedAt;
			this.stateStore.save(this.state);
		} catch (error) {
			this.logEpg('scheduler state save failed: ' + this.errorMessage(error));
		}
	}

	sourceLabel(metadata, defaultLabel) {
		if (metadata.source !== 'reconciliation') {
			return defaultLabel;
		}
		if (defaultLabel === 'scheduler requested') {
			return 'reconciliation recovered';
		}
		return 'reconciliation ' + defaultLabel.replace('scheduler ', '');
	}

	getState() {
		return {
			pending: this.pending,
			pendingParentIds: Array.from(this.pendingParentIds),
			activeParentIds: Array.from(this.activeParentIds),
			finalizedParentIds: Array.from(this.finalizedParentIds),
			lastSchedulerStartedAt: this.state.lastSchedulerStartedAt,
			lastSchedulerSuccessAt: this.state.lastSchedulerSuccessAt,
			lastAppliedParentId: this.state.lastAppliedParentId
		};
	}

	errorMessage(error) {
		return error && error.message ? error.message : String(error);
	}

	logEpg(message) {
		try {
			this.logger('EPG: ' + message);
		} catch (_) {}
	}
}

function createSchedulerRequest(options) {
	return new OperatorSchedulerRequest(options);
}

module.exports = {
	OperatorSchedulerRequest: OperatorSchedulerRequest,
	createSchedulerRequest: createSchedulerRequest
};
