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
	it("preserves episode padding in recording names and subdirectories", function() {
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
				watcher = chinachu.jsonWatcher(temporaryFile, function(err, data, message) {
					if (err) {
						clearTimeout(timeout);
						reject(new Error(err));
						return;
					}
					if (!data.updated) {
						return;
					}
					received.push({ data: data, message: message });
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
			assert.deepStrictEqual(receivedUpdates.map(function(entry) { return entry.data; }), [updatedData1, updatedData2]);
			receivedUpdates.forEach(function(entry) {
				assert.strictEqual(entry.message, "READ: `" + temporaryFile + "` is updated.");
			});
		} finally {
			if (watcher && typeof watcher.close === "function") watcher.close();
			fs.rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
