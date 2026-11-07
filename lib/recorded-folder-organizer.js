"use strict";

const fs = require('node:fs');
const path = require('node:path');
const { workIdentity } = require('./series-resolver');

const ORDERS = {
	filename: ['filename', 'title', 'history'],
	title: ['title', 'filename', 'history'],
	history: ['history', 'filename', 'title']
};
const RECORDING_PREFIX = '【録画中】';

function normalized(value) {
	return String(value || '').normalize('NFKC').toLowerCase();
}

function validFolderName(name) {
	return typeof name === 'string' && name !== '' && name !== '.' && name !== '..' &&
		path.basename(name) === name && !name.includes('\\');
}

// 録画先直下のディレクトリ名だけを列挙する。再帰検索しない。
function listExistingFolders(root, filesystem = fs) {
	return filesystem.readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && validFolderName(entry.name))
		.map(entry => entry.name);
}

function positiveTid(value) {
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function newestHistoricalFolder(program, root, folders, recorded, series, seriesByRecordedId) {
	const tid = positiveTid(series?.tid);
	const identity = tid === null ? workIdentity(program) : '';
	if (tid === null && !identity) return null;
	const available = new Set(folders);
	const matches = [];

	for (const entry of recorded || []) {
		if (!entry || entry.id === program.id || typeof entry.recorded !== 'string') continue;
		const absolutePath = path.resolve(entry.recorded);
		const directory = path.dirname(absolutePath);
		if (directory === root || path.dirname(directory) !== root) continue;
		const folder = path.basename(directory);
		if (!available.has(folder)) continue;

		const past = seriesByRecordedId instanceof Map ? seriesByRecordedId.get(String(entry.id)) :
			seriesByRecordedId?.[String(entry.id)];
		const pastTid = positiveTid(past?.tid);
		if (tid !== null) {
			if (pastTid !== tid) continue;
		} else if (workIdentity(entry) !== identity) {
			// TID未確定の場合は既存の作品名正規化が完全一致した履歴だけを使う。
			continue;
		}
		matches.push({ folder, start: Number(entry.start) || 0 });
	}

	matches.sort((a, b) => b.start - a.start || a.folder.localeCompare(b.folder, 'ja'));
	return matches[0]?.folder || null;
}

function longestFolder(folders) {
	const sorted = folders.slice().sort((a, b) =>
		Array.from(normalized(b)).length - Array.from(normalized(a)).length ||
		a.localeCompare(b, 'ja'));
	if (sorted.length > 1 && Array.from(normalized(sorted[0])).length === Array.from(normalized(sorted[1])).length) return null;
	return sorted[0] || null;
}

// 判定だけを行い、ファイルシステムは変更しない。
// series / seriesByRecordedId は既存シリーズ管理の確定結果を呼び出し側から渡す。
function chooseRecordedFolder({ program, sourcePath, root, folderNames, recorded = [], series = null,
	seriesByRecordedId = null, order = 'filename' } = {}) {
	if (!program || !root || !sourcePath) return null;
	const rootPath = path.resolve(root);
	const originalPath = path.resolve(sourcePath);
	if (path.dirname(originalPath) !== rootPath) return null;

	const folders = [...new Set((folderNames || []).filter(validFolderName))];
	if (!folders.length) return null;
	const newestFolder = newestHistoricalFolder(program, rootPath, folders, recorded, series, seriesByRecordedId);
	const filename = path.basename(originalPath);
	const finalName = filename.startsWith(RECORDING_PREFIX) ? filename.slice(RECORDING_PREFIX.length) : filename;
	const fileText = normalized(path.parse(finalName).name);
	const titleText = positiveTid(series?.tid) === null ? '' : normalized(series?.title);
	const substringFolders = folders.filter(name => Array.from(name).length >= 2);
	const matches = {
		filename: substringFolders.filter(name => fileText.includes(normalized(name))),
		title: titleText ? substringFolders.filter(name => titleText.includes(normalized(name))) : [],
		history: newestFolder ? [newestFolder] : []
	};

	for (const method of ORDERS[order] || ORDERS.filename) {
		let candidates = matches[method];
		if (!candidates.length) continue;
		if (candidates.length > 1) {
			if (newestFolder && candidates.includes(newestFolder)) candidates = [newestFolder];
			else if (method !== 'title') {
				const byTitle = candidates.filter(name => matches.title.includes(name));
				if (byTitle.length) candidates = byTitle;
			}
		}
		const folderName = longestFolder(candidates);
		if (!folderName) return null;
		return { method, folderName, directoryPath: path.join(rootPath, folderName) };
	}
	return null;
}

module.exports = { ORDERS, listExistingFolders, chooseRecordedFolder };
