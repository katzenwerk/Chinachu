"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var describe = test.describe;
var it = test.it;

var chinachu = require("chinachu-common");
var loadedDateFormat = require("dateformat");
var dateFormat = loadedDateFormat.default;

function formatInTimezone(timezone, date, masks) {
	var previousTimezone = process.env.TZ;

	process.env.TZ = timezone;

	try {
		date = new Date(date);
		return masks.map(function(mask) {
			return dateFormat(date, mask);
		});
	} finally {
		if (typeof previousTimezone === "undefined") {
			delete process.env.TZ;
		} else {
			process.env.TZ = previousTimezone;
		}
	}
}

describe("dateformat compatibility", function() {
	it("loads the ESM default export as a function from CommonJS", function() {
		assert.strictEqual(typeof dateFormat, "function");
	});

	it("keeps the masks used by CLI, scheduler, and the sample recordedFormat", function() {
		assert.deepStrictEqual(formatInTimezone("Asia/Tokyo", "2026-01-02T15:04:05.678Z", [
			"isoDateTime",
			"dd HH:MM",
			"yy/mm/dd HH:MM",
			"yymmdd-HHMM"
		]), [
			"2026-01-03T00:04:05+0900",
			"03 00:04",
			"26/01/03 00:04",
			"260103-0004"
		]);
	});

	it("keeps local and UTC date boundaries separate", function() {
		assert.deepStrictEqual(formatInTimezone("Asia/Tokyo", "2025-12-31T15:00:00.000Z", [
			"isoDateTime",
			"yymmdd-HHMM",
			"UTC:yymmdd-HHMM"
		]), [
			"2026-01-01T00:00:00+0900",
			"260101-0000",
			"251231-1500"
		]);
	});

	it("formats the token set, UTC offset, and quoted literals with 5.0.3", function() {
		assert.deepStrictEqual(formatInTimezone("Asia/Tokyo", "2026-01-02T15:04:05.678Z", [
			"d|dd|ddd|dddd|m|mm|mmm|mmmm|yy|yyyy|h|hh|H|HH|M|MM|s|ss|l|L|t|tt|T|TT|o|S|W|N|'literal'",
			"GMT:yyyy-mm-dd'T'HH:MM:ss Z",
			"UTC:yyyy-mm-dd'T'HH:MM:ss'Z'"
		]), [
			"3|03|Sat|Saturday|1|01|Jan|January|26|2026|12|12|0|00|4|04|5|05|678|67|a|am|A|AM|+0900|rd|1|6|literal",
			"2026-01-02T15:04:05 GMT",
			"2026-01-02T15:04:05Z"
		]);
	});

	it("keeps Japanese titles in recorded filenames", function() {
		var program = {
			id: "test",
			start: new Date(2026, 0, 3, 0, 4, 5).getTime(),
			channel: {
				type: "GR",
				channel: "27",
				id: "test-channel",
				sid: 1,
				name: "日本テレビ"
			},
			title: "日本語「番組」/特番"
		};

		assert.strictEqual(chinachu.formatRecordedName(
			program,
			"[<date:yymmdd-HHMM>][<type><channel>][<channel-name>]<title>.m2ts"
		), "[260103-0004][GR27][日本テレビ]日本語「番組」／特番.m2ts");
	});

	it("keeps dateformat 1.0.12 rounding for the recordedFormat L token", function() {
		var program = {
			start: new Date(2026, 0, 3, 0, 4, 5, 678).getTime(),
			channel: {}
		};

		assert.strictEqual(
			chinachu.formatRecordedName(program, "<date:L>-<date:'L'>.m2ts"),
			"68-L.m2ts"
		);
	});
});
