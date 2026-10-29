#!/usr/bin/env node
'use strict';

const readline = require('readline');
const auth = require('./lib/wui-auth');

process.umask(0o077);

const store = auth.createAuthStore(__dirname);

function fail(message) {
	console.error('ERROR: ' + message);
	process.exitCode = 1;
}

function promptHidden(label) {
	if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== 'function') {
		return Promise.reject(new Error('この操作は対話可能なLinux端末で実行してください'));
	}
	return new Promise((resolve, reject) => {
		let value = '';
		process.stdout.write(label);
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.setEncoding('utf8');
		const cleanup = () => {
			process.stdin.removeListener('data', onData);
			process.stdin.setRawMode(false);
			process.stdin.pause();
		};
		const onData = character => {
			if (character === '\u0003') {
				cleanup();
				process.stdout.write('\n');
				reject(new Error('中止しました'));
				return;
			}
			if (character === '\r' || character === '\n') {
				cleanup();
				process.stdout.write('\n');
				resolve(value);
				return;
			}
			if (character === '\u007f' || character === '\b') {
				value = value.slice(0, -1);
				return;
			}
			if (character >= ' ') value += character;
		};
		process.stdin.on('data', onData);
	});
}

function confirm(question) {
	const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => terminal.question(question, answer => {
		terminal.close();
		resolve(/^y(?:es)?$/i.test(answer.trim()));
	}));
}

async function setupPassword() {
	const first = await promptHidden('新しいadminパスワード（6文字以上）: ');
	const second = await promptHidden('確認のため再入力: ');
	if (first !== second) throw new Error('パスワードが一致しません');
	auth.validateNewPassword(first);
	const current = store.read();
	if (current.locked && !await confirm('認証ファイルが壊れているか欠落しています。上書きして復旧しますか [y/N]? ')) return;
	const state = current.state || {
		version: 1,
		revision: '',
		password: null,
		totp: { enabled: false, secret: null, lastUsedCounter: null },
		updatedAt: null
	};
	state.password = await auth.createPasswordRecord(first);
	store.write(state);
	console.log('\n管理者パスワードを登録しました。');
	console.log('ログイン認証を有効にする場合は、WUIの「設定 → ログイン認証」から設定してください。');
	console.log('\nパスワード・2FAを忘れた場合');
	console.log('- パスワードを忘れた場合: ./chinachu auth setup');
	console.log('- 認証アプリを利用できなくなった場合: ./chinachu auth disable-totp');
}

async function disableTotp() {
	const current = store.read();
	if (!current.state || !current.configured) throw new Error('認証情報がありません。先に setup を実行してください');
	if (!current.state.totp.enabled) {
		console.log('2FA（TOTP）は既に無効です。');
		return;
	}
	if (!await confirm('2FA（TOTP）を解除しますか [y/N]? ')) return;
	current.state.totp = { enabled: false, secret: null, lastUsedCounter: null };
	store.write(current.state);
	console.log('2FA（TOTP）を解除しました。WUIの既存セッションは次の要求時に失効します。');
}

async function disableAuth() {
	const current = store.read();
	if (!current.enabled) {
		console.log('ログイン認証は既に無効です。');
		return;
	}
	if (!await confirm('ログイン認証を無効にしますか [y/N]? ')) return;
	store.setEnabled(false);
	console.log('ログイン認証を無効にしました。保存済みのパスワードとTOTPは削除していません。');
}

function showStatus() {
	const current = store.read();
	console.log('ログイン認証: ' + (current.enabled ? (current.locked ? 'LOCKED' : 'ON') : 'OFF'));
	console.log('管理者パスワード: ' + (current.configured ? '設定済み' : '未設定'));
	console.log('2FA（TOTP）: ' + (current.state?.totp?.enabled ? 'ON' : 'OFF'));
	console.log('認証ファイル: ' + store.authFile);
}

function reportSetupState() {
	let current;
	try {
		current = store.read();
	} catch (_) {
		process.exitCode = 2;
		return;
	}
	if (current.locked || current.warning) {
		process.exitCode = 2;
		return;
	}
	process.exitCode = current.configured ? 1 : 0;
}

async function main() {
	const command = process.argv[2] || 'status';
	if (command === 'status') return showStatus();
	if (command === 'setup') return setupPassword();
	if (command === 'disable-totp') return disableTotp();
	if (command === 'disable-auth') return disableAuth();
	if (command === '_needs-setup') return reportSetupState();
	throw new Error('Usage: ./chinachu auth [status|setup|disable-totp|disable-auth]');
}

main().catch(error => fail(error.message));
