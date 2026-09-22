'use strict';

const crypto = require('crypto');
const fs = require('fs');

const epgReconcile = require('./mirakurun-epg-reconcile');

const BASELINE_NAMES = [ 'rules', 'config', 'reserves', 'services', 'tuners', 'recorded' ];

function canonicalize(value) {
	if (Array.isArray(value)) {
		return value.map(canonicalize);
	}
	if (value && typeof value === 'object') {
		const result = {};
		Object.keys(value).sort().forEach(key => {
			if (value[key] !== undefined) {
				result[key] = canonicalize(value[key]);
			}
		});
		return result;
	}
	return value;
}

function fingerprint(value) {
	return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function fileIdentity(filePath) {
	const stat = fs.statSync(filePath);
	return {
		size: stat.size,
		mtimeMs: stat.mtimeMs
	};
}

function sameFileIdentity(left, right) {
	return Boolean(left && right && left.size === right.size && left.mtimeMs === right.mtimeMs);
}

function createFileBaseline(filePath, value) {
	return Object.assign(fileIdentity(filePath), { hash: fingerprint(value) });
}

function createValueBaseline(value) {
	return { hash: fingerprint(value) };
}

function projectServices(services) {
	if (!Array.isArray(services)) {
		throw new Error('Mirakurun services response is not an array');
	}
	return services.map(service => ({
		id: service && service.id,
		serviceId: service && service.serviceId,
		networkId: service && service.networkId,
		name: service && service.name,
		hasLogoData: service && service.hasLogoData,
		channel: {
			type: service && service.channel && service.channel.type,
			channel: service && service.channel && service.channel.channel
		}
	}));
}

function projectTuners(tuners) {
	if (!Array.isArray(tuners)) {
		throw new Error('Mirakurun tuners response is not an array');
	}
	return tuners.map(tuner => ({
		types: Array.isArray(tuner && tuner.types) ? tuner.types.slice() : []
	}));
}

function projectManualReserve(reserve) {
	const ignored = new Set([
		'isConflict', 'isDuplicate', 'ruleId', 'allowEndLack',
		'recordedFormat', 'recordedDir', 'recordedDirId'
	]);
	const result = {};
	Object.keys(reserve).forEach(key => {
		if (ignored.has(key) || key.charAt(0) === '_') {
			return;
		}
		result[key] = reserve[key];
	});
	result.isManualReserved = true;
	return result;
}

function projectReserves(reserves) {
	if (!Array.isArray(reserves)) {
		throw new Error('reserves data is not an array');
	}
	return reserves.reduce((result, reserve) => {
		if (!reserve || typeof reserve !== 'object') {
			return result;
		}
		if (reserve.isManualReserved === true) {
			result.push(projectManualReserve(reserve));
			return result;
		}
		if (reserve.isSkip === true) {
			result.push({ id: reserve.id, isSkip: true });
		}
		return result;
	}, []).sort((left, right) => {
		return JSON.stringify(canonicalize(left)).localeCompare(JSON.stringify(canonicalize(right)));
	});
}

function readJson(filePath) {
	return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '') || 'null');
}

function readJsonArray(filePath) {
	const value = readJson(filePath);
	if (!Array.isArray(value)) {
		throw new Error('JSON data is not an array');
	}
	return value;
}

function hasSameFileFingerprint(filePath, baseline, project) {
	fileIdentity(filePath);
	const value = readJson(filePath);
	return fingerprint(project ? project(value) : value) === baseline.hash;
}

function hasSameValueFingerprint(value, baseline, project) {
	return fingerprint(project ? project(value) : value) === baseline.hash;
}

function addUnique(array, value) {
	if (array.indexOf(value) === -1) {
		array.push(value);
	}
}

class OperatorSchedulerPreflight {
	constructor(options) {
		options = options || {};
		if (!options.stateStore || typeof options.stateStore.load !== 'function') {
			throw new Error('stateStore is required');
		}
		if (typeof options.fetchJobs !== 'function' || typeof options.fetchServices !== 'function' || typeof options.fetchTuners !== 'function') {
			throw new Error('Mirakurun fetch functions are required');
		}

		this.stateStore = options.stateStore;
		this.fetchJobs = options.fetchJobs;
		this.fetchServices = options.fetchServices;
		this.fetchTuners = options.fetchTuners;
		this.paths = options.paths || {};
		this.now = options.now || Date.now;
		this.maxStalenessMs = Number.isFinite(options.maxStalenessMs) ? options.maxStalenessMs : null;
		this.inFlight = null;
		this.stopped = false;
		this.generation = 0;
	}

	check() {
		if (this.stopped) {
			return Promise.resolve(null);
		}
		if (this.inFlight !== null) {
			return this.inFlight;
		}
		const generation = this.generation;
		this.inFlight = this.runCheck(generation).catch(() => {
			if (this.stopped || generation !== this.generation) {
				return null;
			}
			return { dirty: true, reasons: [ 'preflight-error' ], advisory: [] };
		}).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	async runCheck(generation) {
		const reasons = [];
		const advisory = [];
		let state = null;
		let stateUsable = true;

		try {
			state = this.stateStore.load();
			if (!fs.existsSync(this.paths.state)) {
				stateUsable = false;
				addUnique(reasons, 'state');
			}
		} catch (_) {
			stateUsable = false;
			addUnique(reasons, 'state');
		}

		this.checkFile('schedule', this.paths.schedule, null, reasons);
		this.checkFile('reserves2', this.paths.reserves2, null, reasons);

		if (stateUsable) {
			this.compareFile('rules', this.paths.rules, state.baselines.rules, null, reasons);
			this.compareFile('config', this.paths.config, state.baselines.config, null, reasons);
			this.compareFile('reserves', this.paths.reserves, state.baselines.reserves, projectReserves, reasons);
			this.compareRecorded(this.paths.recorded, state.baselines.recorded, advisory);
		} else {
			this.checkFile('rules', this.paths.rules, null, reasons, false);
			this.checkFile('config', this.paths.config, null, reasons, false);
			this.checkFile('reserves', this.paths.reserves, projectReserves, reasons);
		}

		const results = await Promise.allSettled([
			this.fetchJobs(),
			this.fetchServices(),
			this.fetchTuners()
		]);

		if (this.stopped || generation !== this.generation) {
			return null;
		}

		if (results[0].status === 'rejected') {
			addUnique(reasons, 'epg-unavailable');
		} else if (stateUsable) {
			const cycle = epgReconcile.findLatestSettledCycle(results[0].value, this.now(), 0);
			if (cycle && cycle.completedAt > state.lastSchedulerStartedAt) {
				addUnique(reasons, 'epg');
			}
		}

		this.compareRemote('services', results[1], stateUsable && state.baselines.services, projectServices, reasons);
		this.compareRemote('tuners', results[2], stateUsable && state.baselines.tuners, projectTuners, reasons);

		if (stateUsable && this.maxStalenessMs !== null && this.now() - state.lastSchedulerSuccessAt > this.maxStalenessMs) {
			addUnique(reasons, 'stale');
		}

		return {
			dirty: reasons.length !== 0,
			reasons: reasons,
			advisory: advisory,
			lastSchedulerStartedAt: state ? state.lastSchedulerStartedAt : 0,
			lastSchedulerSuccessAt: state ? state.lastSchedulerSuccessAt : 0
		};
	}

	checkFile(reason, filePath, project, reasons, requireArray) {
		try {
			const value = requireArray === false ? readJson(filePath) : readJsonArray(filePath);
			if (project) {
				project(value);
			}
		} catch (_) {
			addUnique(reasons, reason);
		}
	}

	compareFile(reason, filePath, baseline, project, reasons) {
		if (!baseline || typeof baseline.hash !== 'string') {
			addUnique(reasons, reason);
			return;
		}
		try {
			if (!hasSameFileFingerprint(filePath, baseline, project)) {
				addUnique(reasons, reason);
			}
		} catch (_) {
			addUnique(reasons, reason);
		}
	}

	compareRecorded(filePath, baseline, advisory) {
		if (!baseline || typeof baseline.hash !== 'string') {
			addUnique(advisory, 'recorded');
			return;
		}
		try {
			if (!hasSameFileFingerprint(filePath, baseline)) {
				addUnique(advisory, 'recorded');
			}
		} catch (_) {
			addUnique(advisory, 'recorded');
		}
	}

	compareRemote(reason, result, baseline, project, reasons) {
		if (result.status === 'rejected') {
			addUnique(reasons, reason + '-unavailable');
			return;
		}
		if (!baseline || typeof baseline.hash !== 'string') {
			addUnique(reasons, reason);
			return;
		}
		try {
			if (!hasSameValueFingerprint(result.value, baseline, project)) {
				addUnique(reasons, reason);
			}
		} catch (_) {
			addUnique(reasons, reason + '-unavailable');
		}
	}

	stop() {
		this.stopped = true;
		this.generation++;
	}

	getState() {
		return { stopped: this.stopped, checkPending: this.inFlight !== null };
	}
}

class ShadowPeriodicScheduler {
	constructor(options) {
		options = options || {};
		this.preflight = options.preflight;
		this.startScheduler = options.startScheduler;
		this.logger = options.log || function () {};
		this.isShuttingDown = options.isShuttingDown || function () { return false; };
		this.inFlight = null;
		this.stopped = false;
	}

	request() {
		if (this.stopped || this.isShuttingDown()) {
			return Promise.resolve(null);
		}
		if (this.inFlight !== null) {
			return this.inFlight;
		}
		this.inFlight = Promise.resolve().then(() => this.preflight.check()).then(result => {
			if (this.stopped || this.isShuttingDown() || result === null) {
				return null;
			}
			this.logger(formatResult(result));
			return { result: result, started: this.startSafely() };
		}, () => {
			if (this.stopped || this.isShuttingDown()) {
				return null;
			}
			const result = { dirty: true, reasons: [ 'preflight-error' ], advisory: [] };
			this.logger(formatResult(result));
			return { result: result, started: this.startSafely() };
		}).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	startSafely() {
		try {
			return this.startScheduler() !== false;
		} catch (error) {
			this.logger('SCHEDULER: periodic start failed: ' + (error && error.message ? error.message : String(error)));
			return false;
		}
	}

	stop() {
		this.stopped = true;
	}
}

function formatResult(result) {
	let message = result.dirty
		? 'SCHEDULER: preflight dirty reasons=' + result.reasons.join(',')
		: 'SCHEDULER: preflight clean';
	if (result.advisory && result.advisory.length !== 0) {
		message += ' advisory=' + result.advisory.join(',');
	}
	return message;
}

module.exports = {
	BASELINE_NAMES: BASELINE_NAMES,
	OperatorSchedulerPreflight: OperatorSchedulerPreflight,
	ShadowPeriodicScheduler: ShadowPeriodicScheduler,
	canonicalize: canonicalize,
	createFileBaseline: createFileBaseline,
	createValueBaseline: createValueBaseline,
	fileIdentity: fileIdentity,
	fingerprint: fingerprint,
	formatResult: formatResult,
	projectReserves: projectReserves,
	projectServices: projectServices,
	projectTuners: projectTuners,
	sameFileIdentity: sameFileIdentity
};
