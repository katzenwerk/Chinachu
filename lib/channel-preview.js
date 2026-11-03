'use strict';

const http = require('http');
const { spawn } = require('child_process');

// One capture for the entire WUI; busy requests are discarded, never queued.
function createChannelPreview(client) {
	let active = false;
	return function capture(serviceId, response, remainingMs) {
		if (active) {
			console.warn('[channel-preview] ' + JSON.stringify({ serviceId, reason: 'busy', status: 503 }));
			return response.error(503);
		}
		active = true;
		const startedAt = Date.now();
		let request = null;
		let stream = null;
		let ffmpeg = null;
		let finished = false;
		let inputStopped = false;
		let size = 0;
		let stderr = '';
		const chunks = [];
		const timeout = setTimeout(() => finish(504, null,
			remainingMs <= 15000 ? 'broadcast-ended' : 'timeout'), Math.max(1, Math.min(15000, remainingMs)));

		function finish(status, image, reason, error) {
			if (finished) return;
			finished = true;
			if (status !== 200) {
				console.warn('[channel-preview] ' + JSON.stringify({
					serviceId, reason, status: status || null, elapsedMs: Date.now() - startedAt,
					bytes: size, error: error ? String(error.message || error) : undefined,
					stderr: stderr || undefined
				}));
			}
			clearTimeout(timeout);
			response.removeListener('close', onClose);
			if (stream) {
				stream.unpipe();
				stream.destroy();
			}
			if (request) request.destroy();
			if (ffmpeg) {
				ffmpeg.stdin.destroy();
				if (ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
				// Keep the slot until the process has actually closed.
			} else active = false;
			if (!status || response.destroyed) return;
			if (status !== 200) return response.error(status);
			response.setHeader('Cache-Control', 'no-store');
			response.head(200);
			response.end(image);
		}

		function onClose() { finish(null, null, 'client-aborted'); }
		response.once('close', onClose);
		try {
			// Use the configured Mirakurun transport, with a request-local priority.
			// Direct HTTP also makes a pending connection cancellable immediately.
			const options = {
				method: 'GET',
				path: client.basePath + '/services/' + serviceId + '/stream?decode=1',
				headers: { 'X-Mirakurun-Priority': '0', 'User-Agent': client.userAgent }
			};
			if (client.host === '') options.socketPath = client.socketPath;
			else { options.host = client.host; options.port = client.port; }
			request = http.request(options, incoming => {
				stream = incoming;
				stream.on('error', error => { if (!inputStopped) finish(503, null, 'stream-error', error); });
				stream.on('aborted', () => { if (!inputStopped) finish(503, null, 'stream-aborted'); });
				if (finished) { stream.destroy(); return; }
				if (stream.statusCode !== 200) return finish(503, null, 'mirakurun-http', 'HTTP ' + stream.statusCode);
				try {
					ffmpeg = spawn('ffmpeg', [
						'-v', 'error', '-threads', '1', '-f', 'mpegts', '-i', 'pipe:0',
						'-map', '0:v:0', '-frames:v', '1', '-an', '-threads', '1',
						'-vf', 'scale=480:270', '-filter_threads', '1',
						'-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'
					], { stdio: ['pipe', 'pipe', 'pipe'] });
				} catch (error) { finish(503, null, 'ffmpeg-spawn', error); return; }
				ffmpeg.on('error', error => finish(503, null, 'ffmpeg-error', error));
				ffmpeg.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(503, null, 'ffmpeg-stdin', error); });
				ffmpeg.stdout.on('error', error => finish(503, null, 'ffmpeg-stdout', error));
				ffmpeg.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2048); });
				ffmpeg.stderr.on('error', error => finish(503, null, 'ffmpeg-stderr', error));
				ffmpeg.stdout.on('data', chunk => {
					size += chunk.length;
					if (size > 1024 * 1024) return finish(503, null, 'image-too-large');
					chunks.push(chunk);
				});
				// FFmpeg closes stdout after its single image; release the tuner now.
				ffmpeg.stdout.once('end', () => {
					inputStopped = true;
					stream.unpipe();
					stream.destroy();
					request.destroy();
				});
				ffmpeg.once('close', (code, signal) => {
					active = false;
					if (!finished) {
						if (code === 0 && size > 0) finish(200, Buffer.concat(chunks));
						else finish(503, null, size === 0 && code === 0 ? 'empty-image' : 'ffmpeg-exit',
							'exit=' + code + ' signal=' + signal);
					}
				});
				stream.pipe(ffmpeg.stdin);
			});
			request.on('error', error => { if (!inputStopped) finish(503, null, 'request-error', error); });
			request.end();
		} catch (error) { finish(503, null, 'request-setup', error); }
	};
}

module.exports = { createChannelPreview };
