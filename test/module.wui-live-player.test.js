'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { it } = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

class Element extends EventTarget {
	constructor(tagName = 'div') {
		super();
		this.tagName = tagName;
		this.children = [];
		this.attributes = {};
		this.className = '';
		this.classList = {
			contains: name => this.className.split(/\s+/).includes(name),
			add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
			remove: name => { this.className = this.className.split(/\s+/).filter(item => item !== name).join(' '); }
		};
		this.style = { removeProperty() { delete this.display; } };
		this.listeners = {};
		if (tagName === 'video') {
			this.paused = true;
			this.play = () => { this.paused = false; return Promise.resolve(); };
		}
	}
	addEventListener(type, listener, options) {
		(this.listeners[type] ||= []).push({ listener, options });
		super.addEventListener(type, listener, options);
	}
	removeEventListener(type, listener, options) {
		this.listeners[type] = (this.listeners[type] || []).filter(item => item.listener !== listener);
		super.removeEventListener(type, listener, options);
	}
	append(...children) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
	setAttribute(key, value) { this.attributes[key] = value; }
	focus(options) { this.focusOptions = options; }
	get lastElementChild() { return this.children.at(-1); }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

function loadLivePlayer(options = {}) {
	const calls = { loads: [], destroys: 0, feedDestroy: 0, controllerDetach: 0, rendererDestroy: 0, order: [], now: 1800000, intervals: new Map(), intervalId: 0, intervalClears: [], fetches: [] };
	class Player extends EventTarget {
		constructor(video, options) { super(); this.video = video; this.options = options; calls.player = this; }
		load(url) { calls.loads.push(url); return Promise.resolve(); }
		destroy() { calls.destroys++; calls.order.push('destroy'); }
	}
	class Feeder { feedB24() {} destroy() { calls.feedDestroy++; } }
	class Renderer { destroy() { calls.rendererDestroy++; } }
	class Controller {
		attachFeeder() {}
		attachRenderer() {}
		attachMedia(_video, picture) { const svg = new Element('svg'); picture.append(svg); }
		hide() {}
		show() {}
		detachMedia() { calls.controllerDetach++; }
		detachFeeder() { calls.controllerDetach++; }
		detachRenderer() { calls.controllerDetach++; }
	}
	const document = new Element('document');
	document.baseURI = 'https://chinachu.invalid/app/';
	document.body = new Element('body');
	document.fullscreenElement = null;
	document.createElement = tag => {
		const element = new Element(tag);
		if (tag === 'video' && options.nativeHls) element.canPlayType = type => type === 'application/vnd.apple.mpegurl' ? 'maybe' : '';
		return element;
	};
	document.exitFullscreen = () => { document.fullscreenElement = null; return Promise.resolve(); };
	const window = new EventTarget();
	window.setInterval = (callback, delay) => {
		const id = ++calls.intervalId;
		calls.intervals.set(id, { callback, delay });
		return id;
	};
	window.clearInterval = id => { calls.intervals.delete(id); calls.intervalClears.push(id); };
	window.fetch = options.fetch || ((url, init = {}) => {
		calls.fetches.push({ url: String(url), init });
		return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
	});
	window.location = {};
	Object.defineProperty(window.location, 'hash', {
		set(value) { calls.order.push('navigate'); calls.hash = value; },
		get() { return calls.hash; }
	});
	let source = fs.readFileSync(path.join(root, 'web/lib/live-player.js'), 'utf8')
		.replace(/^import .*;\n/gm, '')
		.replace('export function openChannelLiveOverlay', 'function openChannelLiveOverlay')
		.replace('export function openLiveOverlay', 'function openLiveOverlay');
	class FixtureDate extends Date { static now() { return calls.now; } }
	const context = { document, window, navigator: options.navigator, URL, Date: FixtureDate, Mpeg2TsPlayer: Player, MPEGTSFeeder: Feeder, SVGDOMRenderer: Renderer, Controller };
	vm.runInNewContext(source + '\nthis.openLiveOverlay = openLiveOverlay; this.openChannelLiveOverlay = openChannelLiveOverlay;', context);
	return { open: context.openLiveOverlay, openChannel: context.openChannelLiveOverlay, calls, document, window };
}

function findByText(node, text) {
	if (node.textContent === text) return node;
	for (const child of node.children || []) {
		const found = findByText(child, text);
		if (found) return found;
	}
	return null;
}

function findByClass(node, className) {
	if (node.className === className) return node;
	for (const child of node.children || []) {
		const found = findByClass(child, className);
		if (found) return found;
	}
	return null;
}

it('opens a native-controls overlay on the same page and loads the selected channel endpoint', async () => {
	const env = loadLivePlayer();
	const program = { fullTitle: '番組タイトル #13', title: '短いタイトル', start: 0, end: 3600000, detail: '番組詳細文が表示される' };
	let schedule = [{ id: 'gr011', programs: [program] }];
	const live = env.openChannel({ id: 'gr011', name: 'AT-X' }, { getSchedule: () => schedule });
	await Promise.resolve();
	assert.equal(env.document.body.children[0], live.overlay);
	assert.equal(live.video.controls, true);
	assert.equal(live.video.playsInline, true);
	assert.equal(findByClass(live.overlay, 'program-ts-play-overlay'), null, 'live overlay relies on native video controls');
	assert.equal(live.overlay.focusOptions.preventScroll, true);
	assert.equal(findByClass(live.overlay, 'program-live-channel-name').textContent, 'AT-X');
	assert.equal(findByClass(live.overlay, 'program-live-label').textContent, 'LIVE');
	assert.equal(findByClass(live.overlay, 'program-live-program').textContent, '番組タイトル #13');
	const header = findByClass(live.overlay, 'program-live-header');
	const headerClose = findByClass(header, 'chinachu-live-player-close');
	assert.equal(headerClose.parent, header, 'the overlay close button is a header flex item');
	assert.equal(findByClass(live.stage, 'chinachu-live-player-close'), null, 'the close button is outside the video stage');
	const meta = findByClass(live.overlay, 'program-live-meta');
	assert.equal(findByClass(meta, 'program-live-time'), null, 'time and progress are no longer in the upper header');
	assert.equal(findByClass(meta, 'program-live-progress'), null, 'progress is no longer in the upper header');
	const controls = findByClass(live.overlay, 'program-live-controls');
	assert.deepEqual(findByClass(controls, 'program-live-button-group').children.map(button => button.textContent), [
		'字幕を隠す', '全画面', '閉じる'
	]);
	const time = findByClass(controls, 'program-live-time');
	assert.equal(time.parent, controls, 'the time and progress unit is inside the bottom controls');
	const formatTime = value => {
		const date = new Date(value);
		return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
	};
	assert.equal(findByClass(time, 'program-live-time-start').textContent, formatTime(program.start));
	assert.equal(findByClass(time, 'program-live-time-end').textContent, formatTime(program.end));
	assert.equal(findByClass(live.overlay, 'program-live-description').textContent, program.detail);
	const progress = findByClass(live.overlay, 'program-live-progress');
	const progressFill = findByClass(progress, 'program-live-progress-fill');
	assert.equal(progress.attributes['aria-valuenow'], '50');
	assert.equal(progressFill.style.width, '50%');
	const [progressTimer, timer] = [...env.calls.intervals.entries()][0];
	assert.equal(timer.delay, 20000);
	env.calls.now = 2700000;
	program.fullTitle = '同じ番組の変更は再描画しない';
	timer.callback();
	assert.equal(progress.attributes['aria-valuenow'], '75', 'the same programme refresh updates progress only');
	assert.equal(findByClass(live.overlay, 'program-live-program').textContent, '番組タイトル #13', 'the same programme updates only its progress');
	schedule = [{ id: 'gr011', programs: [{ id: 'next', fullTitle: '次の番組 #14', title: '次の番組', start: 2700000, end: 6300000, detail: '次の番組の詳細' }] }];
	timer.callback();
	assert.equal(findByClass(live.overlay, 'program-live-program').textContent, '次の番組 #14');
	assert.equal(findByClass(live.overlay, 'program-live-description').textContent, '次の番組の詳細');
	assert.equal(findByClass(time, 'program-live-time-start').textContent, formatTime(2700000));
	assert.equal(findByClass(time, 'program-live-time-end').textContent, formatTime(6300000));
	assert.equal(progress.attributes['aria-valuenow'], '0', 'progress uses the new programme start at the boundary');
	assert.equal(env.calls.intervals.size, 1, 'refreshing programmes reuses a single timer');
	env.calls.now = 4500000;
	timer.callback();
	assert.equal(progress.attributes['aria-valuenow'], '50', 'progress advances relative to the new programme duration');
	schedule = [];
	assert.doesNotThrow(() => timer.callback(), 'a temporary missing current programme is safe');
	assert.equal(findByClass(live.overlay, 'program-live-program').style.display, 'none');
	const logo = findByClass(live.overlay, 'program-live-channel-logo');
	assert.equal(logo.src, 'https://chinachu.invalid/app/api/channel/gr011/logo.png');
	logo.onerror();
	assert.equal(logo.hidden, true, 'a missing logo is hidden without removing text labels');
	assert.equal(findByClass(live.overlay, 'program-live-channel-name').textContent, 'AT-X');
	assert.equal(env.calls.loads.length, 1);
	assert.equal(env.calls.loads[0], 'https://chinachu.invalid/app/api/channel/gr011/watch.m2ts');
	assert.equal(live.overlay.listeners.keydown.length, 1);
	assert.equal(live.video.listeners.keydown, undefined, 'live player does not install recorded 15-second seek keys');
	const arrow = new Event('keydown', { cancelable: true });
	Object.defineProperty(arrow, 'key', { value: 'ArrowRight' });
	env.document.dispatchEvent(arrow);
	assert.equal(arrow.defaultPrevented, true, 'schedule keyboard navigation is suppressed while the overlay is active');
	live.close();
	assert.equal(env.calls.intervals.size, 0);
	assert.deepEqual(env.calls.intervalClears, [progressTimer]);
	assert.equal(env.calls.destroys, 1);
	assert.equal(env.calls.feedDestroy, 2);
	assert.equal(env.calls.controllerDetach, 6);
	assert.equal(env.calls.rendererDestroy, 2);
	assert.equal(env.document.body.children.length, 0);
	assert.equal(env.document.listeners.keydown.length, 0, 'overlay keyboard listener is removed on close');
});

it('keeps channel identity and omits programme fields when no current programme is supplied', () => {
	const env = loadLivePlayer();
	const live = env.open('gr011', { channelName: 'AT-X', getCurrentProgram: () => null });
	assert.equal(findByClass(live.overlay, 'program-live-channel-name').textContent, 'AT-X');
	assert.equal(findByClass(live.overlay, 'program-live-program').style.display, 'none');
	assert.equal(findByClass(live.overlay, 'program-live-time').style.display, 'none');
	assert.equal(findByClass(live.overlay, 'program-live-progress'), findByClass(live.overlay, 'program-live-time').children[1]);
	assert.equal(findByClass(live.overlay, 'program-live-description').style.display, 'none');
	assert.equal(env.calls.intervals.size, 1, 'one refresh timer remains available to observe a later schedule update');
	live.close();
});

it('falls back to title and omits progress for invalid programme timing', () => {
	const env = loadLivePlayer();
	const live = env.open('gr011', { channelName: 'AT-X', getCurrentProgram: () => ({ fullTitle: '', title: '簡易タイトル', start: NaN, end: 10, detail: '' }) });
	assert.equal(findByClass(live.overlay, 'program-live-program').textContent, '簡易タイトル');
	assert.equal(findByClass(live.overlay, 'program-live-time').style.display, 'none');
	assert.equal(env.calls.intervals.size, 1);
	live.close();
});

it('Escape closes, removes handlers, and allows a fresh live overlay to open', () => {
	const env = loadLivePlayer();
	const first = env.open('gr011');
	const escape = new Event('keydown', { cancelable: true });
	Object.defineProperty(escape, 'key', { value: 'Escape' });
	first.overlay.dispatchEvent(escape);
	assert.equal(escape.defaultPrevented, true);
	assert.equal(env.calls.destroys, 1);
	assert.equal(env.document.body.children.length, 0);
	const second = env.open('bs01');
	assert.equal(env.document.body.children[0], second.overlay);
	findByText(second.overlay, '閉じる').dispatchEvent(new Event('click'));
	assert.equal(env.calls.destroys, 2);
	assert.equal(env.document.body.children.length, 0);
});

it('TOP live action uses the shared channel overlay and the legacy watch route remains available', () => {
	const top = fs.readFileSync(path.join(root, 'web/page/dashboard/top.js'), 'utf8');
	assert.match(top, /liveButton\.observe\("click", function \(\) \{[\s\S]*?module\.openChannelLiveOverlay\(channel,/);
	assert.doesNotMatch(top, /channel\/watch\/id=/, 'TOP no longer sends its live button to the legacy page');
	assert.match(top, /this\.livePlayerDisposed = true;[\s\S]*?this\.liveOverlay\.close\(\)/, 'leaving TOP closes the active overlay');
	assert.equal(fs.existsSync(path.join(root, 'web/page/channel/watch.js')), true);
	assert.equal(fs.existsSync(path.join(root, 'api/script-channel-watch.vm.js')), true);
});

it('the shared overlay removes its legacy-mode button and allows close then reopen', () => {
	const env = loadLivePlayer();
	const live = env.open('gr011');
	assert.equal(findByText(live.overlay, '従来方式'), null);
	const overlayCloseButton = findByClass(live.overlay, 'chinachu-live-player-close');
	assert.equal(overlayCloseButton.textContent, '×');
	assert.equal(overlayCloseButton.parent.className, 'program-live-header', 'the close button belongs to the header');
	assert.equal(overlayCloseButton.attributes['aria-label'], 'ライブ視聴を閉じる');
	overlayCloseButton.dispatchEvent(new Event('click'));
	assert.deepEqual(env.calls.order, ['destroy']);
	assert.equal(env.document.body.children.length, 0);
	const reopened = env.open('bs01');
	assert.equal(env.document.body.children[0], reopened.overlay);
	findByText(reopened.overlay, '閉じる').dispatchEvent(new Event('click'));
	assert.equal(env.calls.destroys, 2, 'the existing lower close button still performs normal teardown');
	assert.equal(env.document.body.children.length, 0);
});
