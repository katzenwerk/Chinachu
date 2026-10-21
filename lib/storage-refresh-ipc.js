'use strict';

const fs = require('fs');
const net = require('net');

const MAX_MESSAGE_BYTES = 64 * 1024;

function encode(value) {
	return JSON.stringify(value) + '\n';
}

function sameSocket(left, right) {
	return left && right && left.dev === right.dev && left.ino === right.ino;
}

function removeSocketIfSame(socketPath, identity, fileSystem) {
	try {
		const current = fileSystem.lstatSync(socketPath);
		if (sameSocket(current, identity) && current.isSocket()) fileSystem.unlinkSync(socketPath);
	} catch (error) {
		if (!error || error.code !== 'ENOENT') throw error;
	}
}

function clearStaleSocket(socketPath, options) {
	const fileSystem = options.fs || fs;
	const network = options.net || net;
	let identity;
	try {
		identity = fileSystem.lstatSync(socketPath);
	} catch (error) {
		if (error && error.code === 'ENOENT') return Promise.resolve();
		return Promise.reject(error);
	}
	if (!identity.isSocket()) {
		const error = new Error('runtime socket path is occupied by a non-socket file: ' + socketPath);
		error.code = 'EEXIST';
		return Promise.reject(error);
	}

	return new Promise((resolve, reject) => {
		let settled = false;
		const probe = network.createConnection(socketPath);
		const timer = setTimeout(() => finish(new Error('runtime socket ownership probe timed out: ' + socketPath)), 1000);

		function finish(error) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			probe.removeAllListeners();
			if (!probe.destroyed) probe.destroy();
			if (error) reject(error); else resolve();
		}

		probe.once('connect', () => {
			const error = new Error('runtime socket is already in use: ' + socketPath);
			error.code = 'EADDRINUSE';
			finish(error);
		});
		probe.once('error', error => {
			if (error.code === 'ENOENT') return finish();
			if (error.code !== 'ECONNREFUSED') return finish(error);
			try {
				removeSocketIfSame(socketPath, identity, fileSystem);
				finish();
			} catch (removeError) {
				finish(removeError);
			}
		});
	});
}

function createServer(options) {
	options = options || {};
	const socketPath = options.socketPath;
	const handler = options.handler;
	const log = typeof options.log === 'function' ? options.log : function () {};
	const label = options.label || 'Storage refresh IPC';
	const fileSystem = options.fs || fs;
	const network = options.net || net;
	let server = null;
	let boundIdentity = null;
	let listenPromise = null;

	function listen() {
		if (server) return Promise.resolve(server);
		if (listenPromise) return listenPromise;
		listenPromise = clearStaleSocket(socketPath, { fs: fileSystem, net: network }).then(() => new Promise((resolve, reject) => {
			server = network.createServer(socket => {
				let input = '';
				let handled = false;
				socket.setEncoding('utf8');
				socket.setTimeout(5000, () => socket.destroy());
				socket.on('error', () => {});
				socket.on('data', chunk => {
					if (handled) return;
					input += chunk;
					if (Buffer.byteLength(input, 'utf8') > MAX_MESSAGE_BYTES) {
						handled = true;
						socket.end(encode({ ok: false, statusCode: 413, error: 'request_too_large' }));
						return;
					}
					const newline = input.indexOf('\n');
					if (newline === -1) return;
					handled = true;
					let request;
					try {
						request = JSON.parse(input.slice(0, newline));
					} catch (_) {
						socket.end(encode({ ok: false, statusCode: 400, error: 'invalid_request' }));
						return;
					}
					Promise.resolve().then(() => handler(request)).then(result => {
						socket.end(encode({ ok: true, result: result }));
					}).catch(error => {
						socket.end(encode({
							ok: false,
							statusCode: error && error.statusCode || 500,
							error: error && error.code || 'refresh_failed',
							message: error && error.publicMessage || '容量情報を更新できませんでした。'
						}));
					});
				});
			});
			server.once('error', error => {
				server = null;
				reject(error);
			});
			server.listen(socketPath, () => {
				server.removeAllListeners('error');
				server.on('error', error => log('WARNING: ' + label + ' error: ' + error.message));
				try {
					fileSystem.chmodSync(socketPath, 0o600);
					boundIdentity = fileSystem.lstatSync(socketPath);
				} catch (error) {
					log('WARNING: ' + label + ' permission update failed: ' + error.message);
				}
				resolve(server);
			});
		})).finally(() => { listenPromise = null; });
		return listenPromise;
	}

	function close() {
		if (!server) return;
		const active = server;
		const identity = boundIdentity;
		server = null;
		boundIdentity = null;
		try {
			active.close(() => {
				try { removeSocketIfSame(socketPath, identity, fileSystem); } catch (error) {
					log('WARNING: ' + label + ' cleanup failed: ' + error.message);
				}
			});
		} catch (_) {}
	}

	return { listen: listen, close: close };
}

function request(options, payload) {
	options = options || {};
	const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000;
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(options.socketPath);
		let input = '';
		let settled = false;
		const timeout = setTimeout(() => finishError('operator_timeout', 504, 'Operatorから応答がありません。'), timeoutMs);

		function cleanup() {
			clearTimeout(timeout);
			socket.removeAllListeners();
			if (!socket.destroyed) socket.destroy();
		}

		function finishError(code, statusCode, publicMessage) {
			if (settled) return;
			settled = true;
			cleanup();
			const error = new Error(publicMessage);
			error.code = code;
			error.statusCode = statusCode;
			error.publicMessage = publicMessage;
			reject(error);
		}

		socket.setEncoding('utf8');
		socket.once('connect', () => socket.write(encode(payload)));
		socket.on('data', chunk => {
			if (settled) return;
			input += chunk;
			if (Buffer.byteLength(input, 'utf8') > MAX_MESSAGE_BYTES) {
				finishError('invalid_operator_response', 502, 'Operatorの応答が不正です。');
				return;
			}
			const newline = input.indexOf('\n');
			if (newline === -1) return;
			let response;
			try { response = JSON.parse(input.slice(0, newline)); } catch (_) {
				finishError('invalid_operator_response', 502, 'Operatorの応答が不正です。');
				return;
			}
			if (!response.ok) {
				finishError(response.error || 'refresh_failed', response.statusCode || 500,
					response.message || '容量情報を更新できませんでした。');
				return;
			}
			settled = true;
			cleanup();
			resolve(response.result);
		});
		socket.once('error', error => {
			if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') {
				finishError('operator_unavailable', 503, 'Operatorが停止しているため更新できません。');
			} else {
				finishError('operator_unavailable', 503, 'Operatorへ接続できません。');
			}
		});
		socket.once('end', () => {
			if (!settled) finishError('invalid_operator_response', 502, 'Operatorから完全な応答を取得できませんでした。');
		});
	});
}

module.exports = {
	clearStaleSocket: clearStaleSocket,
	createServer: createServer,
	request: request
};
