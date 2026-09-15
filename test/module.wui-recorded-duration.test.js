'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repositoryRoot = path.resolve(__dirname, '..');

function loadPage(pagePath, alerts) {
	const context = {
		P: {},
		Class: {
			create(base, properties) {
				return properties;
			}
		},
		sakura: {
			ui: {
				Alert: function Alert(options) {
					alerts.push(options);
					this.render = function() {};
				}
			}
		}
	};

	vm.createContext(context);
	vm.runInContext(fs.readFileSync(path.join(repositoryRoot, pagePath), 'utf8'), context, { filename: pagePath });
	return context.P;
}

describe('WUI recorded duration display', function() {
	it('shows precise file duration and estimates the head only for uninterrupted recordings', function() {
		const alerts = [];
		const page = loadPage('web/page/program/view.js', alerts);
		const uninterrupted = {
			start: 100000,
			operatorRecordingEnd: 160000,
			recordedDurationSeconds: 61.234567
		};
		const resumed = Object.assign({}, uninterrupted, { operatorInterruptionCount: 1 });

		const body = page.buildRecordedFileInfoBody({ size: 1024 * 1024 * 1024 }, uninterrupted, null);
		const resumedBody = page.buildRecordedFileInfoBody({ size: 1024 }, resumed, null);

		assert.match(body, /実ファイル 1分01\.235秒/);
		assert.match(body, /推定先頭:/);
		assert.match(resumedBody, /実ファイル 1分01\.235秒/);
		assert.doesNotMatch(resumedBody, /推定先頭:/);
	});

	it('uses measured head estimation only when uninterrupted and preserves the old one-second fallback', function() {
		const alerts = [];
		const page = loadPage('web/page/program/view.js', alerts);
		const target = {};

		page.renderOperatorTimingWarning(target, {}, {
			start: 100000,
			end: 160000,
			seconds: 60,
			operatorRecordingEnd: 160000,
			recordedDurationSeconds: 55
		}, null);
		assert.match(alerts.pop().body, /推定ファイル先頭.*5\.000秒.*遅れ/);

		page.renderOperatorTimingWarning(target, {}, {
			start: 100000,
			end: 160000,
			seconds: 60,
			operatorRecordingStart: 101001,
			operatorRecordingEnd: 160000,
			operatorActualSeconds: 59
		}, null);
		assert.match(alerts.pop().body, /番組開始より 0分02秒 遅れて録画開始/);

		page.renderOperatorTimingWarning(target, {}, {
			start: 100000,
			end: 160000,
			seconds: 60,
			operatorRecordingEnd: 160000,
			recordedDurationSeconds: 55,
			operatorInterruptionCount: 1
		}, null);
		assert.doesNotMatch(alerts.pop().body, /推定ファイル先頭/);
	});

	it('prefers file duration in the recorded list and falls back to operator duration', function() {
		const page = loadPage('web/page/recorded/list.js', []);

		assert.strictEqual(page.getDisplayedDurationSeconds({
			recordedDurationSeconds: 59.75,
			operatorActualSeconds: 58
		}), 59.75);
		assert.strictEqual(page.getDisplayedDurationSeconds({ operatorActualSeconds: 58 }), 58);
		assert.match(page.getDurationTitle({ recordedDurationSeconds: 59.75, seconds: 60 }), /^実ファイル:/);
	});
});
