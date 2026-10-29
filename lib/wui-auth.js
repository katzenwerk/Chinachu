'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_VERSION = 1;
const COOKIE_NAME = 'chinachu_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SETUP_TTL_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT = 5;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const SCRYPT_KEY_LENGTH = 64;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function randomId(bytes = 32) {
	return crypto.randomBytes(bytes).toString('base64url');
}

function safeEqualText(a, b) {
	const left = Buffer.from(String(a || ''));
	const right = Buffer.from(String(b || ''));
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function writePrivateFileAtomic(filename, content) {
	const directory = path.dirname(filename);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, '.' + path.basename(filename) + '.' + process.pid + '.' + randomId(6));
	let descriptor;
	try {
		descriptor = fs.openSync(temporary, 'wx', 0o600);
		fs.writeFileSync(descriptor, content, { encoding: 'utf8' });
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		fs.renameSync(temporary, filename);
		fs.chmodSync(filename, 0o600);
	} catch (error) {
		if (descriptor !== undefined) {
			try { fs.closeSync(descriptor); } catch (_) {}
		}
		try { fs.unlinkSync(temporary); } catch (_) {}
		throw error;
	}
}

function scrypt(password, salt) {
	return new Promise((resolve, reject) => {
		crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (error, derived) => {
			if (error) reject(error); else resolve(derived);
		});
	});
}

async function createPasswordRecord(password) {
	validateNewPassword(password);
	const salt = crypto.randomBytes(16);
	const hash = await scrypt(password, salt);
	return {
		algorithm: 'scrypt',
		salt: salt.toString('base64'),
		hash: hash.toString('base64'),
		keyLength: SCRYPT_KEY_LENGTH,
		N: SCRYPT_OPTIONS.N,
		r: SCRYPT_OPTIONS.r,
		p: SCRYPT_OPTIONS.p
	};
}

async function verifyPassword(record, password) {
	if (!record || typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > 1024) return false;
	try {
		const salt = Buffer.from(record.salt, 'base64');
		const expected = Buffer.from(record.hash, 'base64');
		const actual = await scrypt(password, salt);
		return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
	} catch (_) {
		return false;
	}
}

function validateNewPassword(password) {
	if (typeof password !== 'string' || password.length < 6) {
		throw new Error('パスワードは6文字以上で指定してください');
	}
	if (Buffer.byteLength(password, 'utf8') > 1024) throw new Error('パスワードが長すぎます');
}

function encodeBase32(buffer) {
	let bits = 0;
	let value = 0;
	let output = '';
	for (const byte of buffer) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	return output;
}

function decodeBase32(value) {
	const normalized = String(value || '').toUpperCase().replace(/[\s=-]/g, '');
	let bits = 0;
	let current = 0;
	const output = [];
	for (const character of normalized) {
		const index = BASE32_ALPHABET.indexOf(character);
		if (index === -1) throw new Error('Invalid Base32 secret');
		current = (current << 5) | index;
		bits += 5;
		if (bits >= 8) {
			output.push((current >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(output);
}

function totpAt(secret, counter) {
	const counterBuffer = Buffer.alloc(8);
	counterBuffer.writeBigUInt64BE(BigInt(counter));
	const digest = crypto.createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1000000;
	return String(number).padStart(6, '0');
}

function verifyTotp(secret, code, lastUsedCounter, now = Date.now()) {
	if (!/^\d{6}$/.test(String(code || ''))) return null;
	const current = Math.floor(now / 30000);
	for (let delta = -1; delta <= 1; delta++) {
		const counter = current + delta;
		if (counter < 0 || (Number.isInteger(lastUsedCounter) && counter <= lastUsedCounter)) continue;
		if (safeEqualText(totpAt(secret, counter), code)) return counter;
	}
	return null;
}

function validateState(value) {
	if (!value || value.version !== AUTH_VERSION || typeof value.revision !== 'string') throw new Error('unsupported auth file');
	if (value.password !== null && value.password !== undefined) {
		const password = value.password;
		if (password.algorithm !== 'scrypt' || typeof password.salt !== 'string' || typeof password.hash !== 'string' ||
			password.keyLength !== SCRYPT_KEY_LENGTH || password.N !== SCRYPT_OPTIONS.N || password.r !== SCRYPT_OPTIONS.r || password.p !== SCRYPT_OPTIONS.p) {
			throw new Error('invalid password record');
		}
		if (Buffer.from(password.salt, 'base64').length !== 16 || Buffer.from(password.hash, 'base64').length !== SCRYPT_KEY_LENGTH) {
			throw new Error('invalid password record encoding');
		}
	}
	if (!value.totp || typeof value.totp.enabled !== 'boolean') throw new Error('invalid TOTP record');
	if (value.totp.enabled && (typeof value.totp.secret !== 'string' || decodeBase32(value.totp.secret).length !== 20)) throw new Error('missing TOTP secret');
	if (value.totp.lastUsedCounter !== null && value.totp.lastUsedCounter !== undefined && !Number.isInteger(value.totp.lastUsedCounter)) {
		throw new Error('invalid TOTP counter');
	}
	return value;
}

function freshState() {
	return {
		version: AUTH_VERSION,
		revision: randomId(12),
		password: null,
		totp: { enabled: false, secret: null, lastUsedCounter: null },
		updatedAt: new Date().toISOString()
	};
}

function createAuthStore(rootDir) {
	const authFile = path.join(rootDir, 'data', 'wui-auth.json');
	const enabledFile = path.join(rootDir, 'data', 'wui-auth.enabled');

	function read() {
		const enabled = fs.existsSync(enabledFile);
		let state;
		try {
			const authStat = fs.lstatSync(authFile);
			if (!authStat.isFile() || (enabled && (authStat.mode & 0o077) !== 0)) {
				throw new Error('auth file permissions are not private');
			}
			state = validateState(JSON.parse(fs.readFileSync(authFile, 'utf8')));
		} catch (error) {
			if (error.code === 'ENOENT' && !enabled) return { enabled: false, locked: false, configured: false, state: freshState() };
			if (!enabled) return { enabled: false, locked: false, configured: false, state: freshState(), warning: error.message };
			return { enabled: true, locked: true, configured: false, state: null, error: error.message };
		}
		if (enabled && !state.password) return { enabled: true, locked: true, configured: false, state: null, error: 'password is not configured' };
		return { enabled, locked: false, configured: Boolean(state.password), state };
	}

	function write(state) {
		const next = validateState({ ...state, revision: randomId(12), updatedAt: new Date().toISOString() });
		writePrivateFileAtomic(authFile, JSON.stringify(next, null, 2) + '\n');
		return next;
	}

	function setEnabled(enabled) {
		if (enabled) {
			writePrivateFileAtomic(enabledFile, 'enabled\n');
		} else {
			try { fs.unlinkSync(enabledFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
		}
	}

	return { authFile, enabledFile, read, write, setEnabled };
}

function parseCookies(header) {
	const cookies = {};
	String(header || '').split(';').forEach(item => {
		const index = item.indexOf('=');
		if (index === -1) return;
		cookies[item.slice(0, index).trim()] = item.slice(index + 1).trim();
	});
	return cookies;
}

function requestAddress(req) {
	return String(req?.socket?.remoteAddress || req?.client?.remoteAddress || 'unknown');
}

function createAuthManager(options) {
	const store = createAuthStore(options.rootDir);
	const log = typeof options.log === 'function' ? options.log : function () {};
	const sessions = new Map();
	const anonymousSockets = new Set();
	const anonymousResponses = new Set();
	const challenges = new Map();
	const setups = new Map();
	const attempts = new Map();
	let lastRevision = null;

	function sessionKey(token) {
		return crypto.createHash('sha256').update(String(token || '')).digest('hex');
	}

	function disconnectSession(session) {
		if (session?.timer) clearTimeout(session.timer);
		for (const socket of session?.sockets || []) {
			try { socket.emit('auth-expired'); } catch (_) {}
			try { socket.disconnect(true); } catch (_) {}
		}
		for (const response of session?.responses || []) {
			try { response.destroy(); } catch (_) {}
		}
	}

	function clearSessions() {
		for (const session of sessions.values()) disconnectSession(session);
		sessions.clear();
		challenges.clear();
		setups.clear();
		disconnectAnonymousSockets();
	}

	function clearSessionsExcept(keptSession) {
		for (const [key, session] of sessions) {
			if (session === keptSession) continue;
			sessions.delete(key);
			disconnectSession(session);
		}
		challenges.clear();
		setups.clear();
	}

	function disconnectAnonymousSockets() {
		for (const socket of anonymousSockets) {
			try { socket.emit('auth-refresh'); } catch (_) {}
			try { socket.disconnect(true); } catch (_) {}
		}
		anonymousSockets.clear();
	}

	function disconnectAnonymousClients() {
		disconnectAnonymousSockets();
		for (const response of anonymousResponses) {
			try { response.destroy(); } catch (_) {}
		}
		anonymousResponses.clear();
	}

	function deferClearSessions() {
		setImmediate(clearSessions);
	}

	function snapshot() {
		const current = store.read();
		const revision = current.state
			? (current.enabled ? 'enabled:' : 'disabled:') + current.state.revision
			: (current.locked ? 'locked:' + current.error : 'unconfigured');
		if (lastRevision !== null && revision !== lastRevision) clearSessions();
		lastRevision = revision;
		return current;
	}

	function commit(state) {
		const next = store.write(state);
		lastRevision = (fs.existsSync(store.enabledFile) ? 'enabled:' : 'disabled:') + next.revision;
		return next;
	}

	function isCurrent(current, req, session) {
		const latest = snapshot();
		return !latest.locked && latest.enabled === current.enabled &&
			latest.state?.revision === current.state?.revision &&
			(!req || !current.enabled || (Boolean(session) && getSession(req) === session));
	}

	function authenticationChanged() {
		return result(409, { error: '認証状態が変更されました。画面を再読み込みして操作をやり直してください。' });
	}

	function getSession(req) {
		const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
		if (!token) return null;
		const key = sessionKey(token);
		const session = sessions.get(key);
		if (!session) return null;
		if (session.expiresAt <= Date.now()) {
			disconnectSession(session);
			sessions.delete(key);
			return null;
		}
		return session;
	}

	function cookie(token, req, expiresAt) {
		const parts = [COOKIE_NAME + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
		if (expiresAt) parts.push('Expires=' + new Date(expiresAt).toUTCString(), 'Max-Age=' + Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
		else parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'Max-Age=0');
		const forwardedProtocol = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
		if (req?.socket?.encrypted === true || forwardedProtocol === 'https') parts.push('Secure');
		return parts.join('; ');
	}

	function createSession(req, previousSession = null) {
		const token = randomId();
		const key = sessionKey(token);
		const session = {
			id: randomId(12),
			csrfToken: randomId(24),
			expiresAt: Date.now() + SESSION_TTL_MS,
			sockets: new Set(previousSession?.sockets || []),
			responses: new Set(previousSession?.responses || []),
			timer: null
		};
		if (previousSession) {
			if (previousSession.timer) clearTimeout(previousSession.timer);
			for (const [previousKey, value] of sessions) {
				if (value !== previousSession) continue;
				sessions.delete(previousKey);
				break;
			}
			for (const socket of session.sockets) socket.once('disconnect', () => session.sockets.delete(socket));
			for (const response of session.responses) {
				const remove = () => session.responses.delete(response);
				response.once('close', remove);
				response.once('finish', remove);
			}
		}
		session.timer = setTimeout(() => {
			disconnectSession(session);
			sessions.delete(key);
		}, SESSION_TTL_MS);
		session.timer.unref?.();
		sessions.set(key, session);
		return { session, cookie: cookie(token, req, session.expiresAt) };
	}

	function rateKey(kind, req) {
		return kind + ':' + requestAddress(req);
	}

	function rateBlocked(kind, req) {
		const key = rateKey(kind, req);
		const entry = attempts.get(key);
		if (entry && entry.inFlight) return true;
		if (!entry || entry.resetAt <= Date.now()) {
			attempts.delete(key);
			return false;
		}
		return entry.count >= RATE_LIMIT;
	}

	function rateFailure(kind, req) {
		const key = rateKey(kind, req);
		const previous = attempts.get(key);
		const entry = !previous || previous.resetAt <= Date.now()
			? { count: 0, resetAt: Date.now() + RATE_WINDOW_MS }
			: previous;
		entry.count += 1;
		attempts.set(key, entry);
	}

	function rateSuccess(kind, req) {
		attempts.delete(rateKey(kind, req));
	}

	async function verifyPasswordAttempt(req, verify, current) {
		if (rateBlocked('password', req)) return null;
		const key = rateKey('password', req);
		const entry = attempts.get(key) || { count: 0, resetAt: 0 };
		// Reserve before yielding; a window expiry must not release an active check.
		entry.inFlight = true;
		attempts.set(key, entry);
		try {
			const verified = await verify();
			if (!isCurrent(current)) return false;
			if (verified) rateSuccess('password', req);
			else rateFailure('password', req);
			return verified;
		} finally {
			entry.inFlight = false;
			if (attempts.get(key) === entry && entry.count === 0) attempts.delete(key);
		}
	}

	async function verifyCurrent(current, password, code, consumeTotp = true) {
		if (!current.state?.password || !await verifyPassword(current.state.password, password)) return false;
		// Check before consuming TOTP, which itself commits a new revision.
		if (!isCurrent(current)) return false;
		if (!current.state.totp.enabled) return true;
		const counter = verifyTotp(current.state.totp.secret, code, current.state.totp.lastUsedCounter);
		if (counter === null) return false;
		if (consumeTotp) {
			current.state.totp.lastUsedCounter = counter;
			current.state = commit(current.state);
		}
		return true;
	}

	function statusFor(req) {
		const current = snapshot();
		const session = current.enabled && !current.locked ? getSession(req) : null;
		return {
			enabled: current.enabled,
			configured: current.configured,
			locked: current.locked,
			authenticated: !current.enabled || Boolean(session),
			username: 'admin',
			totpEnabled: Boolean(current.state?.totp?.enabled),
			csrfToken: session?.csrfToken || null
		};
	}

	function isAuthApiPath(location) {
		return /^\/api\/auth(?:\/[^/]+)*\.json$/.test(location);
	}

	function authorizeApi(req) {
		const current = snapshot();
		if (!current.enabled) return { ok: true, session: null };
		if (current.locked) return { ok: false, status: 503 };
		const session = getSession(req);
		if (!session) return { ok: false, status: 401 };
		if (!['GET', 'HEAD'].includes(req.method) && !safeEqualText(req.headers['x-chinachu-csrf'], session.csrfToken)) {
			return { ok: false, status: 403 };
		}
		return { ok: true, session };
	}

	function authorizeSocket(req) {
		const current = snapshot();
		if (!current.enabled) return true;
		return !current.locked && Boolean(getSession(req));
	}

	function registerSocket(socket) {
		const current = snapshot();
		if (!current.enabled) {
			anonymousSockets.add(socket);
			socket.once('disconnect', () => anonymousSockets.delete(socket));
			return;
		}
		const session = getSession(socket.request);
		if (!session) return socket.disconnect(true);
		session.sockets.add(socket);
		socket.once('disconnect', () => session.sockets.delete(socket));
	}

	function registerResponse(session, response) {
		if (!response) return;
		const responses = session ? session.responses : anonymousResponses;
		responses.add(response);
		const remove = () => responses.delete(response);
		response.once('close', remove);
		response.once('finish', remove);
	}

	function result(status, body, headers = {}, afterSend = null) {
		return { status, body, headers, afterSend };
	}

	async function handleHttp(req, location, query) {
		const current = snapshot();
		const route = location.slice('/api/auth'.length, -'.json'.length) || '/status';
		const session = getSession(req);

		if (route === '/status' && req.method === 'GET') return result(200, statusFor(req));
		if (current.locked) return result(503, { error: '認証情報を読み込めません。Linux実機の管理CLIで復旧してください。' });
		if (current.enabled && session && !['GET', 'HEAD'].includes(req.method) &&
			!safeEqualText(req.headers['x-chinachu-csrf'], session.csrfToken)) {
			return result(403, { error: '操作確認情報が一致しません。画面を再読み込みしてください。' });
		}

		if (route === '/login' && req.method === 'POST') {
			if (!current.enabled) return result(409, { error: 'ログイン認証は無効です。' });
			const verified = await verifyPasswordAttempt(req, () =>
				query.username === 'admin' && verifyPassword(current.state.password, query.password), current);
			if (verified === null) return result(429, { error: 'ログイン試行回数が上限に達しました。しばらく待ってください。' });
			if (!isCurrent(current)) return authenticationChanged();
			if (!verified) {
				log('AUTH: password login failed address=' + requestAddress(req));
				return result(401, { error: 'ユーザー名またはパスワードが正しくありません。' });
			}
			if (current.state.totp.enabled) {
				const challengeId = randomId(24);
				challenges.set(challengeId, { address: requestAddress(req), expiresAt: Date.now() + CHALLENGE_TTL_MS });
				return result(200, { authenticated: false, totpRequired: true, challengeId });
			}
			const created = createSession(req);
			return result(200, { authenticated: true }, { 'Set-Cookie': created.cookie });
		}

		if (route === '/totp' && req.method === 'POST') {
			if (rateBlocked('totp', req)) return result(429, { error: '認証コードの試行回数が上限に達しました。しばらく待ってください。' });
			const challenge = challenges.get(String(query.challengeId || ''));
			if (!challenge || challenge.expiresAt <= Date.now() || challenge.address !== requestAddress(req)) {
				return result(401, { error: 'ログイン確認の有効期限が切れました。' });
			}
			const counter = verifyTotp(current.state.totp.secret, query.code, current.state.totp.lastUsedCounter);
			if (counter === null) {
				const usedCounter = verifyTotp(current.state.totp.secret, query.code, null);
				rateFailure('totp', req);
				log('AUTH: TOTP login failed address=' + requestAddress(req));
				return result(401, { error: Number.isInteger(usedCounter) && usedCounter <= current.state.totp.lastUsedCounter
					? 'このコードは使用済みです。新しく表示されたコードを入力してください。'
					: '認証コードを確認してください。' });
			}
			current.state.totp.lastUsedCounter = counter;
			commit(current.state);
			challenges.delete(String(query.challengeId));
			rateSuccess('totp', req);
			const created = createSession(req);
			return result(200, { authenticated: true }, { 'Set-Cookie': created.cookie });
		}

		if (route === '/logout' && req.method === 'POST') {
			if (current.enabled) {
				const authorization = authorizeApi(req);
				if (!authorization.ok) return result(authorization.status, { error: '認証が必要です。' });
				for (const [key, value] of sessions) {
					if (value === authorization.session) {
						sessions.delete(key);
						setImmediate(() => disconnectSession(value));
						break;
					}
				}
			}
			return result(200, { authenticated: false }, { 'Set-Cookie': cookie('', req, 0) });
		}

		if (route === '/settings' && req.method === 'GET') {
			if (current.locked || current.warning) return result(503, { error: '認証情報の状態を確認できません。Linux実機で認証ファイルを確認してください。' });
			if (current.enabled && !session) return result(401, { error: '認証が必要です。' });
			return result(200, {
				enabled: current.enabled,
				configured: current.configured,
				totpEnabled: Boolean(current.state?.totp?.enabled),
				username: 'admin'
			});
		}

		if (route === '/enabled' && req.method === 'POST') {
			const enable = query.enabled === true || query.enabled === 'true' || query.enabled === '1';
			if (enable === current.enabled) return result(200, { enabled: current.enabled, totpEnabled: current.state.totp.enabled });
			if (current.enabled && !session) return result(401, { error: '認証が必要です。' });
			if (!current.configured) return result(409, { error: '先にLinux実機の管理CLIでパスワードを登録してください。' });
			const verified = await verifyPasswordAttempt(req, () => verifyCurrent(current, query.password, query.totp), current);
			if (verified === null) return result(429, { error: 'パスワード試行回数が上限に達しました。しばらく待ってください。' });
			if (!isCurrent(current, req, session)) return authenticationChanged();
			if (!verified) {
				return result(401, { error: '現在のパスワードまたは確認コードが正しくありません。' });
			}
			store.setEnabled(enable);
			lastRevision = (enable ? 'enabled:' : 'disabled:') + current.state.revision;
			if (enable) {
				const created = createSession(req);
				clearSessionsExcept(created.session);
				return result(200, {
					enabled: true,
					authenticated: true,
					totpEnabled: current.state.totp.enabled,
					csrfToken: created.session.csrfToken
				}, { 'Set-Cookie': created.cookie }, disconnectAnonymousClients);
			}
			deferClearSessions();
			return result(200, { enabled: enable, totpEnabled: current.state.totp.enabled }, { 'Set-Cookie': cookie('', req, 0) });
		}

		if (route === '/password' && req.method === 'POST') {
			if (current.enabled && !session) return result(401, { error: '認証が必要です。' });
			if (!current.configured) return result(409, { error: '初回パスワードはLinux実機の管理CLIで登録してください。' });
			try { validateNewPassword(query.newPassword); } catch (error) { return result(400, { error: error.message }); }
			const verified = await verifyPasswordAttempt(req, () => verifyCurrent(current, query.password, query.totp), current);
			if (verified === null) return result(429, { error: 'パスワード試行回数が上限に達しました。しばらく待ってください。' });
			if (!isCurrent(current, req, session)) return authenticationChanged();
			if (!verified) {
				return result(401, { error: '現在のパスワードまたは確認コードが正しくありません。' });
			}
			let password;
			try { password = await createPasswordRecord(query.newPassword); } catch (error) { return result(400, { error: error.message }); }
			if (!isCurrent(current, req, session)) return authenticationChanged();
			current.state.password = password;
			commit(current.state);
			deferClearSessions();
			return result(200, { changed: true }, { 'Set-Cookie': cookie('', req, 0) });
		}

		if (route === '/totp/setup' && req.method === 'POST') {
			if (!current.enabled || !session) return result(401, { error: 'ログイン認証を有効にしてログインしてください。' });
			const verified = await verifyCurrent(current, query.password, query.totp);
			if (!isCurrent(current, req, session)) return authenticationChanged();
			if (!verified) return result(401, { error: '現在のパスワードまたは確認コードが正しくありません。' });
			const setupId = randomId(24);
			const secret = encodeBase32(crypto.randomBytes(20));
			const issuer = 'Chinachu';
			const account = os.hostname();
			const label = encodeURIComponent(issuer + ':' + account);
			setups.set(setupId, { secret, sessionId: session.id, expiresAt: Date.now() + SETUP_TTL_MS });
			return result(200, {
				setupId,
				secret,
				account,
				issuer,
				otpauth: 'otpauth://totp/' + label + '?secret=' + encodeURIComponent(secret) + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30'
			});
		}

		if (route === '/totp/confirm' && req.method === 'POST') {
			if (!current.enabled || !session) return result(401, { error: '認証が必要です。' });
			const setup = setups.get(String(query.setupId || ''));
			if (!setup || setup.expiresAt <= Date.now() || setup.sessionId !== session.id) return result(410, { error: '2FA（TOTP）登録の有効期限が切れました。' });
			const counter = verifyTotp(setup.secret, query.code, null);
			if (counter === null) return result(401, { error: '認証コードを確認してください。' });
			current.state.totp = { enabled: true, secret: setup.secret, lastUsedCounter: counter };
			setups.delete(String(query.setupId));
			commit(current.state);
			const created = createSession(req, session);
			clearSessionsExcept(created.session);
			return result(200, {
				enabled: true,
				authenticated: true,
				totpEnabled: true,
				csrfToken: created.session.csrfToken
			}, { 'Set-Cookie': created.cookie });
		}

		if (route === '/totp/disable' && req.method === 'POST') {
			if (!current.enabled || !session) return result(401, { error: '認証が必要です。' });
			if (!current.state.totp.enabled) return result(200, { totpEnabled: false });
			const verified = await verifyCurrent(current, query.password, query.totp);
			if (!isCurrent(current, req, session)) return authenticationChanged();
			if (!verified) return result(401, { error: '現在のパスワードまたは確認コードが正しくありません。' });
			current.state.totp = { enabled: false, secret: null, lastUsedCounter: null };
			commit(current.state);
			deferClearSessions();
			return result(200, { totpEnabled: false }, { 'Set-Cookie': cookie('', req, 0) });
		}

		return result(404, { error: '認証APIが見つかりません。' });
	}

	return {
		store,
		statusFor,
		isAuthApiPath,
		authorizeApi,
		authorizeSocket,
		registerSocket,
		registerResponse,
		handleHttp,
		clearSessions
	};
}

module.exports = {
	createAuthManager,
	createAuthStore,
	createPasswordRecord,
	verifyPassword,
	encodeBase32,
	verifyTotp,
	validateNewPassword
};
