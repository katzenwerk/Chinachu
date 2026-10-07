'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const SESSION_PATTERN = /^[a-f0-9]{48}$/;
const CHANNEL_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HLS_ASSET_PATTERN = /^(?:index\.m3u8|init\.mp4|segment\d{6}\.m4s)$/;

function compatCodecArgs() {
	return [
		'-map', '0:v:0', '-map', '0:a:0?',
		'-threads', '0',
		'-filter:v', 'yadif=mode=send_frame:parity=auto:deint=interlaced',
		'-c:v', 'h264', '-c:a', 'aac', '-b:a', '128k',
		'-profile:v', 'high', '-level:v', '4.0', '-pix_fmt', 'yuv420p',
		'-preset', 'superfast', '-tune', 'zerolatency', '-threads:v', '2',
		'-crf', '21', '-maxrate:v', '8M', '-bufsize:v', '16M',
		'-g', '60', '-keyint_min', '60', '-sc_threshold', '0'
	];
}

function buildLiveHlsArgs(directory) {
	return [
		'-v', 'error', '-re', '-i', 'pipe:0'
	].concat(compatCodecArgs(), [
		'-f', 'hls',
		'-hls_time', '2',
		'-hls_list_size', '6',
		'-hls_delete_threshold', '2',
		'-hls_flags', 'delete_segments+independent_segments+temp_file',
		'-hls_segment_type', 'fmp4',
		'-hls_fmp4_init_filename', 'init.mp4',
		'-hls_segment_filename', path.join(directory, 'segment%06d.m4s'),
		'-y', path.join(directory, 'index.m3u8')
	]);
}

function buildRecordedMp4Args(source, destination) {
	return [
		'-v', 'error', '-i', source
	].concat(compatCodecArgs(), [
		'-movflags', '+faststart',
		'-y', destination
	]);
}

function buildRecordedHlsArgs(source, directory) {
	return [
		'-v', 'error', '-i', source
	].concat(compatCodecArgs(), [
		'-f', 'hls',
		'-hls_time', '2',
		'-hls_list_size', '0',
		'-hls_playlist_type', 'event',
		'-hls_flags', 'independent_segments+temp_file',
		'-hls_segment_type', 'fmp4',
		'-hls_fmp4_init_filename', 'init.mp4',
		'-hls_segment_filename', path.join(directory, 'segment%06d.m4s'),
		'-y', path.join(directory, 'index.m3u8')
	]);
}

function parseSingleRange(value, size) {
	if (typeof value !== 'string') return null;
	const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
	if (!match || (!match[1] && !match[2]) || size <= 0) return { invalid: true };

	let start;
	let end;
	if (match[1]) {
		start = Number(match[1]);
		end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	} else {
		const suffix = Number(match[2]);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
		start = Math.max(0, size - suffix);
		end = size - 1;
	}

	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
		return { invalid: true };
	}
	return { start, end };
}

function removeDirectory(directory, root) {
	const resolvedRoot = path.resolve(root);
	const resolved = path.resolve(directory);
	if (resolved === resolvedRoot || !resolved.startsWith(resolvedRoot + path.sep)) {
		throw new Error('refusing to remove a path outside the media root');
	}
	fs.rmSync(resolved, { recursive: true, force: true });
}

function ensurePrivateDirectory(directory) {
	try {
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('media path is not a real directory: ' + directory);
		if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('media path has an unexpected owner: ' + directory);
		fs.chmodSync(directory, 0o700);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const stat = fs.lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('failed to create a private media directory: ' + directory);
	}
}

class MediaDelivery {
	constructor(options = {}) {
		const owner = typeof process.getuid === 'function' ? process.getuid() : 'user';
		this.root = path.resolve(options.root || path.join(os.tmpdir(), 'chinachu-media-' + owner));
		this.liveRoot = path.join(this.root, 'live');
		this.recordedRoot = path.join(this.root, 'recorded');
		this.recordedHlsRoot = path.join(this.root, 'recorded-hls');
		this.spawn = options.spawn || childProcess.spawn;
		this.mirakurun = options.mirakurun;
		this.log = options.log || function() {};
		this.now = options.now || Date.now;
		this.liveIdleMs = options.liveIdleMs || 120000;
		this.staleMs = options.staleMs || 24 * 60 * 60 * 1000;
		this.killTimeoutMs = options.killTimeoutMs || 3000;
		this.live = new Map();
		this.recorded = new Map();
		this.recordedHls = new Map();
		this.nextStaleCleanup = this.now() + Math.min(this.staleMs, 60 * 60 * 1000);
		ensurePrivateDirectory(this.root);
		ensurePrivateDirectory(this.liveRoot);
		ensurePrivateDirectory(this.recordedRoot);
		ensurePrivateDirectory(this.recordedHlsRoot);
		this.cleanupStaleDirectories();
		this.timer = setInterval(() => this.cleanupIdle(), Math.min(this.liveIdleMs, 60000));
		if (this.timer.unref) this.timer.unref();
	}

	writeLog(message) {
		this.log('[media-delivery] ' + message);
	}

	cleanupStaleDirectories() {
		for (const root of [this.liveRoot, this.recordedRoot, this.recordedHlsRoot]) {
			for (const name of fs.readdirSync(root)) {
				const target = path.join(root, name);
				let stat;
				try { stat = fs.statSync(target); } catch (_) { continue; }
				if (this.now() - stat.mtimeMs <= this.staleMs) continue;
				try {
					if (stat.isDirectory()) removeDirectory(target, root);
					else {
						fs.unlinkSync(target);
						if (root === this.recordedRoot && /^[a-f0-9]{64}\.mp4$/.test(name)) {
							this.recorded.delete(name.slice(0, 64));
						}
					}
					this.writeLog('removed stale artifact ' + name);
				} catch (error) {
					this.writeLog('failed stale cleanup ' + name + ': ' + error.message);
				}
			}
		}
	}

	cleanupIdle() {
		const now = this.now();
		for (const session of this.live.values()) {
			if (now - session.lastAccess > this.liveIdleMs) this.stopLiveSession(session.id, 'idle timeout');
		}
		for (const session of this.recordedHls.values()) {
			if (now - session.lastAccess > this.liveIdleMs) {
				this.stopRecordedHlsSession(session.recordedId, session.id, 'idle timeout');
			}
		}
		if (now >= this.nextStaleCleanup) {
			this.cleanupStaleDirectories();
			this.nextStaleCleanup = now + Math.min(this.staleMs, 60 * 60 * 1000);
		}
	}

	async createLiveSession(channelId) {
		if (!CHANNEL_PATTERN.test(String(channelId || ''))) throw Object.assign(new Error('invalid channel id'), { statusCode: 400 });
		if (!this.mirakurun || typeof this.mirakurun.getServiceStream !== 'function') throw new Error('Mirakurun is unavailable');

		const id = crypto.randomBytes(24).toString('hex');
		const directory = path.join(this.liveRoot, id);
		fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
		const session = {
			id,
			channelId: String(channelId),
			directory,
			lastAccess: this.now(),
			stream: null,
			child: null,
			stopping: false,
			ready: false
		};
		this.live.set(id, session);
		this.writeLog('live session=' + id + ' channel=' + channelId + ' profile=compat creating');

		try {
			session.stream = await this.mirakurun.getServiceStream(parseInt(channelId, 36), true);
			if (session.stopping) throw new Error('session stopped');
			const args = buildLiveHlsArgs(directory);
			session.child = this.spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
			this.writeLog('live session=' + id + ' ffmpeg pid=' + session.child.pid);
			if (!session.child.stderr) session.child.stderr = new PassThrough();
			session.child.stderr.on('data', chunk => {
				const message = String(chunk).trim();
				if (message) this.writeLog('live session=' + id + ' ffmpeg: ' + message);
			});
			session.child.once('error', error => {
				this.writeLog('live session=' + id + ' ffmpeg error=' + error.message);
				this.stopLiveSession(id, 'ffmpeg error');
			});
			session.child.once('exit', (code, signal) => {
				this.writeLog('live session=' + id + ' ffmpeg exit code=' + code + ' signal=' + signal);
				if (!session.stopping) this.stopLiveSession(id, 'ffmpeg exit');
			});
			session.stream.once('error', error => {
				this.writeLog('live session=' + id + ' input error=' + error.message);
				this.stopLiveSession(id, 'input error');
			});
			session.stream.pipe(session.child.stdin);
			await this.waitForPlaylist(session);
			session.ready = true;
			this.writeLog('live session=' + id + ' ready');
			return { id, playlist: 'index.m3u8' };
		} catch (error) {
			this.stopLiveSession(id, 'startup failed');
			throw error;
		}
	}

	waitForPlaylist(session) {
		return new Promise((resolve, reject) => {
			const started = this.now();
			const check = () => {
				if (session.stopping) return reject(new Error('HLS session stopped before playlist was ready'));
				try {
					if (fs.statSync(path.join(session.directory, 'index.m3u8')).size > 0) return resolve();
				} catch (_) {}
				if (this.now() - started >= 15000) return reject(new Error('HLS playlist generation timed out'));
				setTimeout(check, 100);
			};
			check();
		});
	}

	getLiveAsset(channelId, sessionId, filename) {
		if (!SESSION_PATTERN.test(String(sessionId || '')) || !HLS_ASSET_PATTERN.test(String(filename || ''))) return null;
		const session = this.live.get(sessionId);
		if (!session || session.channelId !== String(channelId) || session.stopping || !session.ready) return null;
		const target = path.resolve(session.directory, filename);
		if (!target.startsWith(path.resolve(session.directory) + path.sep)) return null;
		let stat;
		try { stat = fs.statSync(target); } catch (_) { return null; }
		if (!stat.isFile()) return null;
		session.lastAccess = this.now();
		this.writeLog('live session=' + sessionId + ' asset=' + filename + ' size=' + stat.size);
		return { path: target, size: stat.size };
	}

	stopLiveSession(sessionId, reason) {
		const session = this.live.get(sessionId);
		if (!session || session.stopping) return false;
		session.stopping = true;
		this.live.delete(sessionId);
		this.writeLog('live session=' + sessionId + ' cleanup reason=' + reason);
		if (session.stream) {
			try { session.stream.unpipe(); } catch (_) {}
			try { session.stream.destroy(); } catch (_) {}
			try { if (session.stream.req) session.stream.req.abort(); } catch (_) {}
		}
		const child = session.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			try { child.kill('SIGTERM'); } catch (_) {}
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					try { child.kill('SIGKILL'); } catch (_) {}
				}
			}, this.killTimeoutMs);
			if (timer.unref) timer.unref();
		}
		try { removeDirectory(session.directory, this.liveRoot); } catch (error) { this.writeLog('live cleanup failed: ' + error.message); }
		return true;
	}

	async createRecordedHlsSession(recordedId, source) {
		if (!CHANNEL_PATTERN.test(String(recordedId || ''))) {
			throw Object.assign(new Error('invalid recorded id'), { statusCode: 400 });
		}
		const sourceStat = fs.statSync(source);
		if (!sourceStat.isFile()) throw Object.assign(new Error('recorded source is not a file'), { statusCode: 410 });

		const id = crypto.randomBytes(24).toString('hex');
		const directory = path.join(this.recordedHlsRoot, id);
		fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
		const session = {
			id,
			recordedId: String(recordedId),
			directory,
			lastAccess: this.now(),
			child: null,
			stopping: false,
			ready: false,
			complete: false
		};
		this.recordedHls.set(id, session);
		this.writeLog('recorded HLS session=' + id + ' recorded=' + recordedId + ' profile=compat creating');

		try {
			const args = buildRecordedHlsArgs(source, directory);
			session.child = this.spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
			this.writeLog('recorded HLS session=' + id + ' ffmpeg pid=' + session.child.pid);
			if (!session.child.stderr) session.child.stderr = new PassThrough();
			session.child.stderr.on('data', chunk => {
				const message = String(chunk).trim();
				if (message) this.writeLog('recorded HLS session=' + id + ' ffmpeg: ' + message);
			});
			session.child.once('error', error => {
				this.writeLog('recorded HLS session=' + id + ' ffmpeg error=' + error.message);
				this.stopRecordedHlsSession(recordedId, id, 'ffmpeg error');
			});
			session.child.once('exit', (code, signal) => {
				this.writeLog('recorded HLS session=' + id + ' ffmpeg exit code=' + code + ' signal=' + signal);
				if (session.stopping) return;
				if (code === 0) {
					session.complete = true;
					session.lastAccess = this.now();
					this.writeLog('recorded HLS session=' + id + ' complete');
				} else {
					this.stopRecordedHlsSession(recordedId, id, 'ffmpeg exit');
				}
			});
			await this.waitForRecordedPlaylist(session);
			session.ready = true;
			session.lastAccess = this.now();
			this.writeLog('recorded HLS session=' + id + ' ready');
			return { id, playlist: 'index.m3u8' };
		} catch (error) {
			this.stopRecordedHlsSession(recordedId, id, 'startup failed');
			throw error;
		}
	}

	waitForRecordedPlaylist(session) {
		return new Promise((resolve, reject) => {
			const started = this.now();
			const check = () => {
				if (session.stopping) return reject(new Error('recorded HLS session stopped before playlist was ready'));
				try {
					const playlist = fs.readFileSync(path.join(session.directory, 'index.m3u8'), 'utf8');
					const segment = playlist.match(/(?:^|\n)(segment\d{6}\.m4s)(?:\n|$)/);
					if (playlist.includes('#EXT-X-MAP:URI="init.mp4"') && segment &&
						fs.statSync(path.join(session.directory, 'init.mp4')).size > 0 &&
						fs.statSync(path.join(session.directory, segment[1])).size > 0) {
						return resolve();
					}
				} catch (_) {}
				if (this.now() - started >= 15000) return reject(new Error('recorded HLS playlist generation timed out'));
				setTimeout(check, 100);
			};
			check();
		});
	}

	getRecordedHlsAsset(recordedId, sessionId, filename) {
		if (!SESSION_PATTERN.test(String(sessionId || '')) || !HLS_ASSET_PATTERN.test(String(filename || ''))) return null;
		const session = this.recordedHls.get(sessionId);
		if (!session || session.recordedId !== String(recordedId) || session.stopping || !session.ready) return null;
		const target = path.resolve(session.directory, filename);
		if (!target.startsWith(path.resolve(session.directory) + path.sep)) return null;
		let stat;
		try { stat = fs.statSync(target); } catch (_) { return null; }
		if (!stat.isFile()) return null;
		session.lastAccess = this.now();
		this.writeLog('recorded HLS session=' + sessionId + ' asset=' + filename + ' size=' + stat.size);
		return { path: target, size: stat.size };
	}

	stopRecordedHlsSession(recordedId, sessionId, reason) {
		const session = this.recordedHls.get(sessionId);
		if (!session || session.recordedId !== String(recordedId) || session.stopping) return false;
		session.stopping = true;
		this.recordedHls.delete(sessionId);
		this.writeLog('recorded HLS session=' + sessionId + ' cleanup reason=' + reason);
		const child = session.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			try { child.kill('SIGTERM'); } catch (_) {}
			const timer = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) {
					try { child.kill('SIGKILL'); } catch (_) {}
				}
			}, this.killTimeoutMs);
			if (timer.unref) timer.unref();
		}
		try { removeDirectory(session.directory, this.recordedHlsRoot); } catch (error) {
			this.writeLog('recorded HLS cleanup failed: ' + error.message);
		}
		return true;
	}

	acquireRecorded(source) {
		const sourceStat = fs.statSync(source);
		const key = crypto.createHash('sha256').update(JSON.stringify({
			path: path.resolve(source), dev: sourceStat.dev, ino: sourceStat.ino,
			size: sourceStat.size, mtimeMs: sourceStat.mtimeMs, profile: 'compat-v1'
		})).digest('hex');
		const destination = path.join(this.recordedRoot, key + '.mp4');
		let job = this.recorded.get(key);
		if (!job && fs.existsSync(destination)) {
			try {
				const now = new Date(this.now());
				fs.utimesSync(destination, now, now);
			} catch (_) {}
			job = { key, destination, clients: 0, complete: true, child: null, promise: Promise.resolve(destination) };
			this.recorded.set(key, job);
		}
		if (!job) {
			const temporary = path.join(this.recordedRoot, key + '.' + crypto.randomBytes(8).toString('hex') + '.part.mp4');
			job = { key, destination, temporary, clients: 0, complete: false, child: null, promise: null };
			job.promise = new Promise((resolve, reject) => {
				const args = buildRecordedMp4Args(source, temporary);
				job.child = this.spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
				this.writeLog('recorded cache=' + key + ' profile=compat ffmpeg pid=' + job.child.pid);
				if (!job.child.stderr) job.child.stderr = new PassThrough();
				job.child.stderr.on('data', chunk => {
					const message = String(chunk).trim();
					if (message) this.writeLog('recorded cache=' + key + ' ffmpeg: ' + message);
				});
				job.child.once('error', error => reject(error));
				job.child.once('exit', (code, signal) => {
					this.writeLog('recorded cache=' + key + ' ffmpeg exit code=' + code + ' signal=' + signal);
					if (code !== 0) return reject(new Error('FFmpeg exited with code ' + code));
					try {
						fs.renameSync(temporary, destination);
						job.complete = true;
						resolve(destination);
					} catch (error) { reject(error); }
				});
			}).catch(error => {
				this.recorded.delete(key);
				try { fs.unlinkSync(temporary); } catch (_) {}
				throw error;
			});
			this.recorded.set(key, job);
		}
		job.clients++;
		let released = false;
		return {
			promise: job.promise,
			release: () => {
				if (released) return;
				released = true;
				job.clients = Math.max(0, job.clients - 1);
				if (!job.complete && job.clients === 0 && job.child && job.child.exitCode === null && job.child.signalCode === null) {
					this.writeLog('recorded cache=' + key + ' cleanup reason=client disconnect');
					try { job.child.kill('SIGTERM'); } catch (_) {}
					const timer = setTimeout(() => {
						if (job.child.exitCode === null && job.child.signalCode === null) {
							try { job.child.kill('SIGKILL'); } catch (_) {}
						}
					}, this.killTimeoutMs);
					if (timer.unref) timer.unref();
				}
			}
		};
	}

	sendFile(request, response, filename) {
		const stat = fs.statSync(filename);
		const range = request.headers && request.headers.range;
		const parsed = range ? parseSingleRange(range, stat.size) : null;
		response.setHeader('Accept-Ranges', 'bytes');
		if (parsed && parsed.invalid) {
			response.setHeader('Content-Range', 'bytes */' + stat.size);
			response.setHeader('Content-Length', 0);
			response.head(416);
			response.end();
			return { status: 416 };
		}
		const start = parsed ? parsed.start : 0;
		const end = parsed ? parsed.end : stat.size - 1;
		const status = parsed ? 206 : 200;
		if (parsed) response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + stat.size);
		response.setHeader('Content-Length', stat.size === 0 ? 0 : end - start + 1);
		response.head(status);
		this.writeLog('HTTP ' + status + ' file=' + path.basename(filename) + ' range=' + (range || '-'));
		if (request.method === 'HEAD' || stat.size === 0) {
			response.end();
			return { status };
		}
		const stream = fs.createReadStream(filename, { start, end });
		response.once('close', () => stream.destroy());
		stream.once('error', () => response.destroy());
		stream.pipe(response);
		return { status, stream };
	}

	close() {
		clearInterval(this.timer);
		for (const session of Array.from(this.live.values())) this.stopLiveSession(session.id, 'manager close');
		for (const session of Array.from(this.recordedHls.values())) {
			this.stopRecordedHlsSession(session.recordedId, session.id, 'manager close');
		}
		for (const job of this.recorded.values()) {
			if (!job.complete && job.child && job.child.exitCode === null && job.child.signalCode === null) {
				try { job.child.kill('SIGTERM'); } catch (_) {}
			}
		}
	}
}

function createMediaDelivery(options) {
	return new MediaDelivery(options);
}

module.exports = {
	createMediaDelivery,
	compatCodecArgs,
	buildLiveHlsArgs,
	buildRecordedMp4Args,
	buildRecordedHlsArgs,
	parseSingleRange,
	SESSION_PATTERN,
	HLS_ASSET_PATTERN
};
