'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { classify } = require('./drama-bangumi-fields');

const LATEST_URL = 'https://raw.githubusercontent.com/bangumi/Archive/master/aux/latest.json';
const AGENT = 'Chinachu drama dictionary (https://github.com/katzenwerk/Chinachu)';

async function get(url, signal, timeout) {
	const response = await fetch(url, { headers: { 'User-Agent': AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
	if (!response.ok) throw new Error('Bangumi HTTP ' + response.status);
	return response;
}

function validateAsset(asset) {
	const name = asset?.name;
	const release = 'https://github.com/bangumi/Archive/releases/download/archive/';
	if (typeof name !== 'string' || !/^dump-\d{4}-\d{2}-\d{2}\.\d{6}Z\.zip$/.test(name) ||
		asset.browser_download_url !== release + name || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') ||
		!Number.isSafeInteger(asset.size) || asset.size <= 0 || !Number.isFinite(Date.parse(asset.created_at))) {
		throw new Error('Bangumi latest.json の配布情報が不正です');
	}
	return asset;
}

async function verifyArchive(asset, file, signal, input) {
	const checksum = createHash('sha256');
	let size = 0;
	const meter = new Transform({
		transform(chunk, encoding, callback) {
			size += chunk.length;
			if (size > asset.size) return callback(new Error('Bangumi ZIP が配布サイズを超えました'));
			checksum.update(chunk);
			callback(null, chunk);
		}
	});
	if (input) {
		await pipeline(input, meter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal });
	} else {
		for await (const chunk of fs.createReadStream(file, { signal })) {
			size += chunk.length;
			checksum.update(chunk);
		}
	}
	if (size !== asset.size || 'sha256:' + checksum.digest('hex') !== asset.digest.toLowerCase()) {
		throw new Error('Bangumi ZIP のサイズまたは SHA-256 が一致しません');
	}
}

async function archiveRows(file, member, signal, visit) {
	const child = spawn('unzip', ['-p', file, member], { stdio: ['ignore', 'pipe', 'pipe'], signal });
	let diagnostics = '';
	child.stderr.on('data', chunk => { if (diagnostics.length < 4096) diagnostics += chunk.toString(); });
	const finished = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('close', code => code === 0 ? resolve() :
			reject(new Error('Bangumi ZIP ' + member + ': ' + (diagnostics.trim() || 'unzip exit ' + code))));
	});
	finished.catch(() => {});
	try {
		const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
		for await (const line of lines) {
			signal.throwIfAborted();
			visit(JSON.parse(line));
		}
		await finished;
	} finally {
		if (child.exitCode === null) child.kill();
		await finished.catch(() => {});
	}
}

async function updateBangumi(store, { scratch, localArchive, signal, notify }) {
	const asset = validateAsset(await (await get(LATEST_URL, signal, 30_000)).json());
	if (store.source('bangumi').revision === asset.digest) return { changed: false, asset };
	signal.throwIfAborted();
	const file = localArchive ? path.resolve(localArchive, asset.name) : path.join(scratch, asset.name);
	if (localArchive) {
		await verifyArchive(asset, file, signal);
	} else {
		const response = await get(asset.browser_download_url, signal, 15 * 60_000);
		await verifyArchive(asset, file, signal, Readable.fromWeb(response.body));
	}

	const stages = store.stageBangumi();
	const ids = new Set();
	let episodes = 0;
	await archiveRows(file, 'subject.jsonlines', signal, source => {
		const work = classify(source);
		if (!work) return;
		stages.work(work);
		ids.add(work.id);
		if (ids.size % 2000 === 0) notify({ works: ids.size, episodes });
	});
	await archiveRows(file, 'episode.jsonlines', signal, row => {
		if (!ids.has(row.subject_id)) return;
		stages.episode(row);
		episodes++;
		if (episodes % 10000 === 0) notify({ works: ids.size, episodes });
	});
	if (!ids.size || !episodes) throw new Error('Bangumi ZIP に対象の作品または各話がありません');
	signal.throwIfAborted();
	stages.publish(asset);
	return { changed: true, asset, works: ids.size, episodes };
}

async function scratchDirectory(database) {
	const directory = path.dirname(database);
	await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
	return fsp.mkdtemp(path.join(directory, '.drama-'));
}

module.exports = { updateBangumi, scratchDirectory };
