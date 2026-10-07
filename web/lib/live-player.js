import { Mpeg2TsPlayer } from './mpeg2toh264/index.js';
import { Controller, MPEGTSFeeder, SVGDOMRenderer } from './mpeg2toh264/aribb24.js';

/** Open the shared live overlay for a schedule channel and resolve its programme from the latest schedule. */
export function openChannelLiveOverlay(channel, { onClose, getSchedule } = {}) {
	return openLiveOverlay(channel.id, {
		channelName: channel.name,
		onClose,
		getCurrentProgram: now => {
			const schedule = typeof getSchedule === 'function' ? getSchedule() : [];
			const currentChannel = (schedule || []).find(item => item.id === channel.id);
			return currentChannel && (currentChannel.programs || []).find(program => program.start <= now && now < program.end) || null;
		}
	});
}

/** Open a live stream above the schedule without navigating away from it. */
export function openLiveOverlay(channelId, { onClose, channelName, getCurrentProgram } = {}) {
	const overlay = document.createElement('div');
	overlay.className = 'program-live-overlay';
	overlay.tabIndex = -1;
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', 'ライブ視聴');
	const panel = document.createElement('div');
	panel.className = 'program-live-panel';
	const heading = document.createElement('div');
	heading.className = 'program-live-header';
	const headingContent = document.createElement('div');
	headingContent.className = 'program-live-header-content';
	const programMeta = document.createElement('div');
	programMeta.className = 'program-live-meta';
	headingContent.append(programMeta);
	heading.append(headingContent);
	const channelLine = document.createElement('div');
	channelLine.className = 'program-live-channel';
	const logo = document.createElement('img');
	logo.className = 'program-live-channel-logo';
	logo.alt = '';
	logo.onerror = () => { logo.hidden = true; };
	logo.src = new URL('./api/channel/' + encodeURIComponent(channelId) + '/logo.png', document.baseURI).href;
	const channelLabel = document.createElement('strong');
	channelLabel.className = 'program-live-channel-name';
	channelLabel.textContent = channelName || channelId;
	const liveLabel = document.createElement('span');
	liveLabel.className = 'program-live-label';
	liveLabel.textContent = 'LIVE';
	channelLine.append(logo, channelLabel, liveLabel);
	programMeta.append(channelLine);
	const programLabel = document.createElement('div');
	programLabel.className = 'program-live-program';
	programLabel.style.display = 'none';
	programMeta.append(programLabel);
	const description = document.createElement('div');
	description.className = 'program-live-description';
	description.style.display = 'none';
	programMeta.append(description);
	let activeProgram = null;
	let progress = null;
	let progressFill = null;
	let progressTimer = null;
	const timeColumn = document.createElement('div');
	timeColumn.className = 'program-live-time';
	timeColumn.style.display = 'none';
	const startLabel = document.createElement('span');
	startLabel.className = 'program-live-time-start';
	const endLabel = document.createElement('span');
	endLabel.className = 'program-live-time-end';
	const formatTime = value => {
		const date = new Date(value);
		return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
	};
	progress = document.createElement('div');
	progress.className = 'program-live-progress';
	progress.setAttribute('role', 'progressbar');
	progress.setAttribute('aria-label', '番組の進行状況');
	progress.setAttribute('aria-valuemin', '0');
	progress.setAttribute('aria-valuemax', '100');
	progressFill = document.createElement('span');
	progressFill.className = 'program-live-progress-fill';
	progress.append(progressFill);
	timeColumn.append(startLabel, progress, endLabel);
	const stage = document.createElement('div');
	stage.className = 'program-live-stage';
	const picture = document.createElement('div');
	picture.className = 'program-live-picture';
	const video = document.createElement('video');
	video.controls = true;
	video.playsInline = true;
	video.preload = 'none';
	video.setAttribute('controlslist', 'nofullscreen');
	picture.append(video);
	stage.append(picture);
	const controls = document.createElement('div');
	controls.className = 'program-live-controls';
	const captionsButton = document.createElement('button');
	captionsButton.type = 'button';
	captionsButton.textContent = '字幕を隠す';
	captionsButton.setAttribute('aria-pressed', 'true');
	const fullscreenButton = document.createElement('button');
	fullscreenButton.type = 'button';
	fullscreenButton.textContent = '全画面';
	const closeButton = document.createElement('button');
	closeButton.type = 'button';
	closeButton.textContent = '閉じる';
	const overlayCloseButton = document.createElement('button');
	overlayCloseButton.className = 'chinachu-live-player-close';
	overlayCloseButton.type = 'button';
	overlayCloseButton.textContent = '×';
	overlayCloseButton.setAttribute('aria-label', 'ライブ視聴を閉じる');
	overlayCloseButton.setAttribute('title', '閉じる');
	heading.append(overlayCloseButton);
	const status = document.createElement('span');
	status.className = 'program-live-status';
	status.setAttribute('role', 'status');
	const buttonGroup = document.createElement('div');
	buttonGroup.className = 'program-live-button-group';
	buttonGroup.append(captionsButton, fullscreenButton, closeButton);
	controls.append(buttonGroup);
	controls.append(timeColumn);
	controls.append(status);
	panel.append(heading, stage, controls);
	overlay.append(panel);
	document.body.append(overlay);

	const player = new Mpeg2TsPlayer(video, {
		mediaSource: 'auto', oversample: 2, recoveryInterval: 24,
		splitFieldSamples: true
	});
	let destroyed = false;
	let playerDestroyed = false;
	let captionsEnabled = true;
	const entries = [];
	const feed = event => {
		const { data, pts } = event.detail;
		if (pts !== null) entries.forEach(entry => entry.feeder.feedB24(data, pts));
	};
	const failed = event => {
		if (!destroyed) status.textContent = 'ライブ映像を読み込めませんでした: ' + event.detail.error.message;
	};
	const setCaptionEnabled = enabled => {
		captionsEnabled = enabled;
		for (const { type, controller, overlay: captionOverlay } of entries) {
			if (type !== 'Caption') continue;
			if (enabled) {
				captionOverlay.style.removeProperty('display');
				controller.show();
			} else {
				controller.hide();
				captionOverlay.style.display = 'none';
			}
		}
		captionsButton.textContent = enabled ? '字幕を隠す' : '字幕を表示';
		captionsButton.setAttribute('aria-pressed', String(enabled));
	};
	function close() {
		if (destroyed) return;
		destroyed = true;
		if (progressTimer !== null) {
			window.clearInterval(progressTimer);
			progressTimer = null;
		}
		player.removeEventListener('private_stream_1', feed);
		player.removeEventListener('private_stream_2', feed);
		player.removeEventListener('error', failed);
		document.removeEventListener('fullscreenchange', fullscreenChanged);
		document.removeEventListener('keydown', keydown);
		overlay.removeEventListener('keydown', keydown);
		window.removeEventListener('pagehide', close);
		captionsButton.removeEventListener('click', toggleCaptions);
		fullscreenButton.removeEventListener('click', toggleFullscreen);
		closeButton.removeEventListener('click', close);
		overlayCloseButton.removeEventListener('click', close);
		for (const { controller, feeder, renderer } of entries) {
			controller.hide();
			controller.detachMedia();
			controller.detachFeeder();
			controller.detachRenderer(renderer);
			feeder.destroy();
			renderer.destroy();
		}
		if (!playerDestroyed) {
			playerDestroyed = true;
			player.destroy();
		}
		if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
		stage.classList.remove('program-live-expanded');
		overlay.remove();
		if (onClose) onClose();
	}
	function toggleCaptions() {
		setCaptionEnabled(!captionsEnabled);
	}
	async function toggleFullscreen() {
		if (document.fullscreenElement === stage) {
			await document.exitFullscreen().catch(() => {});
		} else if (stage.classList.contains('program-live-expanded')) {
			stage.classList.remove('program-live-expanded');
		} else if (typeof stage.requestFullscreen === 'function') {
			try {
				await stage.requestFullscreen();
			} catch (_) {
				if (!destroyed) stage.classList.add('program-live-expanded');
			}
		} else {
			stage.classList.add('program-live-expanded');
		}
		fullscreenChanged();
	}
	overlay.addEventListener('keydown', keydown);
	window.addEventListener('pagehide', close);
	document.addEventListener('keydown', keydown);
	document.addEventListener('fullscreenchange', fullscreenChanged);
	captionsButton.addEventListener('click', toggleCaptions);
	fullscreenButton.addEventListener('click', toggleFullscreen);
	closeButton.addEventListener('click', close);
	overlayCloseButton.addEventListener('click', close);
	const hasValidTiming = program => Number.isFinite(program && program.start) &&
		Number.isFinite(program && program.end) && program.end > program.start &&
		Number.isFinite(new Date(program.start).getTime()) && Number.isFinite(new Date(program.end).getTime());
	const sameProgram = (left, right) => {
		if (!left || !right) return left === right;
		if (left.id != null && right.id != null) return left.id === right.id;
		if (left.key != null && right.key != null) return left.key === right.key;
		return left.start === right.start && left.end === right.end;
	};
	const updateProgress = now => {
		if (!hasValidTiming(activeProgram)) return;
		const percent = Math.max(0, Math.min(100, ((now - activeProgram.start) / (activeProgram.end - activeProgram.start)) * 100));
		progressFill.style.width = percent + '%';
		progress.setAttribute('aria-valuenow', String(Math.round(percent)));
	};
	const refreshProgram = now => {
		let currentProgram = null;
		try {
			if (typeof getCurrentProgram === 'function') currentProgram = getCurrentProgram(now) || null;
		} catch (_) {
			// Schedule data may be briefly unavailable while it is being refreshed.
		}
		if (!sameProgram(activeProgram, currentProgram)) {
			activeProgram = currentProgram;
			const title = currentProgram && (currentProgram.fullTitle || currentProgram.title);
			programLabel.textContent = title || '';
			programLabel.style.display = title ? '' : 'none';
			const detail = currentProgram && typeof currentProgram.detail === 'string' ? currentProgram.detail : '';
			description.textContent = detail;
			description.style.display = detail ? '' : 'none';
			if (hasValidTiming(currentProgram)) {
				startLabel.textContent = formatTime(currentProgram.start);
				endLabel.textContent = formatTime(currentProgram.end);
				timeColumn.style.display = '';
			} else {
				timeColumn.style.display = 'none';
			}
		} else {
			// Keep progress calculations tied to the latest schedule object without
			// rewriting programme text while the programme identity is unchanged.
			activeProgram = currentProgram;
		}
		updateProgress(now);
	};
	refreshProgram(Date.now());
	progressTimer = window.setInterval(() => refreshProgram(Date.now()), 20000);
	try {
		overlay.focus({ preventScroll: true });
	} catch (_) {
		overlay.focus();
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
		close();
		throw error;
	}
	player.addEventListener('private_stream_1', feed);
	player.addEventListener('private_stream_2', feed);
	player.addEventListener('error', failed);
	status.textContent = 'ライブ映像を接続しています…';
	const url = new URL('./api/channel/' + encodeURIComponent(channelId) + '/watch.m2ts', document.baseURI).href;
	let loading;
	try {
		loading = player.load(url);
	} catch (error) {
		close();
		throw error;
	}
	Promise.resolve(loading).then(() => {
		if (destroyed) return;
		status.textContent = '';
		return video.play().catch(() => {
			if (!destroyed) status.textContent = '再生ボタンを押してください';
		});
	}).catch(error => {
		if (!destroyed) status.textContent = 'ライブ映像を読み込めませんでした: ' + error.message;
	});

	return { close, player, overlay, stage, video, setCaptionEnabled };
}
