//#region src/runtime/browser/controller/eventemitter.ts
var e = class {
	listeners = /* @__PURE__ */ new Map();
	on(e, t) {
		this.listeners.has(e) || this.listeners.set(e, []), this.listeners.get(e).push(t);
	}
	off(e, t) {
		this.listeners.has(e) && this.listeners.set(e, this.listeners.get(e).filter((e) => e !== t));
	}
	emit(e, t) {
		(this.listeners.get(e) ?? []).forEach((e) => {
			e(t);
		});
	}
}, t = { BuiltinSound: "BuiltinSound" }, n = { from(e) {
	return {
		event: t.BuiltinSound,
		sound: e
	};
} }, r = class {
	option;
	media = null;
	container = null;
	onContainerResizeHandler = this.onContainerResize.bind(this);
	resize_observer = null;
	onVideoResizeHandler = this.onVideoResize.bind(this);
	onTimeupdateHandler = this.onTimeupdate.bind(this);
	timer = null;
	onSeekingHandler = this.onSeeking.bind(this);
	onPlayHandler = this.onPlay.bind(this);
	onPauseHandler = this.onPause.bind(this);
	renderers = [];
	privious_pts = null;
	feeder = null;
	isShowing = !0;
	emitter = new e();
	constructor(e) {
		this.option = { ...e };
	}
	attachMedia(e, t) {
		this.container && this.renderers.forEach((e) => e.onDetach()), this.media = e, this.container = t ?? e.parentElement, this.container && this.renderers.forEach((e) => e.onAttach(this.container)), this.feeder?.prepare(this.media.currentTime), this.setupHandlers();
	}
	detachMedia() {
		this.container && this.renderers.forEach((e) => e.onDetach()), this.cleanupHandlers(), this.media = this.container = null;
	}
	setupHandlers() {
		!this.media || !this.container || (this.media.addEventListener("seeking", this.onSeekingHandler), this.media.addEventListener("resize", this.onVideoResizeHandler), this.media.addEventListener("play", this.onPlayHandler), this.media.addEventListener("pause", this.onPauseHandler), this.resize_observer = new ResizeObserver(this.onContainerResizeHandler), this.resize_observer.observe(this.container));
	}
	cleanupHandlers() {
		this.media?.removeEventListener("seeking", this.onSeekingHandler), this.media?.removeEventListener("resize", this.onVideoResizeHandler), this.media?.removeEventListener("play", this.onPlayHandler), this.media?.removeEventListener("pause", this.onPauseHandler), this.container && this.resize_observer?.unobserve(this.container), this.resize_observer?.disconnect(), this.resize_observer = null;
	}
	attachFeeder(e) {
		this.detachFeeder(), this.feeder = e, this.feeder.onAttach(), this.media != null && this.feeder.prepare(this.media.currentTime);
	}
	detachFeeder() {
		this.feeder?.onDetach(), this.feeder = null;
	}
	attachRenderer(e) {
		e.onDetach(), this.renderers.push(e), this.container && e.onAttach(this.container);
	}
	detachRenderer(e) {
		e.onDetach(), this.renderers = this.renderers.filter((t) => t !== e);
	}
	on(e, t) {
		this.emitter.on(e, t);
	}
	off(e, t) {
		this.emitter.off(e, t);
	}
	onSeeking() {
		this.feeder?.onSeeking(), this.renderers.forEach((e) => e.onSeeking()), this.clear();
	}
	onContainerResize(e) {
		if (!this.media || !this.container) return;
		let t = e.find((e) => e.target === this.container);
		if (!t) return;
		let n = t.devicePixelContentBoxSize == null ? Math.floor(t.contentBoxSize[0].inlineSize * devicePixelRatio) : t.devicePixelContentBoxSize[0].inlineSize, r = t.devicePixelContentBoxSize == null ? Math.floor(t.contentBoxSize[0].blockSize * devicePixelRatio) : t.devicePixelContentBoxSize[0].blockSize;
		this.renderers.forEach((e) => {
			e.onContainerResize(n, r) && this.paint(!0);
		});
	}
	onVideoResize() {
		!this.media || !this.container || this.renderers.forEach((e) => {
			e.onVideoResize(this.media.videoWidth, this.media.videoHeight) && this.paint(!0);
		});
	}
	onTimeupdate() {
		this.isShowing && (this.registerRenderingLoop(), this.paint(!1));
	}
	registerRenderingLoop() {
		this.timer = requestAnimationFrame(this.onTimeupdateHandler);
	}
	unregisterRenderingLoop() {
		this.timer != null && (cancelAnimationFrame(this.timer), this.timer = null);
	}
	onPlay() {
		this.media != null && this.feeder?.prepare(this.media.currentTime), this.renderers.forEach((e) => {
			e.onPlay();
		}), this.timer ?? this.registerRenderingLoop();
	}
	onPause() {
		this.renderers.forEach((e) => {
			e.onPause();
		}), this.unregisterRenderingLoop();
	}
	paint(e) {
		if (!this.media) return;
		let r = this.media.currentTime, i = this.feeder?.content(r) ?? null;
		if (e) {
			i == null || r >= i.pts + i.duration ? this.renderers.forEach((e) => e.clear()) : this.renderers.forEach((e) => e.render(i.state, structuredClone(i.data), i.info));
			return;
		}
		if (i == null) {
			if (this.privious_pts == null) return;
			this.renderers.forEach((e) => e.clear()), this.privious_pts = null;
		} else if (r >= i.pts + i.duration) {
			let e = i.pts + i.duration;
			if (this.privious_pts === e) return;
			this.renderers.forEach((e) => e.clear()), this.privious_pts = e;
		} else {
			if (this.privious_pts === i.pts) return;
			this.renderers.forEach((e) => e.render(structuredClone(i.state), structuredClone(i.data), structuredClone(i.info))), this.privious_pts = i.pts;
			for (let e of i.data.filter((e) => e.tag === "BuiltinSoundReplay")) this.emitter.emit(t.BuiltinSound, n.from(e.sound));
		}
	}
	clear() {
		this.renderers.forEach((e) => e.clear()), this.privious_pts = null;
	}
	show() {
		this.isShowing = !0, this.timer ?? this.registerRenderingLoop(), this.renderers.forEach((e) => e.show());
	}
	hide() {
		this.isShowing = !1, this.unregisterRenderingLoop(), this.renderers.forEach((e) => e.hide());
	}
	showing() {
		return this.isShowing;
	}
}, i = { from(e, t = !1) {
	return {
		tag: "Character",
		character: e,
		non_spacing: t
	};
} }, a = { from() {
	return { tag: "Mosaic" };
} }, o = { from(e, t, n, r, i = "") {
	return {
		tag: "DRCS",
		width: e,
		height: t,
		depth: n,
		binary: r,
		combining: i
	};
} }, s = { from(e, t, n, r) {
	return {
		tag: "Bitmap",
		x_position: e,
		y_position: t,
		flc_colors: n,
		binary: r
	};
} }, c = { from() {
	return { tag: "Null" };
} }, l = { from() {
	return { tag: "Bell" };
} }, u = { from() {
	return { tag: "ActivePositionBackward" };
} }, d = { from() {
	return { tag: "ActivePositionForward" };
} }, f = { from() {
	return { tag: "ActivePositionDown" };
} }, p = { from() {
	return { tag: "ActivePositionUp" };
} }, m = { from() {
	return { tag: "ClearScreen" };
} }, h = { from() {
	return { tag: "ActivePositionReturn" };
} }, g = { from(e) {
	return {
		tag: "ParameterizedActivePositionForward",
		x: e
	};
} }, _ = { from() {
	return { tag: "Cancel" };
} }, v = { from(e, t) {
	return {
		tag: "ActivePositionSet",
		x: e,
		y: t
	};
} }, ee = { from() {
	return { tag: "RecordSeparator" };
} }, te = { from() {
	return { tag: "UnitSeparator" };
} }, ne = { from() {
	return { tag: "Space" };
} }, re = { from() {
	return { tag: "Delete" };
} }, ie = { from() {
	return { tag: "BlackForeground" };
} }, y = { from() {
	return { tag: "RedForeground" };
} }, ae = { from() {
	return { tag: "GreenForeground" };
} }, oe = { from() {
	return { tag: "YellowForeground" };
} }, se = { from() {
	return { tag: "BlueForeground" };
} }, ce = { from() {
	return { tag: "MagentaForeground" };
} }, le = { from() {
	return { tag: "CyanForeground" };
} }, b = { from() {
	return { tag: "WhiteForeground" };
} }, ue = { from() {
	return { tag: "SmallSize" };
} }, x = { from() {
	return { tag: "MiddleSize" };
} }, de = { from() {
	return { tag: "NormalSize" };
} }, S = {
	TINY: 96,
	DOUBLE_HEIGHT: 65,
	DOUBLE_WIDTH: 68,
	DOUBLE_HEIGHT_AND_WIDTH: 69,
	SPECIAL_1: 107,
	SPECIAL_2: 100
}, fe = { from(e) {
	return {
		tag: "CharacterSizeControl",
		type: e
	};
} }, C = { from(e) {
	return {
		tag: "ColorControlForeground",
		color: e
	};
} }, pe = { from(e) {
	return {
		tag: "ColorControlBackground",
		color: e
	};
} }, me = { from(e) {
	return {
		tag: "ColorControlHalfForeground",
		color: e
	};
} }, w = { from(e) {
	return {
		tag: "ColorControlHalfBackground",
		color: e
	};
} }, he = { from(e) {
	return {
		tag: "PalletControl",
		pallet: e
	};
} }, T = {
	NORMAL: 64,
	INVERTED: 71,
	STOP: 79
}, ge = { from(e) {
	return {
		tag: "FlashingControl",
		type: e
	};
} }, E = { STOP: 79 }, _e = { from(e) {
	return {
		tag: "ConcealmentMode",
		type: e
	};
} }, D = { START: 64 }, ve = { from(e) {
	return {
		tag: "SingleConcealmentMode",
		type: e
	};
} }, ye = {
	START: 64,
	FIRST: 65,
	SECOND: 66,
	THIRD: 67,
	FOURTH: 68,
	FIFTH: 69,
	SIXTH: 70,
	SEVENTH: 71,
	EIGHTH: 72,
	NINTH: 73,
	TENTH: 74
}, be = { from(e) {
	return {
		tag: "ReplacingConcealmentMode",
		type: e
	};
} }, O = {
	NORMAL: 64,
	INVERTED_1: 65,
	INVERTED_2: 66
}, xe = { from(e) {
	return {
		tag: "PatternPolarityControl",
		type: e
	};
} }, Se = {
	BOTH: 64,
	FOREGROUND: 68,
	BACKGROUND: 69
}, k = { from(e) {
	return {
		tag: "WritingModeModification",
		type: e
	};
} }, Ce = { from(e) {
	return {
		tag: "HilightingCharacterBlock",
		enclosure: e
	};
} }, we = { from(e) {
	return {
		tag: "RepeatCharacter",
		repeat: e
	};
} }, Te = { from() {
	return { tag: "StartLining" };
} }, Ee = { from() {
	return { tag: "StopLining" };
} }, De = { from(e) {
	return {
		tag: "TimeControlWait",
		seconds: e
	};
} }, Oe = {
	FREE: 64,
	REAL: 65,
	OFFSET: 66,
	UNIQUE: 67
}, ke = { from(e) {
	return {
		tag: "TimeControlMode",
		type: e
	};
} }, Ae = { from(e) {
	return {
		tag: "SetWritingFormat",
		format: e
	};
} }, je = { from(e, t) {
	return {
		tag: "SetDisplayFormat",
		horizontal: e,
		vertical: t
	};
} }, Me = { from(e, t) {
	return {
		tag: "SetDisplayPosition",
		horizontal: e,
		vertical: t
	};
} }, Ne = { from(e, t) {
	return {
		tag: "CharacterCompositionDotDesignation",
		horizontal: e,
		vertical: t
	};
} }, Pe = { from(e) {
	return {
		tag: "SetHorizontalSpacing",
		spacing: e
	};
} }, Fe = { from(e) {
	return {
		tag: "SetVerticalSpacing",
		spacing: e
	};
} }, Ie = { from(e, t) {
	return {
		tag: "ActiveCoordinatePositionSet",
		x: e,
		y: t
	};
} }, Le = {
	NONE: 0,
	HEMMING: 1,
	SHADE: 2,
	HOLLOW: 3
}, Re = { from() {
	return { tag: "OrnamentControlNone" };
} }, ze = { from(e) {
	return {
		tag: "OrnamentControlHemming",
		color: e
	};
} }, Be = { from(e) {
	return {
		tag: "OrnamentControlShade",
		color: e
	};
} }, Ve = { from() {
	return { tag: "OrnamentControlHollow" };
} }, He = { from(e) {
	return {
		tag: "BuiltinSoundReplay",
		sound: e
	};
} }, Ue = { from(e) {
	return {
		tag: "RasterColourCommand",
		color: e
	};
} }, We = class extends Error {
	constructor(e, t) {
		super(e, t), this.name = this.constructor.name;
	}
}, A = class extends Error {
	constructor(e, t) {
		super(e, t), this.name = this.constructor.name;
	}
}, j = class extends Error {
	constructor(e, t) {
		super(e, t), this.name = this.constructor.name;
	}
}, Ge = class extends Error {
	constructor(e, t) {
		super(e, t), this.name = this.constructor.name;
	}
}, Ke = class extends Error {
	constructor(e, t) {
		super(e, t), this.name = this.constructor.name;
	}
}, M = class extends Error {
	constructor(e, t, n) {
		super(`${t}: ${e}}`, n), this.name = this.constructor.name;
	}
}, N = class extends Error {
	constructor(e, t) {
		super(e, t), this.name = this.constructor.name;
	}
};
//#endregion
//#region src/util/crc32.ts
function qe(e, t = 0, n = e.byteLength) {
	let r = -1;
	for (let i = t; i < n; i++) {
		r ^= e[i];
		for (let e = 0; e < 8; e++) r & 1 ? r = r >>> 1 ^ 3988292384 : r >>>= 1;
	}
	return ~r;
}
//#endregion
//#region src/lib/parser/parser.ts
var P = {
	Small: "Small",
	Middle: "Middle",
	Normal: "Normal",
	Tiny: "Tiny",
	DoubleHeight: "DoubleHeight",
	DoubleWidth: "DoubleWidth",
	DoubleHeightAndWidth: "DoubleHeightAndWidth",
	Special1: "Special1",
	Special2: "Special2"
}, Je = new Map([
	[P.Small, [.5, .5]],
	[P.Middle, [.5, 1]],
	[P.Normal, [1, 1]],
	[P.Tiny, [1 / 4, 1 / 6]],
	[P.DoubleHeight, [1, 2]],
	[P.DoubleWidth, [2, 1]],
	[P.DoubleHeightAndWidth, [2, 2]],
	[P.Special1, [NaN, NaN]],
	[P.Special2, [NaN, NaN]]
]), Ye = { from(e) {
	return {
		magnification: 2,
		...e
	};
} }, Xe = {
	plane: [960, 540],
	area: [960, 540],
	margin: [0, 0],
	fontsize: [36, 36],
	hspace: 4,
	vspace: 24,
	position: [0, 59],
	size: P.Normal,
	pallet: 0,
	foreground: 7,
	halfforeground: 0,
	halfbackground: 0,
	background: 8,
	underline: !1,
	highlight: 0,
	ornament: null,
	flashing: T.STOP,
	elapsed_time: 0
}, Ze = { from(e, t, n) {
	return {
		tag: "ClearScreen",
		state: structuredClone(t),
		option: structuredClone(n),
		time: e
	};
} }, Qe = { from({ character: e, non_spacing: t }, n, r) {
	return {
		tag: "Character",
		state: structuredClone(n),
		option: structuredClone(r),
		character: e,
		non_spacing: t
	};
} }, $e = { from({ width: e, height: t, depth: n, binary: r }, i, a) {
	return {
		tag: "DRCS",
		state: structuredClone(i),
		option: structuredClone(a),
		width: e,
		height: t,
		depth: n,
		binary: r
	};
} }, et = {
	from({ x_position: e, y_position: t, flc_colors: n, binary: r }, i, a) {
		return {
			tag: "Bitmap",
			state: structuredClone(i),
			option: structuredClone(a),
			x_position: e,
			y_position: t,
			flc_colors: n,
			binary: r
		};
	},
	toDataURL(e, t) {
		let n = new Uint8Array(e.binary), r = new Set(e.flc_colors), i = n.subarray(0, 33), a = n.subarray(33, n.byteLength), o = new Uint8Array(i.byteLength + a.byteLength + 396 + 140), s = new DataView(o.buffer);
		o.set(i, 0), o.set(a, 569);
		for (let e = 0; e < t.length; e++) {
			let n = t[e], i = Number.parseInt(n.substring(1, 3), 16), a = Number.parseInt(n.substring(3, 5), 16), s = Number.parseInt(n.substring(5, 7), 16), c = Number.parseInt(n.substring(7, 9), 16);
			o[41 + e * 3 + 0] = i, o[41 + e * 3 + 1] = a, o[41 + e * 3 + 2] = s, o[437 + e] = r.has(e) ? 0 : c;
		}
		s.setInt32(33, 384, !1), o[37] = 80, o[38] = 76, o[39] = 84, o[40] = 69, s.setInt32(429, 128, !1), o[433] = 116, o[434] = 82, o[435] = 78, o[436] = 83, s.setInt32(425, qe(o, 37, 425), !1), s.setInt32(565, qe(o, 433, 565), !1);
		let c = s.getInt32(16, !1), l = s.getInt32(20, !1), u = "data:image/png;base64," + btoa(String.fromCharCode(...o));
		if (r.size === 0) return {
			width: c,
			height: l,
			normal_dataurl: u
		};
		for (let e = 0; e < t.length; e++) {
			let n = t[e], i = Number.parseInt(n.substring(7, 9), 16);
			o[437 + e] = r.has(e) ? i : 0;
		}
		return s.setInt32(425, qe(o, 37, 425), !1), s.setInt32(565, qe(o, 433, 565), !1), {
			width: c,
			height: l,
			normal_dataurl: u,
			flashing_dataurl: "data:image/png;base64," + btoa(String.fromCharCode(...o))
		};
	}
}, F = class e {
	state;
	option;
	non_spacings = [];
	constructor(e = Xe, t) {
		this.state = structuredClone(e), this.option = Ye.from(t), this.state.plane = [this.state.plane[0] * this.option.magnification, this.state.plane[1] * this.option.magnification], this.state.area = [this.state.area[0] * this.option.magnification, this.state.area[1] * this.option.magnification], this.state.margin = [this.state.margin[0] * this.option.magnification, this.state.margin[1] * this.option.magnification], this.state.fontsize = [this.state.fontsize[0] * this.option.magnification, this.state.fontsize[1] * this.option.magnification], this.state.hspace = this.state.hspace * this.option.magnification, this.state.vspace = this.state.vspace * this.option.magnification, this.state.position = [this.state.position[0] * this.option.magnification, this.state.position[1] * this.option.magnification];
	}
	static box(e) {
		return [Math.floor((e.fontsize[0] + e.hspace) * Je.get(e.size)[0]), Math.floor((e.fontsize[1] + e.vspace) * Je.get(e.size)[1])];
	}
	static offset(e) {
		return [Math.floor(e.hspace * Je.get(e.size)[0] / 2), Math.floor(e.vspace * Je.get(e.size)[1] / 2)];
	}
	static scale(e) {
		return Je.get(e.size);
	}
	move_absolute_dot(e, t) {
		this.state.position[0] = e - this.state.margin[0], this.state.position[1] = t - this.state.margin[1];
	}
	move_absolute_pos(t, n) {
		this.state.position[0] = t * e.box(this.state)[0], this.state.position[1] = (n + 1) * e.box(this.state)[1] - 1 * this.option.magnification;
	}
	move_newline() {
		this.state.position[0] = 0, this.move_relative_pos(0, 1);
	}
	move_relative_pos(t, n) {
		for (; t < 0;) for (this.state.position[0] -= e.box(this.state)[0], t++; this.state.position[0] < 0;) this.state.position[0] += this.state.area[0], n--;
		for (; t > 0;) for (this.state.position[0] += e.box(this.state)[0], t--; this.state.position[0] >= this.state.area[0];) this.state.position[0] -= this.state.area[0], n++;
		for (; n < 0;) this.state.position[1] -= e.box(this.state)[1], n++;
		for (; n > 0;) this.state.position[1] += e.box(this.state)[1], n--;
		for (; this.state.position[1] >= this.state.area[1];) this.state.position[1] -= this.state.area[1];
		for (; this.state.position[1] < 0;) this.state.position[1] += this.state.area[1];
	}
	currentState() {
		return structuredClone(this.state);
	}
	currentOption() {
		return structuredClone(this.option);
	}
	parseToken(e) {
		switch (e.tag) {
			case "Character":
				if (e.non_spacing) this.non_spacings.push(Qe.from(e, this.state, this.option));
				else {
					let t = [Qe.from(e, this.state, this.option), ...this.non_spacings];
					return this.non_spacings = [], this.move_relative_pos(1, 0), t;
				}
				break;
			case "DRCS":
				let t = [
					$e.from(e, this.state, this.option),
					...e.combining === "" ? [] : [Qe.from(i.from("　" + e.combining, !0), this.state, this.option)],
					...this.non_spacings
				];
				return this.non_spacings = [], this.move_relative_pos(1, 0), t;
			case "Space": {
				let e = [Qe.from(i.from("　"), this.state, this.option), ...this.non_spacings];
				return this.non_spacings = [], this.move_relative_pos(1, 0), e;
			}
			case "SetWritingFormat":
				switch (e.format) {
					case 0:
					case 2:
					case 4: break;
					case 5:
						this.state.plane = [1920 * this.option.magnification, 1080 * this.option.magnification];
						break;
					case 7:
						this.state.plane = [960 * this.option.magnification, 540 * this.option.magnification];
						break;
					case 9:
						this.state.plane = [720 * this.option.magnification, 480 * this.option.magnification];
						break;
					case 11:
						this.state.plane = [1280 * this.option.magnification, 720 * this.option.magnification];
						break;
					default: break;
				}
				break;
			case "SetDisplayFormat":
				this.state.area = [e.horizontal * this.option.magnification, e.vertical * this.option.magnification];
				break;
			case "SetDisplayPosition":
				this.state.margin = [e.horizontal * this.option.magnification, e.vertical * this.option.magnification];
				break;
			case "CharacterCompositionDotDesignation":
				this.state.fontsize = [e.horizontal * this.option.magnification, e.vertical * this.option.magnification];
				break;
			case "SetHorizontalSpacing":
				this.state.hspace = e.spacing * this.option.magnification;
				break;
			case "SetVerticalSpacing":
				this.state.vspace = e.spacing * this.option.magnification;
				break;
			case "ActivePositionBackward":
				this.move_relative_pos(-1, 0);
				break;
			case "ActivePositionForward":
				this.move_relative_pos(1, 0);
				break;
			case "ActivePositionDown":
				this.move_relative_pos(0, 1);
				break;
			case "ActivePositionUp":
				this.move_relative_pos(0, -1);
				break;
			case "ActivePositionReturn":
				this.move_newline();
				break;
			case "ParameterizedActivePositionForward":
				this.move_relative_pos(e.x, 0);
				break;
			case "ActivePositionSet":
				this.move_absolute_pos(e.x, e.y);
				break;
			case "ActiveCoordinatePositionSet":
				this.move_absolute_dot(e.x * this.option.magnification, e.y * this.option.magnification);
				break;
			case "SmallSize":
				this.state.size = P.Small;
				break;
			case "MiddleSize":
				this.state.size = P.Middle;
				break;
			case "NormalSize":
				this.state.size = P.Normal;
				break;
			case "CharacterSizeControl":
				switch (e.type) {
					case S.TINY:
						this.state.size = P.Tiny;
						break;
					case S.DOUBLE_HEIGHT:
						this.state.size = P.DoubleHeight;
						break;
					case S.DOUBLE_WIDTH:
						this.state.size = P.DoubleWidth;
						break;
					case S.DOUBLE_HEIGHT_AND_WIDTH:
						this.state.size = P.DoubleHeightAndWidth;
						break;
					case S.SPECIAL_1:
						this.state.size = P.Special1;
						break;
					case S.SPECIAL_2:
						this.state.size = P.Special2;
						break;
					default: throw new M(e, "Unexcepted Size Type in STD-B24 ARIB Caption Content");
				}
				break;
			case "PalletControl":
				this.state.pallet = e.pallet;
				break;
			case "BlackForeground":
				this.state.foreground = this.state.pallet << 4 | 0;
				break;
			case "RedForeground":
				this.state.foreground = this.state.pallet << 4 | 1;
				break;
			case "GreenForeground":
				this.state.foreground = this.state.pallet << 4 | 2;
				break;
			case "YellowForeground":
				this.state.foreground = this.state.pallet << 4 | 3;
				break;
			case "BlueForeground":
				this.state.foreground = this.state.pallet << 4 | 4;
				break;
			case "MagentaForeground":
				this.state.foreground = this.state.pallet << 4 | 5;
				break;
			case "CyanForeground":
				this.state.foreground = this.state.pallet << 4 | 6;
				break;
			case "WhiteForeground":
				this.state.foreground = this.state.pallet << 4 | 7;
				break;
			case "ColorControlForeground":
				this.state.foreground = this.state.pallet << 4 | e.color;
				break;
			case "ColorControlHalfForeground":
				this.state.halfforeground = this.state.pallet << 4 | e.color;
				break;
			case "ColorControlHalfBackground":
				this.state.halfbackground = this.state.pallet << 4 | e.color;
				break;
			case "ColorControlBackground":
				this.state.background = this.state.pallet << 4 | e.color;
				break;
			case "StartLining":
				this.state.underline = !0;
				break;
			case "StopLining":
				this.state.underline = !1;
				break;
			case "HilightingCharacterBlock":
				this.state.highlight = e.enclosure;
				break;
			case "OrnamentControlNone":
				this.state.ornament = null;
				break;
			case "OrnamentControlHemming": {
				let t = Math.floor(e.color / 100), n = e.color % 100;
				this.state.ornament = n << 4 | t;
				break;
			}
			case "FlashingControl":
				this.state.flashing = e.type;
				break;
			case "ClearScreen": return [Ze.from(this.state.elapsed_time, this.state, this.option)];
			case "TimeControlWait":
				this.state.elapsed_time += e.seconds;
				break;
		}
		return [];
	}
	parse(e) {
		return e.flatMap(this.parseToken.bind(this));
	}
}, tt = Xe, nt = {
	...Xe,
	size: P.Middle
}, rt = new Map([
	[33, "！"],
	[34, "＂"],
	[35, "＃"],
	[36, "＄"],
	[37, "％"],
	[38, "＆"],
	[39, "＇"],
	[40, "（"],
	[41, "）"],
	[42, "＊"],
	[43, "＋"],
	[44, "，"],
	[45, "－"],
	[46, "．"],
	[47, "／"],
	[48, "０"],
	[49, "１"],
	[50, "２"],
	[51, "３"],
	[52, "４"],
	[53, "５"],
	[54, "６"],
	[55, "７"],
	[56, "８"],
	[57, "９"],
	[58, "："],
	[59, "；"],
	[60, "＜"],
	[61, "＝"],
	[62, "＞"],
	[63, "？"],
	[64, "＠"],
	[65, "Ａ"],
	[66, "Ｂ"],
	[67, "Ｃ"],
	[68, "Ｄ"],
	[69, "Ｅ"],
	[70, "Ｆ"],
	[71, "Ｇ"],
	[72, "Ｈ"],
	[73, "Ｉ"],
	[74, "Ｊ"],
	[75, "Ｋ"],
	[76, "Ｌ"],
	[77, "Ｍ"],
	[78, "Ｎ"],
	[79, "Ｏ"],
	[80, "Ｐ"],
	[81, "Ｑ"],
	[82, "Ｒ"],
	[83, "Ｓ"],
	[84, "Ｔ"],
	[85, "Ｕ"],
	[86, "Ｖ"],
	[87, "Ｗ"],
	[88, "Ｘ"],
	[89, "Ｙ"],
	[90, "Ｚ"],
	[91, "［"],
	[92, "／"],
	[93, "］"],
	[94, "＾"],
	[95, "＿"],
	[96, "｀"],
	[97, "ａ"],
	[98, "ｂ"],
	[99, "ｃ"],
	[100, "ｄ"],
	[101, "ｅ"],
	[102, "ｆ"],
	[103, "ｇ"],
	[104, "ｈ"],
	[105, "ｉ"],
	[106, "ｊ"],
	[107, "ｋ"],
	[108, "ｌ"],
	[109, "ｍ"],
	[110, "ｎ"],
	[111, "ｏ"],
	[112, "ｐ"],
	[113, "ｑ"],
	[114, "ｒ"],
	[115, "ｓ"],
	[116, "ｔ"],
	[117, "ｕ"],
	[118, "ｖ"],
	[119, "ｗ"],
	[120, "ｘ"],
	[121, "ｙ"],
	[122, "ｚ"],
	[123, "｛"],
	[124, "｜"],
	[125, "｝"],
	[126, "～"]
]), it = class {
	data;
	view;
	offset;
	constructor(e) {
		this.data = e, this.view = new DataView(e.buffer, e.byteOffset, e.byteLength), this.offset = 0;
	}
	exists(e) {
		return this.offset + e <= this.view.byteLength;
	}
	isEmpty() {
		return this.offset === this.view.byteLength;
	}
	read(e) {
		if (!this.exists(e)) throw new We("Detected EOF!");
		let t = this.data.subarray(this.offset, this.offset + e);
		return this.offset += e, t;
	}
	peekU8() {
		if (!this.exists(1)) throw new We("Detected EOF!");
		return this.view.getUint8(this.offset);
	}
	readU8() {
		let e = this.peekU8();
		return this.offset += 1, e;
	}
	peekU16() {
		if (!this.exists(2)) throw new We("Detected EOF!");
		return this.view.getUint16(this.offset, !1);
	}
	readU16() {
		let e = this.peekU16();
		return this.offset += 2, e;
	}
	peekU24() {
		if (!this.exists(3)) throw new We("Detected EOF!");
		return this.view.getUint16(this.offset, !1) * 2 ** 8 + this.view.getUint8(this.offset + 2);
	}
	readU24() {
		let e = this.peekU24();
		return this.offset += 3, e;
	}
	peekU32() {
		if (!this.exists(4)) throw new We("Detected EOF!");
		return this.view.getUint32(this.offset, !1);
	}
	readU32() {
		let e = this.peekU32();
		return this.offset += 4, e;
	}
	readAll() {
		let e = this.data.subarray(this.offset);
		return this.offset = this.view.byteLength, e;
	}
}, at = (e, t) => e << t | e >>> 32 - t, I = (e, t, n, r, i, a, o, s) => at(t + e(n, r, i) + a + o | 0, s) + n | 0, L = (e, t, n) => e & t | ~e & n, R = (e, t, n) => e & n | t & ~n, z = (e, t, n) => e ^ t ^ n, B = (e, t, n) => t ^ (e | ~n), V = (e) => {
	let t = (e & 240) >> 4, n = (e & 15) >> 0;
	return `${t.toString(16)}${n.toString(16)}`;
}, ot = (e) => {
	let t = Math.floor((e.byteLength + 8) / 64 + 1) * 64, n = new Uint8Array(t);
	n.set(new Uint8Array(e), 0);
	let r = new DataView(n.buffer);
	r.setUint8(e.byteLength, 128), r.setUint32(t - 8, e.byteLength * 8 % 2 ** 32, !0), r.setUint32(t - 4, e.byteLength * 8 / 2 ** 32, !0);
	let i = 1732584193, a = -271733879, o = -1732584194, s = 271733878;
	for (let e = 0; e < t; e += 64) {
		let t = i, n = a, c = o, l = s;
		i = I(L, i, a, o, s, r.getUint32(e + 0, !0), 3614090360, 7), s = I(L, s, i, a, o, r.getUint32(e + 4, !0), 3905402710, 12), o = I(L, o, s, i, a, r.getUint32(e + 8, !0), 606105819, 17), a = I(L, a, o, s, i, r.getUint32(e + 12, !0), 3250441966, 22), i = I(L, i, a, o, s, r.getUint32(e + 16, !0), 4118548399, 7), s = I(L, s, i, a, o, r.getUint32(e + 20, !0), 1200080426, 12), o = I(L, o, s, i, a, r.getUint32(e + 24, !0), 2821735955, 17), a = I(L, a, o, s, i, r.getUint32(e + 28, !0), 4249261313, 22), i = I(L, i, a, o, s, r.getUint32(e + 32, !0), 1770035416, 7), s = I(L, s, i, a, o, r.getUint32(e + 36, !0), 2336552879, 12), o = I(L, o, s, i, a, r.getUint32(e + 40, !0), 4294925233, 17), a = I(L, a, o, s, i, r.getUint32(e + 44, !0), 2304563134, 22), i = I(L, i, a, o, s, r.getUint32(e + 48, !0), 1804603682, 7), s = I(L, s, i, a, o, r.getUint32(e + 52, !0), 4254626195, 12), o = I(L, o, s, i, a, r.getUint32(e + 56, !0), 2792965006, 17), a = I(L, a, o, s, i, r.getUint32(e + 60, !0), 1236535329, 22), i = I(R, i, a, o, s, r.getUint32(e + 4, !0), 4129170786, 5), s = I(R, s, i, a, o, r.getUint32(e + 24, !0), 3225465664, 9), o = I(R, o, s, i, a, r.getUint32(e + 44, !0), 643717713, 14), a = I(R, a, o, s, i, r.getUint32(e + 0, !0), 3921069994, 20), i = I(R, i, a, o, s, r.getUint32(e + 20, !0), 3593408605, 5), s = I(R, s, i, a, o, r.getUint32(e + 40, !0), 38016083, 9), o = I(R, o, s, i, a, r.getUint32(e + 60, !0), 3634488961, 14), a = I(R, a, o, s, i, r.getUint32(e + 16, !0), 3889429448, 20), i = I(R, i, a, o, s, r.getUint32(e + 36, !0), 568446438, 5), s = I(R, s, i, a, o, r.getUint32(e + 56, !0), 3275163606, 9), o = I(R, o, s, i, a, r.getUint32(e + 12, !0), 4107603335, 14), a = I(R, a, o, s, i, r.getUint32(e + 32, !0), 1163531501, 20), i = I(R, i, a, o, s, r.getUint32(e + 52, !0), 2850285829, 5), s = I(R, s, i, a, o, r.getUint32(e + 8, !0), 4243563512, 9), o = I(R, o, s, i, a, r.getUint32(e + 28, !0), 1735328473, 14), a = I(R, a, o, s, i, r.getUint32(e + 48, !0), 2368359562, 20), i = I(z, i, a, o, s, r.getUint32(e + 20, !0), 4294588738, 4), s = I(z, s, i, a, o, r.getUint32(e + 32, !0), 2272392833, 11), o = I(z, o, s, i, a, r.getUint32(e + 44, !0), 1839030562, 16), a = I(z, a, o, s, i, r.getUint32(e + 56, !0), 4259657740, 23), i = I(z, i, a, o, s, r.getUint32(e + 4, !0), 2763975236, 4), s = I(z, s, i, a, o, r.getUint32(e + 16, !0), 1272893353, 11), o = I(z, o, s, i, a, r.getUint32(e + 28, !0), 4139469664, 16), a = I(z, a, o, s, i, r.getUint32(e + 40, !0), 3200236656, 23), i = I(z, i, a, o, s, r.getUint32(e + 52, !0), 681279174, 4), s = I(z, s, i, a, o, r.getUint32(e + 0, !0), 3936430074, 11), o = I(z, o, s, i, a, r.getUint32(e + 12, !0), 3572445317, 16), a = I(z, a, o, s, i, r.getUint32(e + 24, !0), 76029189, 23), i = I(z, i, a, o, s, r.getUint32(e + 36, !0), 3654602809, 4), s = I(z, s, i, a, o, r.getUint32(e + 48, !0), 3873151461, 11), o = I(z, o, s, i, a, r.getUint32(e + 60, !0), 530742520, 16), a = I(z, a, o, s, i, r.getUint32(e + 8, !0), 3299628645, 23), i = I(B, i, a, o, s, r.getUint32(e + 0, !0), 4096336452, 6), s = I(B, s, i, a, o, r.getUint32(e + 28, !0), 1126891415, 10), o = I(B, o, s, i, a, r.getUint32(e + 56, !0), 2878612391, 15), a = I(B, a, o, s, i, r.getUint32(e + 20, !0), 4237533241, 21), i = I(B, i, a, o, s, r.getUint32(e + 48, !0), 1700485571, 6), s = I(B, s, i, a, o, r.getUint32(e + 12, !0), 2399980690, 10), o = I(B, o, s, i, a, r.getUint32(e + 40, !0), 4293915773, 15), a = I(B, a, o, s, i, r.getUint32(e + 4, !0), 2240044497, 21), i = I(B, i, a, o, s, r.getUint32(e + 32, !0), 1873313359, 6), s = I(B, s, i, a, o, r.getUint32(e + 60, !0), 4264355552, 10), o = I(B, o, s, i, a, r.getUint32(e + 24, !0), 2734768916, 15), a = I(B, a, o, s, i, r.getUint32(e + 52, !0), 1309151649, 21), i = I(B, i, a, o, s, r.getUint32(e + 16, !0), 4149444226, 6), s = I(B, s, i, a, o, r.getUint32(e + 44, !0), 3174756917, 10), o = I(B, o, s, i, a, r.getUint32(e + 8, !0), 718787259, 15), a = I(B, a, o, s, i, r.getUint32(e + 36, !0), 3951481745, 21), i = t + i | 0, a = n + a | 0, o = c + o | 0, s = l + s | 0;
	}
	let c = "";
	return c += V((i & 255) >>> 0), c += V((i & 65280) >>> 8), c += V((i & 16711680) >>> 16), c += V((i & 4278190080) >>> 24), c += V((a & 255) >>> 0), c += V((a & 65280) >>> 8), c += V((a & 16711680) >>> 16), c += V((a & 4278190080) >>> 24), c += V((o & 255) >>> 0), c += V((o & 65280) >>> 8), c += V((o & 16711680) >>> 16), c += V((o & 4278190080) >>> 24), c += V((s & 255) >>> 0), c += V((s & 65280) >>> 8), c += V((s & 16711680) >>> 16), c += V((s & 4278190080) >>> 24), c;
}, H = {
	NUL: 0,
	BEL: 7,
	APB: 8,
	APF: 9,
	APD: 10,
	APU: 11,
	CS: 12,
	APR: 13,
	LS1: 14,
	LS0: 15,
	PAPF: 22,
	CAN: 24,
	SS2: 25,
	ESC: 27,
	APS: 28,
	SS3: 29,
	RS: 30,
	US: 31,
	SP: 32,
	DEL: 127,
	BKF: 128,
	RDF: 129,
	GRF: 130,
	YLF: 131,
	BLF: 132,
	MGF: 133,
	CNF: 134,
	WHF: 135,
	SSZ: 136,
	MSZ: 137,
	NSZ: 138,
	SZX: 139,
	COL: 144,
	FLC: 145,
	CDC: 146,
	POL: 147,
	WMM: 148,
	MACRO: 149,
	HLC: 151,
	RPC: 152,
	SPL: 153,
	STL: 154,
	CSI: 155,
	TIME: 157
}, U = {
	GSM: 66,
	SWF: 83,
	CCC: 84,
	SDF: 86,
	SSM: 87,
	SHS: 88,
	SVS: 89,
	PLD: 91,
	PLU: 92,
	GAA: 93,
	SRC: 94,
	SDP: 95,
	ACPS: 97,
	TCC: 98,
	ORN: 99,
	MDF: 100,
	CFS: 101,
	XCS: 102,
	SCR: 103,
	PRA: 104,
	ACS: 105,
	UED: 106,
	RCS: 110,
	SCS: 111
}, st = (e) => {
	switch (e.readU8()) {
		case H.NUL: return c.from();
		case H.BEL: return l.from();
		case H.APB: return u.from();
		case H.APF: return d.from();
		case H.APD: return f.from();
		case H.APU: return p.from();
		case H.CS: return m.from();
		case H.APR: return h.from();
		case H.PAPF: return g.from(e.readU8() & 63);
		case H.CAN: return _.from();
		case H.APS: {
			let t = e.readU8() & 63, n = e.readU8() & 63;
			return v.from(n, t);
		}
		case H.RS: return ee.from();
		case H.US: return te.from();
		case H.SP: return ne.from();
		case H.DEL: return re.from();
		default: throw new N("Undefined C0 detected");
	}
}, ct = (e) => {
	switch (e.readU8()) {
		case H.BKF: return ie.from();
		case H.RDF: return y.from();
		case H.GRF: return ae.from();
		case H.YLF: return oe.from();
		case H.BLF: return se.from();
		case H.MGF: return ce.from();
		case H.CNF: return le.from();
		case H.WHF: return b.from();
		case H.SSZ: return ue.from();
		case H.MSZ: return x.from();
		case H.NSZ: return de.from();
		case H.SZX: {
			let t = e.readU8();
			switch (t) {
				case 96:
				case 65:
				case 68:
				case 69:
				case 107:
				case 100: return fe.from(t);
			}
			throw new N("Undefined SZX");
		}
		case H.COL: {
			let t = e.readU8(), n = t & 15;
			switch (t & 112) {
				case 32: return he.from(e.readU8() & 15);
				case 64: return C.from(n);
				case 80: return pe.from(n);
				case 96: return me.from(n);
				case 112: return w.from(n);
			}
			throw new N("Undefined COL");
		}
		case H.FLC: {
			let t = e.readU8();
			switch (t) {
				case 64:
				case 71:
				case 79: return ge.from(t);
			}
			throw new N("Undefined FLC");
		}
		case H.CDC: {
			let t = e.readU8();
			if (t === 32) {
				let t = e.readU8();
				switch (t) {
					case 64:
					case 65:
					case 66:
					case 67:
					case 68:
					case 69:
					case 70:
					case 71:
					case 72:
					case 73:
					case 74: return be.from(t);
				}
			} else if (t === D.START) return ve.from(t);
			else if (t === E.STOP) return _e.from(t);
			throw new N("Undefined CDC");
		}
		case H.POL: {
			let t = e.readU8();
			switch (t) {
				case 64:
				case 65:
				case 66: return xe.from(t);
			}
			throw new N("Undefined POL");
		}
		case H.WMM: {
			let t = e.readU8();
			switch (t) {
				case 64:
				case 68:
				case 69: return k.from(t);
			}
			throw new N("Undefined WMM");
		}
		case H.MACRO: throw new A("MACRO is Not Implemeted!");
		case H.HLC: {
			let t = e.readU8() & 15;
			return Ce.from(t);
		}
		case H.RPC: {
			let t = e.readU8() & 63;
			return we.from(t);
		}
		case H.SPL: return Ee.from();
		case H.STL: return Te.from();
		case H.CSI: {
			let t = [0], n = 0;
			for (; !e.isEmpty();) {
				let r = e.readU8();
				if (r === 32 || r == 59) {
					t.push(0);
					continue;
				} else if (r & 64) {
					n = r;
					break;
				}
				t[t.length - 1] *= 10, t[t.length - 1] += r & 15;
			}
			switch (n) {
				case U.GSM: throw new A("GSM is Not Implemented!");
				case U.SWF: return Ae.from(t[0]);
				case U.CCC: throw new A("CCC is Not Implemented!");
				case U.SDF: return je.from(t[0], t[1]);
				case U.SSM: return Ne.from(t[0], t[1]);
				case U.SHS: return Pe.from(t[0]);
				case U.SVS: return Fe.from(t[0]);
				case U.PLD: throw new A("PLD is Not Implemented!");
				case U.PLU: throw new A("PLU is Not Implemented!");
				case U.GAA: throw new A("GAA is Not Implemented!");
				case U.SRC: throw new A("SRC is Not Implemented!");
				case U.SDP: return Me.from(t[0], t[1]);
				case U.ACPS: return Ie.from(t[0], t[1]);
				case U.TCC: throw new A("TCC is Not Implemented!");
				case U.ORN:
					switch (t[0]) {
						case Le.NONE: return Re.from();
						case Le.HEMMING: return ze.from(t[1]);
						case Le.SHADE: return Be.from(t[1]);
						case Le.HOLLOW: return Ve.from();
					}
					throw new N("Undefined ORN");
				case U.MDF: throw new A("MDF is Not Implemented!");
				case U.CFS: throw new A("CFS is Not Implemented!");
				case U.XCS: throw new A("XCS is Not Implemented!");
				case U.SCR: throw new A("SCR is Not Implemented!");
				case U.PRA: return He.from(t[0]);
				case U.ACS: throw new A("ACS is Not Implemented!");
				case U.UED: throw new A("UED is Not Implemented!");
				case U.RCS: return Ue.from(t[0]);
				case U.SCS: throw new A("SCS is Not Implemented!");
				default: throw new N(`Unhandled CSI Code in STD-B24 ARIB Caption (0x${n.toString(16)})`);
			}
		}
		case H.TIME: switch (e.readU8()) {
			case 32: {
				let t = (e.readU8() & 63) / 10;
				return De.from(t);
			}
			case 40: {
				let t = e.readU8();
				switch (t) {
					case 64:
					case 65:
					case 66:
					case 67: return ke.from(t);
				}
				throw new N("Undefined TIME");
			}
			case 41: throw new Ge("TIME 0x29 (Specify Time) is Not Used by Specification");
			default: throw new N("Undefined TIME");
		}
		default: throw new N("Undefined C1/CSI");
	}
}, lt = class {
	tokenize(e) {
		return this.tokenizeDataUnits(e.units);
	}
	tokenizeDataUnits(e) {
		let t = [];
		for (let n of e) switch (n.tag) {
			case "Statement":
				t.push(...this.tokenizeStatement(n.data));
				break;
			case "DRCS":
				this.processDRCS(n.bytes, n.data);
				break;
			case "Bitmap":
				t.push(...this.tokenizeBitmap(n.data));
				break;
			default: throw new M(n, "Unexpected DataUnit in STD-B24 ARIB Caption");
		}
		return t;
	}
	tokenizeBitmap(e) {
		let t = 0, n = (e[t] << 8 | e[t + 1]) << 16 >> 16;
		t += 2;
		let r = (e[t] << 8 | e[t + 1]) << 16 >> 16;
		t += 2;
		let i = e[t];
		t += 1;
		let a = Array.from(e.subarray(t, t + i));
		return t += i, t + 33 > e.byteLength ? [] : [s.from(n, r, a, e.slice(t).buffer)];
	}
}, ut = (e, t) => e.map((e) => {
	if (e.tag !== "DRCS") return e;
	let n = ot(e.binary);
	return t.has(n.toLowerCase()) || t.has(n.toUpperCase()) ? i.from(t.get(n) + e.combining) : e;
}), W = {
	LS2: 110,
	LS3: 111,
	LS1R: 126,
	LS2R: 125,
	LS3R: 124
}, dt = class extends lt {
	GL;
	GR;
	GB;
	character_dicts;
	drcs_dicts;
	non_spacing;
	constructor(e, t, n, r, i, a) {
		super(), this.GL = e, this.GR = t, this.GB = n, this.character_dicts = r, this.drcs_dicts = structuredClone(i), this.non_spacing = a;
	}
	tokenizeStatement(e) {
		let t = new it(e), n = [];
		for (; !t.isEmpty();) {
			if (32 < t.peekU8() && t.peekU8() < 127) {
				let e = 0;
				for (let n = 0; n < this.GB[this.GL].bytes; n++) e <<= 8, e |= t.readU8() & 127;
				let { type: r, dict: a } = this.GB[this.GL];
				switch (r) {
					case "Character":
						if (a.has(e)) {
							let t = a.get(e), r = this.non_spacing.has(t);
							n.push(i.from(t, r));
						}
						break;
					case "DRCS":
						if (a.has(e)) {
							let { width: t, height: r, depth: i, binary: s } = a.get(e);
							n.push(o.from(t, r, i, s));
						}
						break;
					case "MACRO":
						a.has(e) && n.push(...this.tokenizeStatement(a.get(e)));
						break;
					default: throw new M(r, "Undefined Dict Type in STD-B24 ARIB Caption");
				}
				continue;
			} else if (160 < t.peekU8() && t.peekU8() < 255) {
				let e = 0;
				for (let n = 0; n < this.GB[this.GR].bytes; n++) e <<= 8, e |= t.readU8() & 127;
				let { type: r, dict: a } = this.GB[this.GR];
				switch (r) {
					case "Character":
						if (a.has(e)) {
							let t = a.get(e), r = this.non_spacing.has(t);
							n.push(i.from(t, r));
						}
						break;
					case "DRCS":
						if (a.has(e)) {
							let { width: t, height: r, depth: i, binary: s } = a.get(e);
							n.push(o.from(t, r, i, s));
						}
						break;
					case "MACRO":
						a.has(e) && n.push(...this.tokenizeStatement(a.get(e)));
						break;
					default: throw new M(r, "Undefined Dict Type in STD-B24 ARIB Caption");
				}
				continue;
			}
			let e = t.peekU8();
			switch (e) {
				case H.LS1:
					t.readU8(), this.GL = 1;
					break;
				case H.LS0:
					t.readU8(), this.GL = 0;
					break;
				case H.SS2: {
					t.readU8();
					let e = 0;
					for (let n = 0; n < this.GB[2].bytes; n++) e <<= 8, e |= t.readU8() & 127;
					let { type: r, dict: a } = this.GB[2];
					switch (r) {
						case "Character":
							if (a.has(e)) {
								let t = a.get(e), r = this.non_spacing.has(t);
								n.push(i.from(t, r));
							}
							break;
						case "DRCS":
							if (a.has(e)) {
								let { width: t, height: r, depth: i, binary: s } = a.get(e);
								n.push(o.from(t, r, i, s));
							}
							break;
						case "MACRO":
							a.has(e) && n.push(...this.tokenizeStatement(a.get(e)));
							break;
						default: throw new M(r, "Undefined Dict Type in STD-B24 ARIB Caption");
					}
					break;
				}
				case H.ESC: {
					t.readU8();
					let e = t.readU8();
					switch (e) {
						case W.LS2:
							this.GL = 2;
							break;
						case W.LS3:
							this.GL = 3;
							break;
						case W.LS1R:
							this.GR = 1;
							break;
						case W.LS2R:
							this.GR = 2;
							break;
						case W.LS3R:
							this.GR = 3;
							break;
						case 36: {
							let e = t.readU8();
							if (40 <= e && e <= 43) {
								let n = t.readU8();
								if (n === 32) {
									let n = t.readU8();
									this.GB[e - 40] = Object.values(this.drcs_dicts).find(({ code: e }) => e === n);
								} else this.GB[e - 40] = Object.values(this.character_dicts).find(({ code: e }) => e === n);
							} else this.GB[0] = Object.values(this.character_dicts).find(({ code: t }) => t === e);
							break;
						}
						default:
							if (40 <= e && e <= 43) {
								let n = t.readU8();
								if (n === 32) {
									let n = t.readU8();
									this.GB[e - 40] = Object.values(this.drcs_dicts).find(({ code: e }) => e === n);
								} else this.GB[e - 40] = Object.values(this.character_dicts).find(({ code: e }) => e === n);
							} else throw Error(`Undefined ESC Code in STD-B24 ARIB Caption (0x${e.toString(16)})`);
							break;
					}
					break;
				}
				case H.SS3: {
					t.readU8();
					let e = 0;
					for (let n = 0; n < this.GB[3].bytes; n++) e <<= 8, e |= t.readU8() & 127;
					let { type: r, dict: a } = this.GB[3];
					switch (r) {
						case "Character":
							if (a.has(e)) {
								let t = a.get(e), r = this.non_spacing.has(t);
								n.push(i.from(t, r));
							}
							break;
						case "DRCS":
							if (a.has(e)) {
								let { width: t, height: r, depth: i, binary: s } = a.get(e);
								n.push(o.from(t, r, i, s));
							}
							break;
						case "MACRO":
							a.has(e) && n.push(...this.tokenizeStatement(a.get(e)));
							break;
						default: throw new M(r, "Undefined Dict Type in STD-B24 ARIB Caption");
					}
					break;
				}
				default: if (0 <= e && e <= 32 || e === H.DEL) n.push(st(t));
				else if (128 <= e && e <= 159) n.push(ct(t));
				else throw new N("Undefined Conrtol Code in STD-B24 ARIB Caption");
			}
		}
		return n;
	}
	processDRCS(e, t) {
		let n = 0, r = t.byteLength;
		for (t[n + 0], n += 1; n < r;) {
			let r = t[n + 0] << 8 | t[n + 1], i = t[n + 2];
			n += 3;
			for (let a = 0; a < i; a++) {
				(t[n + 0] & 240) >> 4;
				let i = t[n + 0] & 15;
				if (i === 0 || i === 1) {
					let i = t[n + 1] + 2, a = t[n + 2], s = t[n + 3], c = [
						0,
						1,
						6,
						2,
						7,
						5,
						4,
						3
					][i * 29 >> 5], l = Math.floor(a * s * c / 8), u = t.slice(n + 4, n + 4 + l).buffer;
					if (e === 1) {
						let e = (r & 65280) >> 8, t = r & 127, n = Object.values(this.drcs_dicts).find((t) => t.code === e);
						if (n == null || n.type !== "DRCS") continue;
						n.dict.set(t, o.from(a, s, c, u));
					} else {
						let e = r & 32639, t = Object.values(this.drcs_dicts).find((e) => e.code === 64);
						if (t == null || t.type !== "DRCS") continue;
						t.dict.set(e, o.from(a, s, c, u));
					}
					n += 4 + l;
				} else return;
			}
		}
	}
}, ft = new Map([
	[33, "ぁ"],
	[34, "あ"],
	[35, "ぃ"],
	[36, "い"],
	[37, "ぅ"],
	[38, "う"],
	[39, "ぇ"],
	[40, "え"],
	[41, "ぉ"],
	[42, "お"],
	[43, "か"],
	[44, "が"],
	[45, "き"],
	[46, "ぎ"],
	[47, "く"],
	[48, "ぐ"],
	[49, "け"],
	[50, "げ"],
	[51, "こ"],
	[52, "ご"],
	[53, "さ"],
	[54, "ざ"],
	[55, "し"],
	[56, "じ"],
	[57, "す"],
	[58, "ず"],
	[59, "せ"],
	[60, "ぜ"],
	[61, "そ"],
	[62, "ぞ"],
	[63, "た"],
	[64, "だ"],
	[65, "ち"],
	[66, "ぢ"],
	[67, "っ"],
	[68, "つ"],
	[69, "づ"],
	[70, "て"],
	[71, "で"],
	[72, "と"],
	[73, "ど"],
	[74, "な"],
	[75, "に"],
	[76, "ぬ"],
	[77, "ね"],
	[78, "の"],
	[79, "は"],
	[80, "ば"],
	[81, "ぱ"],
	[82, "ひ"],
	[83, "び"],
	[84, "ぴ"],
	[85, "ふ"],
	[86, "ぶ"],
	[87, "ぷ"],
	[88, "へ"],
	[89, "べ"],
	[90, "ぺ"],
	[91, "ほ"],
	[92, "ぼ"],
	[93, "ぽ"],
	[94, "ま"],
	[95, "み"],
	[96, "む"],
	[97, "め"],
	[98, "も"],
	[99, "ゃ"],
	[100, "や"],
	[101, "ゅ"],
	[102, "ゆ"],
	[103, "ょ"],
	[104, "よ"],
	[105, "ら"],
	[106, "り"],
	[107, "る"],
	[108, "れ"],
	[109, "ろ"],
	[110, "ゎ"],
	[111, "わ"],
	[112, "ゐ"],
	[113, "ゑ"],
	[114, "を"],
	[115, "ん"],
	[119, "ゝ"],
	[120, "ゞ"],
	[121, "ー"],
	[122, "。"],
	[123, "「"],
	[124, "」"],
	[125, "、"],
	[126, "・"]
]), pt = new Map([
	[33, "ァ"],
	[34, "ア"],
	[35, "ィ"],
	[36, "イ"],
	[37, "ゥ"],
	[38, "ウ"],
	[39, "ェ"],
	[40, "エ"],
	[41, "ォ"],
	[42, "オ"],
	[43, "カ"],
	[44, "ガ"],
	[45, "キ"],
	[46, "ギ"],
	[47, "ク"],
	[48, "グ"],
	[49, "ケ"],
	[50, "ゲ"],
	[51, "コ"],
	[52, "ゴ"],
	[53, "サ"],
	[54, "ザ"],
	[55, "シ"],
	[56, "ジ"],
	[57, "ス"],
	[58, "ズ"],
	[59, "セ"],
	[60, "ゼ"],
	[61, "ソ"],
	[62, "ゾ"],
	[63, "タ"],
	[64, "ダ"],
	[65, "チ"],
	[66, "ヂ"],
	[67, "ッ"],
	[68, "ツ"],
	[69, "ヅ"],
	[70, "テ"],
	[71, "デ"],
	[72, "ト"],
	[73, "ド"],
	[74, "ナ"],
	[75, "ニ"],
	[76, "ヌ"],
	[77, "ネ"],
	[78, "ノ"],
	[79, "ハ"],
	[80, "バ"],
	[81, "パ"],
	[82, "ヒ"],
	[83, "ビ"],
	[84, "ピ"],
	[85, "フ"],
	[86, "ブ"],
	[87, "プ"],
	[88, "ヘ"],
	[89, "ベ"],
	[90, "ペ"],
	[91, "ホ"],
	[92, "ボ"],
	[93, "ポ"],
	[94, "マ"],
	[95, "ミ"],
	[96, "ム"],
	[97, "メ"],
	[98, "モ"],
	[99, "ャ"],
	[100, "ヤ"],
	[101, "ュ"],
	[102, "ユ"],
	[103, "ョ"],
	[104, "ヨ"],
	[105, "ラ"],
	[106, "リ"],
	[107, "ル"],
	[108, "レ"],
	[109, "ロ"],
	[110, "ヮ"],
	[111, "ワ"],
	[112, "ヰ"],
	[113, "ヱ"],
	[114, "ヲ"],
	[115, "ン"],
	[116, "ヴ"],
	[117, "ヵ"],
	[118, "ヶ"],
	[119, "ヽ"],
	[120, "ヾ"],
	[121, "ー"],
	[122, "。"],
	[123, "「"],
	[124, "」"],
	[125, "、"],
	[126, "・"]
]), mt = new Map([
	[29985, "㐂"],
	[29986, "𠅘"],
	[29987, "份"],
	[29988, "仿"],
	[29989, "侚"],
	[29990, "俉"],
	[29991, "傜"],
	[29992, "儞"],
	[29993, "冼"],
	[29994, "㔟"],
	[29995, "匇"],
	[29996, "卡"],
	[29997, "卬"],
	[29998, "詹"],
	[29999, "𠮷"],
	[3e4, "呍"],
	[30001, "咖"],
	[30002, "咜"],
	[30003, "咩"],
	[30004, "唎"],
	[30005, "啊"],
	[30006, "噲"],
	[30007, "囤"],
	[30008, "圳"],
	[30009, "圴"],
	[30010, "塚"],
	[30011, "墀"],
	[30012, "姤"],
	[30013, "娣"],
	[30014, "婕"],
	[30015, "寬"],
	[30016, "﨑"],
	[30017, "㟢"],
	[30018, "庬"],
	[30019, "弴"],
	[30020, "彅"],
	[30021, "德"],
	[30022, "怗"],
	[30023, "恵"],
	[30024, "愰"],
	[30025, "昤"],
	[30026, "曈"],
	[30027, "曙"],
	[30028, "曺"],
	[30029, "曻"],
	[30030, "桒"],
	[30031, "鿄"],
	[30032, "椑"],
	[30033, "椻"],
	[30034, "橅"],
	[30035, "檑"],
	[30036, "櫛"],
	[30037, "𣏌"],
	[30038, "𣏾"],
	[30039, "𣗄"],
	[30040, "毱"],
	[30041, "泠"],
	[30042, "洮"],
	[30043, "海"],
	[30044, "涿"],
	[30045, "淊"],
	[30046, "淸"],
	[30047, "渚"],
	[30048, "潞"],
	[30049, "濹"],
	[30050, "灤"],
	[30051, "𤋮"],
	[30052, "𤋮"],
	[30053, "煇"],
	[30054, "燁"],
	[30055, "爀"],
	[30056, "玟"],
	[30057, "玨"],
	[30058, "珉"],
	[30059, "珖"],
	[30060, "琛"],
	[30061, "琡"],
	[30062, "琢"],
	[30063, "琦"],
	[30064, "琪"],
	[30065, "琬"],
	[30066, "琹"],
	[30067, "瑋"],
	[30068, "㻚"],
	[30069, "畵"],
	[30070, "疁"],
	[30071, "睲"],
	[30072, "䂓"],
	[30073, "磈"],
	[30074, "磠"],
	[30075, "祇"],
	[30076, "禮"],
	[30077, "鿆"],
	[30078, "䄃"],
	[30241, "鿅"],
	[30242, "秚"],
	[30243, "稞"],
	[30244, "筿"],
	[30245, "簱"],
	[30246, "䉤"],
	[30247, "綋"],
	[30248, "羡"],
	[30249, "脘"],
	[30250, "脺"],
	[30251, "舘"],
	[30252, "芮"],
	[30253, "葛"],
	[30254, "蓜"],
	[30255, "蓬"],
	[30256, "蕙"],
	[30257, "藎"],
	[30258, "蝕"],
	[30259, "蟬"],
	[30260, "蠋"],
	[30261, "裵"],
	[30262, "角"],
	[30263, "諶"],
	[30264, "跎"],
	[30265, "辻"],
	[30266, "迶"],
	[30267, "郝"],
	[30268, "鄧"],
	[30269, "鄭"],
	[30270, "醲"],
	[30271, "鈳"],
	[30272, "銈"],
	[30273, "錡"],
	[30274, "鍈"],
	[30275, "閒"],
	[30276, "雞"],
	[30277, "餃"],
	[30278, "饀"],
	[30279, "髙"],
	[30280, "鯖"],
	[30281, "鷗"],
	[30282, "麴"],
	[30283, "麵"],
	[31265, "⛌"],
	[31266, "⛍"],
	[31267, "❗"],
	[31268, "⛏"],
	[31269, "⛐"],
	[31270, "⛑"],
	[31272, "⛒"],
	[31273, "⛕"],
	[31274, "⛓"],
	[31275, "⛔"],
	[31280, ""],
	[31281, ""],
	[31284, "⛖"],
	[31285, "⛗"],
	[31286, "⛘"],
	[31287, "⛙"],
	[31288, "⛚"],
	[31289, "⛛"],
	[31290, "⛜"],
	[31291, "⛝"],
	[31292, "⛞"],
	[31293, "⛟"],
	[31294, "⛠"],
	[31295, "⛡"],
	[31296, "⭕"],
	[31297, "㉈"],
	[31298, "㉉"],
	[31299, "㉊"],
	[31300, "㉋"],
	[31301, "㉌"],
	[31302, "㉍"],
	[31303, "㉎"],
	[31304, "㉏"],
	[31309, "⒑"],
	[31310, "⒒"],
	[31311, "⒓"],
	[31312, ""],
	[31313, ""],
	[31314, ""],
	[31315, ""],
	[31316, ""],
	[31317, ""],
	[31318, ""],
	[31319, ""],
	[31320, ""],
	[31321, ""],
	[31322, ""],
	[31323, ""],
	[31324, ""],
	[31325, ""],
	[31326, ""],
	[31327, ""],
	[31328, "⬛"],
	[31329, "⬤"],
	[31330, ""],
	[31331, ""],
	[31332, ""],
	[31333, ""],
	[31334, ""],
	[31335, "⚿"],
	[31336, ""],
	[31337, ""],
	[31338, ""],
	[31339, ""],
	[31340, ""],
	[31341, ""],
	[31342, ""],
	[31343, ""],
	[31344, ""],
	[31345, ""],
	[31346, ""],
	[31347, "㊙"],
	[31348, ""],
	[31521, "⛣"],
	[31522, "⭖"],
	[31523, "⭗"],
	[31524, "⭘"],
	[31525, "⭙"],
	[31526, "☓"],
	[31527, "㊋"],
	[31528, "〒"],
	[31529, "⛨"],
	[31530, "㉆"],
	[31531, "㉅"],
	[31532, "⛩"],
	[31533, "࿖"],
	[31534, "⛪"],
	[31535, "⛫"],
	[31536, "⛬"],
	[31537, "♨"],
	[31538, "⛭"],
	[31539, "⛮"],
	[31540, "⛯"],
	[31541, "⚓"],
	[31542, "✈"],
	[31543, "⛰"],
	[31544, "⛱"],
	[31545, "⛲"],
	[31546, "⛳"],
	[31547, "⛴"],
	[31548, "⛵"],
	[31549, ""],
	[31550, "Ⓓ"],
	[31551, "Ⓢ"],
	[31552, "⛶"],
	[31553, ""],
	[31554, ""],
	[31555, ""],
	[31556, ""],
	[31557, ""],
	[31558, "⛷"],
	[31559, "⛸"],
	[31560, "⛹"],
	[31561, "⛺"],
	[31562, ""],
	[31563, "☎"],
	[31564, "⛻"],
	[31565, "⛼"],
	[31566, "⛽"],
	[31567, "⛾"],
	[31568, ""],
	[31569, "⛿"],
	[31777, "➡"],
	[31778, "⬅"],
	[31779, "⬆"],
	[31780, "⬇"],
	[31781, "⬯"],
	[31782, "⬮"],
	[31783, "年"],
	[31784, "月"],
	[31785, "日"],
	[31786, "円"],
	[31787, "㎡"],
	[31788, "㎥"],
	[31789, "㎝"],
	[31790, "㎠"],
	[31791, "㎤"],
	[31792, ""],
	[31793, "⒈"],
	[31794, "⒉"],
	[31795, "⒊"],
	[31796, "⒋"],
	[31797, "⒌"],
	[31798, "⒍"],
	[31799, "⒎"],
	[31800, "⒏"],
	[31801, "⒐"],
	[31802, ""],
	[31803, ""],
	[31804, ""],
	[31805, ""],
	[31806, ""],
	[31807, ""],
	[31808, ""],
	[31809, ""],
	[31810, ""],
	[31811, ""],
	[31812, ""],
	[31813, ""],
	[31814, ""],
	[31815, ""],
	[31816, ""],
	[31817, ""],
	[31818, "㈳"],
	[31819, "㈶"],
	[31820, "㈲"],
	[31821, "㈱"],
	[31822, "㈹"],
	[31823, "㉄"],
	[31824, "▶"],
	[31825, "◀"],
	[31826, "〖"],
	[31827, "〗"],
	[31828, "⟐"],
	[31829, "²"],
	[31830, "³"],
	[31831, ""],
	[31832, ""],
	[31833, ""],
	[31834, ""],
	[31835, ""],
	[31836, ""],
	[31837, ""],
	[31838, ""],
	[31839, ""],
	[31840, ""],
	[31841, ""],
	[31842, ""],
	[31843, ""],
	[31844, ""],
	[31845, ""],
	[31846, ""],
	[31847, ""],
	[31848, ""],
	[31849, ""],
	[31850, ""],
	[31851, ""],
	[31852, ""],
	[31853, ""],
	[31854, ""],
	[31855, ""],
	[31856, ""],
	[31857, ""],
	[31858, ""],
	[31859, ""],
	[31860, ""],
	[31861, ""],
	[31862, ""],
	[31863, ""],
	[31864, "㉇"],
	[31865, ""],
	[31866, ""],
	[31867, "℻"],
	[32033, "㈪"],
	[32034, "㈫"],
	[32035, "㈬"],
	[32036, "㈭"],
	[32037, "㈮"],
	[32038, "㈯"],
	[32039, "㈰"],
	[32040, "㈷"],
	[32041, "㍾"],
	[32042, "㍽"],
	[32043, "㍼"],
	[32044, "㍻"],
	[32045, "№"],
	[32046, "℡"],
	[32047, "〶"],
	[32048, "⚾"],
	[32049, ""],
	[32050, ""],
	[32051, ""],
	[32052, ""],
	[32053, ""],
	[32054, ""],
	[32055, ""],
	[32056, ""],
	[32057, ""],
	[32058, ""],
	[32059, ""],
	[32060, ""],
	[32061, ""],
	[32062, ""],
	[32063, ""],
	[32064, ""],
	[32065, ""],
	[32066, ""],
	[32067, ""],
	[32068, ""],
	[32069, ""],
	[32070, ""],
	[32071, "ℓ"],
	[32072, "㎏"],
	[32073, "㎐"],
	[32074, "㏊"],
	[32075, "㎞"],
	[32076, "㎢"],
	[32077, "㍱"],
	[32080, "½"],
	[32081, "↉"],
	[32082, "⅓"],
	[32083, "⅔"],
	[32084, "¼"],
	[32085, "¾"],
	[32086, "⅕"],
	[32087, "⅖"],
	[32088, "⅗"],
	[32089, "⅘"],
	[32090, "⅙"],
	[32091, "⅚"],
	[32092, "⅐"],
	[32093, "⅛"],
	[32094, "⅑"],
	[32095, "⅒"],
	[32096, "☀"],
	[32097, "☁"],
	[32098, "☂"],
	[32099, "⛄"],
	[32100, "☖"],
	[32101, "☗"],
	[32102, "⛉"],
	[32103, "⛊"],
	[32104, "♦"],
	[32105, "♥"],
	[32106, "♣"],
	[32107, "♠"],
	[32108, "⛋"],
	[32109, "⨀"],
	[32110, "‼"],
	[32111, "⁉"],
	[32112, "⛅"],
	[32113, "☔"],
	[32114, "⛆"],
	[32115, "☃"],
	[32116, "⛇"],
	[32117, "⚡"],
	[32118, "⛈"],
	[32120, "⚞"],
	[32121, "⚟"],
	[32122, "♬"],
	[32123, "☎"],
	[32289, "Ⅰ"],
	[32290, "Ⅱ"],
	[32291, "Ⅲ"],
	[32292, "Ⅳ"],
	[32293, "Ⅴ"],
	[32294, "Ⅵ"],
	[32295, "Ⅶ"],
	[32296, "Ⅷ"],
	[32297, "Ⅸ"],
	[32298, "Ⅹ"],
	[32299, "Ⅺ"],
	[32300, "Ⅻ"],
	[32301, "⑰"],
	[32302, "⑱"],
	[32303, "⑲"],
	[32304, "⑳"],
	[32305, "⑴"],
	[32306, "⑵"],
	[32307, "⑶"],
	[32308, "⑷"],
	[32309, "⑸"],
	[32310, "⑹"],
	[32311, "⑺"],
	[32312, "⑻"],
	[32313, "⑼"],
	[32314, "⑽"],
	[32315, "⑾"],
	[32316, "⑿"],
	[32317, "㉑"],
	[32318, "㉒"],
	[32319, "㉓"],
	[32320, "㉔"],
	[32321, ""],
	[32322, ""],
	[32323, ""],
	[32324, ""],
	[32325, ""],
	[32326, ""],
	[32327, ""],
	[32328, ""],
	[32329, ""],
	[32330, ""],
	[32331, ""],
	[32332, ""],
	[32333, ""],
	[32334, ""],
	[32335, ""],
	[32336, ""],
	[32337, ""],
	[32338, ""],
	[32339, ""],
	[32340, ""],
	[32341, ""],
	[32342, ""],
	[32343, ""],
	[32344, ""],
	[32345, ""],
	[32346, ""],
	[32347, "㉕"],
	[32348, "㉖"],
	[32349, "㉗"],
	[32350, "㉘"],
	[32351, "㉙"],
	[32352, "㉚"],
	[32353, "①"],
	[32354, "②"],
	[32355, "③"],
	[32356, "④"],
	[32357, "⑤"],
	[32358, "⑥"],
	[32359, "⑦"],
	[32360, "⑧"],
	[32361, "⑨"],
	[32362, "⑩"],
	[32363, "⑪"],
	[32364, "⑫"],
	[32365, "⑬"],
	[32366, "⑭"],
	[32367, "⑮"],
	[32368, "⑯"],
	[32369, "❶"],
	[32370, "❷"],
	[32371, "❸"],
	[32372, "❹"],
	[32373, "❺"],
	[32374, "❻"],
	[32375, "❼"],
	[32376, "❽"],
	[32377, "❾"],
	[32378, "❿"],
	[32379, "⓫"],
	[32380, "⓬"],
	[32381, "㉛"]
]), ht = new Map([
	[29985, "㐂"],
	[29986, "𠅘"],
	[29987, "份"],
	[29988, "仿"],
	[29989, "侚"],
	[29990, "俉"],
	[29991, "傜"],
	[29992, "儞"],
	[29993, "冼"],
	[29994, "㔟"],
	[29995, "匇"],
	[29996, "卡"],
	[29997, "卬"],
	[29998, "詹"],
	[29999, "𠮷"],
	[3e4, "呍"],
	[30001, "咖"],
	[30002, "咜"],
	[30003, "咩"],
	[30004, "唎"],
	[30005, "啊"],
	[30006, "噲"],
	[30007, "囤"],
	[30008, "圳"],
	[30009, "圴"],
	[30010, "塚"],
	[30011, "墀"],
	[30012, "姤"],
	[30013, "娣"],
	[30014, "婕"],
	[30015, "寬"],
	[30016, "﨑"],
	[30017, "㟢"],
	[30018, "庬"],
	[30019, "弴"],
	[30020, "彅"],
	[30021, "德"],
	[30022, "怗"],
	[30023, "恵"],
	[30024, "愰"],
	[30025, "昤"],
	[30026, "曈"],
	[30027, "曙"],
	[30028, "曺"],
	[30029, "曻"],
	[30030, "桒"],
	[30031, "鿄"],
	[30032, "椑"],
	[30033, "椻"],
	[30034, "橅"],
	[30035, "檑"],
	[30036, "櫛"],
	[30037, "𣏌"],
	[30038, "𣏾"],
	[30039, "𣗄"],
	[30040, "毱"],
	[30041, "泠"],
	[30042, "洮"],
	[30043, "海"],
	[30044, "涿"],
	[30045, "淊"],
	[30046, "淸"],
	[30047, "渚"],
	[30048, "潞"],
	[30049, "濹"],
	[30050, "灤"],
	[30051, "𤋮"],
	[30052, "𤋮"],
	[30053, "煇"],
	[30054, "燁"],
	[30055, "爀"],
	[30056, "玟"],
	[30057, "玨"],
	[30058, "珉"],
	[30059, "珖"],
	[30060, "琛"],
	[30061, "琡"],
	[30062, "琢"],
	[30063, "琦"],
	[30064, "琪"],
	[30065, "琬"],
	[30066, "琹"],
	[30067, "瑋"],
	[30068, "㻚"],
	[30069, "畵"],
	[30070, "疁"],
	[30071, "睲"],
	[30072, "䂓"],
	[30073, "磈"],
	[30074, "磠"],
	[30075, "祇"],
	[30076, "禮"],
	[30077, "鿆"],
	[30078, "䄃"],
	[30241, "鿅"],
	[30242, "秚"],
	[30243, "稞"],
	[30244, "筿"],
	[30245, "簱"],
	[30246, "䉤"],
	[30247, "綋"],
	[30248, "羡"],
	[30249, "脘"],
	[30250, "脺"],
	[30251, "舘"],
	[30252, "芮"],
	[30253, "葛"],
	[30254, "蓜"],
	[30255, "蓬"],
	[30256, "蕙"],
	[30257, "藎"],
	[30258, "蝕"],
	[30259, "蟬"],
	[30260, "蠋"],
	[30261, "裵"],
	[30262, "角"],
	[30263, "諶"],
	[30264, "跎"],
	[30265, "辻"],
	[30266, "迶"],
	[30267, "郝"],
	[30268, "鄧"],
	[30269, "鄭"],
	[30270, "醲"],
	[30271, "鈳"],
	[30272, "銈"],
	[30273, "錡"],
	[30274, "鍈"],
	[30275, "閒"],
	[30276, "雞"],
	[30277, "餃"],
	[30278, "饀"],
	[30279, "髙"],
	[30280, "鯖"],
	[30281, "鷗"],
	[30282, "麴"],
	[30283, "麵"],
	[31265, "⛌"],
	[31266, "⛍"],
	[31267, "❗"],
	[31268, "⛏"],
	[31269, "⛐"],
	[31270, "⛑"],
	[31272, "⛒"],
	[31273, "⛕"],
	[31274, "⛓"],
	[31275, "⛔"],
	[31280, "🅿"],
	[31281, "🆊"],
	[31284, "⛖"],
	[31285, "⛗"],
	[31286, "⛘"],
	[31287, "⛙"],
	[31288, "⛚"],
	[31289, "⛛"],
	[31290, "⛜"],
	[31291, "⛝"],
	[31292, "⛞"],
	[31293, "⛟"],
	[31294, "⛠"],
	[31295, "⛡"],
	[31296, "⭕"],
	[31297, "㉈"],
	[31298, "㉉"],
	[31299, "㉊"],
	[31300, "㉋"],
	[31301, "㉌"],
	[31302, "㉍"],
	[31303, "㉎"],
	[31304, "㉏"],
	[31309, "⒑"],
	[31310, "⒒"],
	[31311, "⒓"],
	[31312, "🅊"],
	[31313, "🅌"],
	[31314, "🄿"],
	[31315, "🅆"],
	[31316, "🅋"],
	[31317, "🈐"],
	[31318, "🈑"],
	[31319, "🈒"],
	[31320, "🈓"],
	[31321, "🅂"],
	[31322, "🈔"],
	[31323, "🈕"],
	[31324, "🈖"],
	[31325, "🅍"],
	[31326, "🄱"],
	[31327, "🄽"],
	[31328, "⬛"],
	[31329, "⬤"],
	[31330, "🈗"],
	[31331, "🈘"],
	[31332, "🈙"],
	[31333, "🈚"],
	[31334, "🈛"],
	[31335, "⚿"],
	[31336, "🈜"],
	[31337, "🈝"],
	[31338, "🈞"],
	[31339, "🈟"],
	[31340, "🈠"],
	[31341, "🈡"],
	[31342, "🈢"],
	[31343, "🈣"],
	[31344, "🈤"],
	[31345, "🈥"],
	[31346, "🅎"],
	[31347, "㊙"],
	[31348, "🈀"],
	[31521, "⛣"],
	[31522, "⭖"],
	[31523, "⭗"],
	[31524, "⭘"],
	[31525, "⭙"],
	[31526, "☓"],
	[31527, "㊋"],
	[31528, "〒"],
	[31529, "⛨"],
	[31530, "㉆"],
	[31531, "㉅"],
	[31532, "⛩"],
	[31533, "࿖"],
	[31534, "⛪"],
	[31535, "⛫"],
	[31536, "⛬"],
	[31537, "♨"],
	[31538, "⛭"],
	[31539, "⛮"],
	[31540, "⛯"],
	[31541, "⚓"],
	[31542, "✈"],
	[31543, "⛰"],
	[31544, "⛱"],
	[31545, "⛲"],
	[31546, "⛳"],
	[31547, "⛴"],
	[31548, "⛵"],
	[31549, "🅗"],
	[31550, "Ⓓ"],
	[31551, "Ⓢ"],
	[31552, "⛶"],
	[31553, "🅟"],
	[31554, "🆋"],
	[31555, "🆍"],
	[31556, "🆌"],
	[31557, "🅹"],
	[31558, "⛷"],
	[31559, "⛸"],
	[31560, "⛹"],
	[31561, "⛺"],
	[31562, "🅻"],
	[31563, "☎"],
	[31564, "⛻"],
	[31565, "⛼"],
	[31566, "⛽"],
	[31567, "⛾"],
	[31568, "🅼"],
	[31569, "⛿"],
	[31777, "➡"],
	[31778, "⬅"],
	[31779, "⬆"],
	[31780, "⬇"],
	[31781, "⬯"],
	[31782, "⬮"],
	[31783, "年"],
	[31784, "月"],
	[31785, "日"],
	[31786, "円"],
	[31787, "㎡"],
	[31788, "㎥"],
	[31789, "㎝"],
	[31790, "㎠"],
	[31791, "㎤"],
	[31792, "🄀"],
	[31793, "⒈"],
	[31794, "⒉"],
	[31795, "⒊"],
	[31796, "⒋"],
	[31797, "⒌"],
	[31798, "⒍"],
	[31799, "⒎"],
	[31800, "⒏"],
	[31801, "⒐"],
	[31802, ""],
	[31803, ""],
	[31804, ""],
	[31805, ""],
	[31806, ""],
	[31807, ""],
	[31808, "🄁"],
	[31809, "🄂"],
	[31810, "🄃"],
	[31811, "🄄"],
	[31812, "🄅"],
	[31813, "🄆"],
	[31814, "🄇"],
	[31815, "🄈"],
	[31816, "🄉"],
	[31817, "🄊"],
	[31818, "㈳"],
	[31819, "㈶"],
	[31820, "㈲"],
	[31821, "㈱"],
	[31822, "㈹"],
	[31823, "㉄"],
	[31824, "▶"],
	[31825, "◀"],
	[31826, "〖"],
	[31827, "〗"],
	[31828, "⟐"],
	[31829, "²"],
	[31830, "³"],
	[31831, "🄭"],
	[31832, ""],
	[31833, ""],
	[31834, ""],
	[31835, ""],
	[31836, ""],
	[31837, ""],
	[31838, ""],
	[31839, ""],
	[31840, ""],
	[31841, ""],
	[31842, ""],
	[31843, ""],
	[31844, ""],
	[31845, ""],
	[31846, ""],
	[31847, ""],
	[31848, ""],
	[31849, ""],
	[31850, ""],
	[31851, ""],
	[31852, ""],
	[31853, ""],
	[31854, ""],
	[31855, ""],
	[31856, ""],
	[31857, ""],
	[31858, ""],
	[31859, ""],
	[31860, ""],
	[31861, ""],
	[31862, "🄬"],
	[31863, "🄫"],
	[31864, "㉇"],
	[31865, "🆐"],
	[31866, "🈦"],
	[31867, "℻"],
	[32033, "㈪"],
	[32034, "㈫"],
	[32035, "㈬"],
	[32036, "㈭"],
	[32037, "㈮"],
	[32038, "㈯"],
	[32039, "㈰"],
	[32040, "㈷"],
	[32041, "㍾"],
	[32042, "㍽"],
	[32043, "㍼"],
	[32044, "㍻"],
	[32045, "№"],
	[32046, "℡"],
	[32047, "〶"],
	[32048, "⚾"],
	[32049, "🉀"],
	[32050, "🉁"],
	[32051, "🉂"],
	[32052, "🉃"],
	[32053, "🉄"],
	[32054, "🉅"],
	[32055, "🉆"],
	[32056, "🉇"],
	[32057, "🉈"],
	[32058, "🄪"],
	[32059, "🈧"],
	[32060, "🈨"],
	[32061, "🈩"],
	[32062, "🈔"],
	[32063, "🈪"],
	[32064, "🈫"],
	[32065, "🈬"],
	[32066, "🈭"],
	[32067, "🈮"],
	[32068, "🈯"],
	[32069, "🈰"],
	[32070, "🈱"],
	[32071, "ℓ"],
	[32072, "㎏"],
	[32073, "㎐"],
	[32074, "㏊"],
	[32075, "㎞"],
	[32076, "㎢"],
	[32077, "㍱"],
	[32080, "½"],
	[32081, "↉"],
	[32082, "⅓"],
	[32083, "⅔"],
	[32084, "¼"],
	[32085, "¾"],
	[32086, "⅕"],
	[32087, "⅖"],
	[32088, "⅗"],
	[32089, "⅘"],
	[32090, "⅙"],
	[32091, "⅚"],
	[32092, "⅐"],
	[32093, "⅛"],
	[32094, "⅑"],
	[32095, "⅒"],
	[32096, "☀"],
	[32097, "☁"],
	[32098, "☂"],
	[32099, "⛄"],
	[32100, "☖"],
	[32101, "☗"],
	[32102, "⛉"],
	[32103, "⛊"],
	[32104, "♦"],
	[32105, "♥"],
	[32106, "♣"],
	[32107, "♠"],
	[32108, "⛋"],
	[32109, "⨀"],
	[32110, "‼"],
	[32111, "⁉"],
	[32112, "⛅"],
	[32113, "☔"],
	[32114, "⛆"],
	[32115, "☃"],
	[32116, "⛇"],
	[32117, "⚡"],
	[32118, "⛈"],
	[32120, "⚞"],
	[32121, "⚟"],
	[32122, "♬"],
	[32123, "☎"],
	[32289, "Ⅰ"],
	[32290, "Ⅱ"],
	[32291, "Ⅲ"],
	[32292, "Ⅳ"],
	[32293, "Ⅴ"],
	[32294, "Ⅵ"],
	[32295, "Ⅶ"],
	[32296, "Ⅷ"],
	[32297, "Ⅸ"],
	[32298, "Ⅹ"],
	[32299, "Ⅺ"],
	[32300, "Ⅻ"],
	[32301, "⑰"],
	[32302, "⑱"],
	[32303, "⑲"],
	[32304, "⑳"],
	[32305, "⑴"],
	[32306, "⑵"],
	[32307, "⑶"],
	[32308, "⑷"],
	[32309, "⑸"],
	[32310, "⑹"],
	[32311, "⑺"],
	[32312, "⑻"],
	[32313, "⑼"],
	[32314, "⑽"],
	[32315, "⑾"],
	[32316, "⑿"],
	[32317, "㉑"],
	[32318, "㉒"],
	[32319, "㉓"],
	[32320, "㉔"],
	[32321, "🄐"],
	[32322, "🄑"],
	[32323, "🄒"],
	[32324, "🄓"],
	[32325, "🄔"],
	[32326, "🄕"],
	[32327, "🄖"],
	[32328, "🄗"],
	[32329, "🄘"],
	[32330, "🄙"],
	[32331, "🄚"],
	[32332, "🄛"],
	[32333, "🄜"],
	[32334, "🄝"],
	[32335, "🄞"],
	[32336, "🄟"],
	[32337, "🄠"],
	[32338, "🄡"],
	[32339, "🄢"],
	[32340, "🄣"],
	[32341, "🄤"],
	[32342, "🄥"],
	[32343, "🄦"],
	[32344, "🄧"],
	[32345, "🄨"],
	[32346, "🄩"],
	[32347, "㉕"],
	[32348, "㉖"],
	[32349, "㉗"],
	[32350, "㉘"],
	[32351, "㉙"],
	[32352, "㉚"],
	[32353, "①"],
	[32354, "②"],
	[32355, "③"],
	[32356, "④"],
	[32357, "⑤"],
	[32358, "⑥"],
	[32359, "⑦"],
	[32360, "⑧"],
	[32361, "⑨"],
	[32362, "⑩"],
	[32363, "⑪"],
	[32364, "⑫"],
	[32365, "⑬"],
	[32366, "⑭"],
	[32367, "⑮"],
	[32368, "⑯"],
	[32369, "❶"],
	[32370, "❷"],
	[32371, "❸"],
	[32372, "❹"],
	[32373, "❺"],
	[32374, "❻"],
	[32375, "❼"],
	[32376, "❽"],
	[32377, "❾"],
	[32378, "❿"],
	[32379, "⓫"],
	[32380, "⓬"],
	[32381, "㉛"]
]), gt = new Map([
	[96, Uint8Array.from([
		27,
		36,
		66,
		27,
		41,
		74,
		27,
		42,
		48,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[97, Uint8Array.from([
		27,
		36,
		66,
		27,
		41,
		49,
		27,
		42,
		48,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[98, Uint8Array.from([
		27,
		36,
		66,
		27,
		41,
		32,
		65,
		27,
		42,
		48,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[99, Uint8Array.from([
		27,
		40,
		50,
		27,
		41,
		52,
		27,
		42,
		53,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[100, Uint8Array.from([
		27,
		40,
		50,
		27,
		41,
		51,
		27,
		42,
		53,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[101, Uint8Array.from([
		27,
		40,
		50,
		27,
		41,
		32,
		65,
		27,
		42,
		53,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[102, Uint8Array.from([
		27,
		40,
		32,
		65,
		27,
		41,
		32,
		66,
		27,
		42,
		32,
		67,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[103, Uint8Array.from([
		27,
		40,
		32,
		68,
		27,
		41,
		32,
		69,
		27,
		42,
		32,
		70,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[104, Uint8Array.from([
		27,
		40,
		32,
		71,
		27,
		41,
		32,
		72,
		27,
		42,
		32,
		73,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[105, Uint8Array.from([
		27,
		40,
		32,
		74,
		27,
		41,
		32,
		75,
		27,
		42,
		32,
		75,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[106, Uint8Array.from([
		27,
		40,
		32,
		77,
		27,
		41,
		32,
		78,
		27,
		42,
		32,
		79,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[107, Uint8Array.from([
		27,
		36,
		66,
		27,
		41,
		32,
		66,
		27,
		42,
		48,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[108, Uint8Array.from([
		27,
		36,
		66,
		27,
		41,
		32,
		67,
		27,
		42,
		48,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[109, Uint8Array.from([
		27,
		36,
		66,
		27,
		41,
		32,
		68,
		27,
		42,
		48,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[110, Uint8Array.from([
		27,
		40,
		49,
		27,
		41,
		48,
		27,
		42,
		74,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])],
	[111, Uint8Array.from([
		27,
		40,
		74,
		27,
		41,
		50,
		27,
		42,
		32,
		65,
		27,
		43,
		32,
		112,
		15,
		27,
		125
	])]
]), G = {
	KANJI: {
		type: "Character",
		code: 66,
		bytes: 2,
		dict: /* @__PURE__ */ new Map()
	},
	ASCII: {
		type: "Character",
		code: 74,
		bytes: 1,
		dict: rt
	},
	HIRAGANA: {
		type: "Character",
		code: 48,
		bytes: 1,
		dict: ft
	},
	KATANAKA: {
		type: "Character",
		code: 49,
		bytes: 1,
		dict: pt
	},
	MOSAIC_A: {
		type: "Character",
		code: 50,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	MOSAIC_B: {
		type: "Character",
		code: 51,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	MOSAIC_C: {
		type: "Character",
		code: 52,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	MOSAIC_D: {
		type: "Character",
		code: 53,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	P_ASCII: {
		type: "Character",
		code: 54,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	P_HIRAGANA: {
		type: "Character",
		code: 55,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	P_KATANAKA: {
		type: "Character",
		code: 56,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	JIS_X_0201_KATAKANA: {
		type: "Character",
		code: 73,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	JIS_X_0213_2004_KANJI_1: {
		type: "Character",
		code: 57,
		bytes: 2,
		dict: /* @__PURE__ */ new Map()
	},
	JIS_X_0213_2004_KANJI_2: {
		type: "Character",
		code: 58,
		bytes: 2,
		dict: /* @__PURE__ */ new Map()
	},
	ADDITIONAL_SYMBOLS: {
		type: "Character",
		code: 59,
		bytes: 2,
		dict: /* @__PURE__ */ new Map()
	}
}, _t = {
	DRCS_0: {
		type: "DRCS",
		code: 64,
		bytes: 2,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_1: {
		type: "DRCS",
		code: 65,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_2: {
		type: "DRCS",
		code: 66,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_3: {
		type: "DRCS",
		code: 67,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_4: {
		type: "DRCS",
		code: 68,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_5: {
		type: "DRCS",
		code: 69,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_6: {
		type: "DRCS",
		code: 70,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_7: {
		type: "DRCS",
		code: 71,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_8: {
		type: "DRCS",
		code: 72,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_9: {
		type: "DRCS",
		code: 73,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_10: {
		type: "DRCS",
		code: 74,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_11: {
		type: "DRCS",
		code: 75,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_12: {
		type: "DRCS",
		code: 76,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_13: {
		type: "DRCS",
		code: 77,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_14: {
		type: "DRCS",
		code: 78,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	DRCS_15: {
		type: "DRCS",
		code: 79,
		bytes: 1,
		dict: /* @__PURE__ */ new Map()
	},
	MACRO: {
		type: "MACRO",
		code: 112,
		bytes: 1,
		dict: gt
	}
}, vt = class e extends dt {
	static NORMAL_DICT_USE_PUA = { ...G };
	static NORMAL_DICT_USE_UNICODE = { ...G };
	static {
		let e = /* @__PURE__ */ new Map(), t = /* @__PURE__ */ new Map(), n = new TextDecoder("euc-jp", { fatal: !0 });
		for (let r = 33; r < 117; r++) for (let i = 33; i < 127; i++) try {
			let a = r << 8 | i, o = n.decode(Uint8Array.from([r | 128, i | 128]));
			e.set(a, o), t.set(a, o);
		} catch {}
		for (let t = 117; t < 127; t++) for (let n = 33; n < 127; n++) {
			let r = t << 8 | n;
			mt.has(r) && e.set(r, mt.get(r));
		}
		for (let e = 117; e < 127; e++) for (let n = 33; n < 127; n++) {
			let r = e << 8 | n;
			ht.has(r) && t.set(r, ht.get(r));
		}
		this.NORMAL_DICT_USE_PUA = {
			...G,
			KANJI: {
				...G.KANJI,
				dict: e
			},
			ADDITIONAL_SYMBOLS: {
				...G.ADDITIONAL_SYMBOLS,
				dict: e
			}
		}, this.NORMAL_DICT_USE_UNICODE = {
			...G,
			KANJI: {
				...G.KANJI,
				dict: t
			},
			ADDITIONAL_SYMBOLS: {
				...G.ADDITIONAL_SYMBOLS,
				dict: t
			}
		};
	}
	constructor(t) {
		let n = t?.usePUA ? e.NORMAL_DICT_USE_PUA : e.NORMAL_DICT_USE_UNICODE;
		super(0, 2, [
			n.KANJI,
			n.ASCII,
			n.HIRAGANA,
			_t.MACRO
		], n, _t, new Set([
			"´",
			"`",
			"｀",
			"¨",
			"^",
			"＾",
			"‾",
			"￣",
			"_",
			"＿",
			"◯"
		]));
	}
}, yt = {
	ASCII: {
		type: "Character",
		code: 74,
		bytes: 1,
		dict: rt
	},
	LATIN_EXTENSION: {
		type: "Character",
		code: 75,
		bytes: 1,
		dict: new Map([
			[33, "¡"],
			[34, "¢"],
			[35, "£"],
			[36, "¤"],
			[37, "¥"],
			[38, "¦"],
			[39, "§"],
			[40, "¨"],
			[41, "©"],
			[42, "ª"],
			[43, "«"],
			[44, "¬"],
			[45, "Ÿ"],
			[46, "®"],
			[47, "¯"],
			[48, "°"],
			[49, "±"],
			[50, "²"],
			[51, "³"],
			[52, "´"],
			[53, "µ"],
			[54, "¶"],
			[55, "·"],
			[56, "¸"],
			[57, "¹"],
			[58, "º"],
			[59, "»"],
			[60, "¼"],
			[61, "½"],
			[62, "¾"],
			[63, "¿"],
			[64, "À"],
			[65, "Á"],
			[66, "Â"],
			[67, "Ã"],
			[68, "Ä"],
			[69, "Å"],
			[70, "Æ"],
			[71, "Ç"],
			[72, "È"],
			[73, "É"],
			[74, "Ê"],
			[75, "Ë"],
			[76, "Ì"],
			[77, "Í"],
			[78, "Î"],
			[79, "Ï"],
			[80, "Ð"],
			[81, "Ñ"],
			[82, "Ò"],
			[83, "Ó"],
			[84, "Ô"],
			[85, "Õ"],
			[86, "Ö"],
			[87, "×"],
			[88, "Ø"],
			[89, "Ù"],
			[90, "Ú"],
			[91, "Û"],
			[92, "Ü"],
			[93, "Ý"],
			[94, "Þ"],
			[95, "ß"],
			[96, "à"],
			[97, "á"],
			[98, "â"],
			[99, "ã"],
			[100, "ä"],
			[101, "å"],
			[102, "æ"],
			[103, "ç"],
			[104, "è"],
			[105, "é"],
			[106, "ê"],
			[107, "ë"],
			[108, "ì"],
			[109, "í"],
			[110, "î"],
			[111, "ï"],
			[112, "ð"],
			[113, "ñ"],
			[114, "ò"],
			[115, "ó"],
			[116, "ô"],
			[117, "õ"],
			[118, "ö"],
			[119, "÷"],
			[120, "ø"],
			[121, "ù"],
			[122, "ú"],
			[123, "û"],
			[124, "ü"],
			[125, "ý"],
			[126, "þ"]
		])
	},
	SPECIAL_CHARACTERS: {
		type: "Character",
		code: 76,
		bytes: 1,
		dict: new Map([
			[33, "♪"],
			[48, "¤"],
			[49, "¦"],
			[50, "¨"],
			[51, "´"],
			[52, "¸"],
			[53, "¼"],
			[54, "½"],
			[55, "¾"],
			[64, "…"],
			[65, "█"],
			[66, "‘"],
			[67, "’"],
			[68, "“"],
			[69, "”"],
			[70, "•"],
			[71, "™"],
			[72, "⅛"],
			[73, "⅜"],
			[74, "⅝"],
			[75, "⅞"]
		])
	}
}, bt = {}, xt = class extends dt {
	constructor() {
		super(0, 2, [
			yt.ASCII,
			yt.ASCII,
			yt.LATIN_EXTENSION,
			yt.SPECIAL_CHARACTERS
		], yt, bt, /* @__PURE__ */ new Set([]));
	}
}, St = { from(e, t, n, r) {
	return {
		width: e,
		height: t,
		depth: n,
		binary: r
	};
} }, Ct = (e) => {
	if (e.exists(1)) {
		let t = e.peekU8();
		if (0 <= t && t <= 32 || t == 127) return !0;
	}
	if (e.exists(2)) {
		let t = e.peekU16();
		if (49792 <= t && t <= 49823) return !0;
	}
	return !1;
}, wt = class extends lt {
	segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
	decoder = new TextDecoder("utf-8", { fatal: !0 });
	drcs = /* @__PURE__ */ new Map();
	tokenizeStatement(e) {
		let t = new it(e), n = [];
		for (; !t.isEmpty();) {
			if (!Ct(t)) {
				let e = [];
				for (; !t.isEmpty() && !Ct(t);) e.push(t.readU8());
				for (let t of Array.from(this.segmenter.segment(this.decoder.decode(Uint8Array.from(e))), ({ segment: e }) => e)) {
					let [e, ...r] = Array.from(t);
					if (this.drcs.has(e)) {
						let { width: t, height: i, depth: a, binary: s } = this.drcs.get(e);
						n.push(o.from(t, i, a, s, r.join("")));
					} else n.push(i.from(t));
				}
				continue;
			}
			let e = t.peekU8();
			if (t.exists(1) && 0 <= e && e <= 32 || e === H.DEL) {
				switch (e) {
					case H.LS0:
					case H.LS1:
					case H.SS2:
					case H.SS3: throw new Ge("Single/Locking Shift is Not used in UTF-8");
					case H.ESC: throw new A("ESC in UTF-8 is Not Implemented");
				}
				n.push(st(t));
			} else if (t.exists(2) && 49792 <= t.peekU16() && t.peekU16() <= 49823) t.readU8(), n.push(ct(t));
			else throw new N("Undefined Conrtol Code in STD-B24 ARIB Caption");
		}
		return n;
	}
	processDRCS(e, t) {
		if (e === 1) throw new Ge("Not used 1-byte DRCS in UTF-8");
		let n = 0, r = t.byteLength;
		for (t[n + 0], n += 1; n < r;) {
			let e = t[n + 0] << 8 | t[n + 1], r = t[n + 2];
			n += 3;
			for (let i = 0; i < r; i++) {
				(t[n + 0] & 240) >> 4;
				let r = t[n + 0] & 15;
				if (r === 0 || r === 1) {
					let r = t[n + 1] + 2, i = t[n + 2], a = t[n + 3], o = [
						0,
						1,
						6,
						2,
						7,
						5,
						4,
						3
					][r * 29 >> 5], s = Math.floor(i * a * o / 8), c = t.slice(n + 4, n + 4 + s).buffer;
					this.drcs.set(String.fromCodePoint(e), St.from(i, a, o, c)), n += 4 + s;
				} else return;
			}
		}
	}
}, Tt = { from(e) {
	return {
		...e,
		recieve: {
			association: null,
			type: "Caption",
			language: 0,
			...e?.recieve
		},
		tokenizer: {
			pua: !1,
			...e?.tokenizer
		},
		offset: {
			time: 0,
			...e?.offset
		}
	};
} }, Et = (e, t, n) => {
	if (t === 1) return [
		"ARIB",
		new wt(),
		tt
	];
	if (t !== 0) throw new Ge("not Supported TCS");
	switch (n.recieve.association) {
		case "ARIB": return [
			"ARIB",
			new vt({ usePUA: n.tokenizer.pua }),
			tt
		];
		case "SBTVD": return [
			"SBTVD",
			new xt(),
			nt
		];
	}
	switch (e) {
		case "jpn":
		case "eng": return [
			"ARIB",
			new vt({ usePUA: n.tokenizer.pua }),
			tt
		];
		case "spa":
		case "por": return [
			"SBTVD",
			new xt(),
			nt
		];
	}
	return [
		"UNKNOWN",
		new vt({ usePUA: n.tokenizer.pua }),
		tt
	];
};
//#endregion
//#region src/util/binary.ts
function Dt(e, t, n) {
	let r = "";
	for (let i = t; i < n; i++) r += `%${e[i].toString(16).padStart(2, "0")}`;
	return r;
}
function Ot(e, t, n) {
	if (globalThis.TextDecoder) {
		let r = new globalThis.TextDecoder("utf-8", { fatal: !0 }), i = new Uint8Array(e.subarray(t, n));
		return r.decode(i);
	} else return decodeURIComponent(Dt(e, t, n));
}
function kt(e, t, n) {
	if (globalThis.TextDecoder) {
		let r = new globalThis.TextDecoder("iso-8859-1", { fatal: !0 }), i = new Uint8Array(e.subarray(t, n));
		return r.decode(i);
	} else return unescape(Dt(e, t, n));
}
function At(e) {
	let t = atob(e), n = new Uint8Array(t.length);
	for (let e = 0; e < t.length; e++) n[e] = t.charCodeAt(e);
	return n;
}
//#endregion
//#region src/util/id3.ts
var jt = (e, t, n) => {
	let r = 0;
	for (let i = t; i < n; i++) r <<= 7, r |= e[i] & 127;
	return r;
}, Mt = { from(e) {
	let t = 0;
	for (; e[t] !== 0 && t < e.byteLength;) t++;
	return {
		id: "PRIV",
		owner: kt(e, 0, t),
		data: e.subarray(t + 1)
	};
} }, Nt = { from(e) {
	let t = 0, n = e[t + 0], r = t + 1;
	if (n === 3) {
		for (; e[t] !== 0 && t < e.byteLength;) t++;
		let n = t;
		t += 1;
		let i = t;
		for (; e[t] !== 0 && t < e.byteLength;) t++;
		let a = t;
		return {
			id: "TXXX",
			description: Ot(e, r, n),
			text: Ot(e, i, a)
		};
	} else if (n === 0) {
		for (; e[t] !== 0 && t < e.byteLength;) t++;
		let n = t;
		t += 1;
		let i = t;
		for (; e[t] !== 0 && t < e.byteLength;) t++;
		let a = t;
		return {
			id: "TXXX",
			description: kt(e, r, n),
			text: kt(e, i, a)
		};
	} else return null;
} }, Pt = (e) => {
	let t = [];
	for (let n = 0; n < e.length;) {
		let r = n;
		if (n + 3 > e.length) break;
		if (!(e[n + 0] === 73 && e[n + 1] === 68 && e[n + 2] === 51)) if (n === 0) {
			n += 5;
			continue;
		} else break;
		if (n += 6, n + 4 > e.length) break;
		let i = jt(e, n + 0, n + 4);
		n += 4;
		let a = r + 3 + 2 + 1 + 4 + i;
		if (a > e.length) break;
		for (let r = n; r < a;) {
			let n = r;
			if (r + 4 > e.length) break;
			let i = kt(e, r + 0, r + 4);
			if (r += 4, r + 4 > e.length) break;
			let a = jt(e, r + 0, r + 4);
			r += 6;
			let o = n + 4 + 4 + 2 + a;
			if (o > e.length) break;
			switch (i) {
				case "PRIV":
					t.push(Mt.from(e.subarray(r, o)));
					break;
				case "TXXX": {
					let n = Nt.from(e.subarray(r, o));
					n != null && t.push(n);
					break;
				}
			}
			r = o;
		}
		n = r + 3 + 2 + 1 + 4 + i, !(n + 3 > e.length) && e[n + 0] === 51 && e[n + 1] === 68 && e[n + 2] === 73 && (n += 10);
	}
	return t;
}, Ft = class {
	actual = null;
	compareKey;
	compareOrder;
	calculateOrder;
	constructor(e, t, n) {
		this.compareKey = e, this.compareOrder = t, this.calculateOrder = n;
	}
	get parent() {
		return null;
	}
	get balanced() {
		return this.actual?.balanced ?? !0;
	}
	get bias() {
		return this.actual?.bias ?? 0;
	}
	toString() {
		return `${this.actual}`;
	}
	refresh() {}
	rotate() {}
	has(e) {
		return this.actual?.has(e) ?? !1;
	}
	get(e) {
		return this.actual?.get(e) ?? void 0;
	}
	floor(e) {
		return this.actual?.floor(e) ?? void 0;
	}
	ceil(e) {
		return this.actual?.ceil(e) ?? void 0;
	}
	insert(e, t) {
		this.actual == null ? this.actual = new It(e, t, this, this.compareKey, this.compareOrder, this.calculateOrder) : this.actual.insert(e, t);
	}
	delete(e) {
		this.actual?.delete(e);
	}
	replace(e, t) {
		e != null && this.actual === e && (e.parent = null, this.actual = t, t != null && (t.parent = this));
	}
	forEach(e) {
		this.actual?.forEach(e);
	}
	*range(e, t) {
		yield* this.actual?.range(e, t) ?? [];
	}
}, It = class e {
	key;
	value;
	order;
	parent;
	left = null;
	right = null;
	depth = 1;
	compareKey;
	compareOrder;
	calculateOrder;
	constructor(e, t, n, r, i, a) {
		this.key = e, this.value = t, this.parent = n, this.compareKey = r, this.compareOrder = i, this.calculateOrder = a, this.order = this.calculateOrder(this.key);
	}
	refresh() {
		this.depth = Math.max(this.left?.depth ?? 0, this.right?.depth ?? 0) + 1;
	}
	get balanced() {
		let e = Math.min(this.left?.depth ?? 0, this.right?.depth ?? 0);
		return Math.max(this.left?.depth ?? 0, this.right?.depth ?? 0) - e <= 1;
	}
	get bias() {
		return (this.left?.depth ?? 0) - (this.right?.depth ?? 0);
	}
	leftmost() {
		return this.left == null ? this : this.left.leftmost();
	}
	rightmost() {
		return this.right == null ? this : this.right.rightmost();
	}
	rotateL() {
		if (this.right == null) return;
		let e = this.right;
		this.replace(e, e.left), e.left = this, this.parent?.replace(this, e), this.parent = e, this.refresh(), this.parent?.refresh();
	}
	rotateR() {
		if (this.left == null) return;
		let e = this.left;
		this.replace(e, e.right), e.right = this, this.parent?.replace(this, e), this.parent = e, this.refresh(), this.parent?.refresh();
	}
	rotateLR() {
		this.left != null && (this.left.rotateL(), this.rotateR());
	}
	rotateRL() {
		this.right != null && (this.right.rotateR(), this.rotateL());
	}
	rotate() {
		this.bias === 2 ? (this.left?.bias ?? 0) >= 0 ? this.rotateR() : this.rotateLR() : this.bias === -2 && ((this.right?.bias ?? 0) <= 0 ? this.rotateL() : this.rotateRL());
	}
	find(e, t = "exact") {
		let n = this;
		FIND: for (;;) {
			let r = this.compareKey(e, n.key);
			switch (r) {
				case 0: return n;
				case -1:
					if (n.left != null) {
						n = n.left;
						continue FIND;
					} else if (t === "ceil") return n;
					return null;
				case 1:
					if (n.right != null) {
						n = n.right;
						continue FIND;
					} else if (t === "floor") return n;
					return null;
				default: throw new M(r, "Exhaustive check reached!");
			}
		}
	}
	has(e) {
		return this.find(e, "exact") != null;
	}
	get(e) {
		return this.find(e, "exact")?.value ?? void 0;
	}
	floor(e) {
		return this.find(e, "floor")?.value ?? void 0;
	}
	ceil(e) {
		return this.find(e, "ceil")?.value ?? void 0;
	}
	insert(t, n) {
		let r = this;
		FIND: for (;;) {
			let i = this.compareKey(t, r.key);
			switch (i) {
				case 0:
					r.value = n;
					return;
				case -1:
					if (r.left != null) {
						r = r.left;
						continue FIND;
					}
					r.left = new e(t, n, r, this.compareKey, this.compareOrder, this.calculateOrder), r = r.left;
					break FIND;
				case 1:
					if (r.right != null) {
						r = r.right;
						continue FIND;
					}
					r.right = new e(t, n, r, this.compareKey, this.compareOrder, this.calculateOrder), r = r.right;
					break FIND;
				default: throw new M(i, "Exhaustive check reached!");
			}
		}
		for (let e = r; e != null; e = e.parent) e.rotate(), e.refresh();
	}
	delete(e) {
		let t = this.find(e);
		if (t == null) return;
		let n = t.left?.rightmost(), r = t.right?.leftmost(), i;
		n ? (i = n.parent === t ? n : n.parent, n.parent?.replace(n, n.left), t.parent?.replace(t, n), n.right = t.right, t.right != null && (t.right.parent = n), n.left = t.left, t.left != null && (t.left.parent = n)) : r ? (i = r.parent === t ? r : r.parent, r.parent?.replace(r, r.right), t.parent?.replace(t, r), r.left = t.left, t.left != null && (t.left.parent = r), r.right = t.right, t.right != null && (t.right.parent = r)) : (i = t.parent, t.parent?.replace(t, null));
		for (let e = i; e != null; e = e.parent) e.rotate(), e.refresh();
	}
	replace(e, t) {
		this.left === e && (e.parent === this && (e.parent = null), t != null && (t.parent = this), this.left = t), this.right === e && (e.parent === this && (e.parent = null), t != null && (t.parent = this), this.right = t);
	}
	forEach(e) {
		this.left != null && this.left.forEach(e), e(this.value), this.right != null && this.right.forEach(e);
	}
	*range(e, t) {
		let n = this.compareOrder(e, this.order), r = this.compareOrder(t, this.order);
		n <= 0 && (yield* this.left?.range(e, t) ?? []), n <= 0 && r > 0 && (yield this.value), r > 0 && (yield* this.right?.range(e, t) ?? []);
	}
}, Lt = class {
	root;
	compareKey;
	compareOrder;
	calculateOrder;
	constructor(e, t, n) {
		this.compareKey = e, this.compareOrder = t, this.calculateOrder = n, this.root = new Ft(this.compareKey, this.compareOrder, this.calculateOrder);
	}
	clear() {
		this.root = new Ft(this.compareKey, this.compareOrder, this.calculateOrder);
	}
	has(e) {
		return this.root.has(e);
	}
	get(e) {
		return this.root.get(e);
	}
	floor(e) {
		return this.root.floor(e);
	}
	ceil(e) {
		return this.root.ceil(e);
	}
	forEach(e) {
		this.root.forEach(e);
	}
	*range(e, t) {
		yield* this.root.range(e, t);
	}
	insert(e, t) {
		this.root.insert(e, t);
	}
	delete(e) {
		this.root.delete(e);
	}
	toString() {
		return `${this.root}`;
	}
}, Rt = (e) => {
	if (e = e instanceof Uint8Array ? e : new Uint8Array(e), e.byteLength <= 0) return null;
	let t = e[0];
	if (t !== 128 && t !== 129) return null;
	let n = t === 128 ? "Caption" : "Superimpose";
	if (e.byteLength <= 2) return null;
	let r = 3 + (e[2] & 15);
	return e.byteLength < r ? null : {
		tag: n,
		data: e.subarray(r)
	};
}, zt = { from(e) {
	return {
		tag: "Statement",
		data: e
	};
} }, Bt = { from(e, t) {
	return {
		tag: "DRCS",
		data: e,
		bytes: t
	};
} }, K = {
	FREE: 0,
	REALTIME: 1,
	OFFSETTIME: 2,
	RESERVED: 3
}, Vt = (e) => {
	let t = e.readU8();
	return [(t & 240) >> 4, (t & 15) >> 0];
}, Ht = (e) => {
	let t = [
		Vt(e),
		Vt(e),
		Vt(e),
		Vt(e),
		Vt(e)
	].flatMap((e) => e);
	return [
		t[0] * 10 + t[1],
		t[2] * 10 + t[3],
		t[4] * 10 + t[5],
		t[6] * 100 + t[7] * 10 + t[8]
	];
}, Ut = (e) => {
	e = e instanceof Uint8Array ? e : new Uint8Array(e);
	let t = new it(e), n = (t.readU8() & 252) >> 2, r = (n & 32) >> 5, i = n & 15;
	if (t.readU8(), t.readU8(), t.readU16(), i === 0) {
		let e = (t.readU8() & 192) >> 6, n = e === K.OFFSETTIME ? {
			timeControlMode: e,
			offsetTime: Ht(t)
		} : { timeControlMode: e }, i = t.readU8(), a = [];
		for (let e = 0; e < i; e++) {
			let e = t.readU8(), n = (e & 224) >> 5, r = e & 15, i = r === 12 || r === 13 || r === 14 ? {
				displayMode: r,
				displayConditionDesignation: t.readU8()
			} : { displayMode: r }, o = String.fromCharCode(t.readU8(), t.readU8(), t.readU8()), s = t.readU8(), c = (s & 240) >> 4, l = (s & 12) >> 2, u = s & 3;
			a.push({
				...i,
				lang: n,
				iso_639_language_code: o,
				TCS: l,
				format: c,
				rollup: u
			});
		}
		let o = t.readU24(), s = [], c = 0;
		for (; c < o;) {
			t.readU8();
			let e = t.readU8(), n = t.readU24();
			switch (e) {
				case 32:
					s.push({
						tag: "Statement",
						data: t.read(n)
					});
					break;
				case 48:
					s.push({
						tag: "DRCS",
						bytes: 1,
						data: t.read(n)
					});
					break;
				case 49:
					s.push({
						tag: "DRCS",
						bytes: 2,
						data: t.read(n)
					});
					break;
				case 53:
					s.push({
						tag: "Bitmap",
						data: t.read(n)
					});
					break;
				default:
					t.read(n);
					break;
			}
			c += 5 + n;
		}
		return t.readU16(), {
			...n,
			tag: "CaptionManagement",
			group: r,
			languages: a,
			units: s
		};
	} else {
		let e = (t.readU8() & 192) >> 6, n = e === K.REALTIME || e === K.OFFSETTIME ? {
			timeControlMode: e,
			presentationStartTime: Ht(t)
		} : { timeControlMode: e }, a = t.readU24(), o = [], s = 0;
		for (; s < a;) {
			t.readU8();
			let e = t.readU8(), n = t.readU24();
			switch (e) {
				case 32:
					o.push({
						tag: "Statement",
						data: t.read(n)
					});
					break;
				case 48:
					o.push({
						tag: "DRCS",
						bytes: 1,
						data: t.read(n)
					});
					break;
				case 49:
					o.push({
						tag: "DRCS",
						bytes: 2,
						data: t.read(n)
					});
					break;
				case 53:
					o.push({
						tag: "Bitmap",
						data: t.read(n)
					});
					break;
				default:
					t.read(n);
					break;
			}
			s += 5 + n;
		}
		return t.readU16(), {
			...n,
			tag: "CaptionStatement",
			group: r,
			lang: i - 1,
			units: o
		};
	}
}, Wt = { from(e, t) {
	return {
		tag: "Script",
		sup: e,
		sub: t
	};
} }, Gt = { from(e) {
	return {
		tag: "Normal",
		text: e
	};
} }, Kt = { from(e, t) {
	return {
		tag: "Ruby",
		text: e,
		ruby: t
	};
} }, qt = (e) => e === "Middle" ? "Normal" : e, Jt = {
	GUESS: "GUESS_RUBY",
	PRESERVE: "PRESERVE",
	IGNORE: "IGNORE"
}, Yt = (e, t, n) => {
	let r = e.filter((e) => e.tag === "Character" || e.tag === "DRCS").toSorted((e, t) => e.state.position[1] === t.state.position[1] ? Math.sign(e.state.position[0] - t.state.position[0]) : Math.sign(e.state.position[1] - t.state.position[1])), i = [];
	for (let e of r) {
		let t = i.find((t) => {
			let n = t.position[0] + t.area[0], r = t.position[1], i = e.state.position[0], a = e.state.position[1] + 1 - F.box(e.state)[1];
			return n == i && r == a;
		}), n = t != null && t.background === e.state.background, r = t != null && t.highlight === (e.state.highlight !== 0), a = t != null && qt(t.size) === qt(e.state.size);
		n && r && a ? (t.area = [t.area[0] + F.box(e.state)[0], t.area[1]], t.spans.push(Gt.from([e]))) : i.push({
			plane: [...e.state.plane],
			margin: [...e.state.margin],
			position: [e.state.position[0], e.state.position[1] - (F.box(e.state)[1] - 1)],
			area: [F.box(e.state)[0], F.box(e.state)[1]],
			size: qt(e.state.size),
			fontsize: e.state.fontsize,
			background: e.state.background,
			highlight: e.state.highlight !== 0,
			spans: [Gt.from([e])]
		});
	}
	for (let { spans: e } of i) for (let t = 0; t < e.length - 1; t++) {
		let n = e[t + 0], r = e[t + 1];
		n.tag === "Normal" && n.tag === r.tag && (n.text.push(...r.text), e.splice(t + 1, 1), t--);
	}
	if (t.association !== "ARIB") return i;
	for (;;) {
		let e = !1;
		LOOP: for (let t of i.filter(({ size: e }) => e === P.Normal)) {
			let n = t.position[0] + t.area[0], r = t.position[1] + 0, a = t.position[1] + t.area[1];
			for (let o = 0; o < i.length; o++) {
				let s = i[o];
				if (s.size !== P.Small) continue;
				let c = s.position[0], l = s.position[1];
				if (!(n !== c || r !== l)) for (let r = 0; r < i.length; r++) {
					if (r === o) continue;
					let c = i[r];
					if (c.size !== P.Small) continue;
					let l = c.position[0], u = c.position[1] + c.area[1];
					if (n !== l || a !== u) continue;
					t.area[0] += Math.min(s.area[0], c.area[0]);
					let d = Math.min(s.spans[0].text.length, c.spans[0].text.length), f = [];
					for (let e = 0; e < d; e++) {
						let t = s.spans.at(0)?.text.at(e) ?? null, n = c.spans.at(0)?.text.at(e) ?? null;
						t == null || t.tag == "Script" || n == null || n.tag == "Script" || f.push(Wt.from(t, n));
					}
					t.spans.push(Gt.from(f)), i.splice(Math.max(o, r), 1), i.splice(Math.min(o, r), 1), e = !0;
					break LOOP;
				}
			}
		}
		if (!e) break;
	}
	for (;;) {
		let e = !1;
		LOOP: for (let t = 0; t < i.length; t++) {
			let n = i[t].position[0] + i[t].area[0], r = i[t].position[1] + 0, a = i[t].position[1] + i[t].area[1];
			for (let o = t + 1; o < i.length; o++) {
				let s = i[o].position[0], c = i[o].position[1] + 0, l = i[o].position[1] + i[o].area[1];
				if (!(n !== s || r !== c || a !== l)) {
					i[t].area[0] += i[o].area[0], i[t].spans.push(...i[o].spans), i.splice(o, 1), e = !0;
					break LOOP;
				}
			}
		}
		if (!e) break;
	}
	if (n === Jt.GUESS) for (;;) {
		let e = !1;
		LOOP: for (let t of i.filter(({ size: e }) => e === P.Normal)) {
			let n = t.position[0] + 0, r = t.position[0] + t.area[0], a = t.position[1], o = null, s = 0;
			for (let e = 0; e < i.length; e++) {
				let t = i[e];
				if (t.size !== P.Small) continue;
				let c = t.position[0] + 0, l = t.position[0] + t.area[0];
				if (a !== t.position[1] + t.area[1] || n >= l || r <= c) continue;
				let u = Math.min(r, l) - Math.max(n, c);
				u > s && (s = u, o = e);
			}
			if (o != null) {
				let n = i[o];
				if (n.size !== P.Small) continue;
				let r = n.position[0] + 0, a = n.position[0] + n.area[0], s = t.spans.flatMap((e) => e.text), c = s.filter((e) => {
					let t = e.tag === "Script" ? e.sup : e;
					return t.state.position[0], t.state.position[0] + F.box(t.state)[0] <= r;
				}), l = s.filter((e) => {
					let t = e.tag === "Script" ? e.sup : e, n = t.state.position[0];
					return r < t.state.position[0] + F.box(t.state)[0] && n < a;
				}), u = s.filter((e) => {
					let t = e.tag === "Script" ? e.sup : e, n = t.state.position[0];
					return t.state.position[0] + F.box(t.state)[0], a <= n;
				}), d = n.spans.flatMap((e) => e.text);
				t.spans = [
					Gt.from(c),
					Kt.from(l, d),
					Gt.from(u)
				], i.splice(o, 1), e = !0;
				break LOOP;
			}
		}
		if (!e) break;
	}
	return n === Jt.PRESERVE ? i : i.filter((e) => e.size !== P.Small);
}, Xt = { async from(e, t) {
	let n = new Uint8Array(e.binary), r = new Set(e.flc_colors), i = n.subarray(0, 33), a = n.subarray(33, n.byteLength), o = new Uint8Array(i.byteLength + a.byteLength + 396 + 140), s = new DataView(o.buffer);
	o.set(i, 0), o.set(a, 569);
	for (let e = 0; e < t.length; e++) {
		let n = t[e], i = Number.parseInt(n.substring(1, 3), 16), a = Number.parseInt(n.substring(3, 5), 16), s = Number.parseInt(n.substring(5, 7), 16), c = Number.parseInt(n.substring(7, 9), 16);
		o[41 + e * 3 + 0] = i, o[41 + e * 3 + 1] = a, o[41 + e * 3 + 2] = s, o[437 + e] = r.has(e) ? 0 : c;
	}
	s.setInt32(33, 384, !1), o[37] = 80, o[38] = 76, o[39] = 84, o[40] = 69, s.setInt32(429, 128, !1), o[433] = 116, o[434] = 82, o[435] = 78, o[436] = 83, s.setInt32(425, qe(o, 37, 425), !1), s.setInt32(565, qe(o, 433, 565), !1);
	let c = s.getInt32(16, !1), l = s.getInt32(20, !1), u = new Image(c, l);
	u.src = "data:image/png;base64," + btoa(String.fromCharCode(...o)), await u.decode();
	let d = await createImageBitmap(u);
	if (r.size === 0) return {
		tag: "Bitmap",
		x_position: e.x_position,
		y_position: e.y_position,
		width: c,
		height: l,
		normal_dataurl: u.src,
		normal_bitmap: d
	};
	for (let e = 0; e < t.length; e++) {
		let n = t[e], i = Number.parseInt(n.substring(7, 9), 16);
		o[437 + e] = r.has(e) ? i : 0;
	}
	s.setInt32(425, qe(o, 37, 425), !1), s.setInt32(565, qe(o, 433, 565), !1);
	let f = new Image(c, l);
	f.src = "data:image/png;base64," + btoa(String.fromCharCode(...o)), await f.decode();
	let p = await createImageBitmap(f);
	return {
		tag: "Bitmap",
		x_position: e.x_position,
		y_position: e.y_position,
		width: c,
		height: l,
		normal_dataurl: u.src,
		normal_bitmap: d,
		flashing_dataurl: f.src,
		flashing_bitmap: p
	};
} }, Zt = { from(e, t, n) {
	return {
		tag: "Bitmap",
		state: structuredClone(t),
		option: structuredClone(n),
		x_position: e.x_position * n.magnification,
		y_position: e.y_position * n.magnification,
		width: e.width * n.magnification,
		height: e.height * n.magnification,
		normal_dataurl: e.normal_dataurl,
		normal_bitmap: e.normal_bitmap,
		flashing_dataurl: e.flashing_dataurl,
		flashing_bitmap: e.flashing_bitmap
	};
} }, Qt = async (e, t) => {
	let n = [];
	for (let r of e) {
		if (r.tag !== "Bitmap") {
			n.push(r);
			continue;
		}
		n.push(await Xt.from(r, t));
	}
	return n;
}, $t = (e) => e.filter((e) => e.tag !== "Bitmap"), en = class {
	praser;
	constructor(e, t) {
		this.praser = new F(e, t);
	}
	currentState() {
		return this.praser.currentState();
	}
	currentOption() {
		return this.praser.currentOption();
	}
	parseBitmapOrInherit(e) {
		return e.tag === "Bitmap" ? [Zt.from(e, this.praser.currentState(), this.praser.currentOption())] : this.praser.parseToken(e);
	}
	parse(e) {
		return e.flatMap(this.parseBitmapOrInherit.bind(this));
	}
}, tn = (e, t) => ut(e, t), nn = (e, t, n) => Yt(e.filter((e) => e.tag === "Bitmap" ? (e.normal_bitmap.close(), e.flashing_bitmap?.close(), !1) : !0), t, n), q = /* @__PURE__ */ "#000000FF.#FF0000FF.#00FF00FF.#FFFF00FF.#0000FFFF.#FF00FFFF.#00FFFFFF.#FFFFFFFF.#00000000.#AA0000FF.#00AA00FF.#AAAA00FF.#0000AAFF.#AA00AAFF.#00AAAAFF.#AAAAAAFF.#000055FF.#005500FF.#005555FF.#0055AAFF.#0055FFFF.#00AA55FF.#00AAFFFF.#00FF55FF.#00FFAAFF.#550000FF.#550055FF.#5500AAFF.#5500FFFF.#555500FF.#555555FF.#5555AAFF.#5555FFFF.#55AA00FF.#55AA55FF.#55AAAAFF.#55AAFFFF.#55FF00FF.#55FF55FF.#55FFAAFF.#55FFFFFF.#AA0055FF.#AA00FFFF.#AA5500FF.#AA5555FF.#AA55AAFF.#AA55FFFF.#AAAA55FF.#AAAAFFFF.#AAFF00FF.#AAFF55FF.#AAFFAAFF.#AAFFFFFF.#FF0055FF.#FF00AAFF.#FF5500FF.#FF5555FF.#FF55AAFF.#FF55FFFF.#FFAA00FF.#FFAA55FF.#FFAAAAFF.#FFAAFFFF.#FFFF55FF.#FFFFAAFF.#00000080.#FF000080.#00FF0080.#FFFF0080.#0000FF80.#FF00FF80.#00FFFF80.#FFFFFF80.#AA000080.#00AA0080.#AAAA0080.#0000AA80.#AA00AA80.#00AAAA80.#AAAAAA80.#00005580.#00550080.#00555580.#0055AA80.#0055FF80.#00AA5580.#00AAFF80.#00FF5580.#00FFAA80.#55000080.#55005580.#5500AA80.#5500FF80.#55550080.#55555580.#5555AA80.#5555FF80.#55AA0080.#55AA5580.#55AAAA80.#55AAFF80.#55FF0080.#55FF5580.#55FFAA80.#55FFFF80.#AA005580.#AA00FF80.#AA550080.#AA555580.#AA55AA80.#AA55FF80.#AAAA5580.#AAAAFF80.#AAFF0080.#AAFF5580.#AAFFAA80.#AAFFFF80.#FF005580.#FF00AA80.#FF550080.#FF555580.#FF55AA80.#FF55FF80.#FFAA0080.#FFAA5580.#FFAAAA80.#FFAAFF80.#FFFF5580".split("."), rn = ({ dts: e }) => e, an = (e, t) => Math.sign(e - t), on = (e, t) => an(e.dts, t.dts) === 0 ? an(e.lang ?? -1, t.lang ?? -1) : an(e.dts, t.dts), sn = (e) => {
	for (let t of e.data) t.tag === "Bitmap" && (t.normal_bitmap.close(), t.flashing_bitmap?.close());
}, cn = class {
	option;
	priviousTime = null;
	priviousManagementData = null;
	desiredLang = null;
	decoder = new Lt(on, an, rn);
	decoderBuffer = [];
	decodingPromise;
	decodingNotify = Promise.resolve;
	abortController = new AbortController();
	present = new Lt(an, an, (e) => e);
	isDestroyed = !1;
	constructor(e) {
		this.option = Tt.from(e), this.decodingPromise = new Promise((e) => {
			this.decodingNotify = e;
		}), this.pump();
	}
	notify(e) {
		e == null ? (this.abortController.abort(), this.abortController = new AbortController()) : this.decoderBuffer.push(e), this.decodingNotify?.();
	}
	async *generator(e) {
		for (;;) {
			if (await this.decodingPromise, this.decodingPromise = new Promise((e) => {
				this.decodingNotify = e;
			}), e.aborted) {
				this.decoderBuffer = [];
				return;
			}
			let t = [...this.decoderBuffer];
			this.decoderBuffer = [], yield* t;
		}
	}
	async pump() {
		for (; !this.isDestroyed;) for await (let { pts: e, caption: t } of this.generator(this.abortController.signal)) {
			if (t.tag === "CaptionManagement") {
				if (this.priviousManagementData?.group === t.group) continue;
				if (typeof this.option.recieve.language == "number") this.desiredLang = this.option.recieve.language;
				else {
					let e = typeof this.option.recieve.language == "string" ? this.option.recieve.language : this.option.recieve.language[0], n = typeof this.option.recieve.language == "string" ? 0 : this.option.recieve.language[1];
					this.desiredLang = [...t.languages].sort(({ lang: e }, { lang: t }) => e - t).filter(({ iso_639_language_code: t }) => t === e)?.[n]?.lang ?? null;
				}
				this.priviousManagementData = t, this.present.insert(e, {
					pts: e,
					duration: Infinity,
					state: Xe,
					info: {
						association: "UNKNOWN",
						language: "und"
					},
					data: [m.from()]
				});
				continue;
			}
			if (this.priviousManagementData == null) continue;
			let n = this.priviousManagementData.languages.find((e) => e.lang === t.lang);
			if (n == null || this.desiredLang !== t.lang) continue;
			let r = Et(n.iso_639_language_code, n.TCS, this.option);
			if (r == null) continue;
			let [i, a, o] = r, s = await Qt(a.tokenize(t), q), c = Infinity, l = 0;
			for (let e of s) if (e.tag === "ClearScreen") {
				if (l === 0) continue;
				c = l;
			} else e.tag === "TimeControlWait" && (l += e.seconds);
			this.present.insert(e, {
				pts: e,
				duration: c,
				state: o,
				info: {
					association: i,
					language: n.iso_639_language_code
				},
				data: s
			});
		}
	}
	feed(e, t, n) {
		let r = Rt(e);
		if (r == null || r.tag !== this.option.recieve.type) return;
		let i = Ut(r.data);
		if (i == null) return;
		let a = i.tag === "CaptionStatement" ? i.lang + 1 : 0;
		t += this.option.offset.time, n += this.option.offset.time, this.decoder.insert({
			dts: n,
			lang: a
		}, {
			pts: t,
			caption: i
		});
	}
	prepare(e) {
		this.priviousTime = e;
	}
	content(e) {
		if (this.priviousTime != null) for (let t of this.decoder.range(this.priviousTime, e)) this.notify(t);
		return this.priviousTime = e, this.present.floor(e) ?? null;
	}
	clear() {
		this.decoder.clear(), this.disappearance();
	}
	disappearance() {
		this.present.forEach(sn), this.present.clear(), this.priviousTime = null, this.priviousManagementData = null, this.notify(null);
	}
	onAttach() {
		this.disappearance();
	}
	onDetach() {
		this.disappearance();
	}
	onSeeking() {
		this.disappearance();
	}
	destroy() {
		this.isDestroyed = !0, this.disappearance();
	}
}, ln = class extends cn {
	constructor(e) {
		super(e);
	}
	feedB24(e, t, n) {
		e = e instanceof Uint8Array ? e : new Uint8Array(e), this.feed(e, t, n ?? t);
	}
	feedID3(e, t, n) {
		e = e instanceof Uint8Array ? e : new Uint8Array(e);
		for (let r of Pt(e)) switch (r.id) {
			case "PRIV":
				if (r.owner !== "aribb24.js") break;
				this.feed(r.data, t, n ?? t);
				break;
			case "TXXX":
				if (r.description !== "aribb24.js") break;
				this.feed(At(r.text), t, n ?? t);
				break;
		}
	}
}, un = class e extends cn {
	media = null;
	timer = null;
	privious_time = null;
	id3Tracks = [];
	onAddTrackHandler = this.onAddTrack.bind(this);
	onRemoveTrackHandler = this.onRemoveTrack.bind(this);
	onPlayHandler = this.onPlay.bind(this);
	onPauseHandler = this.onPause.bind(this);
	introspectHandler = this.introspect.bind(this);
	constructor(e) {
		super(e);
	}
	attachMedia(e) {
		this.detachMedia(), this.media = e, this.setupHandlers(), this.registerID3Track();
	}
	detachMedia() {
		this.unregisterID3Track(), this.cleanupHandlers(), this.media = null, this.privious_time = null;
	}
	static isID3Track(e) {
		return e.kind === "metadata" ? e.inBandMetadataTrackDispatchType === "com.apple.streaming" || e.label === "id3" ? !0 : e.label === "Timed Metadata" : !1;
	}
	setupHandlers() {
		this.media != null && (this.media.textTracks.addEventListener("addtrack", this.onAddTrackHandler), this.media.textTracks.addEventListener("removetrack", this.onRemoveTrackHandler), this.media.addEventListener("play", this.onPlayHandler), this.media.addEventListener("pause", this.onPauseHandler));
	}
	cleanupHandlers() {
		this.media != null && (this.media.textTracks.removeEventListener("addtrack", this.onAddTrackHandler), this.media.textTracks.removeEventListener("removetrack", this.onRemoveTrackHandler), this.media.removeEventListener("play", this.onPlayHandler), this.media.removeEventListener("pause", this.onPauseHandler));
	}
	destroy() {
		this.detachMedia();
	}
	registerID3Track() {
		if (this.media != null) for (let t of Array.from(this.media.textTracks)) e.isID3Track(t) && this.id3Tracks.push(t);
	}
	unregisterID3Track() {
		this.id3Tracks = [];
	}
	onAddTrack(t) {
		let n = t.track;
		e.isID3Track(n) && this.id3Tracks.push(n);
	}
	onRemoveTrack(t) {
		let n = t.track;
		e.isID3Track(n) && (this.id3Tracks = this.id3Tracks.filter((e) => e !== n));
	}
	introspect() {
		if (this.registerRenderingLoop(), this.media == null) return;
		let e = this.media.currentTime;
		if (this.privious_time == null) {
			this.privious_time = e;
			return;
		}
		for (let t of this.id3Tracks) {
			let n = Array.from(t.cues ?? []);
			if (n.length === 0) continue;
			let r = null, i = null;
			{
				let e = 0, t = n.length;
				for (; e + 1 < t;) {
					let r = Math.floor((e + t) / 2), i = n[r].startTime;
					this.privious_time < i ? t = r : e = r;
				}
				r = e;
			}
			{
				let t = 0, r = n.length;
				for (; t + 1 < r;) {
					let i = Math.floor((t + r) / 2);
					e < n[i].startTime ? r = i : t = i;
				}
				i = t;
			}
			if (!(r === null || i === null || r === i)) if (r < i) for (let e = i; e > r; e--) this.feedID3v2Cue(n[e]);
			else for (let e = r; e < i; e++) this.feedID3v2Cue(n[e]);
		}
		this.privious_time = e;
	}
	registerRenderingLoop() {
		this.timer = requestAnimationFrame(this.introspectHandler);
	}
	unregisterRenderingLoop() {
		this.timer != null && (cancelAnimationFrame(this.timer), this.timer = null);
	}
	onPlay() {
		this.timer ?? this.registerRenderingLoop();
	}
	onPause() {
		this.unregisterRenderingLoop();
	}
	feedID3v2Cue(e) {
		if (e.track == null) return;
		let t = e;
		e.track.inBandMetadataTrackDispatchType === "com.apple.streaming" || e.track.label === "id3" ? t.value.key === "PRIV" && t.value.info === "aribb24.js" ? this.feed(t.value.data, e.startTime, e.startTime) : t.value.key === "TXXX" && t.value.info === "aribb24.js" && this.feed(At(t.value.data), e.startTime, e.startTime) : e.track.label === "Timed Metadata" && (t.frame.key === "PRIV" && t.frame.owner === "aribb24.js" ? this.feed(t.frame.data, e.startTime, e.startTime) : t.frame.key === "TXXX" && t.frame.description === "aribb24.js" && this.feed(At(t.frame.data), e.startTime, e.startTime));
	}
	feedB24(e, t, n) {
		e = e instanceof Uint8Array ? e : new Uint8Array(e), this.feed(e, t, n ?? t);
	}
	feedID3(e, t, n) {
		e = e instanceof Uint8Array ? e : new Uint8Array(e);
		for (let r of Pt(e)) switch (r.id) {
			case "PRIV":
				if (r.owner !== "aribb24.js") break;
				this.feed(r.data, t, n ?? t);
				break;
			case "TXXX":
				if (r.description !== "aribb24.js") break;
				this.feed(At(r.text), t, n ?? t);
				break;
		}
	}
}, dn = /^(\d\d):(\d\d):(\d\d);(\d\d)$/, fn = 1e-5, pn = (e) => {
	let t = e.match(dn);
	if (t == null) throw new Ke("Unexpected TimeCode");
	let n = Number.parseInt(t[1], 10), r = Number.parseInt(t[2], 10), i = Number.parseInt(t[3], 10), a = Number.parseInt(t[4], 10), o = n * 60 + r;
	return ((n * 60 + r) * 60 + i) * 30 + a - (o - Math.floor(o / 10)) * 2;
}, mn = (e) => Math.floor(e * 3e4 / 1001 + fn), hn = (e) => {
	let t = Math.floor(e / 107892), n = Math.floor((e + 2 * Math.floor((e - 107892 * t) / 1800) - 2 * Math.floor((e - 107892 * t) / 18e3) - 107892 * t) / 1800), r = Math.floor((e - 1798 * n - 2 * Math.floor(n / 10) - 107892 * t) / 30), i = e - 30 * r - 1798 * n - 2 * Math.floor(n / 10) - 107892 * t;
	return `${t.toString(10).padStart(2, "0")}:${n.toString(10).padStart(2, "0")}:${r.toString(10).padStart(2, "0")};${i.toString(10).padStart(2, "0")}`;
}, gn = (e) => Math.ceil(e * 1001 / 3e4 * 1e3) / 1e3, _n = (e) => hn(mn(e)), vn = (e) => gn(pn(e)), yn = (e) => {
	let t = new it(e), n = (t.readU8() & 252) >> 2, r = (n & 32) >> 5, i = n & 15;
	if (t.readU8(), t.readU8(), t.readU16(), i === 0) {
		let e = (t.readU8() & 192) >> 6, n = Ht(t), i = e === K.OFFSETTIME ? {
			timeControlMode: e,
			offsetTime: n
		} : { timeControlMode: e };
		t.readU8();
		let a = [];
		for (let e = 0; e < 1; e++) {
			let e = t.readU8(), n = (e & 224) >> 5, r = e & 15, i = t.readU8(), o = r === 12 || r === 13 || r === 14 ? {
				displayMode: r,
				displayConditionDesignation: i
			} : { displayMode: r }, s = String.fromCharCode(t.readU8(), t.readU8(), t.readU8()), c = t.readU8(), l = (c & 240) >> 4, u = (c & 12) >> 2, d = c & 3;
			a.push({
				...o,
				lang: n,
				iso_639_language_code: s,
				TCS: u,
				format: l,
				rollup: d
			});
		}
		return {
			...i,
			tag: "CaptionManagement",
			group: r,
			languages: a,
			units: []
		};
	} else {
		let e = (t.readU8() & 192) >> 6, n = Ht(t), a = e === K.REALTIME || e === K.OFFSETTIME ? {
			timeControlMode: e,
			presentationStartTime: n
		} : { timeControlMode: e }, o = t.readU24(), s = [], c = 0;
		for (; c < o;) {
			t.readU8();
			let e = t.readU8(), n = t.readU24();
			switch (e) {
				case 32:
					s.push({
						tag: "Statement",
						data: t.read(n)
					});
					break;
				case 48:
					s.push({
						tag: "DRCS",
						bytes: 1,
						data: t.read(n)
					});
					break;
				case 49:
					s.push({
						tag: "DRCS",
						bytes: 2,
						data: t.read(n)
					});
					break;
				case 53:
					s.push({
						tag: "Bitmap",
						data: t.read(n)
					});
					break;
				default:
					t.read(n);
					break;
			}
			c += 5 + n;
		}
		return {
			...a,
			tag: "CaptionStatement",
			group: r,
			lang: i - 1,
			units: s
		};
	}
}, J = {
	TIME: "T",
	FRAME: "F"
}, bn = {
	FREE: "FR",
	REALTIME: "RT",
	OFFSETTIME: "OF"
}, xn = {
	PROGRAM: "0",
	CM: "1",
	CONTENTS: "2",
	SOUND: "3"
}, Sn = {
	NEW: "N",
	RENEW: "R",
	ADDITION: "A",
	NOT_SPECIFIED: " "
}, Cn = {
	AUTO_ENABLED: "0",
	AUTO_DISABLED: "1",
	SELECT: "2",
	SELECT_SPECIFIC: "3"
}, wn = {
	INDEPENDENT: " ",
	COMPLEMENT: "T",
	CAPTION: "C"
}, Tn = {
	CONTINUOUS_TIMECODE: "TC",
	UNCONTINUOUS_TIMECODE: "TU",
	LAPTIME: "LT",
	JST: "JS"
}, En = {
	ASYNC: "A",
	PROGRAM_SYNC: "P",
	TIME_SYNC: "T"
}, Dn = {
	CONTENTS_AND_CM: "0",
	CONTENTS: "1",
	CM: "2",
	SOUND: "3"
}, On = {
	REALTIME: "RT",
	DURATIONTIME: "DT",
	UNTIME: "UT",
	NOT_SPECIFIED: "  "
}, kn = {
	STANDARD: "ST",
	DOUBLE: "DB",
	EUROPEAN: "EL",
	FULLHI: "H2",
	HI: "H1",
	HD: "HD",
	SD: "SD",
	MOBILE: "MB"
}, An = {
	HORIZONTAL: "H",
	VERTICAL: "V"
}, jn = {
	HD: " ",
	SD: "*"
}, Mn = {
	FIXED: "F",
	SCROLL: "S",
	ROLLUP: "R"
}, Nn = {
	HORIZONTAL: "H",
	VERTICAL: "V"
}, Pn = (e) => {
	e = e instanceof Uint8Array ? e : new Uint8Array(e);
	let t = new TextDecoder("shift-jis", { fatal: !0 }), n = new it(e), r = t.decode(n.read(8));
	if (!(r === "DCAPTION" || r === "BCAPTION" || r === "MCAPTION")) throw new j(`Undefined CaptionDataLabel: ${r}`);
	n.read(248);
	let i = n.readU32(), a = new it(n.read(Math.floor((4 + i + 255) / 256) * 256 - 4)), o = t.decode(a.read(6)).trim(), s = t.decode(a.read(27)).trim(), c = t.decode(a.read(40)).trim(), l = t.decode(a.read(40)).trim(), u = String.fromCharCode(a.readU8());
	switch (u) {
		case xn.PROGRAM:
		case xn.CM:
		case xn.CONTENTS:
		case xn.SOUND: break;
		default: throw new j(`Undefined programMaterialType: ${u}`);
	}
	let d = String.fromCharCode(a.readU8());
	switch (d) {
		case Sn.NEW:
		case Sn.RENEW:
		case Sn.ADDITION:
		case Sn.NOT_SPECIFIED: break;
		default: throw new j(`Undefined registrationMode: ${d}`);
	}
	let f = t.decode(a.read(3)), p = String.fromCharCode(a.readU8());
	switch (p) {
		case Cn.AUTO_ENABLED:
		case Cn.AUTO_DISABLED:
		case Cn.SELECT:
		case Cn.SELECT_SPECIFIC: break;
		default: throw new j(`Undefined displayMode: ${p}`);
	}
	let m = String.fromCharCode(a.readU8());
	switch (m) {
		case Cn.AUTO_ENABLED:
		case Cn.AUTO_DISABLED:
		case Cn.SELECT:
		case Cn.SELECT_SPECIFIC: break;
		default: throw new j(`Undefined displayMode: ${m}`);
	}
	let h = `${p}${m}`, g = String.fromCharCode(a.readU8());
	switch (g) {
		case wn.INDEPENDENT:
		case wn.COMPLEMENT:
		case wn.CAPTION: break;
		default: throw new j(`Undefined programType: ${g}`);
	}
	let _ = String.fromCharCode(a.readU8());
	if (_ !== "*" && _ !== " ") throw new j(`Undefined sound: ${_}`);
	let v = _ === "*", ee = Number.parseInt(String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8()), 10), te = Number.parseInt(String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), 10), ne = String.fromCharCode(a.readU8());
	if (ne !== "*" && ne !== " ") throw new j(`Undefined untime: ${ne}`);
	let re = ne === "*", ie = String.fromCharCode(a.readU8(), a.readU8());
	switch (ie) {
		case Tn.CONTINUOUS_TIMECODE:
		case Tn.UNCONTINUOUS_TIMECODE:
		case Tn.LAPTIME:
		case Tn.JST: break;
		default: throw new j(`Undefined realtimeTimingType: ${ie}`);
	}
	let y = String.fromCharCode(a.readU8());
	switch (y) {
		case J.TIME:
		case J.FRAME: break;
		default: throw new j(`Undefined TimingUnitType: ${y}`);
	}
	let ae = String.fromCharCode(a.readU8(), a.readU8()), oe = String.fromCharCode(a.readU8(), a.readU8()), se = String.fromCharCode(a.readU8(), a.readU8()), ce = String.fromCharCode(a.readU8(), a.readU8());
	a.readU8();
	let le = y === "F" ? vn(`${ae}:${oe}:${se};${ce}`) : (Number.parseInt(ae, 10) * 60 + Number.parseInt(oe, 10)) * 60 + Number.parseInt(se, 10) + Number.parseInt(ce, 10) / 100, b = String.fromCharCode(a.readU8());
	switch (b) {
		case En.ASYNC:
		case En.PROGRAM_SYNC:
		case En.TIME_SYNC: break;
		default: throw new j(`Undefined syncronizationMode: ${b}`);
	}
	let ue = String.fromCharCode(a.readU8(), a.readU8());
	switch (ue) {
		case bn.FREE:
		case bn.REALTIME:
		case bn.OFFSETTIME: break;
		default: throw new j(`Undefined timeControlMode: ${ue}`);
	}
	let x = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8());
	if (/[^* ]/.test(x)) throw new j(`Undefined extensible: ${x}`);
	let de = [
		x[0] === "*",
		x[1] === "*",
		x[2] === "*",
		x[3] === "*",
		x[4] === "*",
		x[5] === "*",
		x[6] === "*",
		x[7] === "*"
	], S = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8());
	if (/[^* ]/.test(S)) throw new j(`Undefined extensible: ${S}`);
	let fe = [
		S[0] === "*",
		S[1] === "*",
		S[2] === "*",
		S[3] === "*",
		S[4] === "*",
		S[5] === "*",
		S[6] === "*",
		S[7] === "*"
	], C = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), pe = C === "        " ? null : [
		Number.parseInt(C.slice(0, 4), 10),
		Number.parseInt(C.slice(4, 6), 10),
		Number.parseInt(C.slice(6, 8), 10)
	], me = t.decode(a.read(20)).trim(), w = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), he = w === "            " ? null : [
		Number.parseInt(w.slice(0, 4), 10),
		Number.parseInt(w.slice(4, 6), 10),
		Number.parseInt(w.slice(6, 8), 10),
		Number.parseInt(w.slice(8, 10), 10),
		Number.parseInt(w.slice(10, 12), 10)
	], T = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), ge = T === "        " ? null : [
		Number.parseInt(T.slice(0, 4), 10),
		Number.parseInt(T.slice(4, 6), 10),
		Number.parseInt(T.slice(6, 8), 10)
	], E = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), _e = E === "        " ? null : [
		Number.parseInt(E.slice(0, 4), 10),
		Number.parseInt(E.slice(4, 6), 10),
		Number.parseInt(E.slice(6, 8), 10)
	], D = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8());
	if (/[^* ]/.test(D)) throw new j(`Undefined broadcastDaysOfWeek: ${D}`);
	let ve = [
		D[0] === "*",
		D[1] === "*",
		D[2] === "*",
		D[3] === "*",
		D[4] === "*",
		D[5] === "*",
		D[6] === "*"
	], ye = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), be = ye === "      " ? null : [
		Number.parseInt(ye.slice(0, 2), 10),
		Number.parseInt(ye.slice(2, 4), 10),
		Number.parseInt(ye.slice(4, 6), 10)
	], O = String.fromCharCode(a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8(), a.readU8()), xe = O === "      " ? null : [
		Number.parseInt(O.slice(0, 2), 10),
		Number.parseInt(O.slice(2, 4), 10),
		Number.parseInt(O.slice(4, 6), 10)
	], Se = t.decode(a.read(60)).trim();
	a.read(45);
	let k = String.fromCharCode(a.readU8());
	if (k !== "*" && k !== " ") throw new j(`Undefined completed: ${k}`);
	let Ce = k === "*", we = String.fromCharCode(a.readU8());
	if (we !== "*" && we !== " ") throw new j(`Undefined usersAreaUsed: ${we}`);
	let Te = we === "*", Ee = Te ? {
		usersAreaUsed: Te,
		writingFormatConversionMode: a.readU8(),
		drcsConversionMode: (a.readU8() & 192) >> 6
	} : { usersAreaUsed: Te }, De = [];
	for (; !n.isEmpty();) {
		let e = n.readU32(), r = n.read(Math.floor((4 + e + 255) / 256) * 256 - 4), i = new DataView(r.buffer, r.byteOffset, 4 + e), a = 0;
		if (i.byteLength < a + 1 + 2) continue;
		let o = i.getUint16(a + 1, !1);
		if (a += 3, i.byteLength < a + o) continue;
		let s = new it(r.subarray(a, a + o)), c = String.fromCharCode(s.readU8(), s.readU8(), s.readU8(), s.readU8(), s.readU8(), s.readU8()), l = String.fromCharCode(s.readU8());
		switch (l) {
			case Dn.CONTENTS_AND_CM:
			case Dn.CONTENTS:
			case Dn.CM:
			case Dn.SOUND: break;
			default: throw new j(`Undefined PageMaterialType: ${l}`);
		}
		let u = String.fromCharCode(s.readU8(), s.readU8());
		switch (u) {
			case On.REALTIME:
			case On.DURATIONTIME:
			case On.UNTIME:
			case On.NOT_SPECIFIED: break;
			default: throw new j(`Undefined DisplayTimingType: ${u}`);
		}
		let d = String.fromCharCode(s.readU8());
		switch (d) {
			case J.TIME:
			case J.FRAME: break;
			default: throw new j(`Undefined TimingUnitType: ${d}`);
		}
		let f = String.fromCharCode(s.readU8(), s.readU8()), p = String.fromCharCode(s.readU8(), s.readU8()), m = String.fromCharCode(s.readU8(), s.readU8()), h = String.fromCharCode(s.readU8(), s.readU8());
		s.readU8();
		let g = d === "F" ? vn(`${f}:${p}:${m};${h}`) : (Number.parseInt(f, 10) * 60 + Number.parseInt(p, 10)) * 60 + Number.parseInt(m, 10) + Number.parseInt(h, 10) / 100, _ = String.fromCharCode(s.readU8(), s.readU8()), v = String.fromCharCode(s.readU8(), s.readU8()), ee = String.fromCharCode(s.readU8(), s.readU8()), te = String.fromCharCode(s.readU8(), s.readU8()), ne = `${_}${v}${ee}${te}`;
		s.readU8();
		let re = ne === "        " ? Infinity : d === "F" ? vn(`${_}:${v}:${ee};${te}`) : (Number.parseInt(_, 10) * 60 + Number.parseInt(v, 10)) * 60 + Number.parseInt(ee, 10) + Number.parseInt(te, 10) / 100, ie = String.fromCharCode(s.readU8(), s.readU8());
		switch (ie) {
			case bn.FREE:
			case bn.REALTIME:
			case bn.OFFSETTIME: break;
			default: throw new j(`Undefined timeControlMode: ${ie}`);
		}
		let y = String.fromCharCode(s.readU8(), s.readU8(), s.readU8());
		if (y !== "OFF" && y !== "   ") throw new j(`Undefined clearScreen: ${y}`);
		let ae = y === "OFF", oe = String.fromCharCode(s.readU8(), s.readU8());
		switch (oe) {
			case kn.STANDARD:
			case kn.DOUBLE:
			case kn.EUROPEAN:
			case kn.FULLHI:
			case kn.HI:
			case kn.HD:
			case kn.SD:
			case kn.MOBILE: break;
			default: throw new j(`Undefined formatDensity: ${oe}`);
		}
		let se = String.fromCharCode(s.readU8());
		switch (se) {
			case An.HORIZONTAL:
			case An.VERTICAL: break;
			default: throw new j(`Undefined formatWritingMode: ${se}`);
		}
		let ce = `${oe}${se}`, le = String.fromCharCode(s.readU8());
		switch (le) {
			case jn.HD:
			case jn.SD: break;
			default: throw new j(`Undefined displayAspectRatio: ${le}`);
		}
		let b = String.fromCharCode(s.readU8(), s.readU8(), s.readU8(), s.readU8()), ue = String.fromCharCode(s.readU8(), s.readU8(), s.readU8(), s.readU8()), x = String.fromCharCode(s.readU8(), s.readU8(), s.readU8(), s.readU8()), de = String.fromCharCode(s.readU8(), s.readU8(), s.readU8(), s.readU8()), S = b !== "    " && ue !== "    " && x !== "    " && de !== "    " ? [[Number.parseInt(b, 10), Number.parseInt(ue, 10)], [Number.parseInt(x, 10), Number.parseInt(de, 10)]] : null, fe = String.fromCharCode(s.readU8());
		switch (fe) {
			case Mn.FIXED:
			case Mn.SCROLL:
			case Mn.ROLLUP: break;
			default: throw new j(`Undefined scrollType: ${fe}`);
		}
		let C = String.fromCharCode(s.readU8());
		switch (C) {
			case Nn.HORIZONTAL:
			case Nn.VERTICAL: break;
			default: throw new j(`Undefined scrollDirectionType: ${C}`);
		}
		let pe = String.fromCharCode(s.readU8());
		if (pe !== "*" && pe !== " ") throw new j(`Undefined sound: ${pe}`);
		let me = pe === "*", w = Number.parseInt(String.fromCharCode(s.readU8(), s.readU8(), s.readU8(), s.readU8(), s.readU8()), 10), he = String.fromCharCode(s.readU8(), s.readU8(), s.readU8());
		if (he !== "ERS" && he !== "   ") throw new j(`Undefined deleted: ${he}`);
		let T = he === "ERS", ge = t.decode(s.read(20)).trim();
		s.read(32);
		let E = String.fromCharCode(s.readU8());
		if (E !== "*" && E !== " ") throw new j(`Undefined completed: ${E}`);
		let _e = E === "*", D = String.fromCharCode(s.readU8());
		if (D !== "*" && D !== " ") throw new j(`Undefined sound: ${D}`);
		let ve = D === "*", ye = ve ? {
			usersAreaUsed: ve,
			writingFormatConversionMode: s.readU8(),
			drcsConversionMode: (s.readU8() & 192) >> 6
		} : { usersAreaUsed: ve }, be = {
			pageMaterialType: l,
			displayTimingType: u,
			timingUnitType: d,
			displayTiming: g,
			clearTiming: re,
			timeControlMode: ie,
			clearScreen: ae,
			displayFormat: ce,
			displayAspectRatio: le,
			displayWindowArea: S,
			scrollType: fe,
			scrollDirectionType: C,
			sound: me,
			pageDataBytes: w,
			deleted: T,
			memo: ge,
			completed: _e
		};
		if (a += o, i.byteLength < a + 1 + 2) continue;
		let O = i.getUint16(a + 1, !1);
		if (a += 3, i.byteLength < a + O) continue;
		let xe = yn(r.subarray(a, a + O));
		if (xe == null || xe.tag !== "CaptionManagement") continue;
		if (c === "000000") {
			De.push({
				...be,
				...ye,
				pageNumber: c,
				tag: "ReservedPage",
				management: xe
			});
			continue;
		}
		if (a += O, i.byteLength < a + 1 + 3) continue;
		let Se = i.getUint16(a + 1, !1) << 8 | i.getUint8(a + 3);
		if (a += 4, i.byteLength < a + Se) continue;
		let k = yn(r.subarray(a, a + Se));
		k == null || k.tag !== "CaptionStatement" || De.push({
			...be,
			...ye,
			tag: "ActualPage",
			pageNumber: c,
			management: xe,
			statement: k
		});
	}
	return {
		label: r,
		broadcasterIdentification: o,
		materialNumber: s,
		programTitle: c,
		programSubtitle: l,
		programMaterialType: u,
		registrationMode: d,
		languageCode: f,
		displayMode: h,
		programType: g,
		sound: v,
		totalPages: ee,
		totalBytes: te,
		untime: re,
		realtimeTimingType: ie,
		timingUnitType: y,
		initialTime: le,
		syncronizationMode: b,
		timeControlMode: ue,
		extensible: de,
		compatible: fe,
		expireDate: pe,
		author: me,
		creationDateTime: he,
		broadcastStartDate: ge,
		broadcastEndDate: _e,
		broadcastDaysOfWeek: ve,
		broadcastStartTime: be,
		broadcastEndTime: xe,
		memo: Se,
		completed: Ce,
		...Ee,
		pages: De
	};
}, Fn = class {
	option;
	captions;
	constructor(e, t) {
		e = e instanceof Uint8Array ? e : new Uint8Array(e), this.option = Tt.from(t);
		let { initialTime: n, pages: r } = Pn(e);
		this.captions = r.filter((e) => e.tag === "ActualPage").flatMap((e) => {
			let t = e.displayTiming - n + this.option.offset.time, r = e.clearTiming - n + this.option.offset.time - t, i = e.statement, a = e.management.languages.find((e) => e.lang === i.lang);
			if (a == null) return [];
			let o = Et(a.iso_639_language_code, a.TCS, this.option);
			if (o == null) return [];
			let [s, c, l] = o, u = $t(c.tokenize(i));
			return [{
				pts: t,
				duration: r,
				state: l,
				info: {
					association: s,
					language: a.iso_639_language_code
				},
				data: u
			}];
		});
	}
	prepare(e) {}
	content(e) {
		{
			let t = this.captions[0];
			if (!t || e < t.pts) return null;
		}
		let t = 0, n = this.captions.length;
		for (; t + 1 < n;) {
			let r = Math.floor((t + n) / 2);
			this.captions[r].pts <= e ? t = r : n = r;
		}
		return this.captions[t] ?? null;
	}
	clear() {
		this.captions = [];
	}
	onAttach() {}
	onDetach() {}
	onSeeking() {}
	destroy() {
		this.clear();
	}
}, In = class {
	media = null;
	track = null;
	recognition;
	recognitionTime = null;
	interim = "";
	privious = "";
	endedHandler = this.capture.bind(this);
	clearHandler = this.clear.bind(this);
	recognitionEndHandler = this.recognitionEnd.bind(this);
	recognitionResultHandler = this.recognitionResult.bind(this);
	constructor(e = "ja-JP") {
		this.recognition = new (globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition)(), this.recognition.lang = e, this.recognition.interimResults = !0, this.recognition.mode = "ondevice-only", this.recognition.addEventListener("end", this.recognitionEndHandler), this.recognition.addEventListener("error", this.clearHandler), this.recognition.addEventListener("result", this.recognitionResultHandler);
	}
	attachMedia(e) {
		this.detachMedia(), this.media = e, this.media.addEventListener("ended", this.endedHandler), this.media.readyState >= HTMLMediaElement.HAVE_METADATA ? this.capture() : this.media.addEventListener("loadedmetadata", this.endedHandler, { once: !0 });
	}
	detachMedia() {
		this.media != null && (this.media.removeEventListener("ended", this.endedHandler), this.media = null);
	}
	abort() {
		this.recognition.abort();
	}
	recognitionEnd() {
		this.track != null && (this.interim !== "" && (this.privious = this.interim, this.interim = ""), this.recognition.start(this.track));
	}
	recognitionResult(e) {
		if (this.media == null) return;
		let t = e.results;
		this.interim = Array.from(t).map((e) => e[0].transcript).join(""), this.recognitionTime = this.media.currentTime;
	}
	capture() {
		this.media != null && (this.track = this.media.captureStream().getAudioTracks()[0], this.recognition.start(this.track));
	}
	clear() {
		this.recognitionTime = null, this.privious = "", this.interim = "";
	}
	onAttach() {
		this.clear();
	}
	onDetach() {
		this.clear();
	}
	onSeeking() {
		this.abort(), this.clear();
	}
	destroy() {
		this.abort(), this.recognition.removeEventListener("end", this.recognitionEndHandler), this.recognition.removeEventListener("error", this.clearHandler), this.recognition.removeEventListener("result", this.recognitionResultHandler), this.clear();
	}
	prepare(e) {}
	content(e) {
		if (this.media == null || this.recognitionTime == null) return null;
		let t = this.privious + (this.privious === "" ? "" : "\n") + this.interim, n = [""];
		for (let e of t) n[n.length - 1].length >= 18 && n.push(""), e == "\n" ? n.push("") : n[n.length - 1] += e;
		let r = (n.length >= 2 ? n[n.length - 2] : "").trim(), a = (n.length >= 1 ? n[n.length - 1] : "").trim(), o = [
			m.from(),
			Ae.from(7),
			je.from(780, 480),
			Me.from(118, 29),
			Pe.from(4),
			Fe.from(24),
			Ne.from(36, 36),
			x.from(),
			v.from(0, 6),
			b.from(),
			he.from(4),
			pe.from(1),
			de.from(),
			...Array.from(r).map((e) => i.from(e)),
			...r === "" ? [] : [h.from()],
			...Array.from(a).map((e) => i.from(e))
		];
		return {
			pts: this.recognitionTime,
			duration: Infinity,
			state: tt,
			info: {
				association: "ARIB",
				language: "und"
			},
			data: o
		};
	}
}, Ln = { from(e) {
	return { ...e };
} }, Rn = { from(e) {
	return {
		font: {
			normal: "'Hiragino Maru Gothic Pro', 'BIZ UDGothic', 'Yu Gothic Medium', sans-serif",
			...e?.font
		},
		replace: {
			half: !0,
			drcs: /* @__PURE__ */ new Map(),
			glyph: /* @__PURE__ */ new Map(),
			...e?.replace
		},
		color: {
			stroke: null,
			foreground: null,
			background: null,
			...e?.color
		},
		resize: {
			target: "container",
			objectFit: "contain",
			...e?.resize
		}
	};
} }, zn = class {
	option;
	canvas;
	constructor(e) {
		this.option = Rn.from(e), this.canvas = document.createElement("canvas"), this.canvas.style.position = "absolute", this.canvas.style.top = this.canvas.style.left = "0", this.canvas.style.pointerEvents = "none", this.canvas.style.width = "100%", this.canvas.style.height = "100%";
	}
	hide() {
		this.canvas.style.visibility = "hidden";
	}
	show() {
		this.canvas.style.visibility = "visible";
	}
	onAttach(e) {
		e.appendChild(this.canvas);
	}
	onDetach() {
		this.canvas.remove();
	}
	onContainerResize(e, t) {
		return this.option.resize.target === "container" ? (this.clear(), this.resize(e, t), !0) : !1;
	}
	onVideoResize(e, t) {
		return this.option.resize.target === "video" ? (this.clear(), this.resize(e, t), !0) : !1;
	}
	onPlay() {}
	onPause() {}
	onSeeking() {
		this.clear();
	}
}, Bn = new Map([
	["０", "0"],
	["１", "1"],
	["２", "2"],
	["３", "3"],
	["４", "4"],
	["５", "5"],
	["６", "6"],
	["７", "7"],
	["８", "8"],
	["９", "9"],
	["ａ", "a"],
	["ｂ", "b"],
	["ｃ", "c"],
	["ｄ", "d"],
	["ｅ", "e"],
	["ｆ", "f"],
	["ｇ", "g"],
	["ｈ", "h"],
	["ｉ", "i"],
	["ｊ", "j"],
	["ｋ", "k"],
	["ｌ", "l"],
	["ｍ", "m"],
	["ｎ", "n"],
	["ｏ", "o"],
	["ｐ", "p"],
	["ｑ", "q"],
	["ｒ", "r"],
	["ｓ", "s"],
	["ｔ", "t"],
	["ｕ", "u"],
	["ｖ", "v"],
	["ｗ", "w"],
	["ｘ", "x"],
	["ｙ", "y"],
	["ｚ", "z"],
	["Ａ", "A"],
	["Ｂ", "B"],
	["Ｃ", "C"],
	["Ｄ", "D"],
	["Ｅ", "E"],
	["Ｆ", "F"],
	["Ｇ", "G"],
	["Ｈ", "H"],
	["Ｉ", "I"],
	["Ｊ", "J"],
	["Ｋ", "K"],
	["Ｌ", "L"],
	["Ｍ", "M"],
	["Ｎ", "N"],
	["Ｏ", "O"],
	["Ｐ", "P"],
	["Ｑ", "Q"],
	["Ｒ", "R"],
	["Ｓ", "S"],
	["Ｔ", "T"],
	["Ｕ", "U"],
	["Ｖ", "V"],
	["Ｗ", "W"],
	["Ｘ", "X"],
	["Ｙ", "Y"],
	["Ｚ", "Z"],
	["　", " "],
	["！", "!"],
	["＂", "\""],
	["＃", "#"],
	["＄", "$"],
	["％", "%"],
	["＆", "&"],
	["＇", "'"],
	["（", "("],
	["）", ")"],
	["＊", "*"],
	["＋", "+"],
	["，", ","],
	["－", "-"],
	["．", "."],
	["／", "/"],
	["：", ":"],
	["；", ";"],
	["＜", "<"],
	["＝", "="],
	["＞", ">"],
	["？", "?"],
	["＠", "@"],
	["［", "["],
	["＼", "\\"],
	["］", "]"],
	["＾", "^"],
	["＿", "_"],
	["｀", "`"],
	["｛", "{"],
	["｜", "|"],
	["｝", "}"],
	["～", "~"],
	["ー", "ｰ"],
	["、", "､"],
	["。", "｡"],
	["・", "･"],
	["「", "｢"],
	["」", "｣"],
	["｟", "⦅"],
	["｠", "⦆"],
	["￠", "¢"],
	["￡", "£"],
	["￢", "¬"],
	["￣", "¯"],
	["￤", "¦"],
	["￥", "¥"],
	["￦", "₩"],
	["│", "￨"],
	["←", "￩"],
	["↑", "￪"],
	["→", "￫"],
	["↓", "￬"],
	["■", "￭"],
	["○", "￮"]
]), Vn = new Map([
	["black", "#000000FF"],
	["silver", "#C0C0C0FF"],
	["gray", "#808080FF"],
	["white", "#FFFFFFFF"],
	["maroon", "#800000FF"],
	["red", "#FF0000FF"],
	["purple", "#800080FF"],
	["fuchsia", "#FF00FFFF"],
	["green", "#008000FF"],
	["lime", "#00FF00FF"],
	["olive", "#808000FF"],
	["yellow", "#FFFF00FF"],
	["navy", "#000080FF"],
	["blue", "#0000FFFF"],
	["teal", "#008080FF"],
	["aqua", "#00FFFFFF"],
	["orange", "#FFA500FF"],
	["aliceblue", "#F0F8FFFF"],
	["antiquewhite", "#FAEBD7FF"],
	["aquamarine", "#7FFFD4FF"],
	["azure", "#F0FFFFFF"],
	["beige", "#F5F5DCFF"],
	["bisque", "#FFE4C4FF"],
	["blanchedalmond", "#FFEBCDFF"],
	["blueviolet", "#8A2BE2FF"],
	["brown", "#A52A2AFF"],
	["burlywood", "#DEB887FF"],
	["cadetblue", "#5F9EA0FF"],
	["chartreuse", "#7FFF00FF"],
	["chocolate", "#D2691EFF"],
	["coral", "#FF7F50FF"],
	["cornflowerblue", "#6495EDFF"],
	["cornsilk", "#FFF8DCFF"],
	["crimson", "#DC143CFF"],
	["cyan", "#00FFFFFF"],
	["aqua", "#00FFFFFF"],
	["darkblue", "#00008BFF"],
	["darkcyan", "#008B8BFF"],
	["darkgoldenrod", "#B8860BFF"],
	["darkgray", "#A9A9A9FF"],
	["darkgreen", "#006400FF"],
	["darkgrey", "#A9A9A9FF"],
	["darkkhaki", "#BDB76BFF"],
	["darkmagenta", "#8B008BFF"],
	["darkolivegreen", "#556B2FFF"],
	["darkorange", "#FF8C00FF"],
	["darkorchid", "#9932CCFF"],
	["darkred", "#8B0000FF"],
	["darksalmon", "#E9967AFF"],
	["darkseagreen", "#8FBC8FFF"],
	["darkslateblue", "#483D8BFF"],
	["darkslategray", "#2F4F4FFF"],
	["darkslategrey", "#2F4F4FFF"],
	["darkturquoise", "#00CED1FF"],
	["darkviolet", "#9400D3FF"],
	["deeppink", "#FF1493FF"],
	["deepskyblue", "#00BFFFFF"],
	["dimgray", "#696969FF"],
	["dimgrey", "#696969FF"],
	["dodgerblue", "#1E90FFFF"],
	["firebrick", "#B22222FF"],
	["floralwhite", "#FFFAF0FF"],
	["forestgreen", "#228B22FF"],
	["gainsboro", "#DCDCDCFF"],
	["ghostwhite", "#F8F8FFFF"],
	["gold", "#FFD700FF"],
	["goldenrod", "#DAA520FF"],
	["greenyellow", "#ADFF2FFF"],
	["grey", "#808080FF"],
	["honeydew", "#F0FFF0FF"],
	["hotpink", "#FF69B4FF"],
	["indianred", "#CD5C5CFF"],
	["indigo", "#4B0082FF"],
	["ivory", "#FFFFF0FF"],
	["khaki", "#F0E68CFF"],
	["lavender", "#E6E6FAFF"],
	["lavenderblush", "#FFF0F5FF"],
	["lawngreen", "#7CFC00FF"],
	["lemonchiffon", "#FFFACDFF"],
	["lightblue", "#ADD8E6FF"],
	["lightcoral", "#F08080FF"],
	["lightcyan", "#E0FFFFFF"],
	["lightgoldenrodyellow", "#FAFAD2FF"],
	["lightgray", "#D3D3D3FF"],
	["lightgreen", "#90EE90FF"],
	["lightgrey", "#D3D3D3FF"],
	["lightpink", "#FFB6C1FF"],
	["lightsalmon", "#FFA07AFF"],
	["lightseagreen", "#20B2AAFF"],
	["lightskyblue", "#87CEFAFF"],
	["lightslategray", "#778899FF"],
	["lightslategrey", "#778899FF"],
	["lightsteelblue", "#B0C4DEFF"],
	["lightyellow", "#FFFFE0FF"],
	["limegreen", "#32CD32FF"],
	["linen", "#FAF0E6FF"],
	["magenta", "#FF00FFFF"],
	["fuchsia", "#FF00FFFF"],
	["mediumaquamarine", "#66CDAAFF"],
	["mediumblue", "#0000CDFF"],
	["mediumorchid", "#BA55D3FF"],
	["mediumpurple", "#9370DBFF"],
	["mediumseagreen", "#3CB371FF"],
	["mediumslateblue", "#7B68EEFF"],
	["mediumspringgreen", "#00FA9AFF"],
	["mediumturquoise", "#48D1CCFF"],
	["mediumvioletred", "#C71585FF"],
	["midnightblue", "#191970FF"],
	["mintcream", "#F5FFFAFF"],
	["mistyrose", "#FFE4E1FF"],
	["moccasin", "#FFE4B5FF"],
	["navajowhite", "#FFDEADFF"],
	["oldlace", "#FDF5E6FF"],
	["olivedrab", "#6B8E23FF"],
	["orangered", "#FF4500FF"],
	["orchid", "#DA70D6FF"],
	["palegoldenrod", "#EEE8AAFF"],
	["palegreen", "#98FB98FF"],
	["paleturquoise", "#AFEEEEFF"],
	["palevioletred", "#DB7093FF"],
	["papayawhip", "#FFEFD5FF"],
	["peachpuff", "#FFDAB9FF"],
	["peru", "#CD853FFF"],
	["pink", "#FFC0CBFF"],
	["plum", "#DDA0DDFF"],
	["powderblue", "#B0E0E6FF"],
	["rosybrown", "#BC8F8FFF"],
	["royalblue", "#4169E1FF"],
	["saddlebrown", "#8B4513FF"],
	["salmon", "#FA8072FF"],
	["sandybrown", "#F4A460FF"],
	["seagreen", "#2E8B57FF"],
	["seashell", "#FFF5EEFF"],
	["sienna", "#A0522DFF"],
	["skyblue", "#87CEEBFF"],
	["slateblue", "#6A5ACDFF"],
	["slategray", "#708090FF"],
	["slategrey", "#708090FF"],
	["snow", "#FFFAFAFF"],
	["springgreen", "#00FF7FFF"],
	["steelblue", "#4682B4FF"],
	["tan", "#D2B48CFF"],
	["thistle", "#D8BFD8FF"],
	["tomato", "#FF6347FF"],
	["turquoise", "#40E0D0FF"],
	["violet", "#EE82EEFF"],
	["wheat", "#F5DEB3FF"],
	["whitesmoke", "#F5F5F5FF"],
	["yellowgreen", "#9ACD32FF"],
	["rebeccapurple", "#663399FF"],
	["transparent", "#00000000"]
]), Hn = (e, t) => t.association === "SBTVD" && e === P.Small || e === P.Middle, Un = /* @__PURE__ */ new Set([]);
for (let e = 122; e < 127; e++) for (let t = 33; t < 127; t++) {
	let n = e << 8 | t;
	if (!mt.has(n)) continue;
	let r = mt.get(n);
	switch (r) {
		case "年":
		case "月":
		case "日":
		case "円": break;
		default:
			Un.add(r);
			break;
	}
}
for (let e = 122; e < 127; e++) for (let t = 33; t < 127; t++) {
	let n = e << 8 | t;
	if (!ht.has(n)) continue;
	let r = ht.get(n);
	switch (r) {
		case "年":
		case "月":
		case "日":
		case "円": break;
		default:
			Un.add(r);
			break;
	}
}
var Wn = (e) => !!Un.has(e), Gn = (e, t, n, r, i, a) => {
	let o = e.getContext("2d");
	if (o != null) for (let s of r) switch (s.tag) {
		case "Character":
			Xn(o, s, t, n, i, a);
			break;
		case "DRCS":
			Qn(o, s, t, n, i, a);
			break;
		case "ClearScreen":
			s.time === 0 && o.clearRect(0, 0, e.width, e.height);
			break;
		case "Bitmap": break;
		default: throw new M(s, "Unexpected ARIB Parsed Token in CanvasRenderingStrategy");
	}
}, Kn = (e, t, n, r, i) => {
	let { state: a } = t;
	e.clearRect((a.margin[0] + (a.position[0] + 0) - 0) * n[0], (a.margin[1] + (a.position[1] + 1) - F.box(a)[1]) * n[1], F.box(a)[0] * n[0], F.box(a)[1] * n[1]);
}, qn = (e, t, n, r, i) => {
	let { state: a } = t;
	e.fillStyle = i.color.background ?? q[a.background], e.fillRect((a.margin[0] + (a.position[0] + 0) - 0) * n[0], (a.margin[1] + (a.position[1] + 1) - F.box(a)[1]) * n[1], F.box(a)[0] * n[0], F.box(a)[1] * n[1]);
}, Jn = (e, t, n, r, i) => {
	let { state: a, option: o } = t, s = (a.margin[0] + (a.position[0] + 0) + 0) * n[0], c = (a.margin[1] + (a.position[1] + 1) - F.box(a)[1]) * n[1];
	e.translate(s, c), e.scale(n[0], n[1]), e.fillStyle = i.color.foreground ?? q[a.foreground], a.highlight & 1 && e.fillRect(0, F.box(a)[1] - 1 * o.magnification, F.box(a)[0], 1 * o.magnification), a.highlight & 2 && e.fillRect(F.box(a)[0] - 1 * o.magnification, 0, 1 * o.magnification, F.box(a)[1]), a.highlight & 4 && e.fillRect(0, 0, F.box(a)[0], 1 * o.magnification), a.highlight & 8 && e.fillRect(0, 0, 1 * o.magnification, F.box(a)[1]), e.setTransform(1, 0, 0, 1, 0, 0);
}, Yn = (e, t, n, r, i) => {
	let { state: a, option: o } = t;
	if (!a.underline) return;
	let s = (a.margin[0] + (a.position[0] + 0) + 0) * n[0], c = (a.margin[1] + (a.position[1] + 1) - F.box(a)[1]) * n[1];
	e.translate(s, c), e.scale(n[0], n[1]), e.fillStyle = i.color.foreground ?? q[a.foreground], e.fillRect(0, F.box(a)[1] - 1 * o.magnification, F.box(a)[0], 1 * o.magnification), e.setTransform(1, 0, 0, 1, 0, 0);
}, Xn = (e, t, n, r, i, a) => {
	let { state: o, option: s, character: c, non_spacing: l } = t, u = Hn(o.size, i), d = a.replace.half && u && Bn.has(c) ? Bn.get(c) : c;
	l || (Kn(e, t, r, i, a), qn(e, t, r, i, a), Jn(e, t, r, i, a), Yn(e, t, r, i, a));
	let f = (a.color.stroke == null ? null : Vn.get(a.color.stroke) ?? a.color.stroke) ?? (o.ornament == null ? null : q[o.ornament]), p = a.color.foreground ?? q[o.foreground];
	if (a.replace.glyph.has(d)) {
		let t = Math.floor((o.margin[0] + (o.position[0] + 0) + 0 + F.offset(o)[0]) * r[0]), i = Math.floor((o.margin[1] + (o.position[1] + 1) - F.box(o)[1] + F.offset(o)[1]) * r[1]);
		e.translate(t, i);
		let { viewBox: c, path: l } = a.replace.glyph.get(d), u = new n(l), [m, h, g, _] = c, v = g - m, ee = _ - h;
		e.scale(r[0] * o.fontsize[0] / v, r[1] * o.fontsize[1] / ee), e.translate(m, h), f !== null && f !== p && (e.strokeStyle = f, e.lineJoin = "round", e.lineWidth = 4 * Math.max(v / o.fontsize[0], ee / o.fontsize[1]) * s.magnification, e.stroke(u)), e.fillStyle = p, e.fill(u), e.setTransform(1, 0, 0, 1, 0, 0);
		return;
	}
	let m = Math.floor((o.margin[0] + (o.position[0] + 0) + F.box(o)[0] / 2) * r[0]), h = Math.floor((o.margin[1] + (o.position[1] + 1) - F.box(o)[1] / 2) * r[1]);
	e.translate(m, h);
	let g = Wn(d) ? a.font.arib ?? a.font.normal : a.font.normal;
	e.scale(r[0] * 1, F.scale(o)[1] * r[1]), f !== null && f !== p && (e.font = `${o.fontsize[0]}px ${g}`, e.strokeStyle = f, e.lineJoin = "round", e.textBaseline = "middle", e.textAlign = "center", e.lineWidth = 4 * s.magnification, e.strokeText(d, 0, 0, o.fontsize[0] * F.scale(o)[0])), e.font = `${o.fontsize[0]}px ${g}`, e.fillStyle = p, e.textBaseline = "middle", e.textAlign = "center", e.fillText(d, 0, 0, o.fontsize[0] * F.scale(o)[0]), e.setTransform(1, 0, 0, 1, 0, 0);
}, Zn = (e, t, n, r, i, a) => {
	let { state: o, option: s, width: c, height: l, depth: u, binary: d } = t, f = new Uint8Array(d), p = (o.margin[0] + o.position[0] + (0 + F.offset(o)[0])) * r[0], m = (o.margin[1] + o.position[1] + (1 - F.box(o)[1] + F.offset(o)[1])) * r[1];
	e.translate(p, m), e.scale(s.magnification * r[0], s.magnification * r[1]);
	let h = "";
	for (let e = 0; e < l; e++) for (let t = 0; t < c; t++) {
		let n = 0;
		for (let r = 0; r < u; r++) {
			let i = Math.floor(((e * c + t) * u + r) / 8), a = 7 - ((e * c + t) * u + r) % 8;
			n *= 2, n += (f[i] & 1 << a) >> a;
		}
		n !== 0 && (h += (h === "" ? "" : " ") + `M ${t} ${e} h 1 v 1 H ${t} Z`);
	}
	let g = new n(h);
	a != null && (e.strokeStyle = a, e.lineJoin = "round", e.lineWidth = 2 * s.magnification, e.stroke(g)), e.fill(g), e.setTransform(1, 0, 0, 1, 0, 0);
}, Qn = (e, t, n, r, i, a) => {
	let { state: o } = t;
	Kn(e, t, r, i, a), qn(e, t, r, i, a), Jn(e, t, r, i, a), Yn(e, t, r, i, a);
	let s = (a.color.stroke == null ? null : Vn.get(a.color.stroke) ?? a.color.stroke) ?? (o.ornament == null ? null : q[o.ornament]);
	Zn(e, t, n, r, a.color.foreground ?? q[o.foreground], s);
}, $n = (e, t, n, r, i, a) => {
	let o = [1, 1];
	{
		let s = t.getContext("2d");
		if (s == null) return;
		let c = new en(n), l = c.parse(r), { plane: u } = c.currentState();
		e != null && (o = [Math.ceil(e.width / u[0]), Math.ceil(e.height / u[1])]);
		let d = u[0] * o[0], f = u[1] * o[1];
		(t.width !== d || t.height !== f) && (t.width = d, t.height = f, s.clearRect(0, 0, t.width, t.height));
		for (let e of l) switch (e.tag) {
			case "Character":
				Xn(s, e, globalThis.Path2D, o, i, a);
				break;
			case "DRCS":
				Qn(s, e, globalThis.Path2D, o, i, a);
				break;
			case "Bitmap":
				er(s, e, globalThis.Path2D, o, i, a);
				break;
			case "ClearScreen":
				e.time === 0 && s.clearRect(0, 0, t.width, t.height);
				break;
			default: throw new M(e, "Unhandled ARIB Parsed Token in CanvasRendererStrategy");
		}
	}
	if (e != null) {
		let n = e.getContext("2d");
		if (n == null) return;
		switch (n.clearRect(0, 0, e.width, e.height), a.resize.objectFit) {
			case "none":
				n.drawImage(t, 0, 0, e.width, e.height);
				break;
			default: {
				let r = e.width / (t.width / o[0]), i = e.height / (t.height / o[1]), a = Math.min(r, i), s = t.width * a / o[0], c = t.height * a / o[1], l = (e.width - s) / 2, u = (e.height - c) / 2;
				n.drawImage(t, 0, 0, t.width, t.height, l, u, s, c);
				break;
			}
		}
	}
}, er = (e, t, n, r, i, a) => {
	let { x_position: o, y_position: s, width: c, height: l } = t;
	e.drawImage(t.normal_bitmap, o * r[0], s * r[1], c * r[0], l * r[1]), t.normal_bitmap.close(), t.flashing_bitmap?.close();
}, tr = class extends zn {
	buffer;
	constructor(e) {
		super(e), this.buffer = document.createElement("canvas");
	}
	resize(e, t) {
		this.canvas.width = e, this.canvas.height = t;
	}
	destroy() {
		this.resize(0, 0), this.buffer.width = this.buffer.height = 0;
	}
	clear() {
		{
			let e = this.buffer.getContext("2d");
			if (e == null) return;
			e.clearRect(0, 0, this.buffer.width, this.buffer.height);
		}
		{
			let e = this.canvas.getContext("2d");
			if (e == null) return;
			e.clearRect(0, 0, this.canvas.width, this.canvas.height);
		}
	}
	render(e, t, n) {
		$n(this.canvas, this.buffer, e, tn(t, this.option.replace.drcs), n, this.option);
	}
	getPresentationCanvas() {
		return this.canvas;
	}
}, nr = "(function(){var e=class extends Error{constructor(e,t,n){super(`${t}: ${e}}`,n),this.name=this.constructor.name}};let t={from(e,t=!1){return{tag:`Character`,character:e,non_spacing:t}}},n={TINY:96,DOUBLE_HEIGHT:65,DOUBLE_WIDTH:68,DOUBLE_HEIGHT_AND_WIDTH:69,SPECIAL_1:107,SPECIAL_2:100},r={NORMAL:64,INVERTED:71,STOP:79},i={Small:`Small`,Middle:`Middle`,Normal:`Normal`,Tiny:`Tiny`,DoubleHeight:`DoubleHeight`,DoubleWidth:`DoubleWidth`,DoubleHeightAndWidth:`DoubleHeightAndWidth`,Special1:`Special1`,Special2:`Special2`},a=new Map([[i.Small,[.5,.5]],[i.Middle,[.5,1]],[i.Normal,[1,1]],[i.Tiny,[1/4,1/6]],[i.DoubleHeight,[1,2]],[i.DoubleWidth,[2,1]],[i.DoubleHeightAndWidth,[2,2]],[i.Special1,[NaN,NaN]],[i.Special2,[NaN,NaN]]]),o={from(e){return{magnification:2,...e}}},s={plane:[960,540],area:[960,540],margin:[0,0],fontsize:[36,36],hspace:4,vspace:24,position:[0,59],size:i.Normal,pallet:0,foreground:7,halfforeground:0,halfbackground:0,background:8,underline:!1,highlight:0,ornament:null,flashing:r.STOP,elapsed_time:0},c={from(e,t,n){return{tag:`ClearScreen`,state:structuredClone(t),option:structuredClone(n),time:e}}},l={from({character:e,non_spacing:t},n,r){return{tag:`Character`,state:structuredClone(n),option:structuredClone(r),character:e,non_spacing:t}}},u={from({width:e,height:t,depth:n,binary:r},i,a){return{tag:`DRCS`,state:structuredClone(i),option:structuredClone(a),width:e,height:t,depth:n,binary:r}}};var d=class r{state;option;non_spacings=[];constructor(e=s,t){this.state=structuredClone(e),this.option=o.from(t),this.state.plane=[this.state.plane[0]*this.option.magnification,this.state.plane[1]*this.option.magnification],this.state.area=[this.state.area[0]*this.option.magnification,this.state.area[1]*this.option.magnification],this.state.margin=[this.state.margin[0]*this.option.magnification,this.state.margin[1]*this.option.magnification],this.state.fontsize=[this.state.fontsize[0]*this.option.magnification,this.state.fontsize[1]*this.option.magnification],this.state.hspace=this.state.hspace*this.option.magnification,this.state.vspace=this.state.vspace*this.option.magnification,this.state.position=[this.state.position[0]*this.option.magnification,this.state.position[1]*this.option.magnification]}static box(e){return[Math.floor((e.fontsize[0]+e.hspace)*a.get(e.size)[0]),Math.floor((e.fontsize[1]+e.vspace)*a.get(e.size)[1])]}static offset(e){return[Math.floor(e.hspace*a.get(e.size)[0]/2),Math.floor(e.vspace*a.get(e.size)[1]/2)]}static scale(e){return a.get(e.size)}move_absolute_dot(e,t){this.state.position[0]=e-this.state.margin[0],this.state.position[1]=t-this.state.margin[1]}move_absolute_pos(e,t){this.state.position[0]=e*r.box(this.state)[0],this.state.position[1]=(t+1)*r.box(this.state)[1]-1*this.option.magnification}move_newline(){this.state.position[0]=0,this.move_relative_pos(0,1)}move_relative_pos(e,t){for(;e<0;)for(this.state.position[0]-=r.box(this.state)[0],e++;this.state.position[0]<0;)this.state.position[0]+=this.state.area[0],t--;for(;e>0;)for(this.state.position[0]+=r.box(this.state)[0],e--;this.state.position[0]>=this.state.area[0];)this.state.position[0]-=this.state.area[0],t++;for(;t<0;)this.state.position[1]-=r.box(this.state)[1],t++;for(;t>0;)this.state.position[1]+=r.box(this.state)[1],t--;for(;this.state.position[1]>=this.state.area[1];)this.state.position[1]-=this.state.area[1];for(;this.state.position[1]<0;)this.state.position[1]+=this.state.area[1]}currentState(){return structuredClone(this.state)}currentOption(){return structuredClone(this.option)}parseToken(r){switch(r.tag){case`Character`:if(r.non_spacing)this.non_spacings.push(l.from(r,this.state,this.option));else{let e=[l.from(r,this.state,this.option),...this.non_spacings];return this.non_spacings=[],this.move_relative_pos(1,0),e}break;case`DRCS`:let a=[u.from(r,this.state,this.option),...r.combining===``?[]:[l.from(t.from(`　`+r.combining,!0),this.state,this.option)],...this.non_spacings];return this.non_spacings=[],this.move_relative_pos(1,0),a;case`Space`:{let e=[l.from(t.from(`　`),this.state,this.option),...this.non_spacings];return this.non_spacings=[],this.move_relative_pos(1,0),e}case`SetWritingFormat`:switch(r.format){case 0:case 2:case 4:break;case 5:this.state.plane=[1920*this.option.magnification,1080*this.option.magnification];break;case 7:this.state.plane=[960*this.option.magnification,540*this.option.magnification];break;case 9:this.state.plane=[720*this.option.magnification,480*this.option.magnification];break;case 11:this.state.plane=[1280*this.option.magnification,720*this.option.magnification];break;default:break}break;case`SetDisplayFormat`:this.state.area=[r.horizontal*this.option.magnification,r.vertical*this.option.magnification];break;case`SetDisplayPosition`:this.state.margin=[r.horizontal*this.option.magnification,r.vertical*this.option.magnification];break;case`CharacterCompositionDotDesignation`:this.state.fontsize=[r.horizontal*this.option.magnification,r.vertical*this.option.magnification];break;case`SetHorizontalSpacing`:this.state.hspace=r.spacing*this.option.magnification;break;case`SetVerticalSpacing`:this.state.vspace=r.spacing*this.option.magnification;break;case`ActivePositionBackward`:this.move_relative_pos(-1,0);break;case`ActivePositionForward`:this.move_relative_pos(1,0);break;case`ActivePositionDown`:this.move_relative_pos(0,1);break;case`ActivePositionUp`:this.move_relative_pos(0,-1);break;case`ActivePositionReturn`:this.move_newline();break;case`ParameterizedActivePositionForward`:this.move_relative_pos(r.x,0);break;case`ActivePositionSet`:this.move_absolute_pos(r.x,r.y);break;case`ActiveCoordinatePositionSet`:this.move_absolute_dot(r.x*this.option.magnification,r.y*this.option.magnification);break;case`SmallSize`:this.state.size=i.Small;break;case`MiddleSize`:this.state.size=i.Middle;break;case`NormalSize`:this.state.size=i.Normal;break;case`CharacterSizeControl`:switch(r.type){case n.TINY:this.state.size=i.Tiny;break;case n.DOUBLE_HEIGHT:this.state.size=i.DoubleHeight;break;case n.DOUBLE_WIDTH:this.state.size=i.DoubleWidth;break;case n.DOUBLE_HEIGHT_AND_WIDTH:this.state.size=i.DoubleHeightAndWidth;break;case n.SPECIAL_1:this.state.size=i.Special1;break;case n.SPECIAL_2:this.state.size=i.Special2;break;default:throw new e(r,`Unexcepted Size Type in STD-B24 ARIB Caption Content`)}break;case`PalletControl`:this.state.pallet=r.pallet;break;case`BlackForeground`:this.state.foreground=this.state.pallet<<4|0;break;case`RedForeground`:this.state.foreground=this.state.pallet<<4|1;break;case`GreenForeground`:this.state.foreground=this.state.pallet<<4|2;break;case`YellowForeground`:this.state.foreground=this.state.pallet<<4|3;break;case`BlueForeground`:this.state.foreground=this.state.pallet<<4|4;break;case`MagentaForeground`:this.state.foreground=this.state.pallet<<4|5;break;case`CyanForeground`:this.state.foreground=this.state.pallet<<4|6;break;case`WhiteForeground`:this.state.foreground=this.state.pallet<<4|7;break;case`ColorControlForeground`:this.state.foreground=this.state.pallet<<4|r.color;break;case`ColorControlHalfForeground`:this.state.halfforeground=this.state.pallet<<4|r.color;break;case`ColorControlHalfBackground`:this.state.halfbackground=this.state.pallet<<4|r.color;break;case`ColorControlBackground`:this.state.background=this.state.pallet<<4|r.color;break;case`StartLining`:this.state.underline=!0;break;case`StopLining`:this.state.underline=!1;break;case`HilightingCharacterBlock`:this.state.highlight=r.enclosure;break;case`OrnamentControlNone`:this.state.ornament=null;break;case`OrnamentControlHemming`:{let e=Math.floor(r.color/100),t=r.color%100;this.state.ornament=t<<4|e;break}case`FlashingControl`:this.state.flashing=r.type;break;case`ClearScreen`:return[c.from(this.state.elapsed_time,this.state,this.option)];case`TimeControlWait`:this.state.elapsed_time+=r.seconds;break}return[]}parse(e){return e.flatMap(this.parseToken.bind(this))}};let f={from(e,t,n){return{tag:`Bitmap`,state:structuredClone(t),option:structuredClone(n),x_position:e.x_position*n.magnification,y_position:e.y_position*n.magnification,width:e.width*n.magnification,height:e.height*n.magnification,normal_dataurl:e.normal_dataurl,normal_bitmap:e.normal_bitmap,flashing_dataurl:e.flashing_dataurl,flashing_bitmap:e.flashing_bitmap}}};var p=class{praser;constructor(e,t){this.praser=new d(e,t)}currentState(){return this.praser.currentState()}currentOption(){return this.praser.currentOption()}parseBitmapOrInherit(e){return e.tag===`Bitmap`?[f.from(e,this.praser.currentState(),this.praser.currentOption())]:this.praser.parseToken(e)}parse(e){return e.flatMap(this.parseBitmapOrInherit.bind(this))}},m=`#000000FF.#FF0000FF.#00FF00FF.#FFFF00FF.#0000FFFF.#FF00FFFF.#00FFFFFF.#FFFFFFFF.#00000000.#AA0000FF.#00AA00FF.#AAAA00FF.#0000AAFF.#AA00AAFF.#00AAAAFF.#AAAAAAFF.#000055FF.#005500FF.#005555FF.#0055AAFF.#0055FFFF.#00AA55FF.#00AAFFFF.#00FF55FF.#00FFAAFF.#550000FF.#550055FF.#5500AAFF.#5500FFFF.#555500FF.#555555FF.#5555AAFF.#5555FFFF.#55AA00FF.#55AA55FF.#55AAAAFF.#55AAFFFF.#55FF00FF.#55FF55FF.#55FFAAFF.#55FFFFFF.#AA0055FF.#AA00FFFF.#AA5500FF.#AA5555FF.#AA55AAFF.#AA55FFFF.#AAAA55FF.#AAAAFFFF.#AAFF00FF.#AAFF55FF.#AAFFAAFF.#AAFFFFFF.#FF0055FF.#FF00AAFF.#FF5500FF.#FF5555FF.#FF55AAFF.#FF55FFFF.#FFAA00FF.#FFAA55FF.#FFAAAAFF.#FFAAFFFF.#FFFF55FF.#FFFFAAFF.#00000080.#FF000080.#00FF0080.#FFFF0080.#0000FF80.#FF00FF80.#00FFFF80.#FFFFFF80.#AA000080.#00AA0080.#AAAA0080.#0000AA80.#AA00AA80.#00AAAA80.#AAAAAA80.#00005580.#00550080.#00555580.#0055AA80.#0055FF80.#00AA5580.#00AAFF80.#00FF5580.#00FFAA80.#55000080.#55005580.#5500AA80.#5500FF80.#55550080.#55555580.#5555AA80.#5555FF80.#55AA0080.#55AA5580.#55AAAA80.#55AAFF80.#55FF0080.#55FF5580.#55FFAA80.#55FFFF80.#AA005580.#AA00FF80.#AA550080.#AA555580.#AA55AA80.#AA55FF80.#AAAA5580.#AAAAFF80.#AAFF0080.#AAFF5580.#AAFFAA80.#AAFFFF80.#FF005580.#FF00AA80.#FF550080.#FF555580.#FF55AA80.#FF55FF80.#FFAA0080.#FFAA5580.#FFAAAA80.#FFAAFF80.#FFFF5580`.split(`.`),h=new Map([[`０`,`0`],[`１`,`1`],[`２`,`2`],[`３`,`3`],[`４`,`4`],[`５`,`5`],[`６`,`6`],[`７`,`7`],[`８`,`8`],[`９`,`9`],[`ａ`,`a`],[`ｂ`,`b`],[`ｃ`,`c`],[`ｄ`,`d`],[`ｅ`,`e`],[`ｆ`,`f`],[`ｇ`,`g`],[`ｈ`,`h`],[`ｉ`,`i`],[`ｊ`,`j`],[`ｋ`,`k`],[`ｌ`,`l`],[`ｍ`,`m`],[`ｎ`,`n`],[`ｏ`,`o`],[`ｐ`,`p`],[`ｑ`,`q`],[`ｒ`,`r`],[`ｓ`,`s`],[`ｔ`,`t`],[`ｕ`,`u`],[`ｖ`,`v`],[`ｗ`,`w`],[`ｘ`,`x`],[`ｙ`,`y`],[`ｚ`,`z`],[`Ａ`,`A`],[`Ｂ`,`B`],[`Ｃ`,`C`],[`Ｄ`,`D`],[`Ｅ`,`E`],[`Ｆ`,`F`],[`Ｇ`,`G`],[`Ｈ`,`H`],[`Ｉ`,`I`],[`Ｊ`,`J`],[`Ｋ`,`K`],[`Ｌ`,`L`],[`Ｍ`,`M`],[`Ｎ`,`N`],[`Ｏ`,`O`],[`Ｐ`,`P`],[`Ｑ`,`Q`],[`Ｒ`,`R`],[`Ｓ`,`S`],[`Ｔ`,`T`],[`Ｕ`,`U`],[`Ｖ`,`V`],[`Ｗ`,`W`],[`Ｘ`,`X`],[`Ｙ`,`Y`],[`Ｚ`,`Z`],[`　`,` `],[`！`,`!`],[`＂`,`\"`],[`＃`,`#`],[`＄`,`$`],[`％`,`%`],[`＆`,`&`],[`＇`,`'`],[`（`,`(`],[`）`,`)`],[`＊`,`*`],[`＋`,`+`],[`，`,`,`],[`－`,`-`],[`．`,`.`],[`／`,`/`],[`：`,`:`],[`；`,`;`],[`＜`,`<`],[`＝`,`=`],[`＞`,`>`],[`？`,`?`],[`＠`,`@`],[`［`,`[`],[`＼`,`\\\\`],[`］`,`]`],[`＾`,`^`],[`＿`,`_`],[`｀`,\"`\"],[`｛`,`{`],[`｜`,`|`],[`｝`,`}`],[`～`,`~`],[`ー`,`ｰ`],[`、`,`､`],[`。`,`｡`],[`・`,`･`],[`「`,`｢`],[`」`,`｣`],[`｟`,`⦅`],[`｠`,`⦆`],[`￠`,`¢`],[`￡`,`£`],[`￢`,`¬`],[`￣`,`¯`],[`￤`,`¦`],[`￥`,`¥`],[`￦`,`₩`],[`│`,`￨`],[`←`,`￩`],[`↑`,`￪`],[`→`,`￫`],[`↓`,`￬`],[`■`,`￭`],[`○`,`￮`]]),g=new Map([[`black`,`#000000FF`],[`silver`,`#C0C0C0FF`],[`gray`,`#808080FF`],[`white`,`#FFFFFFFF`],[`maroon`,`#800000FF`],[`red`,`#FF0000FF`],[`purple`,`#800080FF`],[`fuchsia`,`#FF00FFFF`],[`green`,`#008000FF`],[`lime`,`#00FF00FF`],[`olive`,`#808000FF`],[`yellow`,`#FFFF00FF`],[`navy`,`#000080FF`],[`blue`,`#0000FFFF`],[`teal`,`#008080FF`],[`aqua`,`#00FFFFFF`],[`orange`,`#FFA500FF`],[`aliceblue`,`#F0F8FFFF`],[`antiquewhite`,`#FAEBD7FF`],[`aquamarine`,`#7FFFD4FF`],[`azure`,`#F0FFFFFF`],[`beige`,`#F5F5DCFF`],[`bisque`,`#FFE4C4FF`],[`blanchedalmond`,`#FFEBCDFF`],[`blueviolet`,`#8A2BE2FF`],[`brown`,`#A52A2AFF`],[`burlywood`,`#DEB887FF`],[`cadetblue`,`#5F9EA0FF`],[`chartreuse`,`#7FFF00FF`],[`chocolate`,`#D2691EFF`],[`coral`,`#FF7F50FF`],[`cornflowerblue`,`#6495EDFF`],[`cornsilk`,`#FFF8DCFF`],[`crimson`,`#DC143CFF`],[`cyan`,`#00FFFFFF`],[`aqua`,`#00FFFFFF`],[`darkblue`,`#00008BFF`],[`darkcyan`,`#008B8BFF`],[`darkgoldenrod`,`#B8860BFF`],[`darkgray`,`#A9A9A9FF`],[`darkgreen`,`#006400FF`],[`darkgrey`,`#A9A9A9FF`],[`darkkhaki`,`#BDB76BFF`],[`darkmagenta`,`#8B008BFF`],[`darkolivegreen`,`#556B2FFF`],[`darkorange`,`#FF8C00FF`],[`darkorchid`,`#9932CCFF`],[`darkred`,`#8B0000FF`],[`darksalmon`,`#E9967AFF`],[`darkseagreen`,`#8FBC8FFF`],[`darkslateblue`,`#483D8BFF`],[`darkslategray`,`#2F4F4FFF`],[`darkslategrey`,`#2F4F4FFF`],[`darkturquoise`,`#00CED1FF`],[`darkviolet`,`#9400D3FF`],[`deeppink`,`#FF1493FF`],[`deepskyblue`,`#00BFFFFF`],[`dimgray`,`#696969FF`],[`dimgrey`,`#696969FF`],[`dodgerblue`,`#1E90FFFF`],[`firebrick`,`#B22222FF`],[`floralwhite`,`#FFFAF0FF`],[`forestgreen`,`#228B22FF`],[`gainsboro`,`#DCDCDCFF`],[`ghostwhite`,`#F8F8FFFF`],[`gold`,`#FFD700FF`],[`goldenrod`,`#DAA520FF`],[`greenyellow`,`#ADFF2FFF`],[`grey`,`#808080FF`],[`honeydew`,`#F0FFF0FF`],[`hotpink`,`#FF69B4FF`],[`indianred`,`#CD5C5CFF`],[`indigo`,`#4B0082FF`],[`ivory`,`#FFFFF0FF`],[`khaki`,`#F0E68CFF`],[`lavender`,`#E6E6FAFF`],[`lavenderblush`,`#FFF0F5FF`],[`lawngreen`,`#7CFC00FF`],[`lemonchiffon`,`#FFFACDFF`],[`lightblue`,`#ADD8E6FF`],[`lightcoral`,`#F08080FF`],[`lightcyan`,`#E0FFFFFF`],[`lightgoldenrodyellow`,`#FAFAD2FF`],[`lightgray`,`#D3D3D3FF`],[`lightgreen`,`#90EE90FF`],[`lightgrey`,`#D3D3D3FF`],[`lightpink`,`#FFB6C1FF`],[`lightsalmon`,`#FFA07AFF`],[`lightseagreen`,`#20B2AAFF`],[`lightskyblue`,`#87CEFAFF`],[`lightslategray`,`#778899FF`],[`lightslategrey`,`#778899FF`],[`lightsteelblue`,`#B0C4DEFF`],[`lightyellow`,`#FFFFE0FF`],[`limegreen`,`#32CD32FF`],[`linen`,`#FAF0E6FF`],[`magenta`,`#FF00FFFF`],[`fuchsia`,`#FF00FFFF`],[`mediumaquamarine`,`#66CDAAFF`],[`mediumblue`,`#0000CDFF`],[`mediumorchid`,`#BA55D3FF`],[`mediumpurple`,`#9370DBFF`],[`mediumseagreen`,`#3CB371FF`],[`mediumslateblue`,`#7B68EEFF`],[`mediumspringgreen`,`#00FA9AFF`],[`mediumturquoise`,`#48D1CCFF`],[`mediumvioletred`,`#C71585FF`],[`midnightblue`,`#191970FF`],[`mintcream`,`#F5FFFAFF`],[`mistyrose`,`#FFE4E1FF`],[`moccasin`,`#FFE4B5FF`],[`navajowhite`,`#FFDEADFF`],[`oldlace`,`#FDF5E6FF`],[`olivedrab`,`#6B8E23FF`],[`orangered`,`#FF4500FF`],[`orchid`,`#DA70D6FF`],[`palegoldenrod`,`#EEE8AAFF`],[`palegreen`,`#98FB98FF`],[`paleturquoise`,`#AFEEEEFF`],[`palevioletred`,`#DB7093FF`],[`papayawhip`,`#FFEFD5FF`],[`peachpuff`,`#FFDAB9FF`],[`peru`,`#CD853FFF`],[`pink`,`#FFC0CBFF`],[`plum`,`#DDA0DDFF`],[`powderblue`,`#B0E0E6FF`],[`rosybrown`,`#BC8F8FFF`],[`royalblue`,`#4169E1FF`],[`saddlebrown`,`#8B4513FF`],[`salmon`,`#FA8072FF`],[`sandybrown`,`#F4A460FF`],[`seagreen`,`#2E8B57FF`],[`seashell`,`#FFF5EEFF`],[`sienna`,`#A0522DFF`],[`skyblue`,`#87CEEBFF`],[`slateblue`,`#6A5ACDFF`],[`slategray`,`#708090FF`],[`slategrey`,`#708090FF`],[`snow`,`#FFFAFAFF`],[`springgreen`,`#00FF7FFF`],[`steelblue`,`#4682B4FF`],[`tan`,`#D2B48CFF`],[`thistle`,`#D8BFD8FF`],[`tomato`,`#FF6347FF`],[`turquoise`,`#40E0D0FF`],[`violet`,`#EE82EEFF`],[`wheat`,`#F5DEB3FF`],[`whitesmoke`,`#F5F5F5FF`],[`yellowgreen`,`#9ACD32FF`],[`rebeccapurple`,`#663399FF`],[`transparent`,`#00000000`]]);let _=(e,t)=>t.association===`SBTVD`&&e===i.Small||e===i.Middle;var v=new Map([[29985,`㐂`],[29986,`𠅘`],[29987,`份`],[29988,`仿`],[29989,`侚`],[29990,`俉`],[29991,`傜`],[29992,`儞`],[29993,`冼`],[29994,`㔟`],[29995,`匇`],[29996,`卡`],[29997,`卬`],[29998,`詹`],[29999,`𠮷`],[3e4,`呍`],[30001,`咖`],[30002,`咜`],[30003,`咩`],[30004,`唎`],[30005,`啊`],[30006,`噲`],[30007,`囤`],[30008,`圳`],[30009,`圴`],[30010,`塚`],[30011,`墀`],[30012,`姤`],[30013,`娣`],[30014,`婕`],[30015,`寬`],[30016,`﨑`],[30017,`㟢`],[30018,`庬`],[30019,`弴`],[30020,`彅`],[30021,`德`],[30022,`怗`],[30023,`恵`],[30024,`愰`],[30025,`昤`],[30026,`曈`],[30027,`曙`],[30028,`曺`],[30029,`曻`],[30030,`桒`],[30031,`鿄`],[30032,`椑`],[30033,`椻`],[30034,`橅`],[30035,`檑`],[30036,`櫛`],[30037,`𣏌`],[30038,`𣏾`],[30039,`𣗄`],[30040,`毱`],[30041,`泠`],[30042,`洮`],[30043,`海`],[30044,`涿`],[30045,`淊`],[30046,`淸`],[30047,`渚`],[30048,`潞`],[30049,`濹`],[30050,`灤`],[30051,`𤋮`],[30052,`𤋮`],[30053,`煇`],[30054,`燁`],[30055,`爀`],[30056,`玟`],[30057,`玨`],[30058,`珉`],[30059,`珖`],[30060,`琛`],[30061,`琡`],[30062,`琢`],[30063,`琦`],[30064,`琪`],[30065,`琬`],[30066,`琹`],[30067,`瑋`],[30068,`㻚`],[30069,`畵`],[30070,`疁`],[30071,`睲`],[30072,`䂓`],[30073,`磈`],[30074,`磠`],[30075,`祇`],[30076,`禮`],[30077,`鿆`],[30078,`䄃`],[30241,`鿅`],[30242,`秚`],[30243,`稞`],[30244,`筿`],[30245,`簱`],[30246,`䉤`],[30247,`綋`],[30248,`羡`],[30249,`脘`],[30250,`脺`],[30251,`舘`],[30252,`芮`],[30253,`葛`],[30254,`蓜`],[30255,`蓬`],[30256,`蕙`],[30257,`藎`],[30258,`蝕`],[30259,`蟬`],[30260,`蠋`],[30261,`裵`],[30262,`角`],[30263,`諶`],[30264,`跎`],[30265,`辻`],[30266,`迶`],[30267,`郝`],[30268,`鄧`],[30269,`鄭`],[30270,`醲`],[30271,`鈳`],[30272,`銈`],[30273,`錡`],[30274,`鍈`],[30275,`閒`],[30276,`雞`],[30277,`餃`],[30278,`饀`],[30279,`髙`],[30280,`鯖`],[30281,`鷗`],[30282,`麴`],[30283,`麵`],[31265,`⛌`],[31266,`⛍`],[31267,`❗`],[31268,`⛏`],[31269,`⛐`],[31270,`⛑`],[31272,`⛒`],[31273,`⛕`],[31274,`⛓`],[31275,`⛔`],[31280,``],[31281,``],[31284,`⛖`],[31285,`⛗`],[31286,`⛘`],[31287,`⛙`],[31288,`⛚`],[31289,`⛛`],[31290,`⛜`],[31291,`⛝`],[31292,`⛞`],[31293,`⛟`],[31294,`⛠`],[31295,`⛡`],[31296,`⭕`],[31297,`㉈`],[31298,`㉉`],[31299,`㉊`],[31300,`㉋`],[31301,`㉌`],[31302,`㉍`],[31303,`㉎`],[31304,`㉏`],[31309,`⒑`],[31310,`⒒`],[31311,`⒓`],[31312,``],[31313,``],[31314,``],[31315,``],[31316,``],[31317,``],[31318,``],[31319,``],[31320,``],[31321,``],[31322,``],[31323,``],[31324,``],[31325,``],[31326,``],[31327,``],[31328,`⬛`],[31329,`⬤`],[31330,``],[31331,``],[31332,``],[31333,``],[31334,``],[31335,`⚿`],[31336,``],[31337,``],[31338,``],[31339,``],[31340,``],[31341,``],[31342,``],[31343,``],[31344,``],[31345,``],[31346,``],[31347,`㊙`],[31348,``],[31521,`⛣`],[31522,`⭖`],[31523,`⭗`],[31524,`⭘`],[31525,`⭙`],[31526,`☓`],[31527,`㊋`],[31528,`〒`],[31529,`⛨`],[31530,`㉆`],[31531,`㉅`],[31532,`⛩`],[31533,`࿖`],[31534,`⛪`],[31535,`⛫`],[31536,`⛬`],[31537,`♨`],[31538,`⛭`],[31539,`⛮`],[31540,`⛯`],[31541,`⚓`],[31542,`✈`],[31543,`⛰`],[31544,`⛱`],[31545,`⛲`],[31546,`⛳`],[31547,`⛴`],[31548,`⛵`],[31549,``],[31550,`Ⓓ`],[31551,`Ⓢ`],[31552,`⛶`],[31553,``],[31554,``],[31555,``],[31556,``],[31557,``],[31558,`⛷`],[31559,`⛸`],[31560,`⛹`],[31561,`⛺`],[31562,``],[31563,`☎`],[31564,`⛻`],[31565,`⛼`],[31566,`⛽`],[31567,`⛾`],[31568,``],[31569,`⛿`],[31777,`➡`],[31778,`⬅`],[31779,`⬆`],[31780,`⬇`],[31781,`⬯`],[31782,`⬮`],[31783,`年`],[31784,`月`],[31785,`日`],[31786,`円`],[31787,`㎡`],[31788,`㎥`],[31789,`㎝`],[31790,`㎠`],[31791,`㎤`],[31792,``],[31793,`⒈`],[31794,`⒉`],[31795,`⒊`],[31796,`⒋`],[31797,`⒌`],[31798,`⒍`],[31799,`⒎`],[31800,`⒏`],[31801,`⒐`],[31802,``],[31803,``],[31804,``],[31805,``],[31806,``],[31807,``],[31808,``],[31809,``],[31810,``],[31811,``],[31812,``],[31813,``],[31814,``],[31815,``],[31816,``],[31817,``],[31818,`㈳`],[31819,`㈶`],[31820,`㈲`],[31821,`㈱`],[31822,`㈹`],[31823,`㉄`],[31824,`▶`],[31825,`◀`],[31826,`〖`],[31827,`〗`],[31828,`⟐`],[31829,`²`],[31830,`³`],[31831,``],[31832,``],[31833,``],[31834,``],[31835,``],[31836,``],[31837,``],[31838,``],[31839,``],[31840,``],[31841,``],[31842,``],[31843,``],[31844,``],[31845,``],[31846,``],[31847,``],[31848,``],[31849,``],[31850,``],[31851,``],[31852,``],[31853,``],[31854,``],[31855,``],[31856,``],[31857,``],[31858,``],[31859,``],[31860,``],[31861,``],[31862,``],[31863,``],[31864,`㉇`],[31865,``],[31866,``],[31867,`℻`],[32033,`㈪`],[32034,`㈫`],[32035,`㈬`],[32036,`㈭`],[32037,`㈮`],[32038,`㈯`],[32039,`㈰`],[32040,`㈷`],[32041,`㍾`],[32042,`㍽`],[32043,`㍼`],[32044,`㍻`],[32045,`№`],[32046,`℡`],[32047,`〶`],[32048,`⚾`],[32049,``],[32050,``],[32051,``],[32052,``],[32053,``],[32054,``],[32055,``],[32056,``],[32057,``],[32058,``],[32059,``],[32060,``],[32061,``],[32062,``],[32063,``],[32064,``],[32065,``],[32066,``],[32067,``],[32068,``],[32069,``],[32070,``],[32071,`ℓ`],[32072,`㎏`],[32073,`㎐`],[32074,`㏊`],[32075,`㎞`],[32076,`㎢`],[32077,`㍱`],[32080,`½`],[32081,`↉`],[32082,`⅓`],[32083,`⅔`],[32084,`¼`],[32085,`¾`],[32086,`⅕`],[32087,`⅖`],[32088,`⅗`],[32089,`⅘`],[32090,`⅙`],[32091,`⅚`],[32092,`⅐`],[32093,`⅛`],[32094,`⅑`],[32095,`⅒`],[32096,`☀`],[32097,`☁`],[32098,`☂`],[32099,`⛄`],[32100,`☖`],[32101,`☗`],[32102,`⛉`],[32103,`⛊`],[32104,`♦`],[32105,`♥`],[32106,`♣`],[32107,`♠`],[32108,`⛋`],[32109,`⨀`],[32110,`‼`],[32111,`⁉`],[32112,`⛅`],[32113,`☔`],[32114,`⛆`],[32115,`☃`],[32116,`⛇`],[32117,`⚡`],[32118,`⛈`],[32120,`⚞`],[32121,`⚟`],[32122,`♬`],[32123,`☎`],[32289,`Ⅰ`],[32290,`Ⅱ`],[32291,`Ⅲ`],[32292,`Ⅳ`],[32293,`Ⅴ`],[32294,`Ⅵ`],[32295,`Ⅶ`],[32296,`Ⅷ`],[32297,`Ⅸ`],[32298,`Ⅹ`],[32299,`Ⅺ`],[32300,`Ⅻ`],[32301,`⑰`],[32302,`⑱`],[32303,`⑲`],[32304,`⑳`],[32305,`⑴`],[32306,`⑵`],[32307,`⑶`],[32308,`⑷`],[32309,`⑸`],[32310,`⑹`],[32311,`⑺`],[32312,`⑻`],[32313,`⑼`],[32314,`⑽`],[32315,`⑾`],[32316,`⑿`],[32317,`㉑`],[32318,`㉒`],[32319,`㉓`],[32320,`㉔`],[32321,``],[32322,``],[32323,``],[32324,``],[32325,``],[32326,``],[32327,``],[32328,``],[32329,``],[32330,``],[32331,``],[32332,``],[32333,``],[32334,``],[32335,``],[32336,``],[32337,``],[32338,``],[32339,``],[32340,``],[32341,``],[32342,``],[32343,``],[32344,``],[32345,``],[32346,``],[32347,`㉕`],[32348,`㉖`],[32349,`㉗`],[32350,`㉘`],[32351,`㉙`],[32352,`㉚`],[32353,`①`],[32354,`②`],[32355,`③`],[32356,`④`],[32357,`⑤`],[32358,`⑥`],[32359,`⑦`],[32360,`⑧`],[32361,`⑨`],[32362,`⑩`],[32363,`⑪`],[32364,`⑫`],[32365,`⑬`],[32366,`⑭`],[32367,`⑮`],[32368,`⑯`],[32369,`❶`],[32370,`❷`],[32371,`❸`],[32372,`❹`],[32373,`❺`],[32374,`❻`],[32375,`❼`],[32376,`❽`],[32377,`❾`],[32378,`❿`],[32379,`⓫`],[32380,`⓬`],[32381,`㉛`]]),y=new Map([[29985,`㐂`],[29986,`𠅘`],[29987,`份`],[29988,`仿`],[29989,`侚`],[29990,`俉`],[29991,`傜`],[29992,`儞`],[29993,`冼`],[29994,`㔟`],[29995,`匇`],[29996,`卡`],[29997,`卬`],[29998,`詹`],[29999,`𠮷`],[3e4,`呍`],[30001,`咖`],[30002,`咜`],[30003,`咩`],[30004,`唎`],[30005,`啊`],[30006,`噲`],[30007,`囤`],[30008,`圳`],[30009,`圴`],[30010,`塚`],[30011,`墀`],[30012,`姤`],[30013,`娣`],[30014,`婕`],[30015,`寬`],[30016,`﨑`],[30017,`㟢`],[30018,`庬`],[30019,`弴`],[30020,`彅`],[30021,`德`],[30022,`怗`],[30023,`恵`],[30024,`愰`],[30025,`昤`],[30026,`曈`],[30027,`曙`],[30028,`曺`],[30029,`曻`],[30030,`桒`],[30031,`鿄`],[30032,`椑`],[30033,`椻`],[30034,`橅`],[30035,`檑`],[30036,`櫛`],[30037,`𣏌`],[30038,`𣏾`],[30039,`𣗄`],[30040,`毱`],[30041,`泠`],[30042,`洮`],[30043,`海`],[30044,`涿`],[30045,`淊`],[30046,`淸`],[30047,`渚`],[30048,`潞`],[30049,`濹`],[30050,`灤`],[30051,`𤋮`],[30052,`𤋮`],[30053,`煇`],[30054,`燁`],[30055,`爀`],[30056,`玟`],[30057,`玨`],[30058,`珉`],[30059,`珖`],[30060,`琛`],[30061,`琡`],[30062,`琢`],[30063,`琦`],[30064,`琪`],[30065,`琬`],[30066,`琹`],[30067,`瑋`],[30068,`㻚`],[30069,`畵`],[30070,`疁`],[30071,`睲`],[30072,`䂓`],[30073,`磈`],[30074,`磠`],[30075,`祇`],[30076,`禮`],[30077,`鿆`],[30078,`䄃`],[30241,`鿅`],[30242,`秚`],[30243,`稞`],[30244,`筿`],[30245,`簱`],[30246,`䉤`],[30247,`綋`],[30248,`羡`],[30249,`脘`],[30250,`脺`],[30251,`舘`],[30252,`芮`],[30253,`葛`],[30254,`蓜`],[30255,`蓬`],[30256,`蕙`],[30257,`藎`],[30258,`蝕`],[30259,`蟬`],[30260,`蠋`],[30261,`裵`],[30262,`角`],[30263,`諶`],[30264,`跎`],[30265,`辻`],[30266,`迶`],[30267,`郝`],[30268,`鄧`],[30269,`鄭`],[30270,`醲`],[30271,`鈳`],[30272,`銈`],[30273,`錡`],[30274,`鍈`],[30275,`閒`],[30276,`雞`],[30277,`餃`],[30278,`饀`],[30279,`髙`],[30280,`鯖`],[30281,`鷗`],[30282,`麴`],[30283,`麵`],[31265,`⛌`],[31266,`⛍`],[31267,`❗`],[31268,`⛏`],[31269,`⛐`],[31270,`⛑`],[31272,`⛒`],[31273,`⛕`],[31274,`⛓`],[31275,`⛔`],[31280,`🅿`],[31281,`🆊`],[31284,`⛖`],[31285,`⛗`],[31286,`⛘`],[31287,`⛙`],[31288,`⛚`],[31289,`⛛`],[31290,`⛜`],[31291,`⛝`],[31292,`⛞`],[31293,`⛟`],[31294,`⛠`],[31295,`⛡`],[31296,`⭕`],[31297,`㉈`],[31298,`㉉`],[31299,`㉊`],[31300,`㉋`],[31301,`㉌`],[31302,`㉍`],[31303,`㉎`],[31304,`㉏`],[31309,`⒑`],[31310,`⒒`],[31311,`⒓`],[31312,`🅊`],[31313,`🅌`],[31314,`🄿`],[31315,`🅆`],[31316,`🅋`],[31317,`🈐`],[31318,`🈑`],[31319,`🈒`],[31320,`🈓`],[31321,`🅂`],[31322,`🈔`],[31323,`🈕`],[31324,`🈖`],[31325,`🅍`],[31326,`🄱`],[31327,`🄽`],[31328,`⬛`],[31329,`⬤`],[31330,`🈗`],[31331,`🈘`],[31332,`🈙`],[31333,`🈚`],[31334,`🈛`],[31335,`⚿`],[31336,`🈜`],[31337,`🈝`],[31338,`🈞`],[31339,`🈟`],[31340,`🈠`],[31341,`🈡`],[31342,`🈢`],[31343,`🈣`],[31344,`🈤`],[31345,`🈥`],[31346,`🅎`],[31347,`㊙`],[31348,`🈀`],[31521,`⛣`],[31522,`⭖`],[31523,`⭗`],[31524,`⭘`],[31525,`⭙`],[31526,`☓`],[31527,`㊋`],[31528,`〒`],[31529,`⛨`],[31530,`㉆`],[31531,`㉅`],[31532,`⛩`],[31533,`࿖`],[31534,`⛪`],[31535,`⛫`],[31536,`⛬`],[31537,`♨`],[31538,`⛭`],[31539,`⛮`],[31540,`⛯`],[31541,`⚓`],[31542,`✈`],[31543,`⛰`],[31544,`⛱`],[31545,`⛲`],[31546,`⛳`],[31547,`⛴`],[31548,`⛵`],[31549,`🅗`],[31550,`Ⓓ`],[31551,`Ⓢ`],[31552,`⛶`],[31553,`🅟`],[31554,`🆋`],[31555,`🆍`],[31556,`🆌`],[31557,`🅹`],[31558,`⛷`],[31559,`⛸`],[31560,`⛹`],[31561,`⛺`],[31562,`🅻`],[31563,`☎`],[31564,`⛻`],[31565,`⛼`],[31566,`⛽`],[31567,`⛾`],[31568,`🅼`],[31569,`⛿`],[31777,`➡`],[31778,`⬅`],[31779,`⬆`],[31780,`⬇`],[31781,`⬯`],[31782,`⬮`],[31783,`年`],[31784,`月`],[31785,`日`],[31786,`円`],[31787,`㎡`],[31788,`㎥`],[31789,`㎝`],[31790,`㎠`],[31791,`㎤`],[31792,`🄀`],[31793,`⒈`],[31794,`⒉`],[31795,`⒊`],[31796,`⒋`],[31797,`⒌`],[31798,`⒍`],[31799,`⒎`],[31800,`⒏`],[31801,`⒐`],[31802,``],[31803,``],[31804,``],[31805,``],[31806,``],[31807,``],[31808,`🄁`],[31809,`🄂`],[31810,`🄃`],[31811,`🄄`],[31812,`🄅`],[31813,`🄆`],[31814,`🄇`],[31815,`🄈`],[31816,`🄉`],[31817,`🄊`],[31818,`㈳`],[31819,`㈶`],[31820,`㈲`],[31821,`㈱`],[31822,`㈹`],[31823,`㉄`],[31824,`▶`],[31825,`◀`],[31826,`〖`],[31827,`〗`],[31828,`⟐`],[31829,`²`],[31830,`³`],[31831,`🄭`],[31832,``],[31833,``],[31834,``],[31835,``],[31836,``],[31837,``],[31838,``],[31839,``],[31840,``],[31841,``],[31842,``],[31843,``],[31844,``],[31845,``],[31846,``],[31847,``],[31848,``],[31849,``],[31850,``],[31851,``],[31852,``],[31853,``],[31854,``],[31855,``],[31856,``],[31857,``],[31858,``],[31859,``],[31860,``],[31861,``],[31862,`🄬`],[31863,`🄫`],[31864,`㉇`],[31865,`🆐`],[31866,`🈦`],[31867,`℻`],[32033,`㈪`],[32034,`㈫`],[32035,`㈬`],[32036,`㈭`],[32037,`㈮`],[32038,`㈯`],[32039,`㈰`],[32040,`㈷`],[32041,`㍾`],[32042,`㍽`],[32043,`㍼`],[32044,`㍻`],[32045,`№`],[32046,`℡`],[32047,`〶`],[32048,`⚾`],[32049,`🉀`],[32050,`🉁`],[32051,`🉂`],[32052,`🉃`],[32053,`🉄`],[32054,`🉅`],[32055,`🉆`],[32056,`🉇`],[32057,`🉈`],[32058,`🄪`],[32059,`🈧`],[32060,`🈨`],[32061,`🈩`],[32062,`🈔`],[32063,`🈪`],[32064,`🈫`],[32065,`🈬`],[32066,`🈭`],[32067,`🈮`],[32068,`🈯`],[32069,`🈰`],[32070,`🈱`],[32071,`ℓ`],[32072,`㎏`],[32073,`㎐`],[32074,`㏊`],[32075,`㎞`],[32076,`㎢`],[32077,`㍱`],[32080,`½`],[32081,`↉`],[32082,`⅓`],[32083,`⅔`],[32084,`¼`],[32085,`¾`],[32086,`⅕`],[32087,`⅖`],[32088,`⅗`],[32089,`⅘`],[32090,`⅙`],[32091,`⅚`],[32092,`⅐`],[32093,`⅛`],[32094,`⅑`],[32095,`⅒`],[32096,`☀`],[32097,`☁`],[32098,`☂`],[32099,`⛄`],[32100,`☖`],[32101,`☗`],[32102,`⛉`],[32103,`⛊`],[32104,`♦`],[32105,`♥`],[32106,`♣`],[32107,`♠`],[32108,`⛋`],[32109,`⨀`],[32110,`‼`],[32111,`⁉`],[32112,`⛅`],[32113,`☔`],[32114,`⛆`],[32115,`☃`],[32116,`⛇`],[32117,`⚡`],[32118,`⛈`],[32120,`⚞`],[32121,`⚟`],[32122,`♬`],[32123,`☎`],[32289,`Ⅰ`],[32290,`Ⅱ`],[32291,`Ⅲ`],[32292,`Ⅳ`],[32293,`Ⅴ`],[32294,`Ⅵ`],[32295,`Ⅶ`],[32296,`Ⅷ`],[32297,`Ⅸ`],[32298,`Ⅹ`],[32299,`Ⅺ`],[32300,`Ⅻ`],[32301,`⑰`],[32302,`⑱`],[32303,`⑲`],[32304,`⑳`],[32305,`⑴`],[32306,`⑵`],[32307,`⑶`],[32308,`⑷`],[32309,`⑸`],[32310,`⑹`],[32311,`⑺`],[32312,`⑻`],[32313,`⑼`],[32314,`⑽`],[32315,`⑾`],[32316,`⑿`],[32317,`㉑`],[32318,`㉒`],[32319,`㉓`],[32320,`㉔`],[32321,`🄐`],[32322,`🄑`],[32323,`🄒`],[32324,`🄓`],[32325,`🄔`],[32326,`🄕`],[32327,`🄖`],[32328,`🄗`],[32329,`🄘`],[32330,`🄙`],[32331,`🄚`],[32332,`🄛`],[32333,`🄜`],[32334,`🄝`],[32335,`🄞`],[32336,`🄟`],[32337,`🄠`],[32338,`🄡`],[32339,`🄢`],[32340,`🄣`],[32341,`🄤`],[32342,`🄥`],[32343,`🄦`],[32344,`🄧`],[32345,`🄨`],[32346,`🄩`],[32347,`㉕`],[32348,`㉖`],[32349,`㉗`],[32350,`㉘`],[32351,`㉙`],[32352,`㉚`],[32353,`①`],[32354,`②`],[32355,`③`],[32356,`④`],[32357,`⑤`],[32358,`⑥`],[32359,`⑦`],[32360,`⑧`],[32361,`⑨`],[32362,`⑩`],[32363,`⑪`],[32364,`⑫`],[32365,`⑬`],[32366,`⑭`],[32367,`⑮`],[32368,`⑯`],[32369,`❶`],[32370,`❷`],[32371,`❸`],[32372,`❹`],[32373,`❺`],[32374,`❻`],[32375,`❼`],[32376,`❽`],[32377,`❾`],[32378,`❿`],[32379,`⓫`],[32380,`⓬`],[32381,`㉛`]]);let b=new Set([]);for(let e=122;e<127;e++)for(let t=33;t<127;t++){let n=e<<8|t;if(!v.has(n))continue;let r=v.get(n);switch(r){case`年`:case`月`:case`日`:case`円`:break;default:b.add(r);break}}for(let e=122;e<127;e++)for(let t=33;t<127;t++){let n=e<<8|t;if(!y.has(n))continue;let r=y.get(n);switch(r){case`年`:case`月`:case`日`:case`円`:break;default:b.add(r);break}}var x=e=>!!b.has(e);let S=(e,t,n,r,i)=>{let{state:a}=t;e.clearRect((a.margin[0]+(a.position[0]+0)-0)*n[0],(a.margin[1]+(a.position[1]+1)-d.box(a)[1])*n[1],d.box(a)[0]*n[0],d.box(a)[1]*n[1])},C=(e,t,n,r,i)=>{let{state:a}=t;e.fillStyle=i.color.background??m[a.background],e.fillRect((a.margin[0]+(a.position[0]+0)-0)*n[0],(a.margin[1]+(a.position[1]+1)-d.box(a)[1])*n[1],d.box(a)[0]*n[0],d.box(a)[1]*n[1])},w=(e,t,n,r,i)=>{let{state:a,option:o}=t,s=(a.margin[0]+(a.position[0]+0)+0)*n[0],c=(a.margin[1]+(a.position[1]+1)-d.box(a)[1])*n[1];e.translate(s,c),e.scale(n[0],n[1]),e.fillStyle=i.color.foreground??m[a.foreground],a.highlight&1&&e.fillRect(0,d.box(a)[1]-1*o.magnification,d.box(a)[0],1*o.magnification),a.highlight&2&&e.fillRect(d.box(a)[0]-1*o.magnification,0,1*o.magnification,d.box(a)[1]),a.highlight&4&&e.fillRect(0,0,d.box(a)[0],1*o.magnification),a.highlight&8&&e.fillRect(0,0,1*o.magnification,d.box(a)[1]),e.setTransform(1,0,0,1,0,0)},T=(e,t,n,r,i)=>{let{state:a,option:o}=t;if(!a.underline)return;let s=(a.margin[0]+(a.position[0]+0)+0)*n[0],c=(a.margin[1]+(a.position[1]+1)-d.box(a)[1])*n[1];e.translate(s,c),e.scale(n[0],n[1]),e.fillStyle=i.color.foreground??m[a.foreground],e.fillRect(0,d.box(a)[1]-1*o.magnification,d.box(a)[0],1*o.magnification),e.setTransform(1,0,0,1,0,0)},E=(e,t,n,r,i,a)=>{let{state:o,option:s,character:c,non_spacing:l}=t,u=_(o.size,i),f=a.replace.half&&u&&h.has(c)?h.get(c):c;l||(S(e,t,r,i,a),C(e,t,r,i,a),w(e,t,r,i,a),T(e,t,r,i,a));let p=(a.color.stroke==null?null:g.get(a.color.stroke)??a.color.stroke)??(o.ornament==null?null:m[o.ornament]),v=a.color.foreground??m[o.foreground];if(a.replace.glyph.has(f)){let t=Math.floor((o.margin[0]+(o.position[0]+0)+0+d.offset(o)[0])*r[0]),i=Math.floor((o.margin[1]+(o.position[1]+1)-d.box(o)[1]+d.offset(o)[1])*r[1]);e.translate(t,i);let{viewBox:c,path:l}=a.replace.glyph.get(f),u=new n(l),[m,h,g,_]=c,y=g-m,b=_-h;e.scale(r[0]*o.fontsize[0]/y,r[1]*o.fontsize[1]/b),e.translate(m,h),p!==null&&p!==v&&(e.strokeStyle=p,e.lineJoin=`round`,e.lineWidth=4*Math.max(y/o.fontsize[0],b/o.fontsize[1])*s.magnification,e.stroke(u)),e.fillStyle=v,e.fill(u),e.setTransform(1,0,0,1,0,0);return}let y=Math.floor((o.margin[0]+(o.position[0]+0)+d.box(o)[0]/2)*r[0]),b=Math.floor((o.margin[1]+(o.position[1]+1)-d.box(o)[1]/2)*r[1]);e.translate(y,b);let E=x(f)?a.font.arib??a.font.normal:a.font.normal;e.scale(r[0]*1,d.scale(o)[1]*r[1]),p!==null&&p!==v&&(e.font=`${o.fontsize[0]}px ${E}`,e.strokeStyle=p,e.lineJoin=`round`,e.textBaseline=`middle`,e.textAlign=`center`,e.lineWidth=4*s.magnification,e.strokeText(f,0,0,o.fontsize[0]*d.scale(o)[0])),e.font=`${o.fontsize[0]}px ${E}`,e.fillStyle=v,e.textBaseline=`middle`,e.textAlign=`center`,e.fillText(f,0,0,o.fontsize[0]*d.scale(o)[0]),e.setTransform(1,0,0,1,0,0)},D=(e,t,n,r,i,a)=>{let{state:o,option:s,width:c,height:l,depth:u,binary:f}=t,p=new Uint8Array(f),m=(o.margin[0]+o.position[0]+(0+d.offset(o)[0]))*r[0],h=(o.margin[1]+o.position[1]+(1-d.box(o)[1]+d.offset(o)[1]))*r[1];e.translate(m,h),e.scale(s.magnification*r[0],s.magnification*r[1]);let g=``;for(let e=0;e<l;e++)for(let t=0;t<c;t++){let n=0;for(let r=0;r<u;r++){let i=Math.floor(((e*c+t)*u+r)/8),a=7-((e*c+t)*u+r)%8;n*=2,n+=(p[i]&1<<a)>>a}n!==0&&(g+=(g===``?``:` `)+`M ${t} ${e} h 1 v 1 H ${t} Z`)}let _=new n(g);a!=null&&(e.strokeStyle=a,e.lineJoin=`round`,e.lineWidth=2*s.magnification,e.stroke(_)),e.fill(_),e.setTransform(1,0,0,1,0,0)},O=(e,t,n,r,i,a)=>{let{state:o}=t;S(e,t,r,i,a),C(e,t,r,i,a),w(e,t,r,i,a),T(e,t,r,i,a);let s=(a.color.stroke==null?null:g.get(a.color.stroke)??a.color.stroke)??(o.ornament==null?null:m[o.ornament]);D(e,t,n,r,a.color.foreground??m[o.foreground],s)};var k=(t,n,r,i,a,o)=>{let s=[1,1];{let c=n.getContext(`2d`);if(c==null)return;let l=new p(r),u=l.parse(i),{plane:d}=l.currentState();t!=null&&(s=[Math.ceil(t.width/d[0]),Math.ceil(t.height/d[1])]);let f=d[0]*s[0],m=d[1]*s[1];(n.width!==f||n.height!==m)&&(n.width=f,n.height=m,c.clearRect(0,0,n.width,n.height));for(let t of u)switch(t.tag){case`Character`:E(c,t,globalThis.Path2D,s,a,o);break;case`DRCS`:O(c,t,globalThis.Path2D,s,a,o);break;case`Bitmap`:A(c,t,globalThis.Path2D,s,a,o);break;case`ClearScreen`:t.time===0&&c.clearRect(0,0,n.width,n.height);break;default:throw new e(t,`Unhandled ARIB Parsed Token in CanvasRendererStrategy`)}}if(t!=null){let e=t.getContext(`2d`);if(e==null)return;switch(e.clearRect(0,0,t.width,t.height),o.resize.objectFit){case`none`:e.drawImage(n,0,0,t.width,t.height);break;default:{let r=t.width/(n.width/s[0]),i=t.height/(n.height/s[1]),a=Math.min(r,i),o=n.width*a/s[0],c=n.height*a/s[1],l=(t.width-o)/2,u=(t.height-c)/2;e.drawImage(n,0,0,n.width,n.height,l,u,o,c);break}}}};let A=(e,t,n,r,i,a)=>{let{x_position:o,y_position:s,width:c,height:l}=t;e.drawImage(t.normal_bitmap,o*r[0],s*r[1],c*r[0],l*r[1]),t.normal_bitmap.close(),t.flashing_bitmap?.close()},j={from(e){return{type:`imagebitmap`,bitmap:e??null}}},M=null,N=null;self.addEventListener(`message`,t=>{switch(t.data.type){case`initialize`:M=t.data.present,N=t.data.buffer;break;case`resize`:{let{width:e,height:n}=t.data;if(M==null)break;M.width=e,M.height=n;break}case`terminate`:M!=null&&(M.width=M.height=0,M=null),N!=null&&(N.width=N.height=0,N=null);break;case`clear`:if(M){let e=M.getContext(`2d`);e&&e.clearRect(0,0,M.width,M.height)}if(N){let e=N.getContext(`2d`);e&&e.clearRect(0,0,N.width,N.height)}break;case`render`:{if(M==null||N==null)break;let{state:e,tokens:n,info:r,option:i}=t.data;k(M,N,e,n,r,i);break}case`imagebitmap`:if(M==null)break;createImageBitmap(M).then(e=>{self.postMessage(j.from(e))});break;default:throw new e(t.data,`Exhaustive check failed in CanvasRenderingWorker`)}})})();", rr = typeof self < "u" && self.Blob && new Blob(["(self.URL || self.webkitURL).revokeObjectURL(self.location.href);", nr], { type: "text/javascript;charset=utf-8" });
function ir(e) {
	let t;
	try {
		if (t = rr && (self.URL || self.webkitURL).createObjectURL(rr), !t) throw "";
		let n = new Worker(t, { name: e?.name });
		return n.addEventListener("error", () => {
			(self.URL || self.webkitURL).revokeObjectURL(t);
		}), n;
	} catch {
		return new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(nr), { name: e?.name });
	}
}
//#endregion
//#region src/runtime/browser/renderer/canvas/canvas-renderer-worker.event.ts
var ar = { from(e, t) {
	return {
		type: "initialize",
		present: e,
		buffer: t
	};
} }, or = { from() {
	return { type: "clear" };
} }, sr = { from(e, t) {
	return {
		type: "resize",
		width: e,
		height: t
	};
} }, cr = { from(e, t, n, r) {
	return {
		type: "render",
		state: e,
		tokens: t,
		info: n,
		option: r
	};
} }, lr = { from(e) {
	return {
		type: "imagebitmap",
		bitmap: e ?? null
	};
} }, ur = class extends zn {
	buffer;
	present;
	worker;
	waitPromise = null;
	waitResolve = () => {};
	constructor(e) {
		super(e), this.present = this.canvas.transferControlToOffscreen(), this.buffer = new OffscreenCanvas(0, 0), this.worker = new ir(), this.worker.postMessage(ar.from(this.present, this.buffer), [this.present, this.buffer]);
	}
	resize(e, t) {
		this.worker.postMessage(sr.from(e, t));
	}
	destroy() {
		this.worker.postMessage(sr.from(0, 0)), this.worker.terminate();
	}
	clear() {
		this.worker.postMessage(or.from());
	}
	render(e, t, n) {
		this.worker.postMessage(cr.from(e, tn(t, this.option.replace.drcs), n, this.option));
	}
	async getPresentationImageBitmap() {
		for (; this.waitPromise != null && (await this.waitPromise, this.waitPromise != null););
		return this.waitPromise = new Promise((e) => {
			this.waitResolve = () => {
				this.waitPromise = null, this.waitResolve = () => {}, e();
			};
		}), this.worker.postMessage(lr.from()), new Promise((e) => {
			this.worker.addEventListener("message", (t) => {
				switch (t.data.type) {
					case "imagebitmap":
						e(t.data.bitmap), this.waitResolve();
						return;
				}
			}, { once: !0 });
		});
	}
}, dr = (e) => e.association === "SBTVD", fr = (e) => e.association === "SBTVD", pr = (e, t) => t.association !== "ARIB" || t.language !== "jpn" ? !1 : e === P.Small, mr = { from(e) {
	return {
		font: {
			normal: "'Hiragino Maru Gothic Pro', 'BIZ UDGothic', 'Yu Gothic Medium', sans-serif",
			arib: "'Hiragino Maru Gothic Pro', 'BIZ UDGothic', 'Yu Gothic Medium', sans-serif",
			...e?.font
		},
		replace: {
			half: !0,
			drcs: /* @__PURE__ */ new Map(),
			glyph: /* @__PURE__ */ new Map(),
			...e?.replace
		},
		color: {
			stroke: null,
			foreground: null,
			background: null,
			...e?.color
		},
		animation: {
			pause: !0,
			...e?.animation
		}
	};
} }, Y = { from(e, t, n = {}, r = []) {
	return {
		name: t,
		xmlns: e,
		attributes: n,
		children: r
	};
} }, hr = (e, t, n, r) => {
	let i = Y.from("http://www.w3.org/2000/svg", "svg"), a = Y.from("http://www.w3.org/2000/svg", "svg"), o = [], s = [], c = /* @__PURE__ */ new Map();
	for (let r of e) switch (i.attributes.viewBox = `0 0 ${r.state.plane[0]} ${r.state.plane[1]}`, a.attributes.viewBox = `0 0 ${r.state.area[0]} ${r.state.area[1]}`, a.attributes.x = `${r.state.margin[0]}`, a.attributes.y = `${r.state.margin[1]}`, a.attributes.width = `${r.state.area[0]}`, a.attributes.height = `${r.state.area[1]}`, r.tag) {
		case "Character": {
			if (!r.non_spacing) {
				let [e, i] = vr(r, t, n);
				c.set(e, `${c.get(e) ?? ""}${c.has(e) ? " " : ""}${i}`);
			}
			let e = Y.from("http://www.w3.org/2000/svg", "g");
			e.children.push(yr(r, t, n)), e.children.push(gr(r, t, n));
			let i = _r(r, t, n);
			i && e.children.push(i), o.push(e);
			break;
		}
		case "DRCS": {
			let [e, i] = vr(r, t, n);
			c.set(e, `${c.get(e) ?? ""}${c.has(e) ? " " : ""}${i}`);
			let a = Y.from("http://www.w3.org/2000/svg", "g");
			for (let e of br(r, t, n)) a.children.push(e);
			a.children.push(gr(r, t, n));
			let s = _r(r, t, n);
			s && a.children.push(s), o.push(a);
			break;
		}
		case "Bitmap": {
			let { width: e, height: t, normal_dataurl: n, flashing_dataurl: i } = et.toDataURL(r, q);
			{
				let i = Y.from("http://www.w3.org/2000/svg", "image");
				i.attributes.href = n, i.attributes.x = `${r.x_position}`, i.attributes.y = `${r.y_position}`, i.attributes.width = `${e}`, i.attributes.height = `${t}`, s.push(i);
			}
			if (i != null) {
				let n = Y.from("http://www.w3.org/2000/svg", "image");
				n.attributes.href = i, n.attributes.x = `${r.x_position}`, n.attributes.y = `${r.y_position}`, n.attributes.width = `${e}`, n.attributes.height = `${t}`;
				let a = Y.from("http://www.w3.org/2000/svg", "animate");
				a.attributes.attributeName = "opacity", a.attributes.values = "1;0", a.attributes.dur = "1s", a.attributes.calcMode = "discrete", a.attributes.repeatCount = "indefinite", n.children.push(a), s.push(n);
			}
			break;
		}
		case "ClearScreen":
			if (r.time === 0) {
				a.children = [];
				break;
			}
			break;
		default: throw new M(r, "Unexpected ARIB Parsed Token in SVGRenderingStrategy");
	}
	for (let [e, t] of c.entries()) {
		let n = Y.from("http://www.w3.org/2000/svg", "path");
		n.attributes["shape-rendering"] = "crispEdges", n.attributes.d = t, n.attributes.fill = e, a.children.push(n);
	}
	return a.children.push(...o), a.children.push(...s), r ? (i.children.push(a), i) : a;
}, gr = (e, t, n) => {
	let { state: r, option: i } = e, a = n.color.foreground ?? q[r.foreground], o = r.position[0] + 0 + 0, s = r.position[1] + 1 - F.box(r)[1], c = "";
	r.highlight & 1 && (c += (c === "" ? "" : " ") + `M ${o} ${s + F.box(r)[1] - 1 * i.magnification} h ${F.box(r)[0]} v ${i.magnification} H ${o} Z`), r.highlight & 2 && (c += (c === "" ? "" : " ") + `M ${o + F.box(r)[0] - 1 * i.magnification} ${s} h ${i.magnification} v ${F.box(r)[1]} H ${o + F.box(r)[0] - 1 * i.magnification} Z`), r.highlight & 4 && (c += (c === "" ? "" : " ") + `M ${o} ${s} h ${F.box(r)[0]} v ${i.magnification} H ${o} Z`), r.highlight & 8 && (c += (c === "" ? "" : " ") + `M ${o} ${s} h ${i.magnification} v ${F.box(r)[1]} H ${o} Z`), r.underline && (c += (c === "" ? "" : " ") + `M ${o} ${s + F.box(r)[1] - 1 * i.magnification} h ${F.box(r)[0]} v ${i.magnification} H ${o} Z`);
	let l = Y.from("http://www.w3.org/2000/svg", "path");
	return l.attributes["shape-rendering"] = "crispEdges", c !== "" && (l.attributes.d = c), l.attributes.fill = a, l;
}, _r = (e, t, n) => {
	let { state: r } = e;
	switch (r.flashing) {
		case T.STOP: return null;
		case T.NORMAL:
		case T.INVERTED: {
			let e = Y.from("http://www.w3.org/2000/svg", "animate");
			return e.attributes.attributeName = "opacity", e.attributes.values = r.flashing === T.NORMAL ? "1;0" : "0;1", e.attributes.dur = "1s", e.attributes.calcMode = "discrete", e.attributes.repeatCount = "indefinite", e;
		}
		default: throw new M(r.flashing, "Unhandled Flasing Token in SVGDOMRenderingStrategy");
	}
}, vr = (e, t, n) => {
	let { state: r } = e, i = n.color.background ?? q[r.background], a = Math.floor(r.position[0] + 0 + 0);
	return [i, `M ${a} ${Math.floor(r.position[1] + 1 - F.box(r)[1])} h ${F.box(r)[0]} v ${F.box(r)[1]} H ${a} Z`];
}, yr = (e, t, n) => {
	let { state: r, option: i, character: a } = e, o = Hn(r.size, t), s = n.replace.half && o, c = Bn.has(a), l = s && c ? Bn.get(a) : a, u = Math.floor(r.position[0] + 0 + F.box(r)[0] / 2), d = Math.floor(r.position[1] + 1 - F.box(r)[1] / 2), f = F.scale(r)[0], p = F.scale(r)[1], m = (n.color.stroke == null ? null : Vn.get(n.color.stroke) ?? n.color.stroke) ?? (r.ornament == null ? null : q[r.ornament]), h = n.color.foreground ?? q[r.foreground], g = Y.from("http://www.w3.org/2000/svg", "text");
	return g.attributes.x = `${u}`, g.attributes.y = `${d}`, g.attributes.transform = `scale(1 ${p})`, g.attributes["transform-origin"] = `${u} ${d}`, g.attributes["font-size"] = `${r.fontsize[0]}`, g.attributes["font-family"] = Wn(l) ? n.font.arib ?? n.font.normal : n.font.normal, g.attributes["dominant-baseline"] = "central", g.attributes["text-anchor"] = "middle", g.attributes.fill = h, g.attributes["paint-order"] = "stroke", g.attributes["stroke-linejoin"] = "round", g.attributes["stroke-width"] = m == null ? "0" : `${4 * i.magnification}`, g.attributes.stroke = m ?? "transparent", g.attributes["data-width"] = `${r.fontsize[0] * f}`, g.attributes.textLength = `${r.fontsize[0] * f}`, g.attributes.lengthAdjust = "spacingAndGlyphs", g.children.push(l), g;
}, br = (e, t, n) => {
	let { state: r, option: i, width: a, height: o, depth: s, binary: c } = e, l = new Uint8Array(c), u = (n.color.stroke == null ? null : Vn.get(n.color.stroke) ?? n.color.stroke) ?? (r.ornament == null ? null : q[r.ornament]), d = n.color.foreground ?? q[r.foreground], f = r.position[0] + (0 + F.offset(r)[0]), p = r.position[1] + (1 - F.box(r)[1] + F.offset(r)[1]), m = "";
	for (let e = 0; e < o; e++) for (let t = 0; t < a; t++) {
		let n = f + t * i.magnification, r = p + e * i.magnification, o = 0;
		for (let n = 0; n < s; n++) {
			let r = Math.floor(((e * a + t) * s + n) / 8), i = 7 - ((e * a + t) * s + n) % 8;
			o *= 2, o += (l[r] & 1 << i) >> i;
		}
		o !== 0 && (m += (m === "" ? "" : " ") + `M ${n} ${r} h ${i.magnification} v ${i.magnification} H ${n} Z`);
	}
	let h = Y.from("http://www.w3.org/2000/svg", "path"), g = Y.from("http://www.w3.org/2000/svg", "path");
	return h.attributes["shape-rendering"] = "crispEdges", g.attributes["shape-rendering"] = "crispEdges", h.attributes.d = m, g.attributes.d = m, h.attributes.stroke = u ?? "transparent", g.attributes.stroke = "transparent", h.attributes.fill = "transparent", g.attributes.fill = d, h.attributes["stroke-width"] = u == null ? "0" : `${4 * i.magnification}`, h.attributes["stroke-linejoin"] = "round", [h, g];
}, xr = (e) => {
	if (typeof e == "string") return document.createTextNode(e);
	let t = document.createElementNS(e.xmlns, e.name);
	for (let [n, r] of Object.entries(e.attributes)) t.setAttribute(n, r);
	for (let n of e.children) t.appendChild(xr(n));
	return t;
}, Sr = (e, t, n, r, i) => {
	let a = new en(t), o = a.parse(n), s = o.filter((e) => e.tag !== "Bitmap"), c = o.filter((e) => e.tag === "Bitmap"), l = o.find((e) => e.tag === "ClearScreen");
	if (l && l.time === 0) for (; e.lastChild != null;) e.removeChild(e.lastChild);
	let u = hr(s, r, i);
	for (let e of c) {
		{
			let t = Y.from("http://www.w3.org/2000/svg", "image");
			t.attributes.href = e.normal_dataurl, t.attributes.x = `${e.x_position}`, t.attributes.y = `${e.y_position}`, t.attributes.width = `${e.width}`, t.attributes.height = `${e.height}`, u.children.push(t);
		}
		if (e.flashing_dataurl != null) {
			let t = Y.from("http://www.w3.org/2000/svg", "image");
			t.attributes.href = e.flashing_dataurl, t.attributes.x = `${e.x_position}`, t.attributes.y = `${e.y_position}`, t.attributes.width = `${e.width}`, t.attributes.height = `${e.height}`;
			let n = Y.from("http://www.w3.org/2000/svg", "animate");
			n.attributes.attributeName = "opacity", n.attributes.values = "1;0", n.attributes.dur = "1s", n.attributes.calcMode = "discrete", n.attributes.repeatCount = "indefinite", t.children.push(n), u.children.push(t);
		}
	}
	let d = xr(u);
	d.style.visibility = "hidden", e.setAttribute("viewBox", `0 0 ${a.currentState().plane[0]} ${a.currentState().plane[1]}`), e.appendChild(d);
	for (let t of Array.from(e.getElementsByTagNameNS("http://www.w3.org/2000/svg", "text"))) {
		let e = t.getComputedTextLength();
		t.setAttribute("textLength", `${Math.min(e, Number.parseInt(t.dataset.width, 10))}`), delete t.dataset.width, t.setAttribute("lengthAdjust", "spacingAndGlyphs");
	}
	for (let t of Array.from(e.getElementsByTagNameNS("http://www.w3.org/2000/svg", "animate"))) t.beginElement();
	d.style.visibility = "visible";
}, Cr = class {
	option;
	svg;
	constructor(e) {
		this.option = mr.from(e), this.svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), this.svg.style.position = "absolute", this.svg.style.top = this.svg.style.left = "0", this.svg.style.pointerEvents = "none", this.svg.style.width = "100%", this.svg.style.height = "100%";
	}
	resize(e, t) {}
	destroy() {
		this.clear();
	}
	clear() {
		for (; this.svg.firstChild;) this.svg.removeChild(this.svg.firstChild);
	}
	hide() {
		this.svg.style.visibility = "hidden";
	}
	show() {
		this.svg.style.visibility = "visible";
	}
	render(e, t, n) {
		fr(n) && this.clear(), Sr(this.svg, e, tn(t, this.option.replace.drcs), n, this.option);
	}
	onAttach(e) {
		e.appendChild(this.svg);
	}
	onDetach() {
		this.svg.remove();
	}
	onContainerResize(e, t) {
		return !1;
	}
	onVideoResize(e, t) {
		return !1;
	}
	onPlay() {
		this.option.animation.pause && this.svg.unpauseAnimations();
	}
	onPause() {
		this.option.animation.pause && this.svg.pauseAnimations();
	}
	onSeeking() {
		this.clear();
	}
	getPresentationSVGElement() {
		return this.svg;
	}
}, wr = { from(e) {
	return { replace: {
		half: !0,
		drcs: /* @__PURE__ */ new Map(),
		...e?.replace
	} };
} }, X = structuredClone(Bn);
X.set("ア", "ｱ"), X.set("イ", "ｲ"), X.set("ウ", "ｳ"), X.set("エ", "ｴ"), X.set("オ", "ｵ"), X.set("カ", "ｶ"), X.set("キ", "ｷ"), X.set("ク", "ｸ"), X.set("ケ", "ｹ"), X.set("コ", "ｺ"), X.set("サ", "ｻ"), X.set("シ", "ｼ"), X.set("ス", "ｽ"), X.set("セ", "ｾ"), X.set("ソ", "ｿ"), X.set("タ", "ﾀ"), X.set("チ", "ﾁ"), X.set("ツ", "ﾂ"), X.set("テ", "ﾃ"), X.set("ト", "ﾄ"), X.set("ナ", "ﾅ"), X.set("ニ", "ﾆ"), X.set("ヌ", "ﾇ"), X.set("ネ", "ﾈ"), X.set("ノ", "ﾉ"), X.set("ハ", "ﾊ"), X.set("ヒ", "ﾋ"), X.set("フ", "ﾌ"), X.set("ヘ", "ﾍ"), X.set("ホ", "ﾎ"), X.set("マ", "ﾏ"), X.set("ミ", "ﾐ"), X.set("ム", "ﾑ"), X.set("メ", "ﾒ"), X.set("モ", "ﾓ"), X.set("ヤ", "ﾔ"), X.set("ユ", "ﾕ"), X.set("ヨ", "ﾖ"), X.set("ラ", "ﾗ"), X.set("リ", "ﾘ"), X.set("ル", "ﾙ"), X.set("レ", "ﾚ"), X.set("ロ", "ﾛ"), X.set("ワ", "ﾜ"), X.set("ヲ", "ｦ"), X.set("ン", "ﾝ"), X.set("ヴ", "ｳﾞ"), X.set("ガ", "ｶﾞ"), X.set("ギ", "ｷﾞ"), X.set("グ", "ｸﾞ"), X.set("ゲ", "ｹﾞ"), X.set("ゴ", "ｺﾞ"), X.set("ザ", "ｻﾞ"), X.set("ジ", "ｼﾞ"), X.set("ズ", "ｽﾞ"), X.set("ゼ", "ｾﾞ"), X.set("ゾ", "ｿﾞ"), X.set("ダ", "ﾀﾞ"), X.set("ヂ", "ﾁﾞ"), X.set("ヅ", "ﾂﾞ"), X.set("デ", "ﾃﾞ"), X.set("ド", "ﾄﾞ"), X.set("バ", "ﾊﾞ"), X.set("ビ", "ﾋﾞ"), X.set("ブ", "ﾌﾞ"), X.set("ベ", "ﾍﾞ"), X.set("ボ", "ﾎﾞ"), X.set("パ", "ﾊﾟ"), X.set("ピ", "ﾋﾟ"), X.set("プ", "ﾌﾟ"), X.set("ペ", "ﾍﾟ"), X.set("ポ", "ﾎﾟ"), X.set("ァ", "ｧ"), X.set("ィ", "ｨ"), X.set("ゥ", "ｩ"), X.set("ェ", "ｪ"), X.set("ォ", "ｫ"), X.set("ャ", "ｬ"), X.set("ュ", "ｭ"), X.set("ョ", "ｮ"), X.set("ッ", "ｯ"), X.set("◌゙", " ﾞ"), X.set("◌゚", " ﾟ");
//#endregion
//#region src/runtime/browser/renderer/text/text-renderer.ts
var Tr = class {
	option;
	text = null;
	constructor(e) {
		this.option = wr.from(e);
	}
	resize(e, t) {}
	destroy() {
		this.text = null;
	}
	clear() {
		this.text = null;
	}
	hide() {}
	show() {}
	render(e, t, n) {
		fr(n) && (this.text = "");
		let r = null, i = new en(e);
		for (let e of i.parse(tn(t, this.option.replace.drcs))) switch (e.tag) {
			case "Character": {
				let { state: t, character: i } = e;
				if (this.text == null || (i === " " || i === "　") && t.background === 8 && dr(n) || pr(t.size, n)) break;
				r != null && t.position[1] !== r && (this.text += "\n"), r = t.position[1], this.option.replace.half && Hn(t.size, n) ? this.text += X.get(i) : this.text += i;
				break;
			}
			case "DRCS": {
				let { state: t } = e;
				if (this.text == null) break;
				r != null && t.position[1] !== r && (this.text += "\n"), r = t.position[1], this.text += "〓";
				break;
			}
			case "Bitmap":
				e.normal_bitmap.close(), e.flashing_bitmap?.close();
				break;
			case "ClearScreen":
				e.time === 0 && (this.text = "");
				break;
			default: throw new M(e, "Unexpected ARIB Parsed Token in TextRenderer");
		}
	}
	onAttach(e) {}
	onDetach() {}
	onContainerResize(e, t) {
		return !1;
	}
	onVideoResize(e, t) {
		return !1;
	}
	onPlay() {}
	onPause() {}
	onSeeking() {
		this.clear();
	}
}, Er = { from(e) {
	return {
		replace: {
			drcs: /* @__PURE__ */ new Map(),
			...e?.replace
		},
		color: {
			foreground: !0,
			background: null,
			stroke: !1,
			...e?.color
		}
	};
} }, Dr = (e, t, n) => {
	switch (e.tag) {
		case "Character": {
			let r = document.createElement("div");
			return r.style.display = "inline-block", r.style.whiteSpace = "pre", n.color.foreground && (r.style.color = q[e.state.foreground]), n.color.stroke && (r.style.webkitTextStroke = "0.1em black", r.style.paintOrder = "stroke fill"), r.textContent = Hn(e.state.size, t) && X.get(e.character) || e.character, r;
		}
		case "DRCS": {
			let t = document.createElementNS("http://www.w3.org/2000/svg", "svg"), { state: r, width: i, height: a, depth: o, binary: s } = e, c = new Uint8Array(s), l = q[r.foreground], u = "";
			for (let e = 0; e < a; e++) for (let t = 0; t < i; t++) {
				let n = 0;
				for (let r = 0; r < o; r++) {
					let a = Math.floor(((e * i + t) * o + r) / 8), s = 7 - ((e * i + t) * o + r) % 8;
					n *= 2, n += (c[a] & 1 << s) >> s;
				}
				n !== 0 && (u += (u === "" ? "" : " ") + `M ${t} ${e} h 1 v 1 H ${t} Z`);
			}
			let d = document.createElementNS("http://www.w3.org/2000/svg", "path");
			if (n.color.stroke) {
				let e = document.createElementNS("http://www.w3.org/2000/svg", "path");
				e.setAttribute("d", u), e.setAttribute("stroke", "black"), e.setAttribute("fill", "transparent"), e.setAttribute("stroke-width", "2"), e.setAttribute("stroke-linejoin", "round"), t.appendChild(e);
			}
			return d.setAttribute("shape-rendering", "crispEdges"), d.setAttribute("d", u), d.setAttribute("stroke", "transparent"), d.setAttribute("fill", l), t.appendChild(d), t.setAttribute("viewBox", `0 0 ${i} ${a}`), t.style.width = "1em", t.style.verticalAlign = "middle", t;
		}
		case "Script":
			let r = document.createElement("div");
			return r.style.display = "inline-flex", r.style.fontSize = "0.5em", r.style.flexDirection = "column", r.style.verticalAlign = "top", r.appendChild(Dr(e.sup, t, n)), r.appendChild(Dr(e.sub, t, n)), r;
	}
}, Or = class {
	option;
	element;
	constructor(e) {
		this.option = Er.from(e), this.element = document.createElement("div");
	}
	resize(e, t) {}
	destroy() {
		for (; this.element.firstChild;) this.element.removeChild(this.element.firstChild);
	}
	clear() {
		for (; this.element.firstChild;) this.element.removeChild(this.element.firstChild);
	}
	hide() {
		this.element.style.visibility = "hidden";
	}
	show() {
		this.element.style.visibility = "showing";
	}
	render(e, t, n) {
		fr(n) && this.clear();
		let r = new en(e), i = new DocumentFragment(), a = nn(r.parse(tn(t, this.option.replace.drcs)), n, Jt.GUESS).map((e) => {
			let t = document.createElement("div");
			t.style.display = "inline-block", e.highlight && (t.style.border = "1px solid white");
			for (let r of e.spans) {
				let e = document.createElement("div");
				switch (e.style.display = "inline-block", r.tag) {
					case "Normal":
						for (let t of r.text) e.appendChild(Dr(t, n, this.option));
						break;
					case "Ruby": {
						let t = document.createElement("span");
						for (let e of r.ruby) t.appendChild(Dr(e, n, this.option));
						let i = document.createElement("rt");
						i.append(t);
						let a = document.createElement("span");
						for (let e of r.text) a.appendChild(Dr(e, n, this.option));
						let o = document.createElement("ruby");
						o.appendChild(a), o.appendChild(i), e.appendChild(o);
						break;
					}
					default: throw new M(r, "Undefined Region Type in HTMLFragmentRenderer");
				}
				t.appendChild(e);
			}
			return t;
		});
		for (let e of a.slice(0, -1)) e.style.marginRight = "0.5em";
		for (let e of a) i.appendChild(e);
		this.clear(), this.element.appendChild(i);
	}
	onAttach(e) {}
	onDetach() {}
	onContainerResize(e, t) {
		return !1;
	}
	onVideoResize(e, t) {
		return !1;
	}
	onPlay() {}
	onPause() {}
	onSeeking() {
		this.clear();
	}
	getPresentationElement() {
		return this.element;
	}
}, Z = (e, ...t) => {
	let n = [e], r = 32;
	for (let e of t.toReversed()) {
		n.unshift(r);
		do
			n.unshift(48 | e % 10), e = Math.floor(e / 10);
		while (e !== 0);
		r = 59;
	}
	return n.unshift(H.CSI), Uint8Array.from(n).buffer;
}, kr = class {
	encodeTokenHandler = this.encodeToken.bind(this);
	encodeToken(e) {
		switch (e.tag) {
			case "Character": return this.encodeCharacter(e);
			case "DRCS": return this.encodeDRCS(e);
			case "Bitmap": return this.encodeBitmap(e);
			case "Mosaic": return this.encodeMosaic(e);
			default: return this.encodeControl(e);
		}
	}
	encodeControl(e) {
		switch (e.tag) {
			case "Null": return Uint8Array.from([H.NUL]).buffer;
			case "Bell": return Uint8Array.from([H.BEL]).buffer;
			case "ActivePositionBackward": return Uint8Array.from([H.APB]).buffer;
			case "ActivePositionForward": return Uint8Array.from([H.APF]).buffer;
			case "ActivePositionDown": return Uint8Array.from([H.APD]).buffer;
			case "ActivePositionUp": return Uint8Array.from([H.APU]).buffer;
			case "ClearScreen": return Uint8Array.from([H.CS]).buffer;
			case "ActivePositionReturn": return Uint8Array.from([H.APR]).buffer;
			case "ParameterizedActivePositionForward": return Uint8Array.from([H.PAPF, 64 | e.x]).buffer;
			case "Cancel": return Uint8Array.from([H.CAN]).buffer;
			case "ActivePositionSet": return Uint8Array.from([
				H.APS,
				64 | e.y,
				64 | e.x
			]).buffer;
			case "RecordSeparator": return Uint8Array.from([H.RS]).buffer;
			case "UnitSeparator": return Uint8Array.from([H.US]).buffer;
			case "Space": return Uint8Array.from([H.SP]).buffer;
			case "Delete": return Uint8Array.from([H.DEL]).buffer;
			case "BlackForeground": return Uint8Array.from([H.BKF]).buffer;
			case "RedForeground": return Uint8Array.from([H.RDF]).buffer;
			case "GreenForeground": return Uint8Array.from([H.GRF]).buffer;
			case "YellowForeground": return Uint8Array.from([H.YLF]).buffer;
			case "BlueForeground": return Uint8Array.from([H.BLF]).buffer;
			case "MagentaForeground": return Uint8Array.from([H.MGF]).buffer;
			case "CyanForeground": return Uint8Array.from([H.CNF]).buffer;
			case "WhiteForeground": return Uint8Array.from([H.WHF]).buffer;
			case "SmallSize": return Uint8Array.from([H.SSZ]).buffer;
			case "MiddleSize": return Uint8Array.from([H.MSZ]).buffer;
			case "NormalSize": return Uint8Array.from([H.NSZ]).buffer;
			case "CharacterSizeControl": return Uint8Array.from([H.SZX, e.type]).buffer;
			case "ColorControlForeground": return Uint8Array.from([H.COL, 64 | e.color]).buffer;
			case "ColorControlBackground": return Uint8Array.from([H.COL, 80 | e.color]).buffer;
			case "ColorControlHalfForeground": return Uint8Array.from([H.COL, 96 | e.color]).buffer;
			case "ColorControlHalfBackground": return Uint8Array.from([H.COL, 112 | e.color]).buffer;
			case "PalletControl": return Uint8Array.from([
				H.COL,
				32,
				64 | e.pallet
			]).buffer;
			case "FlashingControl": return Uint8Array.from([H.FLC, e.type]).buffer;
			case "ConcealmentMode": return Uint8Array.from([H.CDC, e.type]).buffer;
			case "SingleConcealmentMode": return Uint8Array.from([H.CDC, e.type]).buffer;
			case "ReplacingConcealmentMode": return Uint8Array.from([
				H.CDC,
				32,
				e.type
			]).buffer;
			case "PatternPolarityControl": return Uint8Array.from([H.POL, e.type]).buffer;
			case "WritingModeModification": return Uint8Array.from([H.WMM, e.type]).buffer;
			case "HilightingCharacterBlock": return Uint8Array.from([H.HLC, 64 | e.enclosure]).buffer;
			case "RepeatCharacter": return Uint8Array.from([H.RPC, 64 | e.repeat]).buffer;
			case "StartLining": return Uint8Array.from([H.STL]).buffer;
			case "StopLining": return Uint8Array.from([H.SPL]).buffer;
			case "TimeControlWait": return Uint8Array.from([
				H.TIME,
				32,
				64 | e.seconds * 10
			]).buffer;
			case "TimeControlMode": return Uint8Array.from([
				H.TIME,
				40,
				e.type
			]).buffer;
			case "SetWritingFormat": return Z(U.SWF, e.format);
			case "SetDisplayFormat": return Z(U.SDF, e.horizontal, e.vertical);
			case "SetDisplayPosition": return Z(U.SDP, e.horizontal, e.vertical);
			case "CharacterCompositionDotDesignation": return Z(U.SSM, e.horizontal, e.vertical);
			case "SetHorizontalSpacing": return Z(U.SHS, e.spacing);
			case "SetVerticalSpacing": return Z(U.SVS, e.spacing);
			case "ActiveCoordinatePositionSet": return Z(U.ACPS, e.x, e.y);
			case "RasterColourCommand": return Z(U.RCS, e.color);
			case "OrnamentControlNone": return Z(U.ORN, 0);
			case "OrnamentControlHemming": return Z(U.ORN, 1, e.color);
			case "OrnamentControlShade": return Z(U.ORN, 2, e.color);
			case "OrnamentControlHollow": return Z(U.ORN, 3);
			case "BuiltinSoundReplay": return Z(U.PRA, e.sound);
			default: throw new M(e, "Unexpeced ARIBB24Token in encodeControl)");
		}
	}
}, Ar = (...e) => {
	if (!e) return /* @__PURE__ */ new ArrayBuffer(0);
	let t = e.reduce((e, t) => e + t.byteLength, 0), n = new Uint8Array(t);
	for (let t = 0, r = 0; t < e.length; r += e[t].byteLength, t++) n.set(new Uint8Array(e[t]), r);
	return n.buffer;
}, jr = class extends kr {
	current_drcs_code = 60416;
	drcs_units = [];
	drcs_md5_to_code = /* @__PURE__ */ new Map();
	encoder = new TextEncoder();
	encodeCharacter({ character: e }) {
		return this.encoder.encode(e).buffer;
	}
	encode(e) {
		let t = Ar(...e.map(this.encodeTokenHandler));
		return [...this.drcs_units, zt.from(new Uint8Array(t))];
	}
	encodeControl(e) {
		switch (e.tag) {
			case "Null":
			case "Bell":
			case "ActivePositionBackward":
			case "ActivePositionForward":
			case "ActivePositionDown":
			case "ActivePositionUp":
			case "ClearScreen":
			case "ActivePositionReturn":
			case "ParameterizedActivePositionForward":
			case "Cancel":
			case "ActivePositionSet":
			case "RecordSeparator":
			case "UnitSeparator":
			case "Space":
			case "Delete": return super.encodeControl(e);
			default: return Ar(Uint8Array.from([194]).buffer, super.encodeControl(e));
		}
	}
	encodeDRCS(e) {
		let t = ot(e.binary);
		if (!this.drcs_md5_to_code.has(t)) {
			if (this.current_drcs_code > 63743) return this.encoder.encode("〓").buffer;
			let n = Uint8Array.from([
				1,
				(this.current_drcs_code & 65280) >> 8,
				(this.current_drcs_code & 255) >> 0,
				1,
				0,
				2 ** e.depth - 2,
				e.width,
				e.height
			]).buffer;
			this.drcs_units.push(Bt.from(new Uint8Array(Ar(n, e.binary)), 2)), this.drcs_md5_to_code.set(t, this.current_drcs_code), this.current_drcs_code++;
		}
		let n = this.drcs_md5_to_code.get(t);
		return e.combining === "" ? this.encoder.encode(String.fromCodePoint(n)).buffer : Ar(this.encoder.encode(String.fromCodePoint(n)).buffer, this.encodeCharacter(i.from(e.combining)));
	}
	encodeBitmap(e) {
		throw new A("Bitmap is Not Implemented");
	}
	encodeMosaic(e) {
		throw new A("Mozaic Character is Not Implemented");
	}
}, Mr = new Map([
	["０", "0"],
	["１", "1"],
	["２", "2"],
	["３", "3"],
	["４", "4"],
	["５", "5"],
	["６", "6"],
	["７", "7"],
	["８", "8"],
	["９", "9"],
	["ａ", "a"],
	["ｂ", "b"],
	["ｃ", "c"],
	["ｄ", "d"],
	["ｅ", "e"],
	["ｆ", "f"],
	["ｇ", "g"],
	["ｈ", "h"],
	["ｉ", "i"],
	["ｊ", "h"],
	["ｋ", "k"],
	["ｌ", "l"],
	["ｍ", "m"],
	["ｎ", "n"],
	["ｏ", "o"],
	["ｐ", "p"],
	["ｑ", "q"],
	["ｒ", "r"],
	["ｓ", "s"],
	["ｔ", "t"],
	["ｕ", "u"],
	["ｖ", "v"],
	["ｗ", "w"],
	["ｘ", "x"],
	["ｙ", "y"],
	["ｚ", "z"],
	["Ａ", "A"],
	["Ｂ", "B"],
	["Ｃ", "C"],
	["Ｄ", "D"],
	["Ｅ", "E"],
	["Ｆ", "F"],
	["Ｇ", "G"],
	["Ｈ", "H"],
	["Ｉ", "I"],
	["Ｊ", "J"],
	["Ｋ", "K"],
	["Ｌ", "L"],
	["Ｍ", "M"],
	["Ｎ", "N"],
	["Ｏ", "O"],
	["Ｐ", "P"],
	["Ｑ", "Q"],
	["Ｒ", "R"],
	["Ｓ", "S"],
	["Ｔ", "T"],
	["Ｕ", "U"],
	["Ｖ", "V"],
	["Ｗ", "W"],
	["Ｘ", "X"],
	["Ｙ", "Y"],
	["Ｚ", "Z"],
	["　", " "],
	["！", "!"],
	["＂", "\""],
	["＃", "#"],
	["＄", "$"],
	["％", "%"],
	["＆", "&"],
	["＇", "'"],
	["（", "("],
	["）", ")"],
	["＊", "*"],
	["＋", "+"],
	["，", ","],
	["－", "-"],
	["．", "."],
	["／", "/"],
	["：", ":"],
	["；", ";"],
	["＜", "<"],
	["＝", "="],
	["＞", ">"],
	["？", "?"],
	["＠", "@"],
	["［", "["],
	["＼", "\\"],
	["］", "]"],
	["＾", "^"],
	["＿", "_"],
	["｀", "`"],
	["｛", "{"],
	["｜", "|"],
	["｝", "}"],
	["～", "~"],
	["ー", "ｰ"],
	["、", "､"],
	["。", "｡"],
	["・", "･"],
	["「", "｢"],
	["」", "｣"],
	["｟", "⦅"],
	["｠", "⦆"],
	["￠", "¢"],
	["￡", "£"],
	["￢", "¬"],
	["￣", "¯"],
	["￤", "¦"],
	["￥", "¥"],
	["￦", "₩"],
	["│", "￨"],
	["←", "￩"],
	["↑", "￪"],
	["→", "￫"],
	["↓", "￬"],
	["■", "￭"],
	["○", "￮"],
	["ア", "ｱ"],
	["イ", "ｲ"],
	["ウ", "ｳ"],
	["エ", "ｴ"],
	["オ", "ｵ"],
	["カ", "ｶ"],
	["キ", "ｷ"],
	["ク", "ｸ"],
	["ケ", "ｹ"],
	["コ", "ｺ"],
	["サ", "ｻ"],
	["シ", "ｼ"],
	["ス", "ｽ"],
	["セ", "ｾ"],
	["ソ", "ｿ"],
	["タ", "ﾀ"],
	["チ", "ﾁ"],
	["ツ", "ﾂ"],
	["テ", "ﾃ"],
	["ト", "ﾄ"],
	["ナ", "ﾅ"],
	["ニ", "ﾆ"],
	["ヌ", "ﾇ"],
	["ネ", "ﾈ"],
	["ノ", "ﾉ"],
	["ハ", "ﾊ"],
	["ヒ", "ﾋ"],
	["フ", "ﾌ"],
	["ヘ", "ﾍ"],
	["ホ", "ﾎ"],
	["マ", "ﾏ"],
	["ミ", "ﾐ"],
	["ム", "ﾑ"],
	["メ", "ﾒ"],
	["モ", "ﾓ"],
	["ヤ", "ﾔ"],
	["ユ", "ﾕ"],
	["ヨ", "ﾖ"],
	["ラ", "ﾗ"],
	["リ", "ﾘ"],
	["ル", "ﾙ"],
	["レ", "ﾚ"],
	["ロ", "ﾛ"],
	["ワ", "ﾜ"],
	["ヲ", "ｦ"],
	["ン", "ﾝ"],
	["ヴ", "ｳﾞ"],
	["ガ", "ｶﾞ"],
	["ギ", "ｷﾞ"],
	["グ", "ｸﾞ"],
	["ゲ", "ｹﾞ"],
	["ゴ", "ｺﾞ"],
	["ザ", "ｻﾞ"],
	["ジ", "ｼﾞ"],
	["ズ", "ｽﾞ"],
	["ゼ", "ｾﾞ"],
	["ゾ", "ｿﾞ"],
	["ダ", "ﾀﾞ"],
	["ヂ", "ﾁﾞ"],
	["ヅ", "ﾂﾞ"],
	["デ", "ﾃﾞ"],
	["ド", "ﾄﾞ"],
	["バ", "ﾊﾞ"],
	["ビ", "ﾋﾞ"],
	["ブ", "ﾌﾞ"],
	["ベ", "ﾍﾞ"],
	["ボ", "ﾎﾞ"],
	["パ", "ﾊﾟ"],
	["ピ", "ﾋﾟ"],
	["プ", "ﾌﾟ"],
	["ペ", "ﾍﾟ"],
	["ポ", "ﾎﾟ"],
	["ァ", "ｧ"],
	["ィ", "ｨ"],
	["ゥ", "ｩ"],
	["ェ", "ｪ"],
	["ォ", "ｫ"],
	["ャ", "ｬ"],
	["ュ", "ｭ"],
	["ョ", "ｮ"],
	["ッ", "ｯ"]
]), Nr = new Map([...Array.from(ft.entries()).map(([e, t]) => [t, [e]]), ...Array.from(ft.entries()).filter(([e, t]) => Mr.has(t)).map(([e, t]) => [Mr.get(t), [e]])]), Pr = new Map([...Array.from(rt.entries()).map(([e, t]) => [t, [e]]), ...Array.from(rt.entries()).filter(([e, t]) => Mr.has(t)).map(([e, t]) => [Mr.get(t), [e]])]), Fr = new Map([...Array.from(pt.entries()).map(([e, t]) => [t, [e]]), ...Array.from(pt.entries()).filter(([e, t]) => Mr.has(t)).map(([e, t]) => [Mr.get(t), [e]])]), Ir = new Map([...Array.from(mt.entries()).map(([e, t]) => [t, [(e & 65280) >> 8, (e & 255) >> 0]]), ...Array.from(ht.entries()).map(([e, t]) => [t, [(e & 65280) >> 8, (e & 255) >> 0]])]), Lr = class e extends kr {
	static KANJI = /* @__PURE__ */ new Map();
	static ASCII = structuredClone(Pr);
	static HIRAGANA = structuredClone(Nr);
	static KATAKANA = structuredClone(Fr);
	static {
		let t = new TextDecoder("euc-jp", { fatal: !0 });
		for (let n = 33; n < 117; n++) for (let r = 33; r < 127; r++) try {
			let i = t.decode(Uint8Array.from([n | 128, r | 128]));
			e.KANJI.set(i, [n, r]);
		} catch {}
		for (let [t, n] of Ir.entries()) e.KANJI.set(t, n);
	}
	mode = "MACRO0";
	drcs_md5_to_code = /* @__PURE__ */ new Map();
	current_drcs_code = [33, 33];
	drcs_units = [];
	encode(e) {
		let t = Ar(Uint8Array.from([H.ESC, W.LS1R]).buffer, ...e.map(this.encodeTokenHandler));
		return [...this.drcs_units, zt.from(new Uint8Array(t))];
	}
	encodeCharacter({ character: t }) {
		if (e.ASCII.has(t)) switch (this.mode) {
			case "MACRO0": return Uint8Array.from([...e.ASCII.get(t).map((e) => e | 128)]).buffer;
			case "MACRO1": return this.mode = "MACRO0", Uint8Array.from([
				H.SS3,
				96,
				H.ESC,
				W.LS1R,
				...e.ASCII.get(t).map((e) => e | 128)
			]).buffer;
			default: throw new M(this.mode, "Unexpected mode in ARIBB24JapaneseJIS8Encoder");
		}
		else if (e.HIRAGANA.has(t)) return Uint8Array.from([H.SS2, ...e.HIRAGANA.get(t)]).buffer;
		else if (e.KATAKANA.has(t)) switch (this.mode) {
			case "MACRO0": return this.mode = "MACRO1", Uint8Array.from([
				H.SS3,
				97,
				H.ESC,
				W.LS1R,
				...e.KATAKANA.get(t).map((e) => e | 128)
			]).buffer;
			case "MACRO1": return Uint8Array.from([...e.KATAKANA.get(t).map((e) => e | 128)]).buffer;
			default: throw new M(this.mode, "Unexpected mode in ARIBB24JapaneseJIS8Encoder");
		}
		else if (e.KANJI.has(t)) return Uint8Array.from(e.KANJI.get(t)).buffer;
		else throw new Ge("Unsupported Character in JIS8 Encoder");
	}
	encodeDRCS(t) {
		let n = ot(t.binary);
		if (!this.drcs_md5_to_code.has(n)) {
			if (this.current_drcs_code[0] === 127 && this.current_drcs_code[1] === 127) return Uint8Array.from(e.KANJI.get("〓")).buffer;
			let r = Uint8Array.from([
				1,
				this.current_drcs_code[0],
				this.current_drcs_code[1],
				1,
				0,
				2 ** t.depth - 2,
				t.width,
				t.height
			]).buffer;
			this.drcs_units.push(Bt.from(new Uint8Array(Ar(r, t.binary)), 2)), this.drcs_md5_to_code.set(n, structuredClone(this.current_drcs_code)), this.current_drcs_code[1]++, this.current_drcs_code[1] > 127 && (this.current_drcs_code[0]++, this.current_drcs_code[1] = 33);
		}
		return this.mode = "MACRO0", Uint8Array.from([
			H.ESC,
			36,
			41,
			32,
			64,
			...this.drcs_md5_to_code.get(n).map((e) => e | 128),
			H.SS3,
			96,
			H.ESC,
			W.LS1R
		]).buffer;
	}
	encodeBitmap(e) {
		throw new A("Bitmap is Not Implemented");
	}
	encodeMosaic(e) {
		throw new A("Mozaic Character is Not Implemented");
	}
}, Rr = 2 ** 33, zr = (e) => (e[1] & 64) != 0, Br = (e) => (e[1] & 31) << 8 | e[2], Vr = (e) => (e[3] & 32) != 0, Hr = (e) => Vr(e) ? e[4] : 0, Ur = (e) => e[4 + (Vr(e) ? 1 + Hr(e) : 0)], Wr = class extends TransformStream {
	constructor(e, t) {
		let n = new Uint8Array();
		super({ transform(e, t) {
			{
				let t = n;
				n = new Uint8Array(n.byteLength + e.byteLength), n.set(t, 0), n.set(e, t.byteLength);
			}
			for (let e = 0; e < n.byteLength; e++) if (n[e] === 71) {
				if (e + 188 > n.byteLength) {
					n = n.subarray(e);
					return;
				}
				t.enqueue(n.subarray(e, e + 188)), e += 187;
			}
			n = new Uint8Array();
		} }, e, t);
	}
}, Gr = (e) => (e[1] & 15) << 8 | e[2], Kr = (e, t = 0, n = e.byteLength) => {
	let r = 4294967295;
	for (let i = t; i < n; i++) for (let t = 7; t >= 0; t--) {
		let n = (e[i] & 1 << t) >> t, a = r & 2147483648 ? 1 : 0;
		r <<= 1, a ^ n && (r ^= 79764919), r &= 4294967295;
	}
	return r;
}, qr = class {
	accendant = new Uint8Array();
	*feed(e) {
		let t = 4 + (Vr(e) ? 1 + Hr(e) : 0);
		if (zr(e) && (t += 1), this.accendant.byteLength == 0) if (zr(e)) t += Ur(e);
		else return;
		else {
			let n = t + Math.max(0, 3 + Gr(this.accendant) - this.accendant.length);
			if (n > 188) {
				let n = this.accendant;
				this.accendant = new Uint8Array(this.accendant.byteLength + (188 - t)), this.accendant.set(n, 0), this.accendant.set(e.subarray(t), n.byteLength);
				return;
			} else {
				let r = new Uint8Array(this.accendant.byteLength + (n - t));
				r.set(this.accendant, 0), r.set(e.subarray(t, n), this.accendant.byteLength), this.accendant = new Uint8Array(), yield r, t = n;
			}
		}
		if (zr(e)) for (; t < 188 && e[t] !== 255;) {
			let n = t + Math.max(0, 3 + Gr(e.subarray(t)));
			if (n > 188) {
				this.accendant = e.subarray(t);
				break;
			}
			yield e.subarray(t, n), t = n;
		}
	}
}, Jr = (e) => {
	let t = [], n = 3 + Gr(e) - 4;
	for (let r = 8; r < n; r += 4) {
		let n = e[r + 0] << 8 | e[r + 1] << 0, i = (e[r + 2] & 31) << 8 | e[r + 3] << 0;
		n !== 0 && t.push({
			program_number: n,
			program_map_PID: i
		});
	}
	return t;
}, Yr = (e) => {
	let t = [], n = (e[10] & 15) << 8 | e[11], r = 3 + Gr(e) - 4, i = 12 + n;
	for (; i < r;) {
		let n = e[i + 0], r = (e[i + 1] & 31) << 8 | e[i + 2], a = (e[i + 3] & 15) << 8 | e[i + 4], o = null;
		switch (n) {
			case 1:
				o = "VIDEO";
				break;
			case 2:
				o = "VIDEO";
				break;
			case 27:
				o = "VIDEO";
				break;
			case 36:
				o = "VIDEO";
				break;
			case 3:
				o = "AUDIO";
				break;
			case 4:
				o = "AUDIO";
				break;
			case 15:
				o = "AUDIO";
				break;
			case 17:
				o = "AUDIO";
				break;
		}
		let s = i + 5;
		for (; s < i + 5 + a;) {
			let t = e[s + 0], r = e[s + 1];
			if (t === 82) {
				let t = e[s + 2];
				n === 6 && t === 48 ? o = "ARIBB24_CAPTION" : n === 6 && t === 56 && (o = "ARIBB24_SUPERIMPOSE");
			}
			s += 2 + r;
		}
		o != null && t.push({
			type: o,
			elementary_PID: r
		}), i += 5 + a;
	}
	return t;
}, Xr = (e) => e[3], Zr = (e) => e[4] << 8 | e[5], Qr = (e) => {
	let t = Xr(e);
	return t !== 188 && t !== 190 && t !== 191 && t !== 240 && t !== 241 && t !== 255 && t !== 242 && t !== 248;
}, $r = (e) => Qr(e) ? (e[7] & 128) != 0 : !1, ei = (e) => Qr(e) ? (e[7] & 64) != 0 : !1, ti = (e) => {
	if (!$r(e)) return null;
	let t = 0;
	return t *= 8, t += (e[9] & 14) >> 1, t *= 256, t += (e[10] & 255) >> 0, t *= 128, t += (e[11] & 254) >> 1, t *= 256, t += (e[12] & 255) >> 0, t *= 128, t += (e[13] & 254) >> 1, t;
}, ni = (e) => {
	if (!ei(e)) return null;
	let t = $r(e) ? 5 : 0, n = 0;
	return n *= 8, n += (e[9 + t + 0] & 14) >> 1, n *= 256, n += (e[9 + t + 1] & 255) >> 0, n *= 128, n += (e[9 + t + 2] & 254) >> 1, n *= 256, n += (e[9 + t + 3] & 255) >> 0, n *= 128, n += (e[9 + t + 4] & 254) >> 1, n;
}, ri = (e) => Qr(e) ? 3 + e[8] : 0, ii = (e) => Zr(e) === 0 ? !1 : e.byteLength >= 6 + Zr(e), ai = class {
	accendant = new Uint8Array();
	*feed(e) {
		let t = e.subarray(4 + (Vr(e) ? 1 + Hr(e) : 0));
		if (zr(e)) this.accendant.byteLength > 0 && Zr(this.accendant) === 0 && (yield this.accendant), this.accendant = t;
		else if (this.accendant.byteLength > 0) {
			let e = this.accendant;
			this.accendant = new Uint8Array(this.accendant.byteLength + t.byteLength), this.accendant.set(e, 0), this.accendant.set(t, e.byteLength);
		}
		ii(this.accendant) && (yield this.accendant.subarray(0, 6 + Zr(this.accendant)), this.accendant = new Uint8Array());
	}
};
//#endregion
//#region src/lib/demuxer/mpegts/index.ts
async function* oi(e, t) {
	let n = e.pipeThrough(new Wr()), r = new qr(), i = new qr(), a = new ai(), o = /* @__PURE__ */ new Map(), s = null, c = null, l = (t?.offset ?? "BOTH") === "NONE" ? 0 : null, u = null, d = null, f = n.getReader();
	for (;;) {
		let { value: e, done: n } = await f.read();
		if (n) return;
		let p = Br(e);
		if (p === 0) for (let n of r.feed(e)) {
			if (Kr(n) !== 0) continue;
			let e = t?.serviceId ?? null;
			s = Jr(n).find(({ program_number: t }) => e == null || e === t)?.program_map_PID ?? null;
		}
		else if (p === s) for (let n of i.feed(e)) {
			if (Kr(n) !== 0) continue;
			let e = Yr(n);
			c = e.find((e) => t?.type === "Superimpose" ? e.type === "ARIBB24_SUPERIMPOSE" : e.type === "ARIBB24_CAPTION")?.elementary_PID ?? null;
			let r = e.find(({ type: e }) => e === "AUDIO"), i = e.find(({ type: e }) => e === "VIDEO");
			u = t?.type === "Superimpose" ? r?.elementary_PID ?? i?.elementary_PID ?? null : null;
			for (let n of e) {
				let e = (t?.offset === "VIDEO" || t?.offset === "BOTH" || t?.offset == null) && n.type === "VIDEO", r = (t?.offset === "AUDIO" || t?.offset === "BOTH" || t?.offset == null) && n.type === "AUDIO", i = u === n.elementary_PID;
				!e && !r && !i || o.has(n.elementary_PID) || o.set(n.elementary_PID, new ai());
			}
		}
		else if (o.has(p)) {
			if (!(u === p || l == null)) continue;
			for (let t of o.get(p).feed(e)) {
				let e = ti(t);
				e != null && (l ??= e, p === u && (d = e));
			}
		} else if (p === c) for (let n of a.feed(e)) {
			if (l == null) continue;
			let e = Rt(n.subarray(6 + ri(n)));
			if (e == null) continue;
			let r = Ut(e.data);
			if (r == null) continue;
			let i = t?.type === "Superimpose" ? d : ti(n), a = t?.type === "Superimpose" ? d : ni(n) ?? ti(n);
			i == null || a == null || (yield {
				tag: e.tag,
				pts: (Rr + i - l) % Rr / 9e4,
				dts: (Rr + a - l) % Rr / 9e4,
				data: r
			});
		}
	}
}
//#endregion
//#region src/util/bytebuilder.ts
var Q = class {
	buffers = [];
	build() {
		return Ar(...this.buffers);
	}
	write(e) {
		this.buffers.push(e);
	}
	writeU8(e) {
		let t = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(1));
		t.setUint8(0, e), this.buffers.push(t.buffer);
	}
	writeU16(e) {
		let t = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(2));
		t.setUint16(0, e, !1), this.buffers.push(t.buffer);
	}
	writeU24(e) {
		let t = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(3));
		t.setUint16(0, (e & 16776960) >> 8, !1), t.setUint8(2, (e & 255) >> 0), this.buffers.push(t.buffer);
	}
	writeU32(e) {
		let t = /* @__PURE__ */ new DataView(/* @__PURE__ */ new ArrayBuffer(4));
		t.setUint32(0, e, !1), this.buffers.push(t.buffer);
	}
}, si = [
	0,
	4129,
	8258,
	12387,
	16516,
	20645,
	24774,
	28903,
	33032,
	37161,
	41290,
	45419,
	49548,
	53677,
	57806,
	61935,
	4657,
	528,
	12915,
	8786,
	21173,
	17044,
	29431,
	25302,
	37689,
	33560,
	45947,
	41818,
	54205,
	50076,
	62463,
	58334,
	9314,
	13379,
	1056,
	5121,
	25830,
	29895,
	17572,
	21637,
	42346,
	46411,
	34088,
	38153,
	58862,
	62927,
	50604,
	54669,
	13907,
	9842,
	5649,
	1584,
	30423,
	26358,
	22165,
	18100,
	46939,
	42874,
	38681,
	34616,
	63455,
	59390,
	55197,
	51132,
	18628,
	22757,
	26758,
	30887,
	2112,
	6241,
	10242,
	14371,
	51660,
	55789,
	59790,
	63919,
	35144,
	39273,
	43274,
	47403,
	23285,
	19156,
	31415,
	27286,
	6769,
	2640,
	14899,
	10770,
	56317,
	52188,
	64447,
	60318,
	39801,
	35672,
	47931,
	43802,
	27814,
	31879,
	19684,
	23749,
	11298,
	15363,
	3168,
	7233,
	60846,
	64911,
	52716,
	56781,
	44330,
	48395,
	36200,
	40265,
	32407,
	28342,
	24277,
	20212,
	15891,
	11826,
	7761,
	3696,
	65439,
	61374,
	57309,
	53244,
	48923,
	44858,
	40793,
	36728,
	37256,
	33193,
	45514,
	41451,
	53516,
	49453,
	61774,
	57711,
	4224,
	161,
	12482,
	8419,
	20484,
	16421,
	28742,
	24679,
	33721,
	37784,
	41979,
	46042,
	49981,
	54044,
	58239,
	62302,
	689,
	4752,
	8947,
	13010,
	16949,
	21012,
	25207,
	29270,
	46570,
	42443,
	38312,
	34185,
	62830,
	58703,
	54572,
	50445,
	13538,
	9411,
	5280,
	1153,
	29798,
	25671,
	21540,
	17413,
	42971,
	47098,
	34713,
	38840,
	59231,
	63358,
	50973,
	55100,
	9939,
	14066,
	1681,
	5808,
	26199,
	30326,
	17941,
	22068,
	55628,
	51565,
	63758,
	59695,
	39368,
	35305,
	47498,
	43435,
	22596,
	18533,
	30726,
	26663,
	6336,
	2273,
	14466,
	10403,
	52093,
	56156,
	60223,
	64286,
	35833,
	39896,
	43963,
	48026,
	19061,
	23124,
	27191,
	31254,
	2801,
	6864,
	10931,
	14994,
	64814,
	60687,
	56684,
	52557,
	48554,
	44427,
	40424,
	36297,
	31782,
	27655,
	23652,
	19525,
	15522,
	11395,
	7392,
	3265,
	61215,
	65342,
	53085,
	57212,
	44955,
	49082,
	36825,
	40952,
	28183,
	32310,
	20053,
	24180,
	11923,
	16050,
	3793,
	7920
], ci = (e, t = 0, n) => {
	n ??= e.length;
	let r = 0;
	for (let i = t; i < n; i++) r = (r << 8 ^ si[(r >> 8 ^ e[i]) & 255]) & 65535;
	return r;
}, li = (e) => {
	switch (e.tag) {
		case "Statement": return 32;
		case "DRCS": return e.bytes === 2 ? 49 : 48;
		case "Bitmap": return 53;
		default: throw new M(e, "Unexpected Data Unit in STD-B24 ARIB Caption");
	}
}, ui = (e) => {
	let t = new Q();
	for (let n of e.units) t.writeU8(31), t.writeU8(li(n)), t.writeU24(n.data.byteLength), t.write(n.data.buffer.slice(n.data.byteOffset, n.data.byteOffset + n.data.byteLength));
	let n = t.build();
	switch (e.tag) {
		case "CaptionManagement": {
			let t = new Q();
			for (let n of e.languages) t.writeU8(n.lang << 5 | 16 | n.displayMode), (n.displayMode === 12 || n.displayMode === 13 || n.displayMode === 14) && t.writeU8(n.displayConditionDesignation), t.writeU8(n.iso_639_language_code.charCodeAt(0)), t.writeU8(n.iso_639_language_code.charCodeAt(1)), t.writeU8(n.iso_639_language_code.charCodeAt(2)), t.writeU8(n.format << 4 | n.TCS << 2 | n.rollup);
			let r = t.build(), i = new Q();
			if (i.writeU8(e.timeControlMode << 6 | 63), e.timeControlMode === 2) {
				let t = Math.floor(e.offsetTime[0] / 10) << 4 | e.offsetTime[0] % 10 << 0, n = Math.floor(e.offsetTime[1] / 10) << 4 | e.offsetTime[1] % 10 << 0, r = Math.floor(e.offsetTime[2] / 10) << 4 | e.offsetTime[2] % 10 << 0, a = Math.floor(e.offsetTime[3] / 100) << 4 | Math.floor(e.offsetTime[3] / 10) % 10 << 0, o = Math.floor(e.offsetTime[3] % 10) << 4 | 15;
				i.writeU8(t), i.writeU8(n), i.writeU8(r), i.writeU8(a), i.writeU8(o);
			}
			i.writeU8(e.languages.length), i.write(r), i.writeU24(n.byteLength), i.write(n);
			let a = i.build(), o = new Q();
			return o.writeU8(e.group << 7 | 0), o.writeU8(0), o.writeU8(0), o.writeU16(a.byteLength), o.write(a), o.writeU16(ci(new Uint8Array(o.build()))), o.build();
		}
		case "CaptionStatement": {
			let t = new Q();
			if (t.writeU8(e.timeControlMode << 6 | 63), e.timeControlMode === K.REALTIME || e.timeControlMode === K.OFFSETTIME) {
				let n = Math.floor(e.presentationStartTime[0] / 10) << 4 | e.presentationStartTime[0] % 10 << 0, r = Math.floor(e.presentationStartTime[1] / 10) << 4 | e.presentationStartTime[1] % 10 << 0, i = Math.floor(e.presentationStartTime[2] / 10) << 4 | e.presentationStartTime[2] % 10 << 0, a = Math.floor(e.presentationStartTime[3] / 100) << 4 | Math.floor(e.presentationStartTime[3] / 10) % 10 << 0, o = e.presentationStartTime[3] % 10 << 4 | 15;
				t.writeU8(n), t.writeU8(r), t.writeU8(i), t.writeU8(a), t.writeU8(o);
			}
			t.writeU24(n.byteLength), t.write(n);
			let r = t.build(), i = new Q();
			return i.writeU8(e.group << 7 | e.lang + 1 << 2 | 0), i.writeU8(0), i.writeU8(0), i.writeU16(r.byteLength), i.write(r), i.writeU16(ci(new Uint8Array(i.build()))), i.build();
		}
		default: throw new M(e, "Unexpected STD-B24 ARIB Caption Content");
	}
}, di = (e) => {
	let t = new Uint8Array(3 + e.data.byteLength);
	switch (e.tag) {
		case "Caption": return t[0] = 128, t[1] = 255, t[2] = 0, t.set(new Uint8Array(e.data), 3), t.buffer;
		case "Superimpose": return t[0] = 129, t[1] = 255, t[2] = 0, t.set(new Uint8Array(e.data), 3), t.buffer;
		default: throw new M(e, "Unexpected ARIB Caption Type");
	}
}, fi = (e) => {
	switch (e.tag) {
		case "Statement": return 32;
		case "DRCS": return e.bytes === 2 ? 49 : 48;
		case "Bitmap": return 53;
		default: throw new M(e, "Unexpected Data Unit in STD-B24 ARIB Caption");
	}
}, pi = (e) => {
	let t = new Q();
	for (let n of e.units) t.writeU8(31), t.writeU8(fi(n)), t.writeU24(n.data.byteLength), t.write(n.data.buffer.slice(n.data.byteOffset, n.data.byteOffset + n.data.byteLength));
	let n = t.build();
	switch (e.tag) {
		case "CaptionManagement": {
			let t = new Q();
			if (e.languages.length !== 1) throw new j("ARIB STD-B36 must only one language");
			for (let n of e.languages) t.writeU8(16 | n.displayMode), t.writeU8(0), t.writeU8(n.iso_639_language_code.charCodeAt(0)), t.writeU8(n.iso_639_language_code.charCodeAt(1)), t.writeU8(n.iso_639_language_code.charCodeAt(2)), t.writeU8(n.format << 4 | n.TCS << 2 | n.rollup);
			let n = t.build(), r = new Q();
			if (r.writeU8(63), e.timeControlMode !== K.FREE) throw new j("TimeControlMode (TMD) must be 0 (FREE)");
			r.writeU8(0), r.writeU8(0), r.writeU8(0), r.writeU8(0), r.writeU8(15), r.writeU8(0), r.write(n);
			let i = r.build(), a = new Q();
			return a.writeU8(0), a.writeU8(0), a.writeU8(0), a.writeU16(i.byteLength), a.write(i), a.build();
		}
		case "CaptionStatement": {
			let t = new Q();
			if (t.writeU8(63), e.timeControlMode !== K.FREE) throw new j("TimeControlMode (TMD) must be 0 (FREE)");
			t.writeU8(0), t.writeU8(0), t.writeU8(0), t.writeU8(0), t.writeU8(15), t.writeU24(n.byteLength), t.write(n);
			let r = t.build(), i = new Q();
			return i.writeU8(4), i.writeU8(0), i.writeU8(0), i.writeU16(r.byteLength), i.write(r), i.build();
		}
		default: throw new M(e, "Unexpected STD-B24 ARIB Caption Content");
	}
}, mi = new TextDecoder("shift-jis", { fatal: !0 }), $ = /* @__PURE__ */ new Map();
for (let [e, t] of [[0, 128], [161, 223]]) for (let n = e; n < t; n++) {
	let e = [n], t = Uint8Array.from(e);
	try {
		$.set(mi.decode(t), e);
	} catch {}
}
for (let [e, t] of [[129, 159], [224, 239]]) for (let n = e; n < t; n++) {
	for (let e = 64; e <= 126; e++) {
		let t = [n, e], r = Uint8Array.from(t);
		try {
			$.set(mi.decode(r), t);
		} catch {}
	}
	for (let e = 128; e <= 252; e++) {
		let t = [n, e], r = Uint8Array.from(t);
		try {
			$.set(mi.decode(r), t);
		} catch {}
	}
}
var hi = (e) => {
	let t = new Q();
	for (let n = 0; n < e.label.length; n++) t.writeU8(e.label.charCodeAt(n));
	for (let n = e.label.length; n < 256; n++) t.writeU8(32);
	let n = new Q();
	{
		let t = Array.from(e.broadcasterIdentification);
		if (t.some((e) => !$.has(e))) throw new j("broadcasterIdentification cannot convert to shift-jis");
		let r = t.flatMap((e) => $.get(e));
		if (r.length > 6) throw new j("broadcasterIdentification byteLength exceeded");
		for (; r.length < 6;) r.push(32);
		n.write(Uint8Array.from(r).buffer);
	}
	{
		let t = Array.from(e.materialNumber);
		if (t.some((e) => !$.has(e))) throw new j("materialNumber cannot convert to shift-jis");
		let r = t.flatMap((e) => $.get(e));
		if (r.length > 27) throw new j("materialNumber byteLength exceeded");
		for (; r.length < 27;) r.push(32);
		n.write(Uint8Array.from(r).buffer);
	}
	{
		let t = Array.from(e.programTitle);
		if (t.some((e) => !$.has(e))) throw new j("programTitle cannot convert to shift-jis");
		let r = t.flatMap((e) => $.get(e));
		if (r.length > 40) throw new j("programTitle byteLength exceeded");
		for (; r.length < 40;) r.push(32);
		n.write(Uint8Array.from(r).buffer);
	}
	{
		let t = Array.from(e.programSubtitle);
		if (t.some((e) => !$.has(e))) throw new j("programSubtitle cannot convert to shift-jis");
		let r = t.flatMap((e) => $.get(e));
		if (r.length > 40) throw new j("programSubtitle byteLength exceeded");
		for (; r.length < 40;) r.push(32);
		n.write(Uint8Array.from(r).buffer);
	}
	if (n.writeU8(e.programMaterialType.charCodeAt(0)), n.writeU8(e.registrationMode.charCodeAt(0)), e.languageCode.length !== 3) throw new j("languageCode length must be 3");
	if (/[^a-z]/.test(e.languageCode)) throw new j("languageCode length must lowercase");
	for (let t = 0; t < 3; t++) n.writeU8(e.languageCode.charCodeAt(t));
	for (let t = 0; t < 2; t++) n.writeU8(e.displayMode.charCodeAt(t));
	n.writeU8(e.programType.charCodeAt(0)), n.writeU8((e.sound ? "*" : " ").charCodeAt(0));
	{
		let t = e.totalPages.toString(10).padStart(4, "0");
		for (let e = 0; e < 4; e++) n.writeU8(t.charCodeAt(e));
	}
	{
		let t = e.totalBytes.toString(10).padStart(8, "0");
		for (let e = 0; e < 8; e++) n.writeU8(t.charCodeAt(e));
	}
	n.writeU8((e.untime ? "*" : " ").charCodeAt(0));
	for (let t = 0; t < 2; t++) n.writeU8(e.realtimeTimingType.charCodeAt(t));
	switch (n.writeU8(e.timingUnitType.charCodeAt(0)), e.timingUnitType) {
		case J.FRAME: {
			let t = _n(e.initialTime).replaceAll(/[:;]/g, "");
			for (let e = 0; e < 8; e++) n.writeU8(t.charCodeAt(e));
			n.writeU8(70);
			break;
		}
		case J.TIME: {
			let t = Math.ceil(e.initialTime * 100) % 100, r = Math.floor(e.initialTime) % 60, i = Math.floor((e.initialTime - r) / 60) % 60, a = `${Math.floor((e.initialTime - r - i * 60) / 3600).toString(10).padStart(2, "0")}${i.toString(10).padStart(2, "0")}${r.toString(10).padStart(2, "0")}${t.toString(10).padStart(2, "0")}`;
			for (let e = 0; e < 8; e++) n.writeU8(a.charCodeAt(e));
			n.writeU8(48);
			break;
		}
	}
	n.writeU8(e.syncronizationMode.charCodeAt(0));
	for (let t = 0; t < 2; t++) n.writeU8(e.timeControlMode.charCodeAt(t));
	for (let t = 0; t < 8; t++) n.writeU8((e.extensible[t] ? "*" : " ").charCodeAt(0));
	for (let t = 0; t < 8; t++) n.writeU8((e.compatible[t] ? "*" : " ").charCodeAt(0));
	if (e.expireDate == null) for (let e = 0; e < 8; e++) n.writeU8(32);
	else {
		let t = `${e.expireDate[0].toString(10).padStart(4, "0")}${e.expireDate[1].toString(10).padStart(2, "0")}${e.expireDate[2].toString(10).padStart(2, "0")}`;
		for (let e = 0; e < 8; e++) n.writeU8(t.charCodeAt(e));
	}
	{
		let t = Array.from(e.author);
		if (t.some((e) => !$.has(e))) throw new j("author cannot convert to shift-jis");
		let r = t.flatMap((e) => $.get(e));
		if (r.length > 20) throw new j("author byteLength exceeded");
		for (; r.length < 20;) r.push(32);
		n.write(Uint8Array.from(r).buffer);
	}
	if (e.creationDateTime != null) {
		let t = `${e.creationDateTime[0].toString(10).padStart(4, "0")}${e.creationDateTime[1].toString(10).padStart(2, "0")}${e.creationDateTime[2].toString(10).padStart(2, "0")}${e.creationDateTime[3].toString(10).padStart(2, "0")}${e.creationDateTime[4].toString(10).padStart(2, "0")}`;
		for (let e = 0; e < 12; e++) n.writeU8(t.charCodeAt(e));
	} else for (let e = 0; e < 12; e++) n.writeU8(32);
	if (e.broadcastStartDate != null) {
		let t = `${e.broadcastStartDate[0].toString(10).padStart(4, "0")}${e.broadcastStartDate[1].toString(10).padStart(2, "0")}${e.broadcastStartDate[2].toString(10).padStart(2, "0")}`;
		for (let e = 0; e < 8; e++) n.writeU8(t.charCodeAt(e));
	} else for (let e = 0; e < 8; e++) n.writeU8(32);
	if (e.broadcastEndDate != null) {
		let t = `${e.broadcastEndDate[0].toString(10).padStart(4, "0")}${e.broadcastEndDate[1].toString(10).padStart(2, "0")}${e.broadcastEndDate[2].toString(10).padStart(2, "0")}`;
		for (let e = 0; e < 8; e++) n.writeU8(t.charCodeAt(e));
	} else for (let e = 0; e < 8; e++) n.writeU8(32);
	for (let t = 0; t < 7; t++) n.writeU8((e.broadcastDaysOfWeek[t] ? "*" : " ").charCodeAt(0));
	if (e.broadcastStartTime != null) {
		let t = `${e.broadcastStartTime[0].toString(10).padStart(2, "0")}${e.broadcastStartTime[1].toString(10).padStart(2, "0")}${e.broadcastStartTime[2].toString(10).padStart(2, "0")}`;
		for (let e = 0; e < 6; e++) n.writeU8(t.charCodeAt(e));
	} else for (let e = 0; e < 6; e++) n.writeU8(32);
	if (e.broadcastEndTime != null) {
		let t = `${e.broadcastEndTime[0].toString(10).padStart(2, "0")}${e.broadcastEndTime[1].toString(10).padStart(2, "0")}${e.broadcastEndTime[2].toString(10).padStart(2, "0")}`;
		for (let e = 0; e < 6; e++) n.writeU8(t.charCodeAt(e));
	} else for (let e = 0; e < 6; e++) n.writeU8(32);
	{
		let t = Array.from(e.memo);
		if (t.some((e) => !$.has(e))) throw new j("memo cannot convert to shift-jis");
		let r = t.flatMap((e) => $.get(e));
		if (r.length > 60) throw new j("memo byteLength exceeded");
		for (; r.length < 60;) r.push(32);
		n.write(Uint8Array.from(r).buffer);
	}
	for (let e = 0; e < 45; e++) n.writeU8(32);
	n.writeU8((e.completed ? "*" : " ").charCodeAt(0)), n.writeU8((e.usersAreaUsed ? "*" : " ").charCodeAt(0)), e.usersAreaUsed && (n.writeU8(e.writingFormatConversionMode), n.writeU8(e.drcsConversionMode << 6 | 63));
	let r = n.build();
	t.writeU32(r.byteLength), t.write(r), t.write(new ArrayBuffer(Math.floor((4 + r.byteLength + 255) / 256) * 256 - (4 + r.byteLength)));
	for (let n of e.pages) {
		let e = new Q();
		for (let t = 0; t < 6; t++) e.writeU8(n.pageNumber.charCodeAt(t));
		e.writeU8(n.pageMaterialType.charCodeAt(0));
		for (let t = 0; t < 2; t++) e.writeU8(n.displayTimingType.charCodeAt(t));
		for (let t = 0; t < 1; t++) e.writeU8(n.timingUnitType.charCodeAt(t));
		switch (n.timingUnitType) {
			case J.FRAME: {
				let t = _n(n.displayTiming).replaceAll(/[:;]/g, "");
				for (let n = 0; n < 8; n++) e.writeU8(t.charCodeAt(n));
				e.writeU8(70);
				break;
			}
			case J.TIME: {
				let t = Math.round(n.displayTiming * 100) % 100, r = Math.floor(n.displayTiming) % 60, i = Math.floor((n.displayTiming - r) / 60) % 60, a = `${Math.floor((n.displayTiming - r - i * 60) / 3600).toString(10).padStart(2, "0")}${i.toString(10).padStart(2, "0")}${r.toString(10).padStart(2, "0")}${t.toString(10).padStart(2, "0")}`;
				for (let t = 0; t < 8; t++) e.writeU8(a.charCodeAt(t));
				e.writeU8(48);
				break;
			}
		}
		if (n.clearTiming === Infinity) for (let t = 0; t < 9; t++) e.writeU8(32);
		else switch (n.timingUnitType) {
			case J.FRAME: {
				let t = _n(n.clearTiming).replaceAll(/[:;]/g, "");
				for (let n = 0; n < 8; n++) e.writeU8(t.charCodeAt(n));
				e.writeU8(70);
				break;
			}
			case J.TIME: {
				let t = Math.round(n.clearTiming * 100) % 100, r = Math.floor(n.clearTiming) % 60, i = Math.floor((n.clearTiming - r) / 60) % 60, a = `${Math.floor((n.clearTiming - r - i * 60) / 3600).toString(10).padStart(2, "0")}${i.toString(10).padStart(2, "0")}${r.toString(10).padStart(2, "0")}${t.toString(10).padStart(2, "0")}`;
				for (let t = 0; t < 8; t++) e.writeU8(a.charCodeAt(t));
				e.writeU8(48);
				break;
			}
		}
		for (let t = 0; t < 2; t++) e.writeU8(n.timeControlMode.charCodeAt(t));
		for (let t = 0; t < 3; t++) e.writeU8((n.clearScreen ? "OFF" : "   ").charCodeAt(t));
		for (let t = 0; t < 3; t++) e.writeU8(n.displayFormat.charCodeAt(t));
		for (let t = 0; t < 1; t++) e.writeU8(n.displayAspectRatio.charCodeAt(t));
		if (n.displayWindowArea == null) for (let t = 0; t < 16; t++) e.writeU8(32);
		else {
			let t = n.displayWindowArea[0][0].toString(10).padStart(4, "0"), r = n.displayWindowArea[0][1].toString(10).padStart(4, "0"), i = n.displayWindowArea[1][0].toString(10).padStart(4, "0"), a = n.displayWindowArea[1][1].toString(10).padStart(4, "0");
			for (let n = 0; n < 4; n++) e.writeU8(t.charCodeAt(n));
			for (let t = 0; t < 4; t++) e.writeU8(r.charCodeAt(t));
			for (let t = 0; t < 4; t++) e.writeU8(i.charCodeAt(t));
			for (let t = 0; t < 4; t++) e.writeU8(a.charCodeAt(t));
		}
		e.writeU8(n.scrollType.charCodeAt(0)), e.writeU8(n.scrollDirectionType.charCodeAt(0)), e.writeU8((n.sound ? "*" : " ").charCodeAt(0));
		{
			let t = n.pageDataBytes.toString(10).padStart(5, "0");
			for (let n = 0; n < 5; n++) e.writeU8(t.charCodeAt(n));
		}
		for (let t = 0; t < 3; t++) e.writeU8((n.deleted ? "ERS" : "   ").charCodeAt(t));
		{
			let t = Array.from(n.memo);
			if (t.some((e) => !$.has(e))) throw new j("memo cannot convert to shift-jis");
			let r = t.flatMap((e) => $.get(e));
			if (r.length > 20) throw new j("memo byteLength exceeded");
			for (; r.length < 20;) r.push(32);
			e.write(Uint8Array.from(r).buffer);
		}
		for (let t = 0; t < 32; t++) e.writeU8(32);
		e.writeU8((n.completed ? "*" : " ").charCodeAt(0)), e.writeU8((n.usersAreaUsed ? "*" : " ").charCodeAt(0)), n.usersAreaUsed && (e.writeU8(n.writingFormatConversionMode), e.writeU8(n.drcsConversionMode << 6 | 63));
		let r = e.build(), i = pi(n.management), a = n.tag === "ReservedPage" ? /* @__PURE__ */ new ArrayBuffer(0) : pi(n.statement), o = 3 + r.byteLength + (3 + i.byteLength) + (n.tag === "ReservedPage" ? 0 : 4 + a.byteLength);
		t.writeU32(o), t.writeU8(42), t.writeU16(r.byteLength), t.write(r), t.writeU8(58), t.writeU16(i.byteLength), t.write(i), n.tag === "ActualPage" && (t.writeU8(74), t.writeU24(a.byteLength), t.write(a)), t.write(new ArrayBuffer(Math.floor((4 + o + 255) / 256) * 256 - (4 + o)));
	}
	return t.build();
};
//#endregion
export { Ie as ARIBB24ActiveCoordinatePositionSetToken, u as ARIBB24ActivePositionBackwardToken, f as ARIBB24ActivePositionDownToken, d as ARIBB24ActivePositionForwardToken, h as ARIBB24ActivePositionReturnToken, v as ARIBB24ActivePositionSetToken, p as ARIBB24ActivePositionUpToken, l as ARIBB24BellToken, s as ARIBB24BitmapToken, ie as ARIBB24BlackForegroundToken, se as ARIBB24BlueForegroundToken, tt as ARIBB24BrazilianInitialParserState, tt as ARIBB24JapaneseInitialParserState, xt as ARIBB24BrazilianJIS8Tokenizer, He as ARIBB24BuiltinSoundReplayToken, _ as ARIBB24CancelToken, Ne as ARIBB24CharacterCompositionDotDesignationToken, fe as ARIBB24CharacterSizeControlToken, S as ARIBB24CharacterSizeControlType, i as ARIBB24CharacterToken, m as ARIBB24ClearScreenToken, pe as ARIBB24ColorControlBackgroundToken, C as ARIBB24ColorControlForegroundToken, w as ARIBB24ColorControlHalfBackgroundToken, me as ARIBB24ColorControlHalfForegroundToken, _e as ARIBB24ConcealmentModeToken, E as ARIBB24ConcealmentModeType, le as ARIBB24CyanForegroundToken, o as ARIBB24DRCSToken, re as ARIBB24DeleteToken, ge as ARIBB24FlashingControlToken, T as ARIBB24FlashingControlType, ae as ARIBB24GreenForegroundToken, Ce as ARIBB24HilightingCharacterBlockToken, dt as ARIBB24JIS8Tokenizer, Lr as ARIBB24JapaneseJIS8Encoder, vt as ARIBB24JapaneseJIS8Tokenizer, ce as ARIBB24MagentaForegroundToken, x as ARIBB24MiddleSizeToken, a as ARIBB24MosaicToken, de as ARIBB24NormalSizeToken, c as ARIBB24NullToken, ze as ARIBB24OrnamentControlHemmingToken, Ve as ARIBB24OrnamentControlHollowToken, Re as ARIBB24OrnamentControlNoneToken, Be as ARIBB24OrnamentControlShadeToken, Le as ARIBB24OrnamentControlType, he as ARIBB24PalletControlToken, g as ARIBB24ParameterizedActivePositionForwardToken, F as ARIBB24Parser, Ye as ARIBB24ParserOption, xe as ARIBB24PatternPolarityControlToken, O as ARIBB24PatternPolarityControlType, Ue as ARIBB24RasterColourCommandToken, ee as ARIBB24RecordSeparatorToken, y as ARIBB24RedForegroundToken, we as ARIBB24RepeatCharacterToken, be as ARIBB24ReplacingConcealmentModeToken, ye as ARIBB24ReplacingConcealmentModeType, je as ARIBB24SetDisplayFormatToken, Me as ARIBB24SetDisplayPositionToken, Pe as ARIBB24SetHorizontalSpacingToken, Fe as ARIBB24SetVerticalSpacingToken, Ae as ARIBB24SetWritingFormatToken, ve as ARIBB24SingleConcealmentModeToken, D as ARIBB24SingleConcealmentModeType, ue as ARIBB24SmallSizeToken, ne as ARIBB24SpaceToken, Te as ARIBB24StartLiningToken, Ee as ARIBB24StopLiningToken, ke as ARIBB24TimeControlModeToken, Oe as ARIBB24TimeControlModeType, De as ARIBB24TimeControlWaitToken, lt as ARIBB24Tokenizer, jr as ARIBB24UTF8Encoder, te as ARIBB24UnitSeparatorToken, b as ARIBB24WhiteForegroundToken, k as ARIBB24WritingModeModificationToken, Se as ARIBB24WritingModeModificationType, oe as ARIBB24YellowForegroundToken, Fn as B36Feeder, tr as CanvasMainThreadRenderer, Rn as CanvasRendererOption, Rn as CanvasRenderingOption, ur as CanvasWebWorkerRenderer, r as Controller, We as EOFError, t as EventType, M as ExhaustivenessError, Tt as FeederOption, un as HLSFeeder, Or as HTMLFragmentRenderer, ln as MPEGTSFeeder, A as NotImplementedError, Ln as RendererOption, Cr as SVGDOMRenderer, mr as SVGRenderingOption, In as SpeechRecognitionFeeder, Tr as TextRenderer, N as UnreachableError, Gn as canvasRenderingStrategy, Pn as demuxB36, Ut as demuxDatagroup, Rt as demuxIndependentPES, oi as demuxMPEGTS, hi as muxB36, ui as muxDatagroup, di as muxIndependentPES, Yt as regionerForARIBB24ParsedToken, ut as replaceDRCS, hr as svgRenderingStrategy };
