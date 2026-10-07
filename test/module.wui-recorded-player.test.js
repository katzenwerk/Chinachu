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
});
