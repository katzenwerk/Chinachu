'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const schedulerState = require('./scheduler-state');

const STATUS = {
	normal: 'normal',
	warning: 'warning',
	error: 'error',
	unknown: 'unknown'
};

function item(status, code, summary, data) {
	return {
		status: status,
		code: code,
		summary: summary,
		data: data || null
	};
}

function readJson(fsModule, filePath, expectedType, validator) {
	let text;
	let value;

	try {
		text = fsModule.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			return item(STATUS.unknown, 'missing', 'ファイルが存在しません');
		}
		return item(STATUS.unknown, 'unreadable', 'ファイルを読み取れません');
	}

	try {
		value = JSON.parse(text);
	} catch (_) {
		return item(STATUS.error, 'invalid-json', 'JSONをparseできません');
	}

	if (expectedType === 'array' && !Array.isArray(value)) {
		return item(STATUS.error, 'invalid-type', 'トップレベルが配列ではありません');
	}
	if (expectedType === 'object' && (!value || typeof value !== 'object' || Array.isArray(value))) {
		return item(STATUS.error, 'invalid-type', 'トップレベルがobjectではありません');
	}

	if (validator) {
		try {
			validator(value);
		} catch (_) {
			return item(STATUS.error, 'invalid-format', '形式検証に失敗しました');
		}
	}

	return {
		status: STATUS.normal,
		code: 'ok',
		summary: '読込み・JSON・トップレベル型を確認しました',
		data: value
	};
}

function defaultCommitResolver(rootDir) {
	if (!fs.existsSync(path.join(rootDir, '.git'))) {
		return null;
	}

	try {
		const value = childProcess.execFileSync('git', [ 'rev-parse', '--verify', 'HEAD' ], {
			cwd: rootDir,
			encoding: 'utf8',
			timeout: 1000,
			maxBuffer: 4096,
			stdio: [ 'ignore', 'pipe', 'ignore' ]
		}).trim();
		return /^[0-9a-f]{40}$/i.test(value) ? value : null;
	} catch (_) {
		return null;
	}
}

class HealthDiagnostics {
	constructor(options) {
		options = options || {};
		this.fs = options.fs || fs;
		this.now = options.now || Date.now;
		this.cacheMs = Number.isFinite(Number(options.cacheMs)) ? Math.max(0, Number(options.cacheMs)) : 5000;
		this.mirakurunTimeoutMs = Number.isFinite(Number(options.mirakurunTimeoutMs))
			? Math.max(1, Number(options.mirakurunTimeoutMs))
			: 2500;
		this.rootDir = options.rootDir || process.cwd();
		this.paths = options.paths || {};
		this.packageVersion = options.packageVersion || null;
		this.nodeVersion = options.nodeVersion || process.version;
		this.validateRules = options.validateRules || null;
		this.fetchMirakurunStatus = options.fetchMirakurunStatus || null;
		this.commit = (options.commitResolver || defaultCommitResolver)(this.rootDir);
		this.cache = null;
		this.inFlight = null;
	}

	collect(options) {
		options = options || {};
		const now = this.now();
		if (this.inFlight) {
			return this.inFlight;
		}
		if (!options.force && this.cache && now - this.cache.checkedAt < this.cacheMs) {
			return Promise.resolve(this.cache);
		}

		this.inFlight = this.collectFresh(now).then(report => {
			this.cache = report;
			return report;
		}).finally(() => {
			this.inFlight = null;
		});
		return this.inFlight;
	}

	async collectFresh(checkedAt) {
		const config = readJson(this.fs, this.paths.config, 'object');
		const rules = readJson(this.fs, this.paths.rules, 'array', this.validateRules);
		const rawSchedulerState = readJson(this.fs, this.paths.schedulerState, 'object', value => {
			schedulerState.normalizeState(value, { allowPrevious: true, allowLegacy: true });
		});
		const recording = readJson(this.fs, this.paths.recording, 'array');

		return {
			schemaVersion: 1,
			checkedAt: checkedAt,
			basic: this.basicItem(),
			scheduler: this.schedulerItem(rawSchedulerState, checkedAt),
			recording: this.recordingItem(recording, checkedAt),
			json: {
				config: this.publicJsonItem(config),
				rules: this.publicJsonItem(rules),
				schedulerState: this.publicJsonItem(rawSchedulerState)
			},
			mirakurun: await this.mirakurunItem(),
			notMeasured: {
				matchingSuccess: '初期版では成功receiptを未実装です',
				schedulerTriggerSource: '初期版ではtrigger sourceを未計測です'
			}
		};
	}

	basicItem() {
		return item(STATUS.normal, 'ok', 'WUI実行環境の基本情報です', {
			chinachuVersion: this.packageVersion,
			nodeVersion: this.nodeVersion,
			commit: this.commit
		});
	}

	publicJsonItem(result) {
		return item(result.status, result.code, result.summary);
	}

	schedulerItem(result, checkedAt) {
		if (result.status !== STATUS.normal) {
			return item(result.status, result.code, result.summary, {
				source: 'data/scheduler-state.json',
				checkedAt: checkedAt,
				lastSuccessAt: null,
				elapsedMs: null
			});
		}

		const state = schedulerState.normalizeState(result.data, { allowPrevious: true, allowLegacy: true });
		const lastSuccessAt = state.lastSchedulerSuccessAt || null;
		if (lastSuccessAt === null) {
			return item(STATUS.warning, 'no-success-record', 'Schedulerの成功記録がありません', {
				source: 'data/scheduler-state.json', checkedAt: checkedAt, lastSuccessAt: null, elapsedMs: null
			});
		}
		const elapsedMs = checkedAt - lastSuccessAt;
		if (elapsedMs < 0) {
			return item(STATUS.warning, 'future-timestamp', '最終成功時刻が確認時刻より後です', {
				source: 'data/scheduler-state.json', checkedAt: checkedAt, lastSuccessAt: lastSuccessAt, elapsedMs: elapsedMs
			});
		}
		return item(STATUS.normal, 'ok', 'Schedulerの最終成功記録を確認しました', {
			source: 'data/scheduler-state.json', checkedAt: checkedAt, lastSuccessAt: lastSuccessAt, elapsedMs: elapsedMs
		});
	}

	recordingItem(result, checkedAt) {
		if (result.status !== STATUS.normal) {
			return item(result.status, result.code, result.summary, {
				source: 'data/recording.json', checkedAt: checkedAt, count: null
			});
		}
		return item(STATUS.normal, 'ok', '録画中一覧を確認しました', {
			source: 'data/recording.json', checkedAt: checkedAt, count: result.data.length
		});
	}

	async mirakurunItem() {
		if (typeof this.fetchMirakurunStatus !== 'function') {
			return item(STATUS.unknown, 'unsupported', 'Mirakurun確認は利用できません');
		}

		const controller = new AbortController();
		let timedOut = false;
		let timer;
		const timeout = new Promise((resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(new Error('timeout'));
			}, this.mirakurunTimeoutMs);
		});
		try {
			const status = await Promise.race([
				Promise.resolve().then(() => this.fetchMirakurunStatus(controller.signal)),
				timeout
			]);
			if (!status || typeof status !== 'object' || Array.isArray(status)) {
				return item(STATUS.warning, 'invalid-response', 'Mirakurunの応答形式を確認できません');
			}
			return item(STATUS.normal, 'ok', 'Mirakurunへ接続できました', {
				version: typeof status.version === 'string' && status.version !== '' ? status.version : null
			});
		} catch (error) {
			if (timedOut) {
				return item(STATUS.error, 'timeout', 'Mirakurun確認がタイムアウトしました');
			}
			return item(STATUS.error, 'unavailable', 'Mirakurunへ接続できません');
		} finally {
			clearTimeout(timer);
		}
	}
}

function createHealthDiagnostics(options) {
	return new HealthDiagnostics(options);
}

module.exports = {
	STATUS: STATUS,
	HealthDiagnostics: HealthDiagnostics,
	createHealthDiagnostics: createHealthDiagnostics,
	readJson: readJson
};
