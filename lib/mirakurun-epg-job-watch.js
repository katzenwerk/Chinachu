'use strict';

const EventEmitter = require('events');
const { StringDecoder } = require('string_decoder');

const PARENT_JOB_KEY = 'EPG.Gatherer';
const CHILD_JOB_KEY_PATTERN = /^EPG\.Gather\.NID\.[^.]+$/;
const DEFAULT_RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_DELAY_MS = 60000;

class JsonObjectStreamParser {
	constructor(onMessage, onError) {
		this.onMessage = onMessage;
		this.onError = onError;
		this.reset();
	}

	reset() {
		this.decoder = new StringDecoder('utf8');
		this.object = '';
		this.depth = 0;
		this.inString = false;
		this.escaped = false;
	}

	write(chunk) {
		const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);

		for (let i = 0; i < text.length; i++) {
			const character = text.charAt(i);

			if (this.depth === 0) {
				if (character === '{') {
					this.object = character;
					this.depth = 1;
					this.inString = false;
					this.escaped = false;
				}
				continue;
			}

			this.object += character;

			if (this.inString) {
				if (this.escaped) {
					this.escaped = false;
				} else if (character === '\\') {
					this.escaped = true;
				} else if (character === '"') {
					this.inString = false;
				}
				continue;
			}

			if (character === '"') {
				this.inString = true;
			} else if (character === '{') {
				this.depth++;
			} else if (character === '}') {
				this.depth--;

				if (this.depth === 0) {
					this.emitObject();
				}
			}
		}
	}

	emitObject() {
		const object = this.object;
		this.object = '';
		this.inString = false;
		this.escaped = false;

		try {
			this.onMessage(JSON.parse(object));
		} catch (error) {
			if (this.onError) {
				this.onError(error);
			}
		}
	}
}

function getTerminalState(job) {
	if (!job) {
		return null;
	}

	if (job.hasFailed === true || job.status === 'failed') {
		return 'failed';
	}
	if (job.hasSkipped === true || job.status === 'skipped') {
		return 'skipped';
	}
	if (job.hasAborted === true || job.status === 'aborted') {
		return 'aborted';
	}
	if (job.status === 'finished' || job.status === 'completed') {
		return 'completed';
	}

	return null;
}

function isParentFinished(job) {
	return Boolean(job && (job.status === 'finished' || getTerminalState(job) !== null));
}

function isChildForCycle(job, parent) {
	if (!job || !parent || !CHILD_JOB_KEY_PATTERN.test(String(job.key || ''))) {
		return false;
	}

	const createdAt = Number(job.createdAt);
	const startedAt = Number(parent.startedAt);
	const finishedAt = Number(parent.finishedAt);

	return Number.isFinite(createdAt) &&
		Number.isFinite(startedAt) &&
		Number.isFinite(finishedAt) &&
		startedAt <= createdAt && createdAt <= finishedAt;
}

class MirakurunEpgJobWatcher extends EventEmitter {
	constructor(options) {
		super();

		options = options || {};
		if (!options.client) {
			throw new Error('Mirakurun client is required');
		}

		this.client = options.client;
		this.logger = options.log || function () {};
		this.onCycleSettled = options.onCycleSettled || function () {};
		this.fetchJobs = options.fetchJobs || (() => this.fetchJobsFromClient());
		this.setTimer = options.setTimeout || setTimeout;
		this.clearTimer = options.clearTimeout || clearTimeout;
		this.reconnectDelayMs = options.reconnectDelayMs || DEFAULT_RECONNECT_DELAY_MS;

		this.stream = null;
		this.reconnectTimer = null;
		this.reconnectAttempts = 0;
		this.connecting = false;
		this.started = false;
		this.stopped = true;
		this.connectionGeneration = 0;
		this.cycle = null;
	}

	start() {
		if (this.started && !this.stopped) {
			return this;
		}

		this.started = true;
		this.stopped = false;
		this.connect();
		return this;
	}

	stop() {
		if (this.stopped) {
			return;
		}

		this.stopped = true;
		this.started = false;
		this.connecting = false;
		this.connectionGeneration++;

		if (this.reconnectTimer !== null) {
			this.clearTimer(this.reconnectTimer);
			this.reconnectTimer = null;
		}

		if (this.stream !== null) {
			const stream = this.stream;
			this.stream = null;
			this.detachStream(stream);
			this.destroyStream(stream);
			this.log('disconnected');
		}

		this.cycle = null;
		this.removeAllListeners();
	}

	async connect() {
		if (this.stopped || this.connecting || this.stream !== null) {
			return;
		}

		this.connecting = true;
		const generation = ++this.connectionGeneration;

		try {
			const stream = await this.client.getEventsStream({ type: 'update' });

			if (this.stopped || generation !== this.connectionGeneration) {
				this.destroyStream(stream);
				return;
			}

			this.connecting = false;
			this.stream = stream;
			this.reconnectAttempts = 0;
			this.attachStream(stream);
			this.log('connected');
			this.emit('connected');

			if (this.cycle && this.cycle.frozen && !this.cycle.settled) {
				this.reconcileFrozenChildren(this.cycle);
			}
		} catch (error) {
			if (this.stopped || generation !== this.connectionGeneration) {
				return;
			}

			this.connecting = false;
			this.log('connection failed: ' + this.errorMessage(error));
			this.scheduleReconnect();
		}
	}

	attachStream(stream) {
		const parser = new JsonObjectStreamParser(
			message => this.handleMessage(message),
			error => this.log('invalid event: ' + this.errorMessage(error))
		);
		const disconnect = reason => this.handleDisconnect(stream, reason);

		stream._chinachuEpgWatchListeners = {
			data: chunk => parser.write(chunk),
			end: () => disconnect('end'),
			close: () => disconnect('close'),
			error: error => disconnect('error: ' + this.errorMessage(error))
		};

		Object.keys(stream._chinachuEpgWatchListeners).forEach(eventName => {
			stream.on(eventName, stream._chinachuEpgWatchListeners[eventName]);
		});
	}

	detachStream(stream) {
		const listeners = stream && stream._chinachuEpgWatchListeners;
		if (!listeners) {
			return;
		}

		Object.keys(listeners).forEach(eventName => {
			stream.removeListener(eventName, listeners[eventName]);
		});
		delete stream._chinachuEpgWatchListeners;
	}

	destroyStream(stream) {
		if (!stream) {
			return;
		}

		if (stream.req && typeof stream.req.destroy === 'function' && stream.req.destroyed !== true) {
			stream.req.destroy();
		}
		if (typeof stream.destroy === 'function' && stream.destroyed !== true) {
			stream.destroy();
		}
	}

	handleDisconnect(stream, reason) {
		if (this.stopped || this.stream !== stream) {
			return;
		}

		this.stream = null;
		this.detachStream(stream);
		this.destroyStream(stream);
		this.log('disconnected: ' + reason);
		this.emit('disconnected', reason);
		this.scheduleReconnect();
	}

	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer !== null) {
			return;
		}

		const delay = Math.min(
			this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts),
			MAX_RECONNECT_DELAY_MS
		);
		this.reconnectAttempts++;
		this.log('reconnecting in ' + delay + 'ms');
		this.emit('reconnecting', delay);

		this.reconnectTimer = this.setTimer(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	async fetchJobsFromClient() {
		const response = await this.client.call('getJobs');
		return response && Object.prototype.hasOwnProperty.call(response, 'body') ? response.body : response;
	}

	handleMessage(message) {
		if (this.stopped || !message || message.resource !== 'job') {
			return;
		}

		const job = message.data;
		if (!job || job.id === undefined || job.id === null || job.id === '' || !job.key) {
			return;
		}

		if (job.key === PARENT_JOB_KEY) {
			this.handleParent(job);
			return;
		}

		this.handleChild(job);
	}

	handleParent(job) {
		if (!this.cycle || this.cycle.parentId !== job.id) {
			// A finished parent seen without an earlier active-state event can be an old
			// history-removal re-emission. Only active parents open a new cycle.
			if (isParentFinished(job)) {
				return;
			}

			this.cycle = {
				parentId: job.id,
				parent: Object.assign({}, job),
				freezeStarted: false,
				frozen: false,
				childIds: new Set(),
				childStates: new Map(),
				pendingChildEvents: new Map(),
				settled: false
			};
			this.log('cycle detected: ' + job.id);
			this.emit('cycleDetected', job.id);
		} else {
			Object.assign(this.cycle.parent, job);
		}

		if (isParentFinished(this.cycle.parent)) {
			this.freezeChildren(this.cycle);
		}
	}

	async freezeChildren(cycle) {
		if (this.stopped || cycle !== this.cycle || cycle.freezeStarted || cycle.frozen) {
			return;
		}

		cycle.freezeStarted = true;

		try {
			const jobs = await this.fetchJobs();
			if (this.stopped || cycle !== this.cycle) {
				return;
			}
			if (!Array.isArray(jobs)) {
				throw new Error('Mirakurun jobs response is not an array');
			}

			jobs.filter(job => isChildForCycle(job, cycle.parent)).forEach(job => {
				cycle.childIds.add(job.id);
				cycle.childStates.set(job.id, getTerminalState(job));
			});
			cycle.frozen = true;
			this.log('children frozen: ' + cycle.childIds.size + ' parent=' + cycle.parentId);
			this.emit('childrenFrozen', cycle.parentId, Array.from(cycle.childIds));

			cycle.childStates.forEach((state, id) => {
				if (state !== null) {
					this.log('child settled: ' + id + ' state=' + state);
					this.emit('childSettled', cycle.parentId, id, state);
				}
			});

			cycle.pendingChildEvents.forEach(job => this.handleChild(job));
			cycle.pendingChildEvents.clear();
			this.checkCycleSettled(cycle);
		} catch (error) {
			cycle.freezeStarted = false;
			this.log('jobs snapshot failed: ' + this.errorMessage(error));
			this.emit('snapshotError', error);
		}
	}

	handleChild(job) {
		const cycle = this.cycle;
		if (!cycle || cycle.settled) {
			return;
		}

		if (!cycle.frozen) {
			if (CHILD_JOB_KEY_PATTERN.test(String(job.key || ''))) {
				cycle.pendingChildEvents.set(job.id, job);
			}
			return;
		}

		if (!cycle.childIds.has(job.id)) {
			return;
		}

		const state = getTerminalState(job);
		if (state === null || cycle.childStates.get(job.id) !== null) {
			return;
		}

		cycle.childStates.set(job.id, state);
		this.log('child settled: ' + job.id + ' state=' + state);
		this.emit('childSettled', cycle.parentId, job.id, state);
		this.checkCycleSettled(cycle);
	}

	async reconcileFrozenChildren(cycle) {
		try {
			const jobs = await this.fetchJobs();
			if (this.stopped || cycle !== this.cycle || !Array.isArray(jobs)) {
				return;
			}

			jobs.forEach(job => {
				if (cycle.childIds.has(job.id)) {
					this.handleChild(job);
				}
			});
		} catch (error) {
			if (!this.stopped && cycle === this.cycle) {
				this.log('reconnect snapshot failed: ' + this.errorMessage(error));
				this.emit('snapshotError', error);
			}
		}
	}

	checkCycleSettled(cycle) {
		if (cycle.settled || cycle.childIds.size === 0) {
			return;
		}

		const summary = {
			total: cycle.childIds.size,
			completed: 0,
			skipped: 0,
			failed: 0,
			aborted: 0
		};

		for (const state of cycle.childStates.values()) {
			if (state === null) {
				return;
			}
			summary[state]++;
		}

		cycle.settled = true;
		this.log(
			'cycle settled: parent=' + cycle.parentId +
			' total=' + summary.total +
			' completed=' + summary.completed +
			' skipped=' + summary.skipped +
			' failed=' + summary.failed +
			' aborted=' + summary.aborted
		);
		try {
			this.onCycleSettled(cycle.parentId, summary);
		} catch (error) {
			this.log('cycle handler failed: ' + this.errorMessage(error));
		}
		this.emit('cycleSettled', cycle.parentId, summary);
	}

	getState() {
		return {
			started: this.started,
			stopped: this.stopped,
			connected: this.stream !== null,
			reconnectPending: this.reconnectTimer !== null,
			cycle: this.cycle === null ? null : {
				parentId: this.cycle.parentId,
				frozen: this.cycle.frozen,
				settled: this.cycle.settled,
				childIds: Array.from(this.cycle.childIds),
				childStates: Object.fromEntries(this.cycle.childStates)
			}
		};
	}

	errorMessage(error) {
		if (!error) {
			return 'unknown error';
		}
		return error.message || String(error);
	}

	log(message) {
		this.logger('EPG: ' + message);
	}
}

function createWatcher(options) {
	return new MirakurunEpgJobWatcher(options);
}

module.exports = {
	CHILD_JOB_KEY_PATTERN: CHILD_JOB_KEY_PATTERN,
	PARENT_JOB_KEY: PARENT_JOB_KEY,
	JsonObjectStreamParser: JsonObjectStreamParser,
	MirakurunEpgJobWatcher: MirakurunEpgJobWatcher,
	createWatcher: createWatcher,
	getTerminalState: getTerminalState,
	isChildForCycle: isChildForCycle,
	isParentFinished: isParentFinished
};
