'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const manual = require('./series-manual-store');
const channelMap = require('./syobocal-channel-map');
const { createProgLookupStore } = require('./proglookup-store');

function stableJson(value) {
	return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ?
		Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function fileState(filename, optional) {
	try {
		const s = fs.statSync(filename, { bigint: true });
		return [filename, String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
	} catch (error) {
		if (optional && error.code === 'ENOENT') return [filename, 'missing'];
		throw error;
	}
}
function ledgerEntries(options) {
	return ['reserves', 'recorded', 'match'].map(key => {
		const filename = options.ledgerPaths[key];
		if (typeof filename !== 'string' || !filename) throw new Error(key + ' ledger path is required');
		return [key, filename];
	});
}
function sourceFiles(options) {
	const files = ledgerEntries(options).map(([, filename]) => filename).concat(options.manualPath);
	if (options.useSyobocal !== false) files.push(options.dictionaryPath, options.channelMapPath);
	if (usesDrama(options)) files.push(options.dramaPath, options.dramaPath + '-wal');
	return files;
}
function usesDrama(options) {
	return options.dramaPath && (options.dramaSources?.bangumi !== false || options.dramaSources?.wikipedia !== false);
}
function dramaFile(options, filename) {
	return options.dramaPath && (filename === options.dramaPath || filename === options.dramaPath + '-wal');
}
function dramaSourceState(options) {
	return usesDrama(options) ? [options.dramaPath, options.dramaPath + '-wal'].map(filename => {
		try { return fileState(filename, true); } catch { return [filename, 'unavailable']; }
	}) : [];
}
function sourceStateSync(options, progGeneration) {
	return JSON.stringify([sourceFiles(options).map(filename => {
		try { return fileState(filename, filename === options.manualPath || filename === options.channelMapPath || filename === options.dictionaryPath); }
		catch (error) { if (dramaFile(options, filename)) return [filename, 'unavailable']; throw error; }
	}), progGeneration]);
}
function capturedInputs(signature, options, ignoreManual = false) {
	return JSON.parse(signature)[0].filter(([filename]) =>
		!dramaFile(options, filename) && (!ignoreManual || filename !== options.manualPath));
}
async function sourceState(options, progGeneration) {
	const files = sourceFiles(options);
	const stats = await Promise.all(files.map(async filename => {
		try {
			const s = await fs.promises.stat(filename, { bigint: true });
			return [filename, String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
		} catch (error) {
			if (dramaFile(options, filename)) return [filename, 'unavailable'];
			if (error.code === 'ENOENT' && (filename === options.manualPath || filename === options.channelMapPath || filename === options.dictionaryPath)) return [filename, 'missing'];
			throw error;
		}
	}));
	return JSON.stringify([stats, progGeneration]);
}
function busy() {
	return Object.assign(new Error('入力情報を確認中です。更新完了後に再操作してください。'), { code: 'inputs-busy', statusCode: 503 });
}
// Only the short read/open interval must be stable. The database handle pins
// the published inode; dictionary indexing and projection happen after this.
function captureInputs(options, progLookupPath) {
	for (let attempt = 0; attempt < 3; attempt++) {
		let db;
		try {
			const before = sourceStateSync(options, 0);
			const useSyobocal = options.useSyobocal !== false;
			const progFile = useSyobocal ? JSON.stringify(fileState(progLookupPath, true)) : null;
			const inputs = {};
			for (const [key, filename] of ledgerEntries(options)) {
				inputs[key] = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''));
				if (!Array.isArray(inputs[key])) throw new Error(key + ' ledger must contain an array');
			}
			const manualStore = manual.createSeriesManualStore({ path: options.manualPath });
			const manualState = manualStore.exportState();
			const progLookupStore = useSyobocal ? createProgLookupStore({ path: progLookupPath }) : null;
			const progState = progLookupStore?.getStateSnapshot();
			if (progState?.loadError) throw new Error('ProgLookup cache: ' + progState.loadError);
			if (progLookupStore) {
				const progSnapshot = progLookupStore.getSnapshot();
				progLookupStore.getSnapshot = () => progSnapshot;
			}
			const independentMap = useSyobocal ? channelMap.readIndependentChannelMap(options.channelMapPath) : null;
			if (useSyobocal && !independentMap && fs.existsSync(options.channelMapPath)) throw new Error('invalid independent channel map');
			let publication = { generation: useSyobocal ? 'missing' : 'disabled' };
			if (useSyobocal && fs.existsSync(options.dictionaryPath)) {
				db = new DatabaseSync(options.dictionaryPath, { readOnly: true });
				db.exec('PRAGMA query_only=ON');
				const row = db.prepare("SELECT value FROM dictionary_meta WHERE key='published'").get();
				publication = row && JSON.parse(row.value);
				if (!publication?.generation || publication.source !== 'syobocal-official-titlelookup') throw new Error('invalid dictionary publication');
			}
			if (JSON.stringify(capturedInputs(before, options)) !== JSON.stringify(capturedInputs(sourceStateSync(options, 0), options)) ||
				(progFile !== null && progFile !== JSON.stringify(fileState(progLookupPath, true)))) {
				db?.close(); db = null;
				continue;
			}
			return { inputs, manualState, progLookupStore, independentMap, db, publication,
				signature: JSON.stringify([JSON.parse(before)[0], progState?.generation ?? 0]),
				readSignature: before, progFile, progLookupPath };
		} catch (error) {
			if (db) db.close();
			if (attempt === 2) { error.statusCode = error.statusCode || 503; throw error; }
		}
	}
	throw busy();
}
function assertCaptureCurrent(context, options, ignoreManual = false) {
	const previous = capturedInputs(context.readSignature, options, ignoreManual);
	const current = capturedInputs(sourceStateSync(options, 0), options, ignoreManual);
	if (JSON.stringify(previous) !== JSON.stringify(current) ||
		(context.progFile !== null && context.progFile !== JSON.stringify(fileState(context.progLookupPath, true)))) throw busy();
}
module.exports = { sourceState, sourceStateSync, captureInputs, assertCaptureCurrent, busy, dramaSourceState };

// Ignore acquisition progress and map provenance; retain all inputs that can
// affect a completed projection. Used for conservative bulk freshness only.
function projectionIdentity(context) {
	const { createHash } = require('node:crypto');
	const prog = context.progLookupStore?.getSnapshot() || { programs: [], coverage: [] };
	const coverage = [...new Set(prog.coverage.map(row => JSON.stringify([row.kind, row.startMs, row.endMs, row.chIds])))].sort();
	const mappings = rows => (rows || []).map(row => [row.nid, row.sid, row.status, row.chId, row.acquisitionCandidateChIds || []]);
	return createHash('sha256').update(stableJson({ inputs: context.inputs,
		overrides: context.manualState.overrides, workRules: context.manualState.workRules, localSeries: context.manualState.localSeries,
		dictionary: context.publication.generation, channels: mappings(context.independentMap?.channels),
		unresolved: mappings(context.independentMap?.unresolved), programs: prog.programs, coverage })).digest('hex');
}
module.exports.projectionIdentity = projectionIdentity;

module.exports.stableJson = stableJson;
