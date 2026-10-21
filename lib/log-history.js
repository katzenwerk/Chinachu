'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LINE_LIMIT = 300;
const MAX_LINE_LIMIT = 300;
const MAX_READ_BYTES = 512 * 1024;

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function statusError(statusCode, message) {
	const error = new Error(message);
	error.statusCode = statusCode;
	return error;
}

function resolveFilename(repositoryRoot, filename) {
	return path.resolve(repositoryRoot, filename);
}

function createSources(options) {
	return [
		{ name: 'operator', stream: 'stdout', filename: resolveFilename(options.repositoryRoot, options.operatorStdout), rotated: true },
		{ name: 'operator', stream: 'stderr', filename: resolveFilename(options.repositoryRoot, options.operatorStderr), rotated: true },
		{ name: 'scheduler', stream: 'log', filename: resolveFilename(options.repositoryRoot, options.scheduler), rotated: false },
		{ name: 'wui', stream: 'stdout', filename: resolveFilename(options.repositoryRoot, options.wuiStdout), rotated: true },
		{ name: 'wui', stream: 'stderr', filename: resolveFilename(options.repositoryRoot, options.wuiStderr), rotated: true }
	];
}

function safeRegularFile(filename, logRootReal) {
	try {
		const stat = fs.lstatSync(filename);
		if (!stat.isFile() || stat.isSymbolicLink()) return null;
		const real = fs.realpathSync(filename);
		if (path.dirname(real) !== logRootReal) return null;
		return { filename: real, stat: stat };
	} catch (_) {
		return null;
	}
}

function rotatedPattern(filename) {
	const parsed = path.parse(filename);
	const stem = parsed.ext === '.log' ? parsed.name : parsed.base;
	return new RegExp('^' + escapeRegExp(stem) + '__.+\\.log$');
}

function encodeId(source, basename, current, stat) {
	const identity = [basename, String(stat.dev), String(stat.ino)].join('\0');
	const suffix = Buffer.from(identity, 'utf8').toString('base64url');
	return [source.name, source.stream, current ? 'current' : 'rotated', suffix].join('.');
}

function buildCatalog(options, requestedName) {
	if (requestedName && !['operator', 'scheduler', 'wui'].includes(requestedName)) {
		throw statusError(400, 'Unknown log name');
	}
	const logRoot = path.resolve(options.logDir);
	let logRootReal;
	try {
		logRootReal = fs.realpathSync(logRoot);
	} catch (_) {
		return [];
	}
	const entries = [];
	createSources(options).filter(source => !requestedName || source.name === requestedName).forEach(source => {
		const current = safeRegularFile(source.filename, logRootReal);
		if (current !== null) {
			entries.push({
				id: encodeId(source, path.basename(current.filename), true, current.stat),
				name: source.name,
				stream: source.stream,
				current: true,
				filename: current.filename,
				basename: path.basename(current.filename),
				dev: current.stat.dev,
				ino: current.stat.ino,
				size: current.stat.size,
				mtimeMs: current.stat.mtimeMs
			});
		}
		if (!source.rotated) return;
		const pattern = rotatedPattern(source.filename);
		let basenames = [];
		try {
			basenames = fs.readdirSync(logRoot).filter(name => pattern.test(name));
		} catch (_) {
			return;
		}
		basenames.forEach(basename => {
			const file = safeRegularFile(path.join(logRoot, basename), logRootReal);
			if (file === null) return;
			entries.push({
					id: encodeId(source, basename, false, file.stat),
				name: source.name,
				stream: source.stream,
				current: false,
					filename: file.filename,
					basename: basename,
					dev: file.stat.dev,
					ino: file.stat.ino,
					size: file.stat.size,
				mtimeMs: file.stat.mtimeMs
			});
		});
	});
	return entries.sort((a, b) => {
		if (a.name !== b.name) return a.name.localeCompare(b.name);
		if (a.current !== b.current) return a.current ? -1 : 1;
		const streamOrder = { stdout: 0, stderr: 1, log: 2 };
		if (a.stream !== b.stream) return streamOrder[a.stream] - streamOrder[b.stream];
		return b.mtimeMs - a.mtimeMs;
	});
}

function publicEntry(entry) {
	return {
		id: entry.id,
		name: entry.name,
		stream: entry.stream,
		current: entry.current,
		filename: entry.basename,
		size: entry.size,
		mtimeMs: entry.mtimeMs
	};
}

function listFiles(options, requestedName) {
	return buildCatalog(options, requestedName).map(publicEntry);
}

function readChunk(options, request) {
	const id = String(request.id || '');
	const entry = buildCatalog(options).find(item => item.id === id);
	if (!entry) throw statusError(404, 'Log file not found');

	const requestedLimit = Number.parseInt(request.lines, 10);
	const lineLimit = Number.isFinite(requestedLimit)
		? Math.max(1, Math.min(MAX_LINE_LIMIT, requestedLimit))
		: DEFAULT_LINE_LIMIT;
	const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
	let descriptor;
	try {
		descriptor = fs.openSync(entry.filename, flags);
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) throw statusError(404, 'Log file not found');
		if (stat.dev !== entry.dev || stat.ino !== entry.ino) {
			throw statusError(409, 'Log file changed');
		}
		const requestedBefore = Number.parseInt(request.before, 10);
		const end = Number.isFinite(requestedBefore)
			? Math.max(0, Math.min(stat.size, requestedBefore))
			: stat.size;
		const start = Math.max(0, end - MAX_READ_BYTES);
		const buffer = Buffer.alloc(end - start);
		if (buffer.length > 0) fs.readSync(descriptor, buffer, 0, buffer.length, start);

		let contentEnd = buffer.length;
		if (contentEnd > 0 && buffer[contentEnd - 1] === 0x0a) contentEnd -= 1;
		let contentStart = 0;
		let newlineCount = 0;
		for (let index = contentEnd - 1; index >= 0; index -= 1) {
			if (buffer[index] !== 0x0a) continue;
			newlineCount += 1;
			if (newlineCount === lineLimit) {
				contentStart = index + 1;
				break;
			}
		}
		let byteLimitReached = false;
		if (start > 0 && contentStart === 0) {
			const firstNewline = buffer.indexOf(0x0a);
			if (firstNewline === -1 || firstNewline >= contentEnd) {
				contentStart = contentEnd;
			} else {
				contentStart = firstNewline + 1;
			}
			byteLimitReached = true;
		}
		const cursor = start + contentStart;
		const text = buffer.subarray(contentStart, contentEnd).toString('utf8');
		return {
			file: publicEntry({ ...entry, size: stat.size, mtimeMs: stat.mtimeMs }),
			lines: text === '' ? [] : text.split('\n'),
			cursor: cursor,
			hasMore: cursor > 0,
			byteLimitReached: byteLimitReached,
			limits: { lines: lineLimit, bytes: MAX_READ_BYTES }
		};
	} catch (error) {
		if (error && error.statusCode) throw error;
		if (error && (error.code === 'ENOENT' || error.code === 'ELOOP')) throw statusError(404, 'Log file not found');
		throw error;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

module.exports = {
	DEFAULT_LINE_LIMIT,
	MAX_LINE_LIMIT,
	MAX_READ_BYTES,
	listFiles,
	readChunk
};
