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
		document.observe('chinachu:recorded', this.onNotify);

		return this;
	}
	,
	deinit: function() {
		sakura.shortcut.remove("Left");
		sakura.shortcut.remove("Right");
		document.stopObserving('chinachu:recorded', this.onNotify);

		return this;
	}
	,
	refresh: function() {

		this.app.pm.realizeHash(true);

		return this;
	}
	,
	initToolbar: function _initToolbar() {

		this.view.toolbar.add({
			key: 'search',
			ui : new sakura.ui.Button({
				label  : '録画番組検索',
				icon   : './icons/magnifier-zoom.png',
				onClick: this.viewSearchModal.bind(this)
			})
		});

		return this;
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
	isMatchedSearchProgram: function(program) {

		var nf;
		var queryTitleNorm;
		var queryDescNorm;

		if (!program) {
			return false;
		}

		if (this.self.query.pgid && this.self.query.pgid !== program.id) return false;
		if (this.self.query.chid && this.self.query.chid !== program.channel.id) return false;
		if (this.self.query.cat && this.self.query.cat !== program.category) return false;
		if (this.self.query.type && this.self.query.type !== program.channel.type) return false;

		if (global.chinachu.status.feature) {
			nf = global.chinachu.status.feature.normalizationForm;
		}

		if (nf) {
			if (this.self.query.title) {
				queryTitleNorm = this.self.query.title.normalize(nf);
				if (program.title.normalize(nf).match(queryTitleNorm) === null) return false;
			}

			if (this.self.query.desc) {
				queryDescNorm = this.self.query.desc.normalize(nf);
				if (!program.detail || program.detail.normalize(nf).match(queryDescNorm) === null) return false;
			}
		} else {
			if (this.self.query.title && program.title.match(this.self.query.title) === null) return false;
			if (this.self.query.desc && (!program.detail || program.detail.match(this.self.query.desc) === null)) return false;
		}

		if (this.self.query.start || this.self.query.end) {
			var ruleStart = parseInt(this.self.query.start || 0, 10);
			var ruleEnd   = parseInt(this.self.query.end || 24, 10);

			var progStart = new Date(program.start).getHours();
			var progEnd   = new Date(program.end).getHours();

			if (progStart > progEnd) {
				progEnd += 24;
			}

			if (ruleStart > ruleEnd) {
				if ((ruleStart > progStart) && (ruleEnd < progEnd)) return false;
			} else {
				if ((ruleStart > progStart) || (ruleEnd < progEnd)) return false;
			}
		}

		return true;
	}
	,
	getFilteredProgramCount: function() {

		var count = 0;
		var program;

		for (var i = 0, l = global.chinachu.recorded.length; i < l; i++) {
			program = global.chinachu.recorded[i];

			if (this.isMatchedSearchProgram(program)) {
				count++;
			}
		}

		return count;
	}
	,
	getMaxPagePosition: function() {

		var count = this.getFilteredProgramCount();
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

		this.self.query.page = (pagePosition + 1).toString(10);

		this.app.pm._lastHash = '!/recorded/search/' + Object.toQueryString(this.self.query) + '/';
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
			}.bind(this),
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

		if (!this.self.query.skip) {
			this.viewSearchModal();
		} else {
			this.drawMain();
		}

		return this;
	}
	,
	drawMain: function() {

		var rows = [];

		var programs = [];

		var program;

		// 正規化方法
		var nf;
		if (global.chinachu.status.feature) {
			nf = global.chinachu.status.feature.normalizationForm;
		}

		// query.title, query.descの正規化をキャッシュ
		var query_title_norm, query_desc_norm;
		if (nf) {
			if (this.self.query.title) {
				query_title_norm = this.self.query.title.normalize(nf);
			}
			if (this.self.query.desc) {
				query_desc_norm = this.self.query.desc.normalize(nf);
			}
		}

		for (var i = 0, l = global.chinachu.recorded.length; i < l; i++) {
			program = global.chinachu.recorded[i];

			if (this.self.query.pgid && this.self.query.pgid !== program.id) continue;
			if (this.self.query.chid && this.self.query.chid !== program.channel.id) continue;
			if (this.self.query.cat && this.self.query.cat !== program.category) continue;
			if (this.self.query.type && this.self.query.type !== program.channel.type) continue;
			if (nf) {
				if (this.self.query.title && program.title.normalize(nf).match(query_title_norm) === null) continue;
				if (this.self.query.desc && (!program.detail || program.detail.normalize(nf).match(query_desc_norm) === null)) continue;
			}
			else {
				if (this.self.query.title && program.title.match(this.self.query.title) === null) continue;
				if (this.self.query.desc && (!program.detail || program.detail.match(this.self.query.desc) === null)) continue;
			}

			if (this.self.query.start || this.self.query.end) {
				var ruleStart = parseInt(this.self.query.start || 0, 10);
				var ruleEnd   = parseInt(this.self.query.end || 24, 10);

				var progStart = new Date(program.start).getHours();
				var progEnd   = new Date(program.end).getHours();

				if (progStart > progEnd) {
					progEnd += 24;
				}

				if (ruleStart > ruleEnd) {
					if ((ruleStart > progStart) && (ruleEnd < progEnd)) continue;
				} else {
					if ((ruleStart > progStart) || (ruleEnd < progEnd)) continue;
				}
			}

			programs.push(program);
		}

		programs.sort(function(a, b) {
			return a.start - b.start;
		});

		programs.each(function(program, i) {

			var row = {
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
						label   : '削除...',
						icon    : './icons/cross-script.png',
						onSelect: function() {
							new chinachu.ui.RemoveRecordedProgram(program.id);
						}
					},
					'------------------------------------------',
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
			if (typeof program.episode !== 'undefined' && program.episode !== null) {
				titleHtml += '<span class="episode">#' + program.episode + '</span>';
			}
			titleHtml += '<span class="id">#' + program.id + '</span>';

			row.cell.title = {
				sortAlt    : program.title + (program.episode || 0).toString(36),
				html       : titleHtml,
				attribute  : {
					title: program.detail
				}
			};

			row.cell.duration = {
				sortAlt    : program.seconds,
				text       : program.seconds / 60 + 'm'
			};

			row.cell.datetime = {
				sortAlt    : program.start,
				text       : chinachu.dateToString(new Date(program.start))
			};

			rows.push(row);
		});

		this.setPagePosition(this.getPagePosition(), false);

		this.grid.splice(0, null, rows);

		return this;
	}
	,
	viewSearchModal: function() {

		var modal = new flagrate.Modal({
			title  : '録画番組検索',
			buttons: [
				{
					label   : '検索',
					className: 'primary-teal',
					onSelect: function(e, modal) {
						e.targetButton.disable();

						var result = viewSearchForm.result();

						this.self.query = Object.extend(this.self.query, result);
						this.self.query.skip = 1;
						this.self.query.page = 1;

						modal.close();

						window.location.hash = '!/recorded/search/' + Object.toQueryString(this.self.query) + '/';
						//todo
					}.bind(this)
				}
			]
		}).show();

		var viewSearchForm = new Hyperform({
			formWidth  : '100%',
			labelWidth : '100px',
			labelAlign : 'right',
			fields     : [
				{
					key   : 'cat',
					label : 'カテゴリー',
					input : {
						type : 'pulldown',
						items: (function() {
							var array = [];

							[
								'anime', 'information', 'news', 'sports',
								'variety', 'drama', 'music', 'cinema', 'etc'
							].each(function(a) {
								array.push({
									label     : a,
									value     : a,
									isSelected: (this.self.query.cat === a)
								});
							}.bind(this));

							return array;
						}.bind(this))()
					}
				},
				{
					key   : 'title',
					label : 'タイトル',
					input : {
						type : 'text',
						value: this.self.query.title || ''
					}
				},
				{
					key   : 'desc',
					label : '説明',
					input : {
						type : 'text',
						value:  this.self.query.desc || ''
					}
				},
				{
					key   : 'type',
					label : 'タイプ',
					input : {
						type : 'pulldown',
						items: (function() {
							var array = [];

							['GR', 'BS', 'CS', 'SKY'].each(function(a) {
								array.push({
									label     : a,
									value     : a,
									isSelected: ((this.self.query.type || []).indexOf(a) !== -1)
								});
							}.bind(this));

							return array;
						}.bind(this))()
					}
				},
				{
					key   : 'start',
					label : '何時から',
					input : {
						type      : 'text',
						width     : 25,
						maxlength : 2,
						appendText: '時',
						value   : this.self.query.start || '',
						isNumber: true
					}
				},
				{
					key   : 'end',
					label : '何時まで',
					input : {
						type      : 'text',
						width     : 25,
						maxlength : 2,
						appendText: '時',
						value     : this.self.query.end || '',
						isNumber  : true
					}
				},
				{
					key   : 'pgid',
					label : 'プログラムID',
					input : {
						type : 'text',
						value:  this.self.query.pgid || ''
					}
				},
				{
					key   : 'chid',
					label : 'チャンネルID',
					input : {
						type : 'text',
						value:  this.self.query.chid || ''
					}
				}
			]
		}).render(modal.content);

		return this;
	}
});
