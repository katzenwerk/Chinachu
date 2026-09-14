"use strict";

var os     = require("os");
var path   = require("path");
var fs     = require("fs");
var test   = require("node:test");
var assert = require("node:assert/strict");

var describe = test.describe;
var it = test.it;

var chinachu = require("chinachu-common");

var testDataPath = path.join(os.tmpdir(), "chinachu-test-" + Date.now() + ".json");
var watcher = null;

describe("(init)", function() {
	var testData = {
		a: 0,
		b: 1,
		c: "",
		d: "string",
		e: null,
		f: {},
		g: { a: 0, b: 1, c: "", d: "string", e: null, f: {}, h: [] },
		h: [],
		i: [ 0, 1, "", "string", null, {}, [] ]
	};

	it("create test data file", function() {
		fs.writeFileSync(testDataPath, JSON.stringify(testData));
	});
});

describe("jsonWatcher", function() {
	var test = null;

	it("read", function() {
		var finished = false;

		return new Promise(function(resolve, reject) {
			watcher = chinachu.jsonWatcher(testDataPath, function(err, data, msg) {
				if (finished) {
					return;
				}

				if (err) {
					finished = true;
					reject(new Error(err));
					return;
				}

				finished = true;
				test = data;

				assert.ok(test != null);

				resolve();
			}, { now: true });
		});
	});

	it("validate", function() {
		assert.strictEqual(test.a, 0);
		assert.strictEqual(test.b, 1);
		assert.strictEqual(test.c, "");
		assert.strictEqual(test.d, "string");
		assert.strictEqual(test.e, null);
	});

	it("watch", { timeout: 5000 }, function() {
		var temporaryDirectory = null;
		var temporaryFile = null;
		var localWatcher = null;
		var timeout = null;
		var updatedData = { updated: true, value: "変更後" };

		return new Promise(function(resolve, reject) {
			var finished = false;

			var finish = function(err) {
				var cleanupError = null;

				if (finished) {
					return;
				}

				finished = true;
				clearTimeout(timeout);

				if (localWatcher && typeof localWatcher.close === "function") {
					try {
						localWatcher.close();
					} catch (watcherError) {
						cleanupError = watcherError;
					}
				}

				if (temporaryDirectory) {
					try {
						fs.rmSync(temporaryDirectory, { recursive: true, force: true });
					} catch (fileError) {
						cleanupError = cleanupError || fileError;
					}
				}

				if (err || cleanupError) {
					reject(err || cleanupError);
					return;
				}

				resolve();
			};

			try {
				temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "chinachu-json-watcher-"));
				temporaryFile = path.join(temporaryDirectory, "watch.json");
				fs.writeFileSync(temporaryFile, JSON.stringify({ updated: false }));

				localWatcher = chinachu.jsonWatcher(temporaryFile, function(err, data, msg) {
					if (err) {
						finish(new Error(err));
						return;
					}

					try {
						assert.deepStrictEqual(data, updatedData);
						assert.strictEqual(msg, "READ: `" + temporaryFile + "` is updated.");
						finish();
					} catch (assertionError) {
						finish(assertionError);
					}
				}, { wait: 25 });

				timeout = setTimeout(function() {
					finish(new Error("Timed out waiting for jsonWatcher update."));
				}, 3000);

				fs.writeFile(temporaryFile, JSON.stringify(updatedData), function(err) {
					if (err) {
						finish(err);
					}
				});
			} catch (err) {
				finish(err);
			}
		});
	});
});

describe("(clean up)", function() {
	it("remove test data file", function() {
		if (watcher && typeof watcher.close === "function") {
			watcher.close();
		}

		if (fs.existsSync(testDataPath)) {
			fs.unlinkSync(testDataPath);
		}
	});
});
