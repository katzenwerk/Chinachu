'use strict';

const cleaner = require('./lib/ledger-cleaner');

function help() {
	console.log(`Chinachu 台帳整理 (dry-run only)

Usage:
  ./chinachu cleaner
  ./chinachu cleaner --dry-run [options]

Options:
  --dry-run                 録画フォルダを走査し、変更計画だけを表示
  --normalize               一意かつ高確度の所在候補を正規化予定に含める
  --missing=report          不在候補を表示するだけ (既定)
  --missing=keep-history    recorded除外・match履歴保持の予定を表示
  --missing=remove-history  recorded/reserves2/match除外の予定を表示
  --cleanup-missed          録画実績のない終了済みMISSED履歴も整理対象に含める
  --roots=id1,id2           探索する登録録画先を限定 (defaultも指定可能)
  --json                    JSON形式で出力
  --help                    このヘルプを表示

安全上の注意:
  --dry-run は登録済み録画フォルダ配下を走査するため、休止中HDDが起動する場合があります。
  現在の実装は台帳・録画ファイルを一切変更せず、適用機能も提供しません。`);
}

function parse(argv) {
	const options = { dryRun: false, normalizeLocations: false, missingPolicy: 'report', cleanupMissed: false, selectedIds: null, json: false };
	argv.forEach(argument => {
		if (argument === '--dry-run' || argument === '--scan') options.dryRun = true;
		else if (argument === '--normalize') options.normalizeLocations = true;
		else if (argument === '--json') options.json = true;
		else if (argument === '--cleanup-missed') options.cleanupMissed = true;
		else if (argument === '--help' || argument === '-h') options.help = true;
		else if (argument.startsWith('--missing=')) options.missingPolicy = argument.slice('--missing='.length);
		else if (argument.startsWith('--roots=')) options.selectedIds = argument.slice('--roots='.length).split(',').filter(Boolean);
		else throw new Error('Unknown option: ' + argument);
	});
	if (!cleaner.MISSING_POLICIES.has(options.missingPolicy)) throw new Error('Unknown missing policy: ' + options.missingPolicy);
	return Object.assign(options, cleaner.normalizeOptions(options));
}

function printText(plan) {
	console.log('台帳整理 dry-run');
	console.log('録画台帳: ' + plan.summary.total + '件');
	console.log('正常: ' + plan.summary.ok + ' / 所在候補: ' + plan.summary.relocated + ' / 要確認: ' +
		(plan.summary.review + plan.summary.ambiguous) + ' / 不在: ' + plan.summary.missing + ' / 未検査: ' + plan.summary.uninspected);
	console.log('未登録ファイル: ' + plan.summary.unregisteredFiles + '件 (変更対象外)');
	console.log('過去スキップ履歴: ' + plan.summary.skippedHistory + ' / 未録画履歴: ' + plan.summary.missedHistory);
	console.log('索引: ' + plan.index.files + 'ファイル、' + plan.index.visitedDirectories + 'ディレクトリ、完全=' + plan.index.complete);
	plan.roots.forEach(root => console.log('  [' + root.id + '] ' + root.status + ' files=' + root.files + ' ' + root.path));
	plan.results.filter(item => item.action !== 'none' || item.classification === 'ambiguous' || item.classification === 'review' || item.classification === 'uninspected')
		.forEach(item => {
			console.log('\n[' + item.classification + '] ' + (item.id || item.key || '-') + ' ' + item.title);
			console.log('  ' + (item.originalPath || '(pathなし)'));
			if (item.newPath) console.log('  -> ' + item.newPath);
			console.log('  action=' + item.action + ' automatic=' + item.automatic + ' reason=' + item.reason);
		});
	console.log('\n変更は行われていません。');
}

let options;
try { options = parse(process.argv.slice(2)); } catch (error) {
	console.error(error.message);
	process.exitCode = 2;
	help();
	return;
}
if (options.help || !options.dryRun) {
	help();
} else {
	try {
		const ledgers = cleaner.loadLedgers(__dirname);
		const plan = cleaner.buildPlan(Object.assign({}, ledgers, options));
		if (options.json) console.log(JSON.stringify(plan, null, 2)); else printText(plan);
	} catch (error) {
		console.error('台帳整理に失敗しました: ' + error.message);
		process.exitCode = 1;
	}
}
