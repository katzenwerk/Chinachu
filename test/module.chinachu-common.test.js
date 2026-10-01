"use strict";

var os = require("os");
var path = require("path");
var fs = require("fs");
var test = require("node:test");
var assert = require("node:assert/strict");

var describe = test.describe;
var it = test.it;

var chinachu = require("chinachu-common");

describe("jsonWatcher", function() {
	it("reads initial JSON data and reports a later update", { timeout: 5000 }, async function() {
		var temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "chinachu-json-watcher-"));
		var temporaryFile = path.join(temporaryDirectory, "watch.json");
		var initialData = { a: 0, b: 1, c: "", d: "string", e: null, nested: { value: true }, items: [1, "two"] };
		var updatedData = { updated: true, value: "変更後" };
		var watcher = null;

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

			var update = new Promise(function(resolve, reject) {
				var timeout = setTimeout(function() {
					reject(new Error("Timed out waiting for jsonWatcher update."));
				}, 3000);
				watcher.close();
				watcher = chinachu.jsonWatcher(temporaryFile, function(err, data, message) {
					if (err) {
						clearTimeout(timeout);
						reject(new Error(err));
						return;
					}
					if (data.updated) {
						clearTimeout(timeout);
						resolve({ data: data, message: message });
					}
				}, { wait: 25 });
				fs.writeFile(temporaryFile, JSON.stringify(updatedData), function(err) {
					if (err) {
						clearTimeout(timeout);
						reject(err);
					}
				});
			});
			var receivedUpdate = await update;
			assert.deepStrictEqual(receivedUpdate.data, updatedData);
			assert.strictEqual(receivedUpdate.message, "READ: `" + temporaryFile + "` is updated.");
		} finally {
			if (watcher && typeof watcher.close === "function") watcher.close();
			fs.rmSync(temporaryDirectory, { recursive: true, force: true });
		}
	});
});
