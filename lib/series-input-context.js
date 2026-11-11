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
function sourceStateSync(options, progGeneration) {
	return JSON.stringify([ledgerEntries(options).map(([, filename]) => filename).concat(options.dictionaryPath, options.channelMapPath, options.manualPath)
		.map(filename => fileState(filename, filename === options.manualPath || filename === options.channelMapPath)), progGeneration]);
}
async function sourceState(options, progGeneration) {
	const files = ledgerEntries(options).map(([, filename]) => filename).concat(options.dictionaryPath, options.channelMapPath, options.manualPath);
	const stats = await Promise.all(files.map(async filename => {
		try {
			const s = await fs.promises.stat(filename, { bigint: true });
			return [filename, String(s.dev), String(s.ino), String(s.size), String(s.mtimeNs), String(s.ctimeNs)];
		} catch (error) {
			if (error.code === 'ENOENT' && (filename === options.manualPath || filename === options.channelMapPath)) return [filename, 'missing'];
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
			const progFile = JSON.stringify(fileState(progLookupPath, true));
			const inputs = {};
			for (const [key, filename] of ledgerEntries(options)) {
				inputs[key] = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/u, ''));
				if (!Array.isArray(inputs[key])) throw new Error(key + ' ledger must contain an array');
			}
			const manualStore = manual.createSeriesManualStore({ path: options.manualPath });
			const manualState = manualStore.exportState();
			const progLookupStore = createProgLookupStore({ path: progLookupPath });
			const progState = progLookupStore.getStateSnapshot();
			const progSnapshot = progLookupStore.getSnapshot();
			progLookupStore.getSnapshot = () => progSnapshot;
			if (progState.loadError) throw new Error('ProgLookup cache: ' + progState.loadError);
			const independentMap = channelMap.readIndependentChannelMap(options.channelMapPath);
			if (!independentMap && fs.existsSync(options.channelMapPath)) throw new Error('invalid independent channel map');
			db = new DatabaseSync(options.dictionaryPath, { readOnly: true });
			db.exec('PRAGMA query_only=ON');
			const row = db.prepare("SELECT value FROM dictionary_meta WHERE key='published'").get();
			const publication = row && JSON.parse(row.value);
			if (!publication?.generation || publication.source !== 'syobocal-official-titlelookup') throw new Error('invalid dictionary publication');
			if (before !== sourceStateSync(options, 0) || progFile !== JSON.stringify(fileState(progLookupPath, true))) {
				db.close(); db = null;
				continue;
			}
			return { inputs, manualState, progLookupStore, independentMap, db, publication,
				signature: JSON.stringify([JSON.parse(before)[0], progState.generation]),
				readSignature: before, progFile, progLookupPath };
		} catch (error) {
			if (db) db.close();
			if (attempt === 2) { error.statusCode = error.statusCode || 503; throw error; }
		}
	}
	throw busy();
}
function assertCaptureCurrent(context, options, ignoreManual = false) {
	const previous = JSON.parse(context.readSignature)[0];
	const current = JSON.parse(sourceStateSync(options, 0))[0];
	const filter = rows => ignoreManual ? rows.filter(row => row[0] !== options.manualPath) : rows;
	if (JSON.stringify(filter(previous)) !== JSON.stringify(filter(current)) ||
		context.progFile !== JSON.stringify(fileState(context.progLookupPath, true))) throw busy();
}
module.exports = { sourceState, sourceStateSync, captureInputs, assertCaptureCurrent, busy };

// Ignore acquisition progress and map provenance; retain all inputs that can
// affect a completed projection. Used for conservative bulk freshness only.
function projectionIdentity(context) {
	const { createHash } = require('node:crypto');
	const prog = context.progLookupStore.getSnapshot();
	const coverage = [...new Set(prog.coverage.map(row => JSON.stringify([row.kind, row.startMs, row.endMs, row.chIds])))].sort();
	const mappings = rows => (rows || []).map(row => [row.nid, row.sid, row.status, row.chId, row.acquisitionCandidateChIds || []]);
	return createHash('sha256').update(stableJson({ inputs: context.inputs,
		overrides: context.manualState.overrides, workRules: context.manualState.workRules, localSeries: context.manualState.localSeries,
		dictionary: context.publication.generation, channels: mappings(context.independentMap?.channels),
		unresolved: mappings(context.independentMap?.unresolved), programs: prog.programs, coverage })).digest('hex');
}
module.exports.projectionIdentity = projectionIdentity;

module.exports.stableJson = stableJson;
