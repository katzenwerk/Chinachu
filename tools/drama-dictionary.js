'use strict';

const { parseArgs } = require('node:util');
const path = require('node:path');
const { DEFAULT_PATH, runSource, snapshot, bangumiDue, wikipediaPlan } = require('../lib/drama-dictionary');
const { openStore } = require('../lib/drama-store');

async function main() {
	const args = parseArgs({
		allowPositionals: true,
		options: {
			db: { type: 'string', default: DEFAULT_PATH },
			year: { type: 'string' },
			'start-year': { type: 'string', default: '2000' },
			archive: { type: 'string' },
			cache: { type: 'string' },
			'seed-cache': { type: 'string' },
			at: { type: 'string' },
			help: { type: 'boolean' }
		}
	});
	const [command, identifier, ...other] = args.positionals;
	if (args.values.help) {
		console.log('node tools/drama-dictionary.js bangumi|wikipedia|status|plan|work [ID] --db FILE\n' +
			'  bangumi: --archive DIR  (公式メタデータと照合できる既存ZIP)\n' +
			'  wikipedia: --year YEAR --start-year YEAR --cache DIR --seed-cache DIR\n' +
			'  plan: --at ISO-DATETIME --start-year YEAR\n' +
			'  work: Bangumi ID または wiki:ページID:年:期:区分');
		return;
	}
	if (!['bangumi','wikipedia','status','plan','work'].includes(command) || other.length ||
		(command === 'work') !== Boolean(identifier)) throw new Error('--help で使い方を確認してください');
	const database = path.resolve(args.values.db);
	const parseYear = raw => {
		if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1) throw new Error('年は1〜9999で指定してください');
		return Number(raw);
	};
	const year = args.values.year === undefined ? undefined : parseYear(args.values.year);
	const startYear = parseYear(args.values['start-year']);
	const now = args.values.at ? Date.parse(args.values.at) : Date.now();
	if (!Number.isFinite(now) || args.values.at && command !== 'plan') throw new Error('--at は plan のみ利用できます');
	let value;
	if (command === 'bangumi' || command === 'wikipedia') {
		const abort = new AbortController();
		for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => abort.abort());
		value = await runSource(command, { database, now, year, startYear, force: true, checkAll: Boolean(year),
			localArchive: args.values.archive, cache: args.values.cache, seedCache: args.values['seed-cache'], signal: abort.signal,
			notify: details => console.error(JSON.stringify(details)) });
		if (value.sources[command].phase !== 'ready') process.exitCode = 1;
	} else {
		const store = openStore(database, true);
		try {
			if (command === 'status') value = { ...snapshot(store), supplements: store.audit() };
			if (command === 'plan') value = { bangumi: bangumiDue(now, store.source('bangumi')), wikipedia: wikipediaPlan(now, startYear, store.years()) };
			if (command === 'work') value = store.getWork(identifier);
		} finally {
			store.close();
		}
	}
	console.log(JSON.stringify(value, null, 2));
}

main().catch(error => {
	console.error(error.message);
	process.exitCode = 1;
});
