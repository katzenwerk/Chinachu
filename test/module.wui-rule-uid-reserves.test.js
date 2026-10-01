'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

function loadPage(relativePath, fixture = {}) {
	const rows = [];
	const chinachu = {
		rules: [],
		reserves: [],
		ui: { DynamicTime: function() { this.entity = {}; } },
		util: { scotify: function() { return ''; } }
	};
	const context = {
		P: {},
		Class: { create: function(_parent, definition) { return definition; } },
		global: { chinachu },
		chinachu,
		window: { location: { hash: '' }, open: function() {} },
		history: { replaceState: function() {} },
		screen: { width: 1280, height: 800 },
		document: {},
		Ajax: {
			Request: function(_url, options) {
				options.onSuccess({ responseJSON: fixture.reserves || [] });
			}
		},
		encodeURIComponent,
		Math,
		Date
	};
	vm.createContext(context);
	vm.runInContext(`
		Array.prototype.each = function(callback) { this.forEach(callback); return this; };
		Array.prototype.invoke = function(method) {
			var args = Array.prototype.slice.call(arguments, 1);
			return this.map(function(value) { return value[method].apply(value, args); });
		};
		Array.prototype.truncate = function() { return this; };
		String.prototype.truncate = function() { return String(this); };
		Number.prototype.toPaddedString = function(length) { return String(this).padStart(length, '0'); };
	`, context);
	vm.runInContext(fs.readFileSync(path.join(root, relativePath), 'utf8'), context, { filename: relativePath });
	context.global.chinachu.rules = vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(fixture.rules || [])) + ')', context);
	context.global.chinachu.reserves = vm.runInContext('JSON.parse(' + JSON.stringify(JSON.stringify(fixture.reserves || [])) + ')', context);
	context.chinachu.rules = context.global.chinachu.rules;
	context.chinachu.reserves = context.global.chinachu.reserves;
	const grid = {
		splice: function(_start, _deleteCount, newRows) {
			rows.splice(0, rows.length, ...newRows);
			return { each: callback => { rows.forEach(callback); return this; } };
		},
		deselect: function() {}
	};
	return { context, page: context.P, rows, grid };
}

function renderRules(rules, reserves) {
	const loaded = loadPage('web/page/rules/list.js', { rules, reserves });
	loaded.page.grid = loaded.grid;
	loaded.page.setGridPagePosition = function() {};
	loaded.page.getPageNumber = function() { return 1; };
	loaded.page.drawMain();
	return loaded.rows;
}

function renderReserves(reserves, query) {
	const loaded = loadPage('web/page/reserves/list.js', { reserves });
	loaded.page.self = { query };
	loaded.page.grid = loaded.grid;
	loaded.page.setPagePosition = function() {};
	loaded.page.getPagePosition = function() { return 0; };
	loaded.page.drawMain();
	return loaded;
}

const program = (id, fields = {}) => ({
	id, title: 'Fixture', fullTitle: 'Fixture', detail: '', subTitle: '', start: id,
	seconds: 1800, flags: [], category: 'アニメ', channel: { id: 'ch', name: 'Channel', type: 'GR' },
	...fields
});

describe('WUI stable rule UID reserve association', function() {
	it('uses strict UID association across index changes and falls back only for UID-less legacy rules', function() {
		const rules = [{ ruleUid: 'UID-B' }, { ruleUid: 'UID-A' }];
		const reserves = [
			...Array.from({ length: 20 }, (_unused, index) => program('old-' + index, { ruleId: 1 })),
			program('uid-b', { ruleId: 1, ruleUid: 'UID-B' }),
			program('uid-a', { ruleId: 1, ruleUid: 'UID-A' })
		];
		const rows = renderRules(rules, reserves);

		// UID-B is now at index 0; old index-1 reservations must not inflate its count.
		assert.match(rows[0].cell.reserve_count.html, /ruleUid=UID-B/);
		assert.match(rows[0].cell.reserve_count.html, />1<\/a>/);
		assert.doesNotMatch(rows[0].cell.reserve_count.html, /(?:\?|&)rule=0(?:&|')/);

		const uidFiltered = renderReserves(reserves, { page: '1', ruleUid: 'UID-B', rule: '1' });
		assert.equal(uidFiltered.page.getMaxPagePosition(), 0);
		assert.deepEqual(uidFiltered.rows.map(row => row.data.id), ['uid-b']);
		uidFiltered.page.app = { pm: {} };
		uidFiltered.page.updatePageHash();
		assert.match(uidFiltered.page.app.pm._lastHash, /ruleUid=UID-B/);
		assert.doesNotMatch(uidFiltered.page.app.pm._lastHash, /(?:\?|&)rule=/);

		const legacyRules = [{}, {}];
		const legacyReserves = [program('legacy-1', { ruleId: 1 }), program('legacy-2', { ruleId: 1 })];
		const legacyRows = renderRules(legacyRules, legacyReserves);
		assert.match(legacyRows[1].cell.reserve_count.html, /rule=1/);
		assert.match(legacyRows[1].cell.reserve_count.html, />2<\/a>/);

		const legacyFiltered = renderReserves(reserves, { page: '1', rule: '1' });
		assert.equal(legacyFiltered.page.getMaxPagePosition(), 0);
		assert.deepEqual(legacyFiltered.rows.map(row => row.data.id), reserves.filter(row => row.ruleId === 1).map(row => row.id));
		const legacyList = renderReserves(legacyReserves, { page: '1', rule: '1' });
		assert.deepEqual(legacyList.rows.map(row => row.data.id), ['legacy-1', 'legacy-2']);
	});
});
