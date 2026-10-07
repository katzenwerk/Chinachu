'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { it } = require('node:test');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

class Element extends EventTarget {
 constructor(tag = 'div') {
  super(); this.tagName = tag; this.children = []; this.attributes = {};
  if (tag === 'video') this.paused = true;
  this.style = { removeProperty() {} }; this.classList = { contains: () => false, remove() {}, add() {} };
 }
 addEventListener(type, listener, options) {
  if (type === 'keydown') this.keydownListenerOptions = options;
  super.addEventListener(type, listener, options);
 }
 focus(options) { this.focusCalls = this.focusCalls || []; this.focusCalls.push(options); }
 append(...children) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
 appendChild(child) { this.append(child); }
 replaceChildren(...children) { this.children = []; this.append(...children); }
 setAttribute(key, value) { this.attributes[key] = value; }
 get lastElementChild() { return this.children.at(-1); }
 remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}
function environment() {
 const document = new Element();
 document.baseURI = 'http://fixture/';
 document.createElement = tag => new Element(tag);
 const window = new Element();
 window.setTimeout = setTimeout; window.clearTimeout = clearTimeout;
 return { document, window, URL, console, setTimeout, clearTimeout };
}
function loadPage(env, importPlayer) {
	const context = { ...env, P: {}, Class: { create: (_base, page) => page }, global: { chinachu: { status: { feature: { filer: true } } } } };
	let source = fs.readFileSync(path.join(root, 'web/page/program/view.js'), 'utf8');
	if (importPlayer) {
		context.importPlayer = importPlayer;
		source = source.replace("import(new URL('./lib/recorded-player.js', document.baseURI).href)", 'importPlayer()');
	}
	vm.runInNewContext(source, context);
 context.P.self = { query: {} };
 return context.P;
}

it('desktop non-Safari detection excludes desktop browsers without classifying mobile and TV Linux as desktop', () => {
	const context = {};
	let source = fs.readFileSync(path.join(root, 'web/lib/recorded-player.js'), 'utf8');
	source = source.replace(/^import .*;\n/gm, '').replace('export function', 'function');
	vm.runInNewContext(source, context);
	const detected = context.isDesktopNonSafariEnvironment;
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36',
		vendor: 'Google Inc.', platform: 'Win32'
	}), true, 'Windows desktop Chrome is excluded');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36 Edg/153.0',
		vendor: 'Google Inc.', platform: 'Win32'
	}), true, 'Windows desktop Edge is excluded');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0',
		vendor: '', platform: 'Linux x86_64'
	}), true, 'Linux desktop Firefox is excluded');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36',
		vendor: 'Google Inc.', platform: 'Linux x86_64'
	}), true, 'Linux desktop Chrome is excluded');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15',
		vendor: 'Apple Computer, Inc.', platform: 'MacIntel'
	}), false, 'macOS Safari keeps recorded HLS');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
		vendor: 'Apple Computer, Inc.', platform: 'iPhone'
	}), false, 'iPhone Safari keeps recorded HLS');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
		vendor: 'Apple Computer, Inc.', platform: 'iPad'
	}), false, 'iPad Safari keeps recorded HLS');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 Chrome/153.0 Safari/537.36',
		vendor: 'Google Inc.', platform: 'Linux armv8l'
	}), false, 'Android is not excluded by its Linux platform');
	assert.equal(detected({
		userAgent: 'Mozilla/5.0 (Linux; Android 9; AFTMM) AppleWebKit/537.36 Silk/130.5 Safari/537.36',
		vendor: 'Amazon.com', platform: 'Linux armv8l'
	}), false, 'Fire TV is not excluded by its Linux platform');
});

it('desktop non-Safari keeps the recorded player on the mpeg2toh264 path and hides FFmpeg compatibility playback', async () => {
	const env = environment();
	env.navigator = {
		userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0 Safari/537.36',
		vendor: 'Google Inc.', platform: 'Win32'
	};
	let loadedUrl = null;
	class Player extends EventTarget {
		constructor(video) {
			super();
			video.play = async () => {};
			video.load = () => {};
		}
		async load(url) { loadedUrl = url; }
		destroy() {}
	}
	class Feeder { destroy() {} }
	class Renderer { destroy() {} }
	class CaptionController {
		attachFeeder() {} attachRenderer() {}
		attachMedia(_video, picture) { picture.append(new Element('svg')); }
		detachMedia() {} detachFeeder() {} detachRenderer() {} show() {} hide() {}
	}
	const context = {
		...env,
		Mpeg2TsPlayer: Player,
		MPEGTSFeeder: Feeder,
		SVGDOMRenderer: Renderer,
		Controller: CaptionController
	};
	const source = fs.readFileSync(path.join(root, 'web/lib/recorded-player.js'), 'utf8')
		.replace(/^import .*;\n/gm, '').replace('export function', 'function');
	vm.runInNewContext(source, context);
	const frame = new Element();
	const adapter = context.createRecordedPlayer(frame, {
		compatUrl: 'http://fixture/watch.mp4?profile=compat',
		compatHlsUrl: 'http://fixture/watch-hls.json?profile=compat',
		onEnded() {}, onError(error) { throw error; }
	});
	const compatButton = frame.children[0].children[1].children.find(child => child.textContent === 'FFmpeg互換再生');
	assert.equal(compatButton.hidden, true);
	compatButton.dispatchEvent(new Event('click'));
	await adapter.load('http://fixture/file.m2ts');
	assert.equal(loadedUrl, 'http://fixture/file.m2ts');
	adapter.destroy();
});

it('recorded preview uses one central poster, starts no player before click, and excludes unavailable/non-recorded files', () => {
 const env = environment(); const page = loadPage(env); const target = new Element();
 const program = { _isRecorded: true, seconds: 1801 };
 page.renderRecordedPreview(target, program, 'recorded-id');
 assert.equal(target.children.length, 1);
 const frame = target.children[0];
 const poster = frame.children[0];
 assert.equal(poster.className, 'program-ts-poster');
 assert.equal(poster.children[0].parent, poster, 'the image fills the poster wrapper');
 assert.equal(poster.children[0].src, './api/recorded/recorded-id/preview.jpg?width=480&height=270&pos=900');
 const playButton = poster.children[1];
 assert.equal(playButton.tagName, 'button');
 assert.equal(playButton.parent, poster, 'the play button shares the image-only wrapper');
 assert.equal(playButton.textContent, '', 'the poster play button contains no font glyph');
 assert.equal(playButton.children.length, 0, 'CSS draws the play triangle without an icon child');
 assert.equal(page.recordedPlayerSlot.player, null);
 assert.equal(page.recordedPlayerSlot.pending, false);
 for (const fields of [{ _isRecorded: false }, { _isRecording: true }, { fileExists: false }, { cleanupState: 'deleted' }]) {
  const excluded = new Element();
  page.renderRecordedPreview(excluded, { ...program, ...fields }, 'recorded-id');
  assert.equal(excluded.children.length, 0);
 }
 page.fallbackFromMatch = true;
 const fallback = new Element();
 page.renderRecordedPreview(fallback, program, 'match-key');
 assert.match(fallback.children[0].children[0].children[0].src, /recorded\/match-key\/preview/);
 let destroyed = 0;
 page.recordedPlayerSlot.player = { destroy() { destroyed++; } };
 page.destroyRecordedPlayer(); page.destroyRecordedPlayer();
 assert.equal(destroyed, 1);
 assert.equal(page.recordedPlayerSlot, null);
 page.programViewDisposed = true;
 const disposed = new Element(); page.renderRecordedPreview(disposed, program, 'recorded-id');
 assert.equal(disposed.children.length, 0);
});

it('navigation during lazy import cancels startup and recorded notifications only interrupt an unavailable file', async () => {
	let resolveImport; let loads = 0;
	const pending = new Promise(resolve => { resolveImport = resolve; });
	const env = environment();
	const page = loadPage(env, () => pending);
	const target = new Element();
	page.renderRecordedPreview(target, { _isRecorded: true, seconds: 60 }, 'fixture');
	target.children[0].children[1].dispatchEvent(new Event('click'));
	page.destroyRecordedPlayer();
	resolveImport({ createRecordedPlayer() { loads++; } });
	await pending; await Promise.resolve();
	assert.equal(loads, 0);
	let program = { id: 'fixture', recorded: '/fixture.ts', _isRecorded: true };
	const notified = loadPage({ ...environment(), chinachu: { util: { getProgramById: () => program } } });
	notified.program = program;
	notified.recordedPlayerSlot = { pending: true };
	let refreshes = 0;
	notified.refresh = () => { refreshes++; };
	for (const type of ['chinachu:schedule', 'chinachu:reserves', 'chinachu:recording', 'chinachu:recorded']) notified.handleNotify({ type });
	assert.equal(refreshes, 0);
	program = { ...program, fileExists: false };
	notified.handleNotify({ type: 'chinachu:recorded' });
	assert.equal(refreshes, 1);
});

it('passes the recorded HLS session URL from the programme page to the player', async () => {
	const env = environment();
	let options;
	const page = loadPage(env, async () => ({
		createRecordedPlayer(_frame, playerOptions) {
			options = playerOptions;
			return { async load() {}, destroy() {} };
		}
	}));
	const target = new Element();
	page.renderRecordedPreview(target, { _isRecorded: true, seconds: 60 }, 'idx1ar7');
	target.children[0].children[0].children[1].dispatchEvent(new Event('click'));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(options.compatHlsUrl, 'http://fixture/api/recorded/idx1ar7/watch-hls.json?profile=compat');
	assert.equal(options.compatUrl, 'http://fixture/api/recorded/idx1ar7/watch.mp4?profile=compat');
});

it('adapter wires official caption events and destroys player and both caption overlays exactly once', async () => {
 const env = environment(); let loaded = 0; let destroyed = 0; let detached = 0; let feeds = 0; let ended = 0; let player;
 class Player extends EventTarget {
  constructor(video) {
   super(); player = this; this.video = video;
   video.paused = true; video.currentTime = 40;
   const ranges = [[0, 120]];
   video.seekable = { get length() { return ranges.length; }, start(index) { return ranges[index][0]; }, end(index) { return ranges[index][1]; } };
   video.play = async () => { video.paused = false; video.dispatchEvent(new Event('play')); video.dispatchEvent(new Event('playing')); };
   video.load = () => { video.nativeLoadCount = (video.nativeLoadCount || 0) + 1; };
  }
  async load() { loaded++; }
  destroy() { destroyed++; }
 }
 class Feeder { feedB24() { feeds++; } destroy() { detached++; } }
 class Renderer { destroy() { detached++; } }
 class CaptionController {
  attachFeeder() {} attachRenderer() {}
  attachMedia(_video, picture) { picture.append(new Element('svg')); }
  detachMedia() { detached++; } detachFeeder() {} detachRenderer() {} show() {} hide() {}
 }
 const context = { ...env, Mpeg2TsPlayer: Player, MPEGTSFeeder: Feeder, SVGDOMRenderer: Renderer, Controller: CaptionController };
 // Execute the adapter with injected browser/player dependencies; keep its logic unchanged.
 const source = fs.readFileSync(path.join(root, 'web/lib/recorded-player.js'), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function');
 vm.runInNewContext(source, context);
 const frame = new Element();
 let adapter;
 adapter = context.createRecordedPlayer(frame, { onEnded() { ended++; adapter.destroy(); }, onError(error) { throw error; } });
 assert.equal(loaded, 0);
 assert.equal(player.video.preload, 'auto', 'MSE must be allowed to open after the explicit click');
 const playOverlay = frame.children[0].children[0].children.find(child => child.className === 'program-ts-play-overlay');
 assert.ok(playOverlay);
 const picture = frame.children[0].children[0];
 const seekFeedback = picture.children.find(child => child.className === 'program-ts-seek-feedback');
 assert.equal(picture.tabIndex, -1);
	assert.equal(picture.keydownListenerOptions.capture, true, 'picture captures keyboard events from its video child');
 assert.equal(playOverlay.hidden, false, 'paused video shows the custom play button');
 await adapter.load('http://fixture/file.m2ts');
 assert.equal(loaded, 1);
 assert.equal(playOverlay.hidden, true, 'playing video hides the custom play button');
	assert.equal(picture.focusCalls.length, 1, 'initial playback focuses picture once');
	assert.equal(picture.focusCalls[0].preventScroll, true, 'initial focus prevents scrolling');
	const key = (name, repeat = false) => {
		const event = new Event('keydown', { cancelable: true, bubbles: true });
		Object.defineProperties(event, { key: { value: name }, repeat: { value: repeat } });
		return event;
	};
	player.video.currentTime = 40;
	env.document.dispatchEvent(key('ArrowRight'));
	assert.equal(player.video.currentTime, 40, 'document-level keys do not seek the video');
	const right = key('ArrowRight'); picture.dispatchEvent(right);
	assert.equal(player.video.currentTime, 55);
	assert.equal(right.defaultPrevented, true);
	assert.equal(right.cancelBubble, true);
	assert.equal(seekFeedback.textContent, '15秒→');
	const left = key('ArrowLeft'); picture.dispatchEvent(left);
	assert.equal(player.video.currentTime, 40);
	assert.equal(left.defaultPrevented, true);
	assert.equal(seekFeedback.textContent, '←15秒');
	const repeated = key('ArrowRight', true); picture.dispatchEvent(repeated);
	assert.equal(player.video.currentTime, 40, 'repeated keydown does not seek');
	assert.equal(repeated.defaultPrevented, true, 'native repeated seeking is suppressed');
	assert.equal(seekFeedback.textContent, '←15秒', 'repeated keydown does not add seek feedback');
	const otherKey = key('Space'); picture.dispatchEvent(otherKey);
	assert.equal(otherKey.defaultPrevented, false, 'other native video keys are not intercepted');
	const boundaryFeedback = seekFeedback.textContent;
	player.video.currentTime = 0; picture.dispatchEvent(key('ArrowLeft'));
	assert.equal(player.video.currentTime, 0, 'seek remains clamped at the start');
	assert.equal(seekFeedback.textContent, boundaryFeedback, 'a seek with no movement shows no feedback');
	player.video.currentTime = 5; picture.dispatchEvent(key('ArrowLeft'));
	assert.equal(player.video.currentTime, 0, 'backward seek clamps to the seekable start');
	player.video.currentTime = 118; picture.dispatchEvent(key('ArrowRight'));
	assert.equal(player.video.currentTime, 120, 'forward seek clamps to the seekable end');
	player.video.paused = true; player.video.dispatchEvent(new Event('pause'));
	assert.equal(playOverlay.hidden, false, 'pause restores the custom play button');
	playOverlay.dispatchEvent(new Event('click'));
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(playOverlay.hidden, true, 'the overlay resumes the video');
	assert.equal(picture.focusCalls.length, 2, 'overlay playback restores focus to picture');
	player.video.dispatchEvent(new Event('playing'));
	assert.equal(picture.focusCalls.length, 2, 'playing events do not steal focus');
	player.video.seekable = { length: 0 };
	const lastFeedback = seekFeedback.textContent;
	const unavailable = key('ArrowRight'); picture.dispatchEvent(unavailable);
	assert.equal(unavailable.defaultPrevented, false, 'unseekable video keeps native key handling');
	assert.equal(seekFeedback.textContent, lastFeedback, 'unavailable seek shows no feedback');
	player.video.seekable = { length: 2, start(index) { return [[0, 5], [20, 30]][index][0]; }, end(index) { return [[0, 5], [20, 30]][index][1]; } };
	player.video.currentTime = 0; picture.dispatchEvent(key('ArrowRight'));
	assert.equal(player.video.currentTime, 20, 'seek across a gap clamps to the nearest seekable boundary');
 const event = new Event('private_stream_1'); event.detail = { data: new Uint8Array(), pts: 1 };
 player.dispatchEvent(event);
 assert.equal(feeds, 2);
 player.video.dispatchEvent(new Event('ended'));
 env.window.dispatchEvent(new Event('pagehide')); adapter.destroy();
 assert.equal(ended, 1); assert.equal(destroyed, 1); assert.equal(detached, 6);
 assert.equal(frame.children.length, 0);
 player.dispatchEvent(event); assert.equal(feeds, 2);
 // Leaving the document mid-load must also release the official player.
	env.window.matchMedia = query => ({ matches: query === '(hover: none) and (pointer: coarse)' });
 adapter = context.createRecordedPlayer(frame, { onEnded() {}, onError() {} });
	const touchPlayOverlay = frame.children[0].children[0].children.find(child => child.className === 'program-ts-play-overlay');
	assert.equal(touchPlayOverlay.hidden, true, 'coarse-pointer devices hide the custom play button immediately');
	player.video.dispatchEvent(new Event('loadedmetadata'));
	player.video.dispatchEvent(new Event('canplay'));
	player.video.dispatchEvent(new Event('pause'));
	assert.equal(touchPlayOverlay.hidden, true, 'metadata and pause events never reveal the custom button on touch');
	player.video.paused = false;
	player.video.dispatchEvent(new Event('play'));
	player.video.dispatchEvent(new Event('playing'));
	assert.equal(touchPlayOverlay.hidden, true, 'play state updates leave the native-controls-only mode active');
 const videoAfterDestroy = player.video;
	const pictureAfterDestroy = frame.children[0].children[0];
	env.window.dispatchEvent(new Event('pagehide'));
 assert.equal(destroyed, 2);
	videoAfterDestroy.currentTime = 30;
	pictureAfterDestroy.dispatchEvent(key('ArrowRight'));
	assert.equal(videoAfterDestroy.currentTime, 30, 'destroy removes the video key listener');
 assert.equal(frame.children.length, 0);
	adapter = context.createRecordedPlayer(frame, { compatUrl: 'http://fixture/watch.mp4?profile=compat', onEnded() {}, onError(error) { throw error; } });
	const compatButton = frame.children[0].children[1].children.find(child => child.textContent === 'FFmpeg互換再生');
	assert.equal(compatButton.hidden, false, 'manual FFmpeg compatibility playback is available');
	const pendingStandardLoad = adapter.load('http://fixture/file.m2ts');
	compatButton.dispatchEvent(new Event('click'));
	await pendingStandardLoad;
	assert.equal(player.video.src, 'http://fixture/watch.mp4?profile=compat');
	assert.equal(player.video.nativeLoadCount, 1);
	assert.equal(destroyed, 3, 'switching modes tears down the MSE player exactly once');
	adapter.destroy();
	assert.equal(destroyed, 3, 'closing after switching modes does not destroy MSE twice');
	assert.equal(frame.children.length, 0);

	const fetches = [];
	env.window.fetch = async (url, options = {}) => {
		fetches.push({ url, options });
		if (options.method === 'DELETE') return { ok: true, json: async () => ({ stopped: true }) };
		return {
			ok: true,
			json: async () => ({
				playlist: './watch-hls/0123456789abcdef0123456789abcdef0123456789abcdef/index.m3u8',
				close: './watch-hls/0123456789abcdef0123456789abcdef0123456789abcdef.json'
			})
		};
	};
	context.navigator = {
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1',
		vendor: 'Apple Computer, Inc.', platform: 'iPhone'
	};
	adapter = context.createRecordedPlayer(frame, {
		compatUrl: 'http://fixture/api/recorded/fixture/watch.mp4?profile=compat',
		compatHlsUrl: 'http://fixture/api/recorded/fixture/watch-hls.json?profile=compat',
		onEnded() {},
		onError(error) { throw error; }
	});
	player.video.canPlayType = type => type === 'application/vnd.apple.mpegurl' ? 'probably' : '';
	const hlsButton = frame.children[0].children[1].children.find(child => child.textContent === 'FFmpeg互換再生');
	hlsButton.dispatchEvent(new Event('click'));
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(fetches[0].url, 'http://fixture/api/recorded/fixture/watch-hls.json?profile=compat');
	assert.equal(player.video.src, 'http://fixture/api/recorded/fixture/watch-hls/0123456789abcdef0123456789abcdef0123456789abcdef/index.m3u8');
	adapter.destroy();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(fetches[1].options.method, 'DELETE');
	assert.equal(fetches[1].options.keepalive, true);
	assert.equal(frame.children.length, 0);
});
