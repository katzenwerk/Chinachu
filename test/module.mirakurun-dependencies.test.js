"use strict";

var fs = require("fs");
var path = require("path");
var Module = require("module");
var test = require("node:test");
var assert = require("node:assert/strict");

var describe = test.describe;
var it = test.it;

function findPackage(entryPath, expectedName) {
	var directory = path.dirname(entryPath);

	while (directory !== path.dirname(directory)) {
		var packagePath = path.join(directory, "package.json");

		if (fs.existsSync(packagePath)) {
			var pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));

			if (pkg.name === expectedName) {
				return {
					path: packagePath,
					package: pkg
				};
			}
		}

		directory = path.dirname(directory);
	}

	throw new Error("Could not find package metadata for " + expectedName);
}

function resolveFrom(moduleName, dependencyName) {
	return require.resolve(dependencyName, {
		paths: [path.dirname(require.resolve(moduleName))]
	});
}

describe("Mirakurun consumer dependency resolution", function() {
	it("keeps Mirakurun 4.1.3 without a Chinachu-side transitive override", function() {
		var rootPackage = require("../package.json");
		var mirakurunPackage = require("mirakurun/package.json");
		var jsYamlEntry = resolveFrom("mirakurun", "js-yaml");
		var rpcServerEntry = require.resolve("jsonrpc2-ws/lib/server");
		var rpcPackage = findPackage(rpcServerEntry, "jsonrpc2-ws").package;
		var uuidEntry = require.resolve("uuid", {
			paths: [path.dirname(rpcServerEntry)]
		});
		var semver = require(resolveFrom("mirakurun", "semver"));

		assert.strictEqual(mirakurunPackage.version, "4.1.3");
		assert.ok(!rootPackage.overrides || !rootPackage.overrides.mirakurun);
		assert.strictEqual(findPackage(jsYamlEntry, "js-yaml").package.version, mirakurunPackage.dependencies["js-yaml"]);
		assert.strictEqual(rpcPackage.version, mirakurunPackage.dependencies["jsonrpc2-ws"]);
		assert.ok(semver.satisfies(findPackage(uuidEntry, "uuid").package.version, rpcPackage.dependencies.uuid));
	});

	it("loads the Mirakurun client through js-yaml without loading server RPC modules", function() {
		var mirakurunEntry = require.resolve("mirakurun");
		var jsYamlEntry = resolveFrom("mirakurun", "js-yaml");
		var loaded = [];
		var originalLoad = Module._load;
		var client;

		delete require.cache[mirakurunEntry];
		delete require.cache[jsYamlEntry];

		Module._load = function(request) {
			loaded.push(request);
			return originalLoad.apply(this, arguments);
		};

		try {
			var Client = require("mirakurun").default;
			client = new Client();
		} finally {
			Module._load = originalLoad;
		}

		assert.strictEqual(client.basePath, "/api");
		assert.ok(loaded.includes("js-yaml"));
		assert.ok(!loaded.includes("jsonrpc2-ws/lib/server"));
		assert.ok(!loaded.includes("uuid"));
	});

	it("parses the packaged API specification with Mirakurun's resolved js-yaml", function() {
		var mirakurunEntry = require.resolve("mirakurun");
		var jsYamlEntry = resolveFrom("mirakurun", "js-yaml");
		var yaml = require(jsYamlEntry);
		var apiPath = path.resolve(path.dirname(mirakurunEntry), "../api.yml");
		var spec = yaml.load(fs.readFileSync(apiPath, "utf8"));

		assert.strictEqual(spec.basePath, "/api");
		assert.ok(Object.hasOwn(spec, "definitions"));
	});

	it("keeps the server-side module load and uuid.v4 minimum compatibility", function() {
		var rpcServerEntry = require.resolve("jsonrpc2-ws/lib/server");
		var uuidEntry = require.resolve("uuid", {
			paths: [path.dirname(rpcServerEntry)]
		});
		var uuid = require(uuidEntry);

		assert.ok(require(rpcServerEntry) != null);
		assert.strictEqual(typeof uuid.v4, "function");
		assert.match(uuid.v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	});
});
