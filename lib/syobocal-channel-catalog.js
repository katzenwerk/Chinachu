'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const channelMap = require('./syobocal-channel-map');

const ENDPOINT = 'https://cal.syoboi.jp/db.php';
const SCHEMA_VERSION = 1;
const MIN_REQUEST_INTERVAL_MS = 2000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function sha256(value) {
	return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(fsImpl, filename, value) {
	fsImpl.mkdirSync(path.dirname(filename), { recursive: true });
	const temporary = filename + '.tmp-' + process.pid + '-' + Date.now();
	try {
		fsImpl.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n');
		fsImpl.renameSync(temporary, filename);
	} catch (error) {
		try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch (_) {}
		throw error;
	}
}

function requestUrl(parameters) {
	const value = new URL(ENDPOINT);
	for (const [key, item] of Object.entries(parameters)) value.searchParams.set(key, item);
	return value.toString();
}

function defaultRequest(url, options) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, {
			headers: { 'User-Agent': options.userAgent, Accept: 'application/xml,text/xml' },
			timeout: options.timeoutMs
		}, response => {
			const chunks = [];
			let size = 0;
			response.on('data', chunk => {
				size += chunk.length;
				if (size > options.maxResponseBytes) {
					request.destroy(Object.assign(new Error('official XML response exceeded the size limit'), {
						code: 'response-too-large'
					}));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => {
				if (!response.complete) { reject(new Error('incomplete official XML response')); return; }
				try {
					const buffer = Buffer.concat(chunks);
					resolve({ statusCode: response.statusCode, headers: response.headers,
						body: response.statusCode === 200 ? new TextDecoder('utf-8', { fatal: true }).decode(buffer) : buffer.toString('utf8') });
				} catch (error) { reject(error); }
			});
			response.on('aborted', () => reject(Object.assign(new Error('incomplete official XML response'), { code: 'incomplete-response' })));
			response.on('error', reject);
		});
		request.on('timeout', () => request.destroy(Object.assign(new Error('official XML request timed out'), {
			code: 'request-timeout'
		})));
		request.on('error', reject);
		const deadline = setTimeout(() => request.destroy(Object.assign(new Error('official XML deadline exceeded'), { code: 'request-timeout' })), options.timeoutMs);
		request.once('close', () => clearTimeout(deadline));
		if (options.signal) {
			const abort = () => request.destroy(Object.assign(new Error('official XML request aborted'), { code: 'request-aborted' }));
			if (options.signal.aborted) abort();
			else options.signal.addEventListener('abort', abort, { once: true });
			request.once('close', () => options.signal.removeEventListener('abort', abort));
		}
	});
}

// One WUI's Syobocal requests share pacing/cooldown, not acquisition budgets.
function createOfficialRequestQueue(options) {
	options = options || {};
	const request = options.request || defaultRequest;
	const now = options.now || Date.now;
	const sleep = options.sleep || ((ms, signal) => require('node:timers/promises').setTimeout(ms, undefined, { signal }));
	let nextAt = 0;
	let cooldownUntil = 0;
	let tail = Promise.resolve();
	let stateError = null;
	function readCooldown() {
		try {
			if (options.statePath) {
				const saved = JSON.parse(fs.readFileSync(options.statePath, 'utf8'));
				if (!saved || !Number.isFinite(saved.cooldownUntil)) throw new Error('invalid Syobocal request cooldown state');
				cooldownUntil = saved.cooldownUntil;
			}
			stateError = null;
		} catch (error) { stateError = error.code === 'ENOENT' ? null : error; }
	}
	readCooldown();
	function enqueue(url, requestOptions) {
		const task = tail.then(async () => {
			if (stateError) { readCooldown(); if (stateError) throw stateError; }
			const signal = requestOptions && requestOptions.signal;
			const abort = () => { if (signal && signal.aborted) throw Object.assign(new Error('request aborted'), { code: 'request-aborted' }); };
			while (now() < Math.max(nextAt, cooldownUntil)) {
				abort();
				await sleep(Math.max(nextAt, cooldownUntil) - now(), signal);
			}
			abort();
			try {
				const response = await request(url, requestOptions);
				if (Number(response.statusCode) === 429) {
					const raw = response.headers && response.headers['retry-after'];
					const delay = /^\d+$/u.test(String(raw)) ? Number(raw) * 1000 : Date.parse(raw) - now();
					cooldownUntil = now() + Math.max(2000, Number.isFinite(delay) ? delay : 15 * 60 * 1000);
					if (options.statePath) atomicWriteJson(fs, options.statePath, { cooldownUntil });
				}
				return response;
			} finally {
				nextAt = now() + MIN_REQUEST_INTERVAL_MS;
			}
		});
		tail = task.catch(() => {});
		return task;
	}
	return { request: enqueue, getNextAt: () => Math.max(nextAt, cooldownUntil) };
}

function createOfficialXmlClient(options) {
	options = options || {};
	const request = options.request || defaultRequest;
	const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
	const now = options.now || Date.now;
	const minimumInterval = Number(options.minRequestIntervalMs) || MIN_REQUEST_INTERVAL_MS;
	let lastRequestAt = 0;

	async function fetchXml(parameters, signal) {
		const wait = Math.max(0, lastRequestAt + minimumInterval - now());
		if (wait) await sleep(wait);
		const url = requestUrl(parameters);
		lastRequestAt = now();
		const response = await request(url, {
			userAgent: options.userAgent || 'Chinachu-thorn/unknown (Syobocal official XML)',
			timeoutMs: Number(options.timeoutMs) || 30000,
			maxResponseBytes: Number(options.maxResponseBytes) || MAX_RESPONSE_BYTES,
			signal
		});
		const statusCode = Number(response && response.statusCode);
		if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
			throw Object.assign(new Error('official API returned HTTP ' + statusCode), {
				code: 'http-error', httpStatus: statusCode
			});
		}
		return { url, statusCode, headers: response.headers || {}, body: String(response.body || '') };
	}

	return { fetchXml };
}

function validateCatalog(chLookupXml, chGroupLookupXml) {
	const officialChannels = channelMap.parseChLookupXml(chLookupXml);
	const channelGroups = channelMap.parseChGroupLookupXml(chGroupLookupXml);
	if (!officialChannels.length || officialChannels.some(channel => !channel.chGroupId)) {
		throw Object.assign(new Error('ChLookup did not provide complete ChGID data'), { code: 'catalog-incomplete' });
	}
	const channelIds = new Set();
	for (const channel of officialChannels) {
		if (channelIds.has(channel.chId)) {
			throw Object.assign(new Error('ChLookup contains duplicate ChID ' + channel.chId), { code: 'catalog-duplicate' });
		}
		channelIds.add(channel.chId);
	}
	const groupsById = new Map();
	for (const group of channelGroups) {
		if (groupsById.has(group.chGroupId)) {
			throw Object.assign(new Error('ChGroupLookup contains duplicate ChGID ' + group.chGroupId), { code: 'catalog-duplicate' });
		}
		groupsById.set(group.chGroupId, group);
	}
	if (!groupsById.size || officialChannels.some(channel => !groupsById.has(channel.chGroupId))) {
		throw Object.assign(new Error('ChGroupLookup does not cover every ChGID in ChLookup'), { code: 'catalog-incomplete' });
	}
	return { officialChannels, channelGroups };
}

function responseSource(command, response, fetchedAt) {
	return {
		command,
		url: response.url,
		httpStatus: response.statusCode,
		fetchedAt,
		sha256: sha256(response.body),
		contentType: response.headers['content-type'] || null
	};
}

async function fetchChannelCatalog(options) {
	options = options || {};
	const client = options.client || createOfficialXmlClient(options);
	const chLookup = await client.fetchXml({
		Command: 'ChLookup', ChID: '*', Fields: 'ChID,ChName,ChiEPGName,ChGID,LastUpdate'
	});
	const chGroupLookup = await client.fetchXml({
		Command: 'ChGroupLookup', ChGID: '*', Fields: 'ChGID,ChGroupName,ChGroupComment,ChGroupOrder,LastUpdate'
	});
	const parsed = validateCatalog(chLookup.body, chGroupLookup.body);
	const fetchedAt = new Date((options.now || Date.now)()).toISOString();
	return Object.assign({
		schemaVersion: SCHEMA_VERSION,
		fetchedAt,
		sources: [
			responseSource('ChLookup', chLookup, fetchedAt),
			responseSource('ChGroupLookup', chGroupLookup, fetchedAt)
		],
		chLookupXml: chLookup.body,
		chGroupLookupXml: chGroupLookup.body
	}, parsed);
}

function normalizeCatalog(value) {
	if (!value || value.schemaVersion !== SCHEMA_VERSION || typeof value.fetchedAt !== 'string' ||
		typeof value.chLookupXml !== 'string' || typeof value.chGroupLookupXml !== 'string') {
		throw Object.assign(new Error('unsupported Syobocal channel catalog format'), { code: 'catalog-invalid' });
	}
	const parsed = validateCatalog(value.chLookupXml, value.chGroupLookupXml);
	return Object.assign({}, value, parsed, {
		sources: Array.isArray(value.sources) ? value.sources : []
	});
}

function readChannelCatalog(filename, fsImpl) {
	fsImpl = fsImpl || fs;
	if (!filename || !fsImpl.existsSync(filename)) return null;
	return normalizeCatalog(JSON.parse(fsImpl.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, '')));
}

function writeChannelCatalog(filename, catalog, fsImpl) {
	fsImpl = fsImpl || fs;
	const normalized = normalizeCatalog(catalog);
	atomicWriteJson(fsImpl, filename, {
		schemaVersion: SCHEMA_VERSION,
		fetchedAt: normalized.fetchedAt,
		sources: normalized.sources,
		chLookupXml: normalized.chLookupXml,
		chGroupLookupXml: normalized.chGroupLookupXml
	});
}

module.exports = {
	ENDPOINT,
	SCHEMA_VERSION,
	atomicWriteJson,
	createOfficialRequestQueue,
	createOfficialXmlClient,
	fetchChannelCatalog,
	normalizeCatalog,
	readChannelCatalog,
	requestUrl,
	sha256,
	validateCatalog,
	writeChannelCatalog
};
