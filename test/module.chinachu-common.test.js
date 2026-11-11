"use strict";

var os = require("os");
var path = require("path");
var fs = require("fs");
var test = require("node:test");
var assert = require("node:assert/strict");

var describe = test.describe;
var it = test.it;

var chinachu = require("chinachu-common");

describe("formatRecordedName", function() {
	it("preserves episode padding and explicit filename character compatibility", function() {
		var baseProgram = {
			start: 0,
			channel: {}
		};
		var cases = [
			{ episode: null, expected: "n" },
			{ episode: 0, expected: "000" },
			{ episode: 7, expected: "007" },
			{ episode: -7, expected: "0-7" },
			{ episode: 1234, expected: "1234" }
		];

		cases.forEach(function(entry) {
			var program = Object.assign({}, baseProgram, { episode: entry.episode });

			assert.strictEqual(
				chinachu.formatRecordedName(program, "<episode:3>.m2ts"),
				entry.expected + ".m2ts"
			);
			assert.strictEqual(
				chinachu.formatRecordedName(program, "series/<episode:3>/program.m2ts"),
				path.join("series", entry.expected, "program.m2ts")
			);
		});

		// Preserve every original mapping, including replacements that differ from NFKC.
		var originalMarks = "🈀🈁🈂🈐🈑🈒🈓🈔🈕🈖🈗🈘🈙🈚🈛🈜🈝🈞🈟🈠🈡🈢🈣🈤🈥🈦🈧🈨🈩🈪🈫🈬🈭🈮🈯🈰🈱🈲🈳🈴🈵🈶🈷🈸🈹🈺🈻🉐🉑㊙㊗";
		var originalLabels = "ほか ココ サ 手 字 双 デ 二 多 解 天 交 映 無 料 前 後 再 新 初 終 生 販 声 吹 演 投 捕 一 三 遊 左 中 右 指 走 打 禁 空 合 満 有 月 申 割 営 配 得 可 秘 祝".split(" ");
		assert.strictEqual(chinachu.replaceEnclosingCharacters(originalMarks), originalLabels.map(function(label) { return "[" + label + "]"; }).join(""));
		var broadcastMarks = "🅊🅌🄿🅆🅋🅂🅍🄱🄽🅎🆛🆜🆝🆞🆟🆠🆡🆢🆣🆤🆥🆦🆧🆨🆩🆪🆫🆬⚿";
		var broadcastLabels = "HV SD P W MV S SS B N PPV 3D 2ndScr 2K 4K 8K 5.1 7.1 22.2 60P 120P d HC HDR Hi-Res Lossless SHV UHD VOD 鍵".split(" ");
		assert.strictEqual(chinachu.replaceEnclosingCharacters(broadcastMarks), broadcastLabels.map(function(label) { return "[" + label + "]"; }).join(""));
		assert.strictEqual(chinachu.replaceEnclosingCharacters("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳"),
			"[1][2][3][4][5][6][7][8][9][10][11][12][13][14][15][16][17][18][19][20]");
		assert.strictEqual(chinachu.replaceEnclosingCharacters("㈱㈲㈹㈳㈶㈽㈾㈿"), "[株][有][代][社][財][企][資][協]");
		var program = { start: 0, channel: {}, title: "ＡＢＣ ｶﾞ ㍑ Ⅳ 🆞⚿①㈱", fullTitle: "🈑🆧", subTitle: "㈶⑳" };
		var before = JSON.stringify(program);
		assert.strictEqual(chinachu.formatRecordedName(program, "<title>.m2ts"), program.title + ".m2ts");
		assert.strictEqual(chinachu.formatRecordedName(program, "<title>.m2ts", { replaceEnclosingCharacters: false }), program.title + ".m2ts");
		assert.strictEqual(chinachu.formatRecordedName(program, "<title>.m2ts", { replaceEnclosingCharacters: true }), "ＡＢＣ ｶﾞ ㍑ Ⅳ [4K][鍵][1][株].m2ts");
		assert.strictEqual(chinachu.formatRecordedName(program, "<fulltitle>/<subtitle>.m2ts", { replaceEnclosingCharacters: true }), path.join("[字][HDR]", "[財][20].m2ts"));
		assert.strictEqual(chinachu.formatRecordedName(program, "<title>.m2ts", {
			needToReplaceEnclosingCharacters: true, enclosingCharacterMap: { "🆞": "4K", "⚿": "", "①": "(1)", "🈑": "字幕" }
		}), "ＡＢＣ ｶﾞ ㍑ Ⅳ 4K(1)[株].m2ts");
		assert.strictEqual(chinachu.replaceEnclosingCharacters("🈑①🈑①", { "🈑": "字幕", "①": "(1)" }), "字幕(1)字幕(1)");
		assert.strictEqual(JSON.stringify(program), before);
		var expanded = "[2ndScr]".repeat(80);
		var limited = chinachu.formatRecordedName({ start: 0, channel: {}, title: "🆜".repeat(80) }, "<title>.m2ts", { replaceEnclosingCharacters: true });
		assert.strictEqual(limited, expanded.slice(0, 255 - Buffer.byteLength(".m2ts")) + ".m2ts");
		assert.strictEqual(Buffer.byteLength(limited), 255);
		// Literal aliases share a basename; an ID in the existing format keeps them distinct.
		assert.strictEqual(chinachu.formatRecordedName(program, "<title>.m2ts", { replaceEnclosingCharacters: true }),
			chinachu.formatRecordedName({ ...program, title: "ＡＢＣ ｶﾞ ㍑ Ⅳ [4K][鍵][1][株]" }, "<title>.m2ts", { replaceEnclosingCharacters: true }));
		assert.notStrictEqual(chinachu.formatRecordedName({ ...program, id: "one" }, "<id>_<title>.m2ts", { replaceEnclosingCharacters: true }),
			chinachu.formatRecordedName({ ...program, id: "two" }, "<id>_<title>.m2ts", { replaceEnclosingCharacters: true }));
	});
});

describe("programMatchesRule title conditions", function() {
	it("keeps absent/OR behavior and requires every title condition only in AND mode", function() {
		var program = {
			fullTitle: "新番組　ドラマ Special",
			detail: "",
			start: 0,
			end: 1800000,
			seconds: 1800,
			category: "drama",
			flags: [],
			channel: { id: "channel-a", channel: "27", type: "GR", sid: 1 }
		};

		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles: ["存在しない", "ドラマ"] }, program), true);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles_mode: "or", reserve_titles: ["存在しない", "ドラマ"] }, program), true);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles_mode: "and", reserve_titles: ["新番組", "ドラマ"] }, program), true);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles_mode: "and", reserve_titles: ["新番組", "存在しない"] }, program), false);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles: [] }, program), false);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles_mode: "or", reserve_titles: [] }, program), false);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles_mode: "and", reserve_titles: [] }, program), false);
		assert.strictEqual(chinachu.programMatchesRule({ reserve_titles_mode: "and", reserve_titles: ["新番組", "Special"] }, program, "NFKC"), true);
	});
});

describe("jsonWatcher", function() {
	it("reads initial JSON data and keeps reporting atomic replacements", { timeout: 5000 }, async function() {
		var temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "chinachu-json-watcher-"));
		var temporaryFile = path.join(temporaryDirectory, "watch.json");
		var initialData = { a: 0, b: 1, c: "", d: "string", e: null, nested: { value: true }, items: [1, "two"] };
		var updatedData1 = { updated: true, value: "変更後1" };
		var updatedData2 = { updated: true, value: "変更後2" };
		var watcher = null;
		var replaceAtomically = function(data, suffix) {
			var temporaryReplacement = temporaryFile + "." + suffix + ".tmp";
			fs.writeFileSync(temporaryReplacement, JSON.stringify(data));
			fs.renameSync(temporaryReplacement, temporaryFile);
		};

		try {
			fs.writeFileSync(temporaryFile, JSON.stringify(initialData));
			var receivedInitial = await new Promise(function(resolve, reject) {
				watcher = chinachu.jsonWatcher(temporaryFile, function(err, data) {
					if (err) {
						reject(new Error(err));
						return;
					}
					resolve(data);
				}, { now: true, wait: 25 });
			});
			assert.deepStrictEqual(receivedInitial, initialData);

			var updates = new Promise(function(resolve, reject) {
				var timeout = setTimeout(function() {
					reject(new Error("Timed out waiting for jsonWatcher update."));
				}, 3000);
				var received = [];
				watcher.close();
				watcher = chinachu.jsonWatcher(temporaryFile, function(err, data) {
					if (err) {
						clearTimeout(timeout);
						reject(new Error(err));
						return;
					}
					if (!data.updated) {
						return;
					}
					received.push(data);
					if (data.value === updatedData1.value) {
						replaceAtomically(updatedData2, "second");
					} else if (data.value === updatedData2.value) {
						clearTimeout(timeout);
						resolve(received);
					}
				}, { wait: 25 });
				replaceAtomically(updatedData1, "first");
			});
			var receivedUpdates = await updates;
			assert.deepStrictEqual(receivedUpdates, [updatedData1, updatedData2]);
		} finally {
			if (watcher && typeof watcher.close === "function") watcher.close();
			fs.rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
