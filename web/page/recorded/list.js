P = Class.create(P, {

	init: function() {

		this.view.content.className = 'loading';

		this.matchItems = [];
		this.matchLoaded = false;
		this.matchApiUrl = './api/match.json';

		this.initToolbar();
		this.draw();
		this.loadMatches();

		this.onPageLeft = function() {
			this.movePage(-1);
		}.bind(this);

		this.onPageRight = function() {
			this.movePage(1);
		}.bind(this);

		sakura.shortcut.add('Left', this.onPageLeft, {
			protectInput: true
		});

		sakura.shortcut.add('Right', this.onPageRight, {
			protectInput: true
		});

		this.onNotify = this.refresh.bindAsEventListener(this);
		document.observe('chinachu:recorded', this.onNotify);
		document.observe('chinachu:reserves', this.onNotify);

		return this;
	}
	,
	deinit: function() {
		sakura.shortcut.remove('Left');
		sakura.shortcut.remove('Right');

		document.stopObserving('chinachu:recorded', this.onNotify);
		document.stopObserving('chinachu:reserves', this.onNotify);

		return this;
	}
	,
	refresh: function() {

		this.loadMatches();

		return this;
	}
	,
	loadMatches: function() {

		new Ajax.Request(this.matchApiUrl, {
			method: 'get',
			onSuccess: function(t) {
				var json;

				try {
					json = t.responseText.evalJSON();
				} catch (e) {
					json = [];
				}

				if (!Object.isArray(json)) {
					json = [];
				}

				this.matchItems = json;
				this.matchLoaded = true;
				this.drawMain();
			}.bind(this),
			onFailure: function() {
				this.matchItems = [];
				this.matchLoaded = true;
				this.drawMain();
			}.bind(this)
		});

		return this;
	}
	,
	initToolbar: function _initToolbar() {

		this.view.toolbar.add({
			key: 'match-result-ng',
			ui : flagrate.createCheckbox({
				label: 'NG',
				onChange: function(e) {
					this.toggleMatchResultKind('NG', e.targetCheckbox.isChecked());
				}.bind(this)
			})
		});

		this.view.toolbar.add({
			key: 'match-result-recorded',
			ui : flagrate.createCheckbox({
				label: '録画済',
				onChange: function(e) {
					this.toggleMatchResultKind('RECORDED', e.targetCheckbox.isChecked());
				}.bind(this)
			})
		});

		this.view.toolbar.add({
			key: 'match-result-skipped',
			ui : flagrate.createCheckbox({
				label: 'スキップ',
				onChange: function(e) {
					this.toggleMatchResultKind('SKIPPED', e.targetCheckbox.isChecked());
				}.bind(this)
			})
		});

		this.view.toolbar.add({
			key: 'reload-match-results',
			ui : new sakura.ui.Button({
				label  : '再読込',
				icon   : './icons/arrow-circle-double.png',
				onClick: function() {
					this.refresh();
				}.bind(this)
			})
		});

		this.syncMatchResultFilterToolbar();

		return this;
	}
	,
	getVisibleMatchResultKinds: function() {

		var kinds;

		try {
			kinds = JSON.parse(localStorage.getItem('recorded.match.visible.results') || '["NG","RECORDED"]');
		} catch (e) {
			kinds = ['NG', 'RECORDED'];
		}

		if (!Object.isArray(kinds)) {
			kinds = ['NG', 'RECORDED'];
		}

		return kinds;
	}
	,
	toggleMatchResultKind: function(kind, checked) {

		var kinds = this.getVisibleMatchResultKinds();

		if (checked) {
			if (kinds.indexOf(kind) === -1) {
				kinds.push(kind);
			}
		} else {
			kinds = kinds.without(kind);
		}

		localStorage.setItem('recorded.match.visible.results', JSON.stringify(kinds));
		this.setPagePosition(0, false);
		this.syncMatchResultFilterToolbar();
		this.drawMain();

		return this;
	}
	,
	syncMatchResultFilterToolbar: function() {

		var kinds = this.getVisibleMatchResultKinds();

		if (this.view.toolbar.one('match-result-ng')) {
			if (kinds.indexOf('NG') !== -1) {
				this.view.toolbar.one('match-result-ng').check();
			} else {
				this.view.toolbar.one('match-result-ng').uncheck();
			}
		}

		if (this.view.toolbar.one('match-result-recorded')) {
			if (kinds.indexOf('RECORDED') !== -1) {
				this.view.toolbar.one('match-result-recorded').check();
			} else {
				this.view.toolbar.one('match-result-recorded').uncheck();
			}
		}

		if (this.view.toolbar.one('match-result-skipped')) {
			if (kinds.indexOf('SKIPPED') !== -1) {
				this.view.toolbar.one('match-result-skipped').check();
			} else {
				this.view.toolbar.one('match-result-skipped').uncheck();
			}
		}

		return this;
	}
	,
	updateToolbar: function() {

		if (!this.grid) return;

		var selected = this.grid.getSelectedRows();

		if (selected.length === 0) {

		} else if (selected.length === 1) {

		} else {

		}
	}
	,
	getRowsPerPage: function() {

		return 25;
	}
	,
	getPagePosition: function() {

		var page = 1;

		if (this.self.query && typeof this.self.query.page !== 'undefined') {
			page = parseInt(this.self.query.page, 10);
		}

		if (isNaN(page) || page < 1) {
			page = 1;
		}

		return page - 1;
	}
	,
	getMaxPagePosition: function() {

		var count = this.getVisibleMatchItems().length;
		var rowsPerPage = this.getRowsPerPage();
		var maxPagePosition = Math.ceil(count / rowsPerPage) - 1;

		if (isNaN(maxPagePosition) || maxPagePosition < 0) {
			maxPagePosition = 0;
		}

		return maxPagePosition;
	}
	,
	updatePageHash: function() {

		var pagePosition = this.getPagePosition();
		var page = pagePosition + 1;

		this.app.pm._lastHash = '!/recorded/list/page=' + page + '/';
		history.replaceState(null, null, '#' + this.app.pm._lastHash);

		return this;
	}
	,
	setPagePosition: function(pagePosition, redraw) {

		var maxPagePosition = this.getMaxPagePosition();

		pagePosition = parseInt(pagePosition, 10);

		if (isNaN(pagePosition) || pagePosition < 0) {
			pagePosition = 0;
		}

		if (pagePosition > maxPagePosition) {
			pagePosition = maxPagePosition;
		}

		this.self.query.page = (pagePosition + 1).toString(10);

		if (this.grid) {
			this.grid._pagePosition = pagePosition;
		}

		this.updatePageHash();

		if (redraw) {
			this.drawMain();
		}

		return this;
	}
	,
	movePage: function(delta) {

		var currentPagePosition = this.getPagePosition();
		var nextPagePosition;

		if (this.grid && typeof this.grid._pagePosition !== 'undefined') {
			currentPagePosition = parseInt(this.grid._pagePosition, 10);

			if (isNaN(currentPagePosition) || currentPagePosition < 0) {
				currentPagePosition = this.getPagePosition();
			}
		}

		nextPagePosition = currentPagePosition + delta;

		if (nextPagePosition < 0) {
			nextPagePosition = 0;
		}

		if (nextPagePosition > this.getMaxPagePosition()) {
			nextPagePosition = this.getMaxPagePosition();
		}

		if (nextPagePosition === currentPagePosition) {
			return false;
		}

		this.setPagePosition(nextPagePosition, true);

		return true;
	}
	,
	draw: function() {

		this.view.content.className = '';
		this.view.content.update();

		this.grid = new flagrate.Grid({
			multiSelect  : false,
			disableSelect: true,
			pagination   : true,
			numberOfRowsPerPage: this.getRowsPerPage(),
			fill         : true,
			cols: [
				{
					key  : 'type',
					label: '放送波',
					width: 45,
					align: 'center',
					disableResize: true
				},
				{
					key  : 'channel',
					label: 'チャンネル',
					width: 140
				},
				{
					key  : 'result',
					label: '結果',
					width: 78,
					align: 'center'
				},
				{
					key  : 'title',
					label: 'タイトル'
				},
				{
					key  : 'datetime',
					label: '放送日時',
					width: 210
				},
				{
					key  : 'duration',
					label: '長さ',
					width: 60
				}
			],
			onClick: function(e, row) {
				if (row.data._matchItem && row.data._matchItem.key) {
					window.location.href = '#!/program/view/key=' + encodeURIComponent(row.data._matchItem.key) + '/';
					return;
				}

				if (row.data.id) {
					window.location.href = '#!/program/view/id=' + row.data.id + '/';
				}
			},
			onRendered: function() {
				var pagePosition = parseInt(this.grid._pagePosition, 10);

				if (isNaN(pagePosition) || pagePosition < 0) {
					pagePosition = 0;
				}

				this.self.query.page = (pagePosition + 1).toString(10);
				this.updatePageHash();
			}.bind(this)
		}).insertTo(this.view.content);

		this.setPagePosition(this.getPagePosition(), false);

		this.drawMain();

		return this;
	}
	,
	getMatchProgram: function(item) {

		/*
		 * match.json merged schema:
		 *   program          = display/search program snapshot
		 *   recordingResult  = recorded result/file information
		 *   reservationMeta  = reserve metadata
		 *
		 * Older schema fallback is kept for safe rollback.
		 */
		return item.program || item.recorded || item.reserve || {};
	}
	,
	getMatchEnd: function(item) {

		var program = this.getMatchProgram(item);
		var start = program.start || 0;
		var seconds = program.seconds || 0;

		return program.end || (start + (seconds * 1000));
	}
	,
	isPastMatch: function(item) {

		var end = this.getMatchEnd(item);

		/*
		 * Only finalized programmes should be shown as results.
		 * A programme currently on-air must stay hidden even if match.json
		 * already contains MISSED/NG-like status due to a generation timing gap.
		 */
		return end > 0 && Date.now() > end;
	}
	,
	getMatchKind: function(item) {

		if (item.status === 'RECORDED') {
			return this.isPastMatch(item) ? 'RECORDED' : null;
		}

		if (item.status === 'SKIPPED_ONLY' || (item.recd_flg && item.recd_flg.isSkip === true)) {
			return this.isPastMatch(item) ? 'SKIPPED' : null;
		}

		if (item.status === 'MISSED') {
			return this.isPastMatch(item) ? 'NG' : null;
		}

		if (!this.isPastMatch(item)) {
			return null;
		}

		if (item.recd_flg &&
				item.recd_flg.hasReserve === true &&
				item.recd_flg.hasRecorded === false &&
				item.recd_flg.isSkip === false) {
			return 'NG';
		}

		if (item.status && item.status !== 'RESERVED') {
			return 'NG';
		}

		return null;
	}
	,
	getVisibleMatchItems: function() {

		var visibleKinds = this.getVisibleMatchResultKinds();

		return (this.matchItems || []).filter(function(item) {
			var kind = this.getMatchKind(item);

			return kind !== null && visibleKinds.indexOf(kind) !== -1;
		}.bind(this));
	}
	,
	findRecordedProgram: function(item) {

		var program = this.getMatchProgram(item);
		var result = item.recordingResult || item.recorded || {};
		var id = result.id || result.recordedId || result.origId || program.id || program.origId || null;
		var start = result.start || program.start || 0;
		var seconds = result.seconds || program.seconds || 0;
		var channel = result.channel || program.channel || item.channel || {};
		var i, l, recorded;

		if (!global.chinachu || !global.chinachu.recorded) {
			return null;
		}

		for (i = 0, l = global.chinachu.recorded.length; i < l; i++) {
			recorded = global.chinachu.recorded[i];

			if (id && recorded.id === id) {
				return recorded;
			}

			if (start === recorded.start &&
					seconds === recorded.seconds &&
					channel && recorded.channel &&
					channel.id === recorded.channel.id) {
				return recorded;
			}
		}

		return null;
	}
	,
	normalizeMatchItem: function(item) {

		var kind = this.getMatchKind(item);
		var program = this.getMatchProgram(item);
		var result = item.recordingResult || item.recorded || {};
		var recordedProgram = kind === 'RECORDED' ? this.findRecordedProgram(item) : null;
		var source = program || {};
		var channel = item.channel || source.channel || {};
		var end = this.getMatchEnd(item);
		var id = source.id || source.origId || source.programId || result.id || result.recordedId || result.origId || null;
		var recordedId = result.id || result.recordedId || result.origId || (recordedProgram && recordedProgram.id) || null;
		var viewId = kind === 'RECORDED' ? ((recordedProgram && recordedProgram.id) || recordedId || id) : null;
		var seconds = source.seconds || result.seconds || 0;

		if (!seconds && source.start && end) {
			seconds = Math.floor((end - source.start) / 1000);
		}

		return {
			id              : id,
			_viewId         : viewId,
			_recordedId     : recordedId,
			_matchItem      : item,
			_matchKind      : kind,
			start           : source.start || result.start || 0,
			end             : source.end || result.end || end,
			seconds         : seconds,
			title           : source.title || result.title || '-',
			fullTitle       : source.fullTitle || source.title || result.title || '-',
			detail          : source.detail || '',
			flags           : source.flags || [],
			subTitle        : source.subTitle,
			episode         : source.episode,
			category        : source.category || null,
			recordingResult : result,
			reservationMeta : item.reservationMeta || {},
			channel         : {
				id  : channel.id || '-',
				name: channel.name || '-',
				type: channel.type || '-',
				sid : channel.sid,
				nid : channel.nid
			},
			isManualReserved: source.isManualReserved || false
		};
	}
	,
	getResultLabel: function(kind) {

		switch (kind) {
		case 'RECORDED':
			return '録画済';
		case 'SKIPPED':
			return 'スキップ';
		case 'NG':
			return 'NG';
		default:
			return kind || '-';
		}
	}
	,
	getResultLabelHtml: function(kind) {

		var label = this.getResultLabel(kind);

		if (kind === 'SKIPPED') {
			return '<span class="match-result-label flag skip">' + label.escapeHTML() + '</span>';
		}

		var cls = 'match-result-label match-result-' + (kind || 'unknown').toLowerCase();

		return '<span class="' + cls + '">' + label.escapeHTML() + '</span>';
	}
	,
	buildMenuItems: function(program) {

		var items = [];

		if (program._matchKind === 'RECORDED' && program._recordedId) {
			items.push({
				label   : '削除...',
				icon    : './icons/cross-script.png',
				onSelect: function() {
					new chinachu.ui.RemoveRecordedProgram(program._recordedId);
				}
			});
			items.push('------------------------------------------');
		}

		if (program.id) {
			items.push({
				label   : 'ルール作成...',
				icon    : './icons/regular-expression.png',
				onSelect: function() {
					new chinachu.ui.CreateRuleByProgram(program.id);
				}
			});
			items.push('------------------------------------------');
		}

		items.push({
			label   : 'タイトルをコピー...',
			onSelect: function() {
				chinachu.ui.copyStr(program.title);
			}
		});

		if (program.detail) {
			items.push({
				label   : '説明をコピー...',
				onSelect: function() {
					chinachu.ui.copyStr(program.detail);
				}
			});
		}

		if (program.id) {
			items.push({
				label   : 'IDをコピー...',
				onSelect: function() {
					chinachu.ui.copyStr(program.id);
				}
			});
		}

		items.push('------------------------------------------');
		items.push({
			label   : '関連サイト',
			icon    : './icons/document-page-next.png',
			onSelect: function() {
				window.open("https://www.google.com/search?btnI=I'm+Feeling+Lucky&q=" + program.title);
			}
		});
		items.push({
			label   : 'Google検索',
			icon    : './icons/ui-search-field.png',
			onSelect: function() {
				window.open('https://www.google.com/search?q=' + program.title);
			}
		});
		items.push({
			label   : 'Wikipedia',
			icon    : './icons/book-open-text-image.png',
			onSelect: function() {
				window.open('https://ja.wikipedia.org/wiki/' + program.title);
			}
		});

		return items;
	}
	,
	drawMain: function() {

		var rows = [];
		var programs = [];

		this.syncMatchResultFilterToolbar();

		this.getVisibleMatchItems().forEach(function(item) {
			programs.push(this.normalizeMatchItem(item));
		}.bind(this));

		programs.sort(function(a, b) {
			return b.start - a.start;
		});

		programs.each(function(program, i) {

			var flags = program.flags || [];
			var row = {
				data: program,
				cell: {
					id: {
						className: 'id',
						sortAlt  : i,
						text     : program.id || ''
					}
				},
				menuItems: this.buildMenuItems(program)
			};

			row.cell.type = {
				sortAlt  : program.channel.type,
				className: 'types',
				html     : '<span class="label-type-' + program.channel.type + '">' + program.channel.type + '</span>'
			};

			row.cell.result = {
				sortAlt    : program._matchKind,
				className  : 'match-result',
				html       : this.getResultLabelHtml(program._matchKind)
			};

			row.cell.channel = {
				sortAlt    : program.channel.id,
				text       : program.channel.name,
				attribute  : {
					title: program.channel.id
				}
			};

			var titleHtml = '';

			if (flags.invoke) {
				titleHtml += flags.invoke('sub', /.+/, '<span class="flag #{0}">#{0}</span>').join('');
			}

			titleHtml += program.title.escapeHTML ? program.title.escapeHTML() : program.title;

			if (program.subTitle && program.title.indexOf(program.subTitle) === -1) {
				titleHtml += '<span class="subtitle">' + program.subTitle.escapeHTML() + '</span>';
			}
			if (typeof program.episode !== 'undefined' && program.episode !== null) {
				titleHtml += '<span class="episode">#' + program.episode + '</span>';
			}
			if (program.id) {
				titleHtml += '<span class="id">#' + program.id + '</span>';
			}

			if (program._matchKind !== 'RECORDED') {
				titleHtml = '<span class="match-no-link">' + titleHtml + '</span>';
			}

			if (program.isManualReserved) {
				titleHtml = '<span class="flag manual">手動</span>' + titleHtml;
			}

			row.cell.title = {
				sortAlt    : program.title + (program.episode || 0).toString(36),
				html       : titleHtml,
				attribute  : {
					title: program.fullTitle + (program.detail ? ' - ' + program.detail : '')
				}
			};

			row.cell.duration = {
				sortAlt    : program.seconds,
				text       : Math.round(program.seconds / 60) + 'm'
			};

			row.cell.datetime = {
				sortAlt    : program.start,
				text       : program.start ? chinachu.dateToString(new Date(program.start)) : '-'
			};

			rows.push(row);
		}.bind(this));

		this.setPagePosition(this.getPagePosition(), false);

		this.grid.splice(0, void 0, rows);

		return this;
	}
});
