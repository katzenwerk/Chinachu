const M = 33554432;
const w = 8, A = 10;
const a = globalThis.ManagedMediaSource;
function u(h = !1) {
  const e = typeof MediaSource > "u" ? null : MediaSource;
  return h && a ? a : e ?? a ?? null;
}
function S(h, e = !1) {
  return u(e)?.isTypeSupported(h) ?? !1;
}
function g(h = !1) {
  return u(h)?.canConstructInDedicatedWorker === !0;
}
function T() {
  return a !== void 0;
}
function _() {
  return typeof MediaSource > "u" && a !== void 0;
}
class v {
  #e = !0;
  #r = [];
  get open() {
    return this.#e;
  }
  /** Returns whether this changed anything. */
  set(e) {
    return e === this.#e ? !1 : (this.#e = e, e && this.#i(), !0);
  }
  wait() {
    return this.#e ? Promise.resolve() : new Promise((e) => {
      this.#r.push(e);
    });
  }
  /** Let everyone through whatever the state is, for teardown. */
  abandon() {
    this.#i();
  }
  #i() {
    const e = this.#r;
    this.#r = [];
    for (const t of e) t();
  }
}
class E {
  /**
   * Made in the constructor rather than in `open`, because a caller needs
   * something to attach before the codec is known: the worker sends
   * `mediaSource.handle` across the moment a load starts, and `sourceopen`
   * does not fire until the page has put it on the element -- long before the
   * first init fragment.
   */
  mediaSource;
  /**
   * Whether that is a Managed Media Source, which a media element takes in its
   * own way. See the player's `#createSink`.
   */
  managed;
  /** The one the source was made from, and the one that answers for codecs. */
  #e;
  #r;
  #i;
  #t = null;
  /** What the `SourceBuffer` was opened with, or last changed to. */
  #v = "";
  /** A codec to move the `SourceBuffer` to before the next append. */
  #d = null;
  #h = [];
  #w = 0;
  #n = null;
  #p = !1;
  /**
   * Whether a managed source wants data at the moment.
   *
   * True until told otherwise, and always true for an unmanaged source, which
   * takes whatever it is given. A managed one starts out not streaming and
   * asks once it is attached and playing, so waiting for permission before the
   * initialization segment would mean waiting for a player that never starts:
   * this holds the door open until `endstreaming` closes it.
   */
  #c = !0;
  /** The last thing said about there being no room, so it is said once. */
  #a = !1;
  /** Whether everything buffered is waiting to be thrown away; see `reset`. */
  #o = !1;
  /** Which stretch of timeline is being filled. Bumped by every `reset`. */
  #_ = 0;
  /** A duration to put on the MediaSource as soon as it will take one. */
  #E = null;
  /** Media times a decoder can start from, in order; see #evict. */
  #S = [];
  /** Whether the playhead has been put where the media starts; see #startAtMedia. */
  #s = !1;
  #D = 0;
  #u = !1;
  #A = !1;
  #l = new v();
  #R = [];
  constructor(e) {
    this.#r = e;
    const t = u(e.preferManaged);
    if (!t) throw new Error("this browser has no Media Source Extensions");
    this.#e = t, this.mediaSource = new t(), this.managed = t === a, this.managed && (this.mediaSource.addEventListener(
      "startstreaming",
      this.#T
    ), this.mediaSource.addEventListener("endstreaming", this.#P)), this.#i = new Promise((s) => {
      this.mediaSource.addEventListener(
        "sourceopen",
        () => {
          e.onMark?.("sourceopen"), s();
        },
        { once: !0 }
      );
    });
  }
  ready() {
    return this.#l.wait();
  }
  /**
   * Open the stream, or -- for the initialization segment a seek brings with
   * it -- re-open the one already running.
   */
  async open(e, t) {
    if (!this.#e.isTypeSupported(e))
      throw new Error(`unsupported codec: ${e}`);
    if (await this.#i, !this.#u) {
      if (this.#t)
        e !== this.#v && (this.#d = e);
      else {
        const s = this.mediaSource.addSourceBuffer(e);
        s.mode = "segments", s.addEventListener("updateend", this.#f), s.addEventListener("error", this.#W), this.#t = s, this.#v = e;
      }
      this.#B({ data: t, init: !0 }), this.#U();
    }
  }
  push(e, t, s) {
    this.#u || (s && this.#S.push(t), this.#B({ data: e, init: !1 }));
  }
  /**
   * How long the whole presentation is.
   *
   * Without this the media element has no timeline to offer a viewer: it is
   * what turns `seekable` into the length of the file rather than the length
   * of what has been converted so far.
   */
  setDuration(e) {
    this.#E = e, this.#U();
  }
  /**
   * Throw away everything buffered and everything queued.
   *
   * A seek lands somewhere the buffer does not reach, and what follows it is
   * a different part of the file: keeping the old media would leave the
   * timeline with a hole in the middle and the eviction bookkeeping describing
   * bytes that are no longer there.
   */
  reset() {
    this.#u || (this.#_++, this.#h = [], this.#w = 0, this.#S = [], this.#s = !1, this.#A = !1, this.#p = !1, this.#b(), this.#t && (this.#o = !0), this.#M(!0), this.#y(), this.#k());
  }
  async finish() {
    if (this.#A = !0, this.#u || !this.#t) return;
    const e = this.#_;
    await new Promise((t) => {
      this.#R.push(t), this.#k();
    }), !(this.#u || this.#_ !== e) && this.mediaSource.readyState === "open" && this.mediaSource.endOfStream();
  }
  close() {
    this.#u || (this.#u = !0, this.managed && (this.mediaSource.removeEventListener(
      "startstreaming",
      this.#T
    ), this.mediaSource.removeEventListener(
      "endstreaming",
      this.#P
    )), this.#t?.removeEventListener("updateend", this.#f), this.#t?.removeEventListener("error", this.#W), this.#t = null, this.#h = [], this.#w = 0, this.#S = [], this.#l.abandon(), this.#M(!0));
  }
  /** Tell the sink where playback has got to, so it can evict what is behind. */
  setCurrentTime(e) {
    this.#D = e, this.#I(), this.#y(), this.#k();
  }
  #B(e) {
    this.#h.push(e), this.#w += e.data.byteLength, this.#y(), this.#k();
  }
  #k() {
    const e = this.#t;
    if (this.#u || !e || e.updating || this.#n)
      return;
    if (this.#o) {
      this.#n = { type: "clear" };
      try {
        e.remove(0, Number.POSITIVE_INFINITY);
      } catch (s) {
        this.#n = null, this.#o = !1, this.#g(s);
      }
      return;
    }
    if (this.#p) return;
    const t = this.#h[0];
    if (!t) {
      this.#M(!1);
      return;
    }
    if (this.#d !== null) {
      const s = this.#d;
      this.#d = null;
      try {
        e.changeType(s), this.#v = s;
      } catch (i) {
        this.#g(i);
        return;
      }
    }
    this.#n = { type: "append", pending: t, epoch: this.#_ };
    try {
      e.appendBuffer(t.data);
    } catch (s) {
      this.#n = null, s instanceof DOMException && s.name === "QuotaExceededError" ? (this.#p = !0, this.#y(), this.#b(), this.#I()) : this.#g(s);
    }
  }
  #f = () => {
    const e = this.#n;
    if (e?.type === "append") {
      if (e.epoch === this.#_ && this.#h[0] === e.pending) {
        const t = this.#h.shift();
        this.#w -= t.data.byteLength, t.init || this.#O();
      }
    } else e?.type === "remove" ? (this.#p = !1, this.#b()) : e?.type === "clear" && (this.#o = !1);
    this.#n = null, this.#U(), this.#I(), this.#y(), this.#k();
  };
  /**
   * The managed source asking for data again, which is the only thing that
   * reopens the door `endstreaming` closed.
   */
  #T = () => {
    this.#c = !0, this.#y(), this.#b();
  };
  /**
   * The managed source saying it has enough.
   *
   * What is already queued still goes in -- it was converted, and a few
   * fragments are cheaper to append than to convert again -- but nothing more
   * is taken until it asks. This is the whole point of the managed source: it
   * knows what the radio and the battery are doing and the page does not.
   */
  #P = () => {
    this.#c = !1, this.#y(), this.#b();
  };
  #W = () => {
    this.#g(new Error("the SourceBuffer rejected what was appended"));
  };
  /**
   * Put the playhead where the media begins, which is not zero.
   *
   * The timeline keeps the distance the transport stream put between the two
   * tracks, so it opens with only the earlier one on it -- audio alone for over
   * 0.7 s where a recording starts mid-GOP, and at least one frame even when
   * they start together, because the muxer needs somewhere to put the first
   * decode time. buffered is the intersection of the two track buffers, so it
   * begins after that, and nothing is ever appended at zero. Chrome moves the
   * playhead into the first buffered range by itself; Firefox waits at zero for
   * data that is not coming.
   */
  #O() {
    const e = this.#t?.buffered;
    this.#s || !e || e.length === 0 || (this.#s = !0, this.#r.onMark?.("appended"), this.#r.seek(e.start(0)));
  }
  /**
   * Put the length of the file on the MediaSource, once it will take one.
   *
   * The setter only exists while the stream is open and nothing is updating,
   * so this runs again after every operation until it finds its moment. A
   * duration shorter than what is already buffered would evict the difference,
   * so what is buffered wins: it is the file speaking for itself.
   */
  #U() {
    const e = this.#E;
    if (e === null || this.#u || this.mediaSource.readyState !== "open" || this.#n || this.#t?.updating) return;
    const t = this.#t?.buffered, s = t && t.length > 0 ? t.end(t.length - 1) : 0;
    this.#E = null;
    try {
      this.mediaSource.duration = Math.max(e, s);
    } catch (i) {
      this.#g(i);
    }
  }
  /**
   * Drop what is behind the playhead, once a browser has said it is out of
   * room.
   *
   * Only some of them say so. Chrome and Safari throw `QuotaExceededError` and
   * hand the decision back; Firefox keeps its own ceiling and evicts by itself,
   * from its own bookkeeping, and does not need help. Removing anyway would
   * only be another chance to remove the wrong thing.
   */
  #I() {
    const e = this.#t;
    if (!this.#p || !e || e.updating || this.#n || this.#o || e.buffered.length === 0) return;
    const t = this.#D - this.#r.keepBehindSeconds;
    let s = 0;
    for (const r of this.#S) {
      if (r > t) break;
      s = r;
    }
    const i = s - 1e-3;
    if (!(i <= 0)) {
      for (; this.#S.length > 0 && this.#S[0] < s; )
        this.#S.shift();
      this.#n = { type: "remove" }, e.remove(0, i);
    }
  }
  /** How far past the playhead the buffer reaches, in seconds. */
  #N() {
    const e = this.#t?.buffered;
    return !e || e.length === 0 ? 0 : e.end(e.length - 1) - this.#D;
  }
  #y() {
    const e = !this.#p && this.#c && this.#N() < this.#r.maxAheadSeconds && this.#w < this.#r.queueHighWaterMark && this.#h.length < 2;
    this.#l.set(e) && this.#r.onReadyChange?.(e);
  }
  /**
   * Say whether conversion is waiting on the buffer, whichever of the two
   * reasons it is: no room left, or a managed source that wants nothing for
   * now. Both look the same from where the conversion sits.
   */
  #b() {
    const e = this.#p || !this.#c;
    e !== this.#a && (this.#a = e, this.#r.onBlocked?.(e));
  }
  /** Wake `finish`, either because everything is appended or because we gave up. */
  #M(e) {
    if (!e && (!this.#A || this.#h.length > 0 || this.#n))
      return;
    const t = this.#R;
    this.#R = [];
    for (const s of t) s();
  }
  #g(e) {
    this.#r.onError?.(
      e instanceof Error ? e : new Error(String(e))
    );
  }
}
const k = "" + new URL("assets/worker-BUrAso_o.js", import.meta.url).href, y = k, c = 0.1, f = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "playing",
  "waiting"
];
function p(h = !1) {
  return g(h);
}
const b = 'video/mp4; codecs="mp4v.61"';
function R(h = !1) {
  return S(b, h);
}
function o(h) {
  return h instanceof Error ? h : new Error(String(h));
}
function n() {
  return performance.timeOrigin + performance.now();
}
class U extends EventTarget {
  video;
  #e;
  #r;
  #i = null;
  /** Which load messages belong to. Bumped by every load and every stop. */
  #t = 0;
  #v = "idle";
  /** The sink, when the page owns the MediaSource. */
  #d = null;
  #h = null;
  /** The `<source>` child a Managed Media Source needs; see #attachManaged. */
  #w = null;
  /** Whether remote playback was turned off here, and so is ours to turn back. */
  #n = !1;
  #p = null;
  #c = null;
  /** How long the input is, when it turned out to be one that can be seeked. */
  #a = null;
  /** Source video properties indexed by presentation time. */
  #o = [];
  /** What sound the programme last said it was carrying. See `AudioTracks`. */
  #_ = null;
  /** When `load()` was called, as epoch milliseconds; every mark counts from it. */
  #E = 0;
  /** When the last mark was, so each one can say what it cost on its own. */
  #S = 0;
  /** Built the first time deinterlacing is turned on, and kept after that. */
  #s = null;
  /** Whether deinterlacing was asked for. */
  #D = !1;
  #u = !1;
  #A = 0;
  #l = 0;
  #R = 0;
  #B = 0;
  #k = 0;
  #f = 0;
  #T = 0;
  #P = !1;
  #W = "reading";
  #O = 0;
  #U = 0;
  #I = 0;
  #N = "";
  #y = "";
  #b = !1;
  #M = !1;
  #g = !1;
  #H = null;
  #q = !1;
  constructor(e, t = {}) {
    super(), this.video = e, this.#e = t;
    const s = t.mediaSource ?? "auto";
    this.#r = s === "auto" ? p(t.preferManagedMediaSource) ? "worker" : "main" : s, this.video.addEventListener("seeking", this.#Y);
    for (const i of f)
      this.video.addEventListener(i, this.#$);
    t.deinterlace && (this.deinterlace = !0);
  }
  get state() {
    return this.#v;
  }
  /**
   * How long the input is, or null while it is a stream that plays as it
   * arrives. The same number reaches the media element as its duration.
   */
  get duration() {
    return this.#a;
  }
  /**
   * What sound the programme is carrying and which of it is being taken, or
   * null before its program map has been read. See `AudioTracks`.
   */
  get audio() {
    return this.#_;
  }
  /**
   * Take the sound from another of the service's streams from here on.
   *
   * From here on, and no further back: the fragments already converted carry
   * the sound they were made with and are in the buffer being played, so the
   * change arrives when the playhead reaches what is being converted now --
   * a few seconds on a live stream, and however far ahead the buffer has run
   * on a recording. Emptying the buffer to make it immediate would take the
   * picture with it.
   *
   * The PID is one of `audio.available`. One the program map has yet to name
   * is remembered until it does, so a page restoring a viewer's choice may
   * call this before the map arrives.
   */
  selectAudio(e) {
    this.#i?.postMessage({
      type: "audio",
      id: this.#t,
      pid: e,
      dualMonoSub: null
    });
  }
  /**
   * The same choice inside a dual-mono stream, where the two services are the
   * two channels of one stream rather than two streams.
   *
   * A bilingual broadcast in Japan is carried either way, and which way is not
   * the viewer's business: `audio.dualMono` says which control to offer. This
   * one describes nothing anew, so the change costs no restart point.
   */
  selectDualMono(e) {
    this.#i?.postMessage({
      type: "audio",
      id: this.#t,
      pid: null,
      dualMonoSub: e
    });
  }
  /** Which side of the wire ended up owning the MediaSource. */
  get mediaSourceOwner() {
    return this.#r;
  }
  /**
   * Whether the picture is being deinterlaced, which is not quite the same as
   * having asked for it: a source that says it is progressive is left alone,
   * and starts being filtered again the moment it says otherwise. Assigning
   * turns it on or off where it stands, so the two can be compared on the
   * frame; a browser that cannot run it stays false.
   */
  get deinterlace() {
    return this.#s?.running ?? !1;
  }
  /** Whether deinterlacing was asked for, whatever the source turned out to be. */
  get deinterlaceWanted() {
    return this.#D;
  }
  /**
   * The deinterlacer itself, once there has been one, for the settings that
   * are its own -- the field order, and whether a picture goes up per field
   * or per frame. Null until `deinterlace` has been turned on.
   */
  get deinterlacer() {
    return this.#s;
  }
  set deinterlace(e) {
    this.#D = e, this.#K();
  }
  /**
   * Run the filter where it is both wanted and called for.
   *
   * A progressive source has one moment per frame and nothing to rebuild, so
   * filtering it can only soften it. Until the source has said which it is --
   * before the first fragment of a load -- what was asked for is what happens,
   * since an interlaced picture left unfiltered is the more visible mistake of
   * the two.
   */
  #K() {
    if (!this.#u)
      try {
        !this.#s && this.#e.deinterlacer && (this.#s = this.#e.deinterlacer(this.video)), this.#s && (this.#s.videoTimeline = this.#o, this.#s.enabled = this.#D);
      } catch (e) {
        this.#m("error", { error: o(e) });
      }
  }
  #ie(e, t, s) {
    e <= 0 || t <= 0 || this.#Q({ start: s, codedSize: { width: e, height: t } });
  }
  /** Add source metadata now, but apply it only when its picture is shown. */
  #re(e) {
    for (const { start: t, interlaced: s, topFieldFirst: i } of e)
      this.#Q({
        start: t,
        scan: { interlaced: s, topFieldFirst: i }
      });
  }
  #Q(e) {
    const t = this.#o.at(-1), s = {
      start: e.start,
      codedSize: e.codedSize ?? t?.codedSize,
      scan: e.scan ?? t?.scan
    };
    if (t?.start === s.start) this.#o.pop();
    else if (t?.codedSize?.width === s.codedSize?.width && t?.codedSize?.height === s.codedSize?.height && t?.scan?.interlaced === s.scan?.interlaced && t?.scan?.topFieldFirst === s.scan?.topFieldFirst)
      return;
    if (this.#o.push(s), this.video.buffered.length > 0) {
      const i = this.video.buffered.start(0);
      let r = 0;
      for (; r + 1 < this.#o.length && this.#o[r + 1].start <= i; )
        r++;
      r > 0 && this.#o.splice(0, r);
    }
    this.#s && (this.#s.videoTimeline = this.#o);
  }
  #C() {
    this.#o = [], this.#s && (this.#s.videoTimeline = []);
  }
  load(e) {
    if (this.#u)
      return Promise.reject(new Error("the player has been destroyed"));
    if (this.#r === "worker" && !p(this.#e.preferManagedMediaSource))
      return Promise.reject(
        new Error("this browser cannot construct a MediaSource in a worker")
      );
    this.stop();
    const t = this.#t;
    this.#a = null, this.#C(), this.#K(), this.#E = n(), this.#S = this.#E, this.#l = this.#R = this.#B = this.#E, this.#A = this.#k = this.#f = this.#T = 0, this.#P = !1, this.#M = !1, this.#U = this.#E, this.#I = 0, this.#O = 0, this.#W = "reading", this.#g || (this.#b = !1, this.#H = null);
    const s = this.#he(), i = new Promise((r, d) => {
      this.#c = { resolve: r, reject: d };
    });
    return this.#L("loading"), s.postMessage({
      type: "load",
      id: t,
      url: String(e),
      chaseStatusUrl: this.#y || this.#e.chaseStatusUrl,
      wasmUrl: this.#e.wasmUrl === void 0 ? null : String(this.#e.wasmUrl),
      oversample: this.#e.oversample,
      recoveryInterval: this.#e.recoveryInterval,
      openGopRecovery: this.#e.openGopRecovery,
      splitFieldSamples: this.#e.splitFieldSamples,
      audioGainSteps: this.#e.audioGainSteps ?? 0,
      surroundAudioGainSteps: this.#e.surroundAudioGainSteps ?? this.#e.audioGainSteps ?? 0,
      passthrough: this.#e.passthrough ?? !1,
      pictureWorkers: this.#e.pictureWorkers,
      serviceId: this.#e.serviceId ?? null,
      sink: this.#r,
      encodedVideo: this.#s?.encodedVideo != null,
      preferManagedMediaSource: this.#e.preferManagedMediaSource ?? !1,
      queueHighWaterMark: this.#e.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#e.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#e.keepBehindSeconds ?? 10
    }), this.#V(), i;
  }
  /** Abandon the current load. The player stays usable. */
  stop() {
    const e = this.#t;
    this.#t++, this.#i?.postMessage({ type: "stop", id: e }), this.#se(), this.#j(new Error("the load was stopped")), this.#L("idle");
  }
  /** Stop, and give up the worker. The player cannot be loaded again. */
  destroy() {
    if (!this.#u) {
      this.stop(), this.#u = !0, this.video.removeEventListener("seeking", this.#Y);
      for (const e of f)
        this.video.removeEventListener(e, this.#$);
      this.#s?.destroy(), this.#s = null, this.#i?.terminate(), this.#i = null;
    }
  }
  addEventListener(e, t, s) {
    super.addEventListener(e, t, s);
  }
  removeEventListener(e, t, s) {
    super.removeEventListener(e, t, s);
  }
  #he() {
    if (!this.#i) {
      const e = new Worker(
        this.#e.workerUrl ?? y,
        {
          type: "module"
        }
      );
      e.onmessage = this.#ne, e.onerror = (t) => this.#F(
        new Error(t.message || "the worker failed")
      ), this.#i = e;
    }
    return this.#i;
  }
  #ne = (e) => {
    const t = e.data;
    if (t.id === this.#t)
      switch (this.#e.chaseStatusUrl && (this.#R = n()), t.type) {
        case "chase":
          t.sourceUrl && (this.#N = t.sourceUrl), t.statusUrl && (this.#y = t.statusUrl), t.size > this.#k && (this.#B = n()), this.#k = t.size, this.#P = t.complete, this.#W = t.phase, this.#m(
            "chase",
            this.#f ? { ...t, phase: "reconnecting" } : t
          );
          break;
        case "handle":
          t.managed && this.#X(), this.video.srcObject = t.handle, this.#G("attached", n());
          break;
        case "open":
          this.#s?.encodedVideo?.append(t.data), this.#ae(t.mimeCodec, t.data);
          break;
        case "video-config":
          this.#ie(
            t.width,
            t.height,
            t.start
          );
          break;
        case "fragment":
          this.#e.chaseStatusUrl && (this.#U = n()), this.#s?.encodedVideo?.append(t.data), this.#d?.push(
            t.data,
            t.start,
            t.randomAccess
          );
          break;
        case "opened":
          this.#L("converting"), this.#j(null);
          break;
        case "seekable":
          this.#a = t.duration, this.#d?.setDuration(t.duration), this.#m("seekable", { duration: t.duration }), this.#Z();
          break;
        case "reset":
          this.#s?.encodedVideo?.reset(), this.#C(), this.#d?.reset();
          break;
        case "scans":
          this.#re(t.scans);
          break;
        case "workers":
          this.#m("workers", {
            pictureWorkers: t.pictureWorkers
          });
          break;
        case "services":
          this.#m("services", t.services);
          break;
        case "audio":
          this.#_ = t.audio, this.#m("audio", t.audio);
          break;
        case "private_stream_1":
        case "private_stream_2":
          this.#m(t.type, t.stream);
          break;
        case "mark":
          this.#G(t.name, t.at);
          break;
        case "seek":
          this.video.currentTime < t.time && (this.video.currentTime = t.time);
          break;
        case "progress":
          this.#m("progress", {
            bytesRead: t.bytesRead,
            totalBytes: t.totalBytes
          });
          break;
        case "stats":
          t.stats.videoFrames > this.#I && (this.#U = n()), this.#I = t.stats.videoFrames, this.#m("stats", t.stats);
          break;
        case "blocked":
          this.#L(t.blocked ? "buffer-full" : "converting");
          break;
        case "finish":
          this.#ce();
          break;
        case "completed":
          if (this.#e.chaseStatusUrl && this.#c) {
            this.#x(new Error("録画に再生可能な映像がありません"));
            break;
          }
          this.#s?.encodedVideo?.finish(), this.#L("completed"), this.#r === "worker" && this.#z();
          break;
        case "video-data":
          t.data === null ? this.#s?.encodedVideo?.reset() : this.#s?.encodedVideo?.append(t.data);
          break;
        case "error":
          t.recoverable ? this.#F(new Error(t.message)) : this.#x(new Error(t.message));
          break;
      }
  };
  /** Open a MediaSource here, for browsers that cannot have one in a worker. */
  #ae(e, t) {
    const s = this.#t;
    let i;
    try {
      i = this.#d ?? this.#oe(s);
    } catch (r) {
      this.#F(o(r));
      return;
    }
    i.open(e, t).then(
      // The worker is waiting on flow to know the open succeeded. Going
      // through ready() rather than saying true covers the case where the
      // append filled the queue on its own.
      () => i.ready().then(() => this.#te(s, { type: "flow", id: s, ready: !0 })),
      (r) => {
        s === this.#t && this.#F(o(r));
      }
    );
  }
  #oe(e) {
    const t = new E({
      preferManaged: this.#e.preferManagedMediaSource,
      queueHighWaterMark: this.#e.queueHighWaterMark ?? 33554432,
      maxAheadSeconds: this.#e.maxAheadSeconds ?? 8,
      keepBehindSeconds: this.#e.keepBehindSeconds ?? 10,
      seek: (s) => {
        this.video.currentTime < s && (this.video.currentTime = s);
      },
      onMark: (s) => this.#G(s, n()),
      onReadyChange: (s) => this.#te(e, { type: "flow", id: e, ready: s }),
      onBlocked: (s) => {
        e === this.#t && this.#L(s ? "buffer-full" : "converting");
      },
      onError: (s) => {
        e === this.#t && this.#F(s);
      }
    });
    return this.#d = t, this.#h = URL.createObjectURL(t.mediaSource), t.managed ? this.#de(this.#h) : this.video.src = this.#h, this.#G("attached", n()), this.#a !== null && t.setDuration(this.#a), t;
  }
  /**
   * Put a Managed Media Source on the element, which takes more than a `src`.
   *
   * Safari leaves one closed until the element has given up remote playback --
   * AirPlay has nowhere to send a source the page is feeding, so the two are
   * mutually exclusive -- and until the URL is on a `<source>` child rather
   * than the attribute. Neither is optional: miss one and `sourceopen` never
   * arrives and the load waits for a stream that has not begun.
   */
  #de(e) {
    this.video.removeAttribute("src"), this.#X();
    const t = document.createElement("source");
    t.type = "video/mp4", t.src = e, this.video.append(t), this.#w = t, this.video.load();
  }
  /**
   * Rule out AirPlay, which a managed source cannot be sent over and which
   * Safari will not open one until the element has given up. The element
   * belongs to whoever made it, so it is put back on the way out -- unless it
   * was already off, and theirs to keep.
   */
  #X() {
    this.video.disableRemotePlayback || (this.video.disableRemotePlayback = !0, this.#n = !0);
  }
  #ce() {
    const e = this.#t, t = this.#d;
    t && t.finish().then(
      () => {
        e === this.#t && this.#z();
      },
      (s) => {
        e === this.#t && this.#F(o(s));
      }
    );
  }
  /**
   * Answer the viewer moving the playhead somewhere the buffer does not reach.
   *
   * Everything inside a buffered range is Media Source Extensions' own affair,
   * including the correction #startAtMedia asks for, so those go no further.
   * What is left is a real seek: the worker throws the buffer away and reads
   * the input again from where the viewer asked to be.
   */
  #Y = () => {
    if (this.#e.chaseStatusUrl && (this.#O = n()), this.#a === null || this.#v === "idle" || this.#v === "error") return;
    const e = this.video.currentTime;
    this.#J(e) || (this.#L("seeking"), this.#C(), this.#V(), this.#i?.postMessage({
      type: "seek",
      id: this.#t,
      time: e
    }));
  };
  #$ = (e) => {
    this.#v !== "idle" && (this.#G(e.type, n()), e.type === "waiting" && this.#ue());
  };
  /**
   * Move the playhead over a hole in the media, where playback has stopped at
   * one.
   *
   * The conversion leaves the media where the source put it, so a recording
   * joined from two takes has a real gap between them rather than one closed up
   * -- closing it would move everything after it, and the captions, which carry
   * the source's own timestamps, would be out by the length of the gap for the
   * rest of the stream. A browser stops at a gap and waits, so somebody has to
   * step over it, and it is this side: it is the one that knows the playhead.
   *
   * Only where media is already buffered past the hole, which is what
   * distinguishes a hole from the ordinary wait for the converter to catch up.
   *
   * Read from the media element rather than from the sink: what stops playback
   * is the element's own view, which is the tracks' ranges taken together, and
   * it is the one reading available whether the `MediaSource` is here or in the
   * worker.
   */
  #ue() {
    if (this.video.seeking) return;
    const e = this.video.currentTime, t = this.video.buffered;
    let s = null;
    for (let i = 0; i < t.length; i++) {
      const r = t.start(i);
      if (e >= r - c && e < t.end(i) - c)
        return;
      r > e + c && (s === null || r < s) && (s = r);
    }
    s !== null && (this.video.currentTime = s);
  }
  /**
   * Report where a step of the load fell on the clock `load()` started.
   *
   * The worker's marks arrive as epoch milliseconds because that is the only
   * reading the two contexts share; what a caller wants is how long it waited,
   * which is measured from here.
   */
  #G(e, t) {
    if (this.#E === 0) return;
    const s = t - this.#E, i = Math.max(0, t - this.#S);
    this.#S = Math.max(this.#S, t), this.#m("timing", { name: e, sinceLoad: s, sincePrevious: i });
  }
  #J(e) {
    const t = this.video.buffered;
    for (let s = 0; s < t.length; s++)
      if (e >= t.start(s) && e < t.end(s))
        return !0;
    return !1;
  }
  /**
   * Tell whoever holds the buffer where playback is, so it can drop what is
   * behind. This cannot ride on `timeupdate`: that event stops firing exactly
   * when playback stalls, which is when eviction matters most.
   */
  #le = () => {
    const e = this.video.currentTime;
    this.#e.chaseStatusUrl && (this.#Z(), this.#ee()), this.#r === "main" && this.#d?.setCurrentTime(e), (this.#r !== "main" || this.#e.chaseStatusUrl) && this.#i?.postMessage({
      type: "time",
      id: this.#t,
      currentTime: e
    });
  };
  #Z() {
    if (this.#H === null || this.#a === null || this.video.readyState < 1 || this.#c)
      return;
    const e = this.#H;
    this.#H = null, this.video.currentTime = Math.min(e, this.#a), this.#q && this.video.play().catch(() => {
    }), this.#g = !1;
  }
  #ee() {
    const e = n(), t = this.video;
    if (!this.#g && !this.#M && Math.abs(t.currentTime - this.#A) > 0.05) {
      this.#A = t.currentTime, this.#l = e, this.#f = this.#T = 0, this.#b = !1;
      return;
    }
    if (!this.#g && !this.#M && (t.paused && this.#c === null && !t.error || t.ended)) {
      this.#l = e, this.#f = this.#T = 0;
      return;
    }
    const s = this.#W === "waiting" && !this.#P && this.#a !== null && t.currentTime >= this.#a - 2 && e - this.#B < 1e4 && e - this.#R < 1e4, i = !this.#J(t.currentTime + 0.1) && e - this.#U < 1e4;
    if (!this.#f && (s || i || e - this.#O < 1e4)) {
      this.#l = e;
      return;
    }
    if (!(e - this.#l < 1e4)) {
      if (this.#f ||= this.#l, e - this.#f >= 3e4) {
        this.#i?.postMessage({
          type: "stop",
          id: this.#t
        }), this.#i?.terminate(), this.#i = null, this.#x(
          new Error("追っかけ再生を復旧できませんでした。再試行してください。")
        );
        return;
      }
      if (this.#m("chase", {
        phase: "reconnecting",
        size: this.#k,
        complete: this.#P
      }), !this.#b && this.#N && (this.#M || t.error || e - this.#R >= 1e4 || e - this.#f >= 2e4)) {
        this.#b = !0, this.#g = !0, this.#H = this.#A, this.#q = !t.paused || !!t.error || this.#M || !!this.#c;
        const r = this.#f, d = this.#l;
        this.#i?.terminate(), this.#i = null;
        const l = this.#c;
        this.#c = null, this.load(this.#N).then(
          () => l?.resolve(),
          (m) => l?.reject(m)
        ), this.#A = this.#H ?? 0, this.#f = r, this.#l = d, this.#T = e;
        return;
      }
      !this.#T && this.#a !== null && (this.#T = e, this.#i?.postMessage({
        type: "recover",
        id: this.#t,
        time: Math.min(t.currentTime, this.#a)
      }));
    }
  }
  #te(e, t) {
    e === this.#t && this.#i?.postMessage(t);
  }
  #V() {
    this.#p === null && (this.#p = setInterval(
      this.#le,
      200
    ));
  }
  #z() {
    this.#p !== null && (clearInterval(this.#p), this.#p = null);
  }
  #se() {
    this.#z(), this.#s?.encodedVideo?.reset(), this.#C(), this.#d?.close(), this.#d = null, this.#h && URL.revokeObjectURL(this.#h), this.#h = null, this.#w?.remove(), this.#w = null, this.#n && (this.video.disableRemotePlayback = !1, this.#n = !1), this.video.removeAttribute("src"), this.video.srcObject = null, this.video.load();
  }
  #F(e) {
    if (!this.#e.chaseStatusUrl) {
      this.#x(e);
      return;
    }
    this.#M = !0, this.#f ||= n(), this.#l = Math.min(this.#l, n() - 1e4), this.#V(), this.#ee();
  }
  #x(e) {
    this.#g = !1, this.#H = null, this.#se(), this.#L("error"), this.#j(e), this.#m("error", { error: e });
  }
  #j(e) {
    const t = this.#c;
    t && (this.#c = null, e ? t.reject(e) : t.resolve());
  }
  #L(e) {
    this.#v !== e && (this.#v = e, this.#m("statechange", { state: e }));
  }
  #m(e, t) {
    this.dispatchEvent(new CustomEvent(e, { detail: t }));
  }
}
export {
  A as DEFAULT_KEEP_BEHIND_SECONDS,
  w as DEFAULT_MAX_AHEAD_SECONDS,
  M as DEFAULT_QUEUE_HIGH_WATER_MARK,
  U as Mpeg2TsPlayer,
  _ as requiresManagedMediaSource,
  T as supportsManagedMediaSource,
  R as supportsPassthrough,
  p as supportsWorkerMediaSource
};
//# sourceMappingURL=index.js.map
