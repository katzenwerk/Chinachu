"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");

var describe = test.describe;
var it = test.it;

var chinachu = require("chinachu-common");
var dateFormat = require("dateformat").default;

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
	it("preserves date masks, timezone boundaries, and recorded filename formatting", function() {
		assert.deepStrictEqual(formatInTimezone("Asia/Tokyo", "2025-12-31T15:00:00.000Z", [
			"isoDateTime",
			"dd HH:MM",
			"yy/mm/dd HH:MM",
			"yymmdd-HHMM",
			"UTC:yymmdd-HHMM"
		]), [
			"2026-01-01T00:00:00+0900",
			"01 00:00",
			"26/01/01 00:00",
			"260101-0000",
			"251231-1500"
		]);

		var program = {
			id: "test",
			start: new Date(2026, 0, 3, 0, 4, 5, 678).getTime(),
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

		assert.strictEqual(
			chinachu.formatRecordedName(
				{ start: program.start, channel: {} },
				"<date:L>-<date:'L'>.m2ts"
			),
			"68-L.m2ts"
		);
	});
});
