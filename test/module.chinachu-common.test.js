"use strict";

var os     = require("os");
var path   = require("path");
var fs     = require("fs");
var should = require("should");

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

	it("read", function(done) {
		var finished = false;

		watcher = chinachu.jsonWatcher(testDataPath, function(err, data, msg) {
			if (finished) {
				return;
			}

			if (err) {
				finished = true;
				done(new Error(err));
				return;
			}

			finished = true;
			test = data;

			should.exist(test);

			done();
		}, { now: true });
	});

	it("validate", function() {
		should.strictEqual(test.a, 0);
		should.strictEqual(test.b, 1);
		should.strictEqual(test.c, "");
		should.strictEqual(test.d, "string");
		should.strictEqual(test.e, null);
	});

	it.skip("watch");
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
