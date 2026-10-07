// WUI adapter. Conversion, Range seeking and ManagedMediaSource are upstream's.
import { Mpeg2TsPlayer } from './mpeg2toh264/index.js';
import { Controller, MPEGTSFeeder, SVGDOMRenderer } from './mpeg2toh264/aribb24.js';

const SEEK_SECONDS = 15;

function isDesktopNonSafariEnvironment(nav) {
	if (!nav) return false;
	const userAgent = String(nav.userAgent || '');
	const vendor = String(nav.vendor || '');
	const userAgentData = nav.userAgentData || null;
	const platform = String(userAgentData && userAgentData.platform || nav.platform || '');
	const mobileOrTv = userAgentData && userAgentData.mobile === true ||
		/(?:Android|Mobile|Silk|Kindle|KF[A-Z0-9]+|AFT[A-Z0-9]*|Smart-?TV|SMART-TV|HbbTV|Tizen|Web0S|WebOS|NetCast)/i.test(userAgent);
	if (mobileOrTv) return false;

	const safari = /Safari\//.test(userAgent) && /Apple Computer/i.test(vendor) &&
		!/(?:Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS|Firefox)/i.test(userAgent);
	if (safari) return false;

	return /(?:Windows|Win32|Win64|MacIntel|macOS|Linux|Chrome OS)/i.test(platform) ||
		/(?:Windows NT|Macintosh|X11|CrOS)/i.test(userAgent);
}

export function createRecordedPlayer(frame, { onEnded, onError, compatUrl, compatHlsUrl }) {
	const stage = document.createElement('div');
	stage.className = 'program-ts-stage';
	const picture = document.createElement('div');
	picture.className = 'program-ts-picture';
	picture.tabIndex = -1;
	const video = document.createElement('video');
	video.controls = true;
	video.playsInline = true;
	// This element is created only after the user's click. 'none' would leave
	// MSE waiting for sourceopen while load() waits before calling play().
	video.preload = 'auto';
	// Fullscreen belongs to the stage so that the ARIB overlay stays visible.
	video.setAttribute('controlslist', 'nofullscreen');
	const useNativePlayControls = typeof window.matchMedia === 'function' &&
		window.matchMedia('(hover: none) and (pointer: coarse)').matches;
	const playOverlay = document.createElement('button');
	playOverlay.className = 'program-ts-play-overlay';
	playOverlay.type = 'button';
	playOverlay.textContent = '▶';
	playOverlay.setAttribute('aria-label', '動画を再生');
	playOverlay.hidden = useNativePlayControls || !video.paused;
	const seekFeedback = document.createElement('div');
	seekFeedback.className = 'program-ts-seek-feedback';
	seekFeedback.setAttribute('role', 'status');
	seekFeedback.setAttribute('aria-live', 'polite');
	seekFeedback.hidden = true;
	picture.append(video, playOverlay, seekFeedback);
	stage.append(picture);
	const controls = document.createElement('div');
	controls.className = 'program-ts-controls';
	const captionsButton = document.createElement('button');
	captionsButton.type = 'button';
	captionsButton.textContent = '字幕を隠す';
	captionsButton.setAttribute('aria-pressed', 'true');
	const fullscreenButton = document.createElement('button');
	fullscreenButton.type = 'button';
	fullscreenButton.textContent = '全画面';
	const compatButton = document.createElement('button');
	compatButton.type = 'button';
	compatButton.textContent = 'FFmpeg互換再生';
	const desktopNonSafari = isDesktopNonSafariEnvironment(
		typeof navigator === 'undefined' ? null : navigator
	);
	compatButton.hidden = desktopNonSafari || (!compatUrl && !compatHlsUrl);
	const status = document.createElement('span');
	status.setAttribute('role', 'status');
	controls.append(captionsButton, fullscreenButton, compatButton, status);
	stage.append(controls);
	frame.append(stage);

	const player = new Mpeg2TsPlayer(video, {
		mediaSource: 'auto', oversample: 2, recoveryInterval: 24,
		splitFieldSamples: true
	});
	let destroyed = false;
	let playerDestroyed = false;
	let captionsEnabled = true;
	let seekFeedbackTimer = null;
	let hlsCloseUrl = null;
	const entries = [];
	// Same feeder/controller/renderer wiring as packages/demo/src/demo.ts.
	const feed = event => {
		const { data, pts } = event.detail;
		if (pts !== null) entries.forEach(entry => entry.feeder.feedB24(data, pts));
	};
	const fullscreenChanged = () => {
		fullscreenButton.textContent = document.fullscreenElement === stage ||
			stage.classList.contains('program-ts-expanded') ? '全画面を終了' : '全画面';
	};
	const escape = event => {
		if (event.key === 'Escape') {
			stage.classList.remove('program-ts-expanded');
			fullscreenChanged();
		}
	};
	function closeHlsSession() {
		if (!hlsCloseUrl) return;
		const target = hlsCloseUrl;
		hlsCloseUrl = null;
		if (typeof window.fetch === 'function') {
			window.fetch(target, { method: 'DELETE', keepalive: true }).catch(() => {});
		}
	}
	const ended = () => {
		closeHlsSession();
		onEnded();
	};
	const failed = event => onError(event.detail.error);
	const mediaFailed = () => {
		const mediaError = video.error;
		const details = [
			mediaError ? 'code=' + mediaError.code : 'code=unknown',
			mediaError && mediaError.message ? 'message=' + mediaError.message : null,
			'networkState=' + video.networkState,
			'readyState=' + video.readyState
		].filter(Boolean).join(' ');
		closeHlsSession();
		onError(new Error('ブラウザが映像を再生できませんでした (' + details + ')'));
	};
	const disposeMpegPlayer = () => {
		if (playerDestroyed) return;
		playerDestroyed = true;
		player.removeEventListener('private_stream_1', feed);
		player.removeEventListener('private_stream_2', feed);
		player.removeEventListener('error', failed);
		for (const { controller, feeder, renderer } of entries.splice(0)) {
			controller.hide();
			controller.detachMedia();
			controller.detachFeeder();
			controller.detachRenderer(renderer);
			feeder.destroy();
			renderer.destroy();
		}
		player.destroy();
	};
	const startCompatPlayback = async () => {
		if (destroyed || playerDestroyed || desktopNonSafari || (!compatUrl && !compatHlsUrl)) return;
		disposeMpegPlayer();
		compatButton.disabled = true;
		compatButton.textContent = 'FFmpeg互換再生中';
		const supportsNativeHls = typeof video.canPlayType === 'function' &&
			video.canPlayType('application/vnd.apple.mpegurl') !== '';
		status.textContent = supportsNativeHls && compatHlsUrl ?
			'FFmpeg互換HLSを準備中…（ARIB字幕・文字スーパーなし）' :
			'FFmpeg互換映像を読み込み中…（ARIB字幕・文字スーパーなし）';
		if (supportsNativeHls && compatHlsUrl && typeof window.fetch === 'function') {
			try {
				const createUrl = new URL(compatHlsUrl, document.baseURI);
				const result = await window.fetch(createUrl.href, { credentials: 'same-origin' });
				if (!result.ok) throw new Error('HTTP ' + result.status);
				const session = await result.json();
				const playlistUrl = new URL(session.playlist, createUrl);
				const closeUrl = new URL(session.close, createUrl);
				if (destroyed) {
					window.fetch(closeUrl.href, { method: 'DELETE', keepalive: true }).catch(() => {});
					return;
				}
				hlsCloseUrl = closeUrl.href;
				video.src = playlistUrl.href;
				status.textContent = 'FFmpeg互換HLS再生中（ARIB字幕・文字スーパーなし）';
			} catch (error) {
				if (!destroyed) onError(new Error('FFmpeg互換HLSを開始できませんでした: ' + error.message));
				return;
			}
		} else if (compatUrl) {
			video.src = compatUrl;
		} else {
			onError(new Error('このブラウザではFFmpeg互換再生を利用できません'));
			return;
		}
		video.load();
		Promise.resolve(video.play()).then(() => {
			if (!destroyed) status.textContent = 'FFmpeg互換再生中（ARIB字幕・文字スーパーなし）';
		}).catch(() => {
			if (!destroyed) status.textContent = '動画の再生ボタンを押してください';
		});
	};
	const focusPicture = () => {
		try {
			picture.focus({ preventScroll: true });
		} catch (_) {
			picture.focus();
		}
	};
	const updatePlayOverlay = () => { playOverlay.hidden = useNativePlayControls || !video.paused; };
	const playFromOverlay = () => {
		try {
			Promise.resolve(video.play()).then(() => {
				if (!destroyed) focusPicture();
			}, () => {
				if (!destroyed) updatePlayOverlay();
			});
		} catch (_) {
			updatePlayOverlay();
		}
	};
	const showSeekFeedback = direction => {
		seekFeedback.textContent = direction === 'backward' ? '←15秒' : '15秒→';
		seekFeedback.hidden = false;
		if (seekFeedbackTimer !== null) window.clearTimeout(seekFeedbackTimer);
		seekFeedbackTimer = window.setTimeout(() => {
			seekFeedback.hidden = true;
			seekFeedbackTimer = null;
		}, 900);
	};
	const seekByArrow = event => {
		if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
		if (event.repeat) {
			event.preventDefault();
			event.stopPropagation();
			return;
		}
		const currentTime = video.currentTime;
		if (!Number.isFinite(currentTime) || !video.seekable.length) return;
		const target = currentTime + (event.key === 'ArrowLeft' ? -SEEK_SECONDS : SEEK_SECONDS);
		let seekTime = NaN;
		let nearestDistance = Infinity;
		for (let index = 0; index < video.seekable.length; index++) {
			const start = video.seekable.start(index);
			const end = video.seekable.end(index);
			if (target >= start && target <= end) {
				seekTime = target;
				break;
			}
			for (const boundary of [start, end]) {
				const distance = Math.abs(target - boundary);
				if (distance < nearestDistance) {
					nearestDistance = distance;
					seekTime = boundary;
				}
			}
		}
		if (!Number.isFinite(seekTime)) return;
		try {
			video.currentTime = seekTime;
			event.preventDefault();
			event.stopPropagation();
			if (seekTime !== currentTime) showSeekFeedback(event.key === 'ArrowLeft' ? 'backward' : 'forward');
		} catch (_) {
			// Leave native key handling available if this seek cannot be applied.
		}
	};
	const resize = () => {
		if (video.videoWidth && video.videoHeight) {
			picture.style.setProperty('--program-ts-aspect', String(video.videoWidth / video.videoHeight));
		}
	};

	function destroy() {
		if (destroyed) return;
		destroyed = true;
		closeHlsSession();
		disposeMpegPlayer();
		video.removeEventListener('ended', ended);
		video.removeEventListener('error', mediaFailed);
		video.removeEventListener('resize', resize);
		picture.removeEventListener('keydown', seekByArrow, { capture: true });
		video.removeEventListener('pause', updatePlayOverlay);
		video.removeEventListener('play', updatePlayOverlay);
		video.removeEventListener('playing', updatePlayOverlay);
		playOverlay.removeEventListener('click', playFromOverlay);
		compatButton.removeEventListener('click', startCompatPlayback);
		if (seekFeedbackTimer !== null) window.clearTimeout(seekFeedbackTimer);
		document.removeEventListener('fullscreenchange', fullscreenChanged);
		document.removeEventListener('keydown', escape);
		window.removeEventListener('pagehide', destroy);
		if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
		stage.remove();
	}

	try {
		for (const type of ['Caption', 'Superimpose']) {
			const feeder = new MPEGTSFeeder({ recieve: { type }, tokenizer: {}, offset: {} });
			const renderer = new SVGDOMRenderer();
			const controller = new Controller();
			const entry = { type, feeder, renderer, controller };
			entries.push(entry);
			controller.attachFeeder(feeder);
			controller.attachRenderer(renderer);
			controller.attachMedia(video, picture);
			entry.overlay = picture.lastElementChild;
			entry.overlay.setAttribute('preserveAspectRatio', 'none');
		}
	} catch (error) {
		destroy();
		throw error;
	}
	player.addEventListener('private_stream_1', feed);
	player.addEventListener('private_stream_2', feed);
	player.addEventListener('error', failed);
	video.addEventListener('ended', ended);
	video.addEventListener('error', mediaFailed);
	video.addEventListener('resize', resize);
	picture.addEventListener('keydown', seekByArrow, { capture: true });
	video.addEventListener('pause', updatePlayOverlay);
	video.addEventListener('play', updatePlayOverlay);
	video.addEventListener('playing', updatePlayOverlay);
	playOverlay.addEventListener('click', playFromOverlay);
	compatButton.addEventListener('click', startCompatPlayback);
	document.addEventListener('fullscreenchange', fullscreenChanged);
	document.addEventListener('keydown', escape);
	window.addEventListener('pagehide', destroy);
	captionsButton.addEventListener('click', () => {
		captionsEnabled = !captionsEnabled;
		for (const { type, controller, overlay } of entries) {
			if (type !== 'Caption') continue;
			if (captionsEnabled) {
				overlay.style.removeProperty('display');
				controller.show();
			} else {
				controller.hide();
				overlay.style.display = 'none';
			}
		}
		captionsButton.textContent = captionsEnabled ? '字幕を隠す' : '字幕を表示';
		captionsButton.setAttribute('aria-pressed', String(captionsEnabled));
	});
	fullscreenButton.addEventListener('click', async () => {
		if (document.fullscreenElement === stage) {
			await document.exitFullscreen().catch(() => {});
		} else if (stage.classList.contains('program-ts-expanded')) {
			stage.classList.remove('program-ts-expanded');
		} else {
			try {
				await stage.requestFullscreen();
			} catch (_) {
				// iPhone versions without element fullscreen: retain captions in-page.
				if (!destroyed) stage.classList.add('program-ts-expanded');
			}
		}
		fullscreenChanged();
	});

	return {
		destroy,
		async load(url) {
			status.textContent = '読み込み中…';
			try {
				await player.load(url);
			} catch (error) {
				if (playerDestroyed || destroyed) return;
				throw error;
			}
			if (destroyed || playerDestroyed) return;
			status.textContent = '';
			try {
				await video.play();
				if (!destroyed) focusPicture();
			}
			catch (_) {
				if (!destroyed) status.textContent = '動画の再生ボタンを押してください';
			}
		}
	};
}
