P = Class.create(P, {

	init: function() {

		this.view.content.className = 'loading';

		this.initToolbar();
		this.draw();

	this.onPageLeft = function() {
		this.movePage(-1);
	}.bind(this);

	this.onPageRight = function() {
		this.movePage(1);
	}.bind(this);

		sakura.shortcut.add("Left", this.onPageLeft, {
			protectInput: true
		});

		sakura.shortcut.add("Right", this.onPageRight, {
			protectInput: true
		});

		this.onNotify = this.refresh.bindAsEventListener(this);
		document.observe('chinachu:reserves', this.onNotify);

		return this;
	}
	,
	deinit: function() {

		sakura.shortcut.remove("Left");
		sakura.shortcut.remove("Right");

		document.stopObserving('chinachu:reserves', this.onNotify);

		return this;
	}
	,
	refresh: function() {

		this.drawMain();

		return this;
	}
	,
	initToolbar: function _initToolbar() {

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

				var filterRuleId = this.self.query.rule;
		var count = 0;

		for (var i = 0, l = global.chinachu.reserves.length; i < l; i++) {
			if (typeof filterRuleId !== 'undefined'
				&& (typeof global.chinachu.reserves[i].ruleId === 'undefined' || String(global.chinachu.reserves[i].ruleId) !== String(filterRuleId))) {
				continue;
			}

			count++;
		}
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
		var queryParams = [];

		queryParams.push('page=' + page);

		if (this.self.query.rule) {
			queryParams.push('rule=' + encodeURIComponent(this.self.query.rule));
		}

		this.app.pm._lastHash = '!/reserves/list/' + '?' + queryParams.join('&');
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
					key  : 'category',
					label: 'ジャンル',
					width: 70,
					align: 'center',
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
				window.location.href = '#!/program/view/id=' + row.data.id + '/';
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
	drawMain: function() {
        var filterRuleId = this.self.query.rule;
		var rows = [];

		var programs = [];

		for (var i = 0, l = global.chinachu.reserves.length; i < l; i++) {
			programs.push(global.chinachu.reserves[i]);
		}

		programs.sort(function(a, b) {
			return a.start - b.start;
		});

		programs.each(function(program, i) {
	        if (typeof filterRuleId !== 'undefined' && ( typeof program.ruleId === 'undefined' || String(program.ruleId) !== String(filterRuleId))) {
		        return;
	        }
			var row = {
				className: '',
				data: program,
				cell: {
					id: {
						className: 'id',
						sortAlt  : i,
						text     : program.id
					}
				},
				menuItems: [
					{
						label   : 'ルール作成...',
						icon    : './icons/regular-expression.png',
						onSelect: function() {
							new chinachu.ui.CreateRuleByProgram(program.id);
						}
					},
					'------------------------------------------',
					{
						label   : 'ツイート...',
						icon    : 'https://abs.twimg.com/favicons/favicon.ico',
						onSelect: function() {
							var left = (screen.width - 640) / 2;
							var top  = (screen.height - 265) / 2;

							var tweetWindow = window.open(
								'https://twitter.com/share?url=&text=' + encodeURIComponent(chinachu.util.scotify(program)),
								'chinachu-tweet-' + program.id,
								'width=640,height=265,left=' + left + ',top=' + top + ',menubar=no'
							);
						}
					},
					'------------------------------------------',
					{
						label   : 'SCOT形式でコピー...',
						onSelect: function(e) {
							chinachu.ui.copyStr(chinachu.util.scotify(program));
						}
					},
					{
						label   : 'IDをコピー...',
						onSelect: function() {
							chinachu.ui.copyStr(program.id);
						}
					},
					{
						label   : 'タイトルをコピー...',
						onSelect: function() {
							chinachu.ui.copyStr(program.title);
						}
					},
					{
						label   : '説明をコピー...',
						onSelect: function() {
							chinachu.ui.copyStr(program.detail);
						}
					},
					'------------------------------------------',
					{
						label   : '関連サイト',
						icon    : './icons/document-page-next.png',
						onSelect: function() {
							window.open("https://www.google.com/search?btnI=I'm+Feeling+Lucky&q=" + program.title);
						}
					},
					{
						label   : 'Google検索',
						icon    : './icons/ui-search-field.png',
						onSelect: function() {
							window.open("https://www.google.com/search?q=" + program.title);
						}
					},
					{
						label   : 'Wikipedia',
						icon    : './icons/book-open-text-image.png',
						onSelect: function() {
							window.open("https://ja.wikipedia.org/wiki/" + program.title);
						}
					}
				]
			};

			row.cell.type = {
				sortAlt  : program.channel.type,
				className: 'types',
				html     : '<span class="label-type-' + program.channel.type + '">' + program.channel.type + '</span>'
			};

			row.cell.category = {
				sortAlt    : program.category,
				className  : 'categories',
				html       : '<span class="label-cat-' + program.category + '">' + program.category + '</span>'
			};

			row.cell.channel = {
				sortAlt    : program.channel.id,
				text       : program.channel.name,
				attribute  : {
					title: program.channel.id
				}
			};

			var titleHtml = program.flags.invoke('sub', /.+/, '<span class="flag #{0}">#{0}</span>').join('') + program.title;
			if (program.subTitle && program.title.indexOf(program.subTitle) === -1) {
				titleHtml += '<span class="subtitle">' + program.subTitle + '</span>';
			}
			if (typeof program.episode !== 'undefined' && program.episode !== null) {
				titleHtml += '<span class="episode">#' + program.episode + '</span>';
			}
			titleHtml += '<span class="id">#' + program.id + '</span>';

			row.menuItems.unshift('--');
			if (program.isManualReserved) {
				titleHtml = '<span class="flag manual">手動</span>' + titleHtml;

				row.menuItems.unshift({
					label   : '予約取消...',
					icon    : './icons/cross-script.png',
					onSelect: function() {
						new chinachu.ui.Unreserve(program.id);
					}
				});
			} else {
				if (program.isSkip) {
					titleHtml = '<span class="flag skip">スキップ</span>' + titleHtml;
					row.className += ' disabled';

					row.menuItems.unshift({
						label   : 'スキップの取消...',
						icon    : './icons/tick-circle.png',
						onSelect: function() {
							new chinachu.ui.Unskip(program.id);
						}
					});
				} else {
					row.menuItems.unshift({
						label   : 'スキップ...',
						icon    : './icons/exclamation-red.png',
						onSelect: function() {
							new chinachu.ui.Skip(program.id);
						}
					});
				}
			}
			if (program.isConflict) {
				titleHtml = '<span class="flag conflict">競合</span>' + titleHtml;
				row.className += ' disabled';
			}

			row.cell.title = {
				sortAlt    : program.title,
				html       : titleHtml,
				attribute  : {
					title: program.fullTitle + ' - ' + program.detail
				}
			};

			row.cell.duration = {
				sortAlt    : program.seconds,
				text       : program.seconds / 60 + 'm'
			};

			row.cell.datetime = {
				sortAlt    : program.start,
				element    : new chinachu.ui.DynamicTime({
					tagName: 'div',
					type   : 'full',
					time   : program.start
				}).entity
			};

			rows.push(row);
		});

		this.setPagePosition(this.getPagePosition(), false);

		this.grid.splice(0, void 0, rows);

		return this;
	}
});
