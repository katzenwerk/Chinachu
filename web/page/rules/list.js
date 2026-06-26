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
		document.observe('chinachu:rules', this.onNotify);
		document.observe('chinachu:reserves', this.onNotify);

		return this;
	}
	,
	deinit: function() {

		sakura.shortcut.remove("Left");
		sakura.shortcut.remove("Right");

		document.stopObserving('chinachu:rules', this.onNotify);
		document.stopObserving('chinachu:reserves', this.onNotify);

		return this;
	}
	,
	refresh: function() {

		this.drawMain();

		return this;
	}
	,
	getPageNumber: function() {

		var page = 1;
		var match;

		if (this.self.query && typeof this.self.query.page !== 'undefined') {
			page = parseInt(this.self.query.page, 10) || 1;
		} else {
			match = (window.location.hash || '').match(/(?:[?&]|\/)page=(\d+)/);

			if (match) {
				page = parseInt(match[1], 10) || 1;
			}
		}

		if (page < 1) {
			page = 1;
		}

		return page;
	}
	,
	getGridPagePosition: function() {

		if (!this.grid) {
			return this.getPageNumber() - 1;
		}

		if (typeof this.grid.pagePosition === 'number') {
			return this.grid.pagePosition;
		}

		if (typeof this.grid._pagePosition === 'number') {
			return this.grid._pagePosition;
		}

		return this.getPageNumber() - 1;
	}
	,
	setGridPagePosition: function(pagePosition, render) {

		if (!this.grid) {
			return this;
		}

		pagePosition = parseInt(pagePosition, 10) || 0;

		if (pagePosition < 0) {
			pagePosition = 0;
		}

		this.grid.pagePosition = pagePosition;
		this.grid._pagePosition = pagePosition;

		if (render !== false) {
			if (typeof this.grid._requestRender === 'function') {
				this.grid._requestRender();
			} else if (typeof this.grid._render === 'function') {
				this.grid._render();
			}
		}

		return this;
	}
	,
	updatePageHash: function() {

		var currentPage = this.getGridPagePosition() + 1;

		this.app.pm._lastHash = '!/rules/list/?page=' + currentPage;
		history.replaceState(null, null, '#' + this.app.pm._lastHash);

		return this;
	}
	,
	movePage: function(delta) {

		var currentPosition = this.getGridPagePosition();
		var nextPosition = currentPosition + delta;
		var rowsPerPage = 25;
		var rowCount = global.chinachu.rules ? global.chinachu.rules.length : 0;
		var maxPosition;

		if (!this.grid) {
			return this;
		}

		if (this.grid.numberOfRowsPerPage) {
			rowsPerPage = this.grid.numberOfRowsPerPage;
		}

		maxPosition = Math.max(0, Math.ceil(rowCount / rowsPerPage) - 1);

		if (nextPosition < 0) {
			nextPosition = 0;
		}

		if (nextPosition > maxPosition) {
			nextPosition = maxPosition;
		}

		if (nextPosition === currentPosition) {
			return this;
		}

		/*
		 * flagrate.Grid の内部描画メソッドへ直接触ると版差が出るため、
		 * ルール一覧では page 値を更新してから drawMain() を再実行する。
		 * drawMain() -> _drawMainWithCounts() -> grid.splice() の既存描画経路を使う。
		 */
		if (!this.self.query) {
			this.self.query = {};
		}

		this.self.query.page = (nextPosition + 1).toString(10);
		this.setGridPagePosition(nextPosition, false);
		this.updatePageHash();
		this.drawMain();

		return this;
	}
	,
	initToolbar: function _initToolbar() {

		this.view.toolbar.add({
			key: 'execute-scheduler',
			ui : new sakura.ui.Button({
				label  : 'EXECUTE {0}'.__('SCHEDULER'.__()),
				icon   : './icons/calendar-import.png',
				onClick: function() {
					new chinachu.ui.ExecuteScheduler();
				}.bind(this)
			})
		});

		this.view.toolbar.add({ key: '--', ui: new sakura.ui.Element({ tagName: 'hr' }) });

		this.view.toolbar.add({
			key: 'add',
			ui : new sakura.ui.Button({
				label  : 'ADD'.__(),
				icon   : './icons/plus-circle.png',
				onClick: function() {
					new chinachu.ui.NewRule();
				}.bind(this)
			})
		});

		this.view.toolbar.add({
			key: 'edit',
			ui : new sakura.ui.Button({
				label  : 'EDIT'.__(),
				icon   : './icons/hammer.png',
				onClick: function() {
					new chinachu.ui.EditRule(global.chinachu.rules.indexOf(this.grid.getSelectedRows().first().data));
				}.bind(this)
			}).disable()
		});

		/*this.view.toolbar.add({
			key: 'copy',
			ui : new sakura.ui.Button({
				label  : 'COPY'.__(),
				icon   : './icons/document-copy.png',
				onClick: function() {
					//console.log(this.grid.getSelectedRows().first());
					//new chinachu.ui.CreateRuleByProgram(this.grid.getSelectedRows().first().data.id);
				}.bind(this)
			}).disable()
		});*/

		this.view.toolbar.add({
			key: 'delete',
			ui : new sakura.ui.Button({
				label  : 'DELETE'.__(),
				icon   : './icons/cross-script.png',
				onClick: function() {

					var selected = this.grid.getSelectedRows();
					var nums = [];
					selected.each(function(row) {
						nums.push(global.chinachu.rules.indexOf(row.data));
					});
					nums.sort(function (a, b) {
						return a - b;
					});

					var modal  = new flagrate.Modal({
						title: 'ルール削除',
						text : 'これらの ' + selected.length + ' ルールを削除します',
						buttons: [
							{
								label: '削除',
								color: '@red',
								onSelect: function(e, modal) {

									modal.buttons.each(function(a) {
										a.button.disable();
									});

									main();
								}
							},
							{
								label: 'キャンセル',
								onSelect: function(e, modal) {
									modal.close();
								}
							}
						]
					}).show();

					var main = function() {

						document.stopObserving('chinachu:rules', main);

						if (nums.length === 0) {
							modal.close();
							return;
						}

						var num  = nums.pop();
						console.log(num, nums);

						modal.content.updateText('ルール#' + num.toString(10) + ' を削除しています...');

						new Ajax.Request('./api/rules/' + num.toString(10) + '.json', {
							method    : 'delete',
							onComplete: function() {
								document.observe('chinachu:rules', main);
							},
							onSuccess: function() {

								modal.content.updateText('ルール#' + num.toString(10) + ' を削除しました');
							},
							onFailure: function(t) {

								new flagrate.Modal({
									title: '失敗',
									text : 'ルール#' + num.toString(10) + ' の削除に失敗しました (' + t.status + ')'
								}).show();
							}
						});
					};
				}.bind(this)
			}).disable()
		});

		return this;
	}
	,
	updateToolbar: function() {

		if (!this.grid) return;

		var selected = this.grid.getSelectedRows();

		if (selected.length === 0) {
			this.view.toolbar.one('edit').disable();
			//this.view.toolbar.one('copy').disable();
			this.view.toolbar.one('delete').disable();
		} else if (selected.length === 1) {
			this.view.toolbar.one('edit').enable();
			//this.view.toolbar.one('copy').enable();
			this.view.toolbar.one('delete').enable();
		} else {
			this.view.toolbar.one('edit').disable();
			//this.view.toolbar.one('copy').disable();
		}
	}
	,
	draw: function() {

		this.view.content.className = '';
		this.view.content.update();

		this.grid = new flagrate.Grid({
			multiSelect: true,
			pagination : true,
			numberOfRowsPerPage: 25,
			fill       : true,
			cols: [
				{
					key  : 'n',
					label: '#',
					width: 40,
					disableResize: true
				},
				{
					key  : 'types',
					label: '放送波',
					width: 70
				},
                {   key  : 'reserve_count',
                    label: '予約数',
                    width: 50
                },
				{
					key  : 'categories',
					label: 'ジャンル',
					width: 70
				},
				{
					key  : 'channels',
					label: 'ch',
					width: 70
				},
				{
					key  : 'ignore_channels',
					label: '無視ch',
					width: 70
				},
				{
					key  : 'reserve_flags',
					label: 'フラグ',
					width: 60
				},
				{
					key  : 'ignore_flags',
					label: '無視ﾌﾗｸﾞ',
					width: 60
				},
				{
					key  : 'hour',
					label: '時間帯',
					width: 55
				},
				{
					key  : 'duration',
					label: '長さ(分)',
					width: 70
				},
				{
					key  : 'reserve_titles',
					label: '対象タイトル'
				},
				{
					key  : 'ignore_titles',
					label: '無視タイトル'
				},
				{
					key  : 'reserve_descriptions',
					label: '対象説明文'
				},
				{
					key  : 'ignore_descriptions',
					label: '無視説明文'
				},
				{
					key  : 'allow_end_lack',
					label: '末尾切れ',
					width: 70,
					align: 'center'
				},
				{
					key  : 'recorded_format',
					label: '録画ファイル名フォーマット'
				}
			],
			onSelect  : this.updateToolbar.bind(this),
			onDeselect: this.updateToolbar.bind(this),
			onDblClick: function(e, row) {
				new chinachu.ui.EditRule(global.chinachu.rules.indexOf(row.data));
			}.bind(this),
	onRendered: function () {
		this.updatePageHash();
	}.bind(this)
		}).insertTo(this.view.content);

		this.setGridPagePosition(this.getPageNumber() - 1, false);

		this.drawMain();

		return this;
	}
	,
	drawMain: function() {
        new Ajax.Request('./api/reserves.json', {
	        method: 'get',
	        onSuccess: function(res) {
		        var reserves = res.responseJSON;

		        // ruleIdごとに予約数を集計
		        var reserveCounts = {};
		        var skipCounts = {};
                reserves.forEach(function(r) {
                    if (typeof r.ruleId === 'number' && !r.isSkip) {
                        reserveCounts[r.ruleId] = (reserveCounts[r.ruleId] || 0) + 1;
                    }
                    if (typeof r.ruleId === 'number' && r.iskip ==false) {
                        skipCounts[r.ruleId] = (skipCounts[r.ruleId] || 0) + 1;
                    }

                });

		        // メイン描画処理を別関数に切り出して呼ぶ
		        this._drawMainWithCounts(reserveCounts);
	        }.bind(this)
        });
    }
    ,
	_drawMainWithCounts: function(reserveCounts) {
		var rows = [];

		global.chinachu.rules.each(function(rule, i) {

			var row = {
				data: rule,
				cell: {
					n: {
						sortAlt: i,
						text   : i.toString(10)
					}
				}
			};

			if (rule.isDisabled) row.className = 'disabled';

			if (rule.types) {
				row.cell.types = {
					sortKey  : rule.types[0],
					className: 'types',
					html     : rule.types.invoke('sub', /^(.{1}).*$/, '<span class="label-type-#{0}">#{1}</span>').join('')
				};
			} else {
				row.cell.types = {
					className: 'default',
					sortKey  : 0,
					text     : 'any'
				};
			}

			if (rule.categories) {
				row.cell.categories = {
					sortKey    : rule.categories[0],
					className  : 'categories',
					html       : rule.categories.invoke('sub', /.+/, '<span class="label-cat-#{0}">#{0}</span>').join(''),
					attribute  : { title: rule.categories.join(', ').truncate(256) }
				};
			} else {
				row.cell.categories = {
					className: 'default',
					sortKey  : 0,
					text     : 'any'
				};
			}
            row.cell.reserve_count = {
	            html: '<a href="#!/reserves/list/page=0&rule=' + i + '" title="このルールの予約一覧を見る" target=_blank onclick="event.stopPropagation();">'
	                + (reserveCounts[i] || 0).toString(10)
	                + '</a>'
            };

			if (rule.channels) {
				row.cell.channels = {
					text       : rule.channels.join(', '),
					attribute  : { title: rule.channels.join(', ').truncate(256) }
				};
			} else {
				row.cell.channels = {
					className: 'default',
					sortKey  : 0,
					text     : 'any'
				};
			}

			if (rule.ignore_channels) {
				row.cell.ignore_channels = {
					text       : rule.ignore_channels.join(', '),
					attribute  : { title: rule.ignore_channels.join(', ').truncate(256) }
				};
			} else {
				row.cell.ignore_channels = {
					className: 'default',
					sortKey  : 0,
					text     : 'none'
				};
			}

			if (rule.reserve_flags) {
				row.cell.reserve_flags = {
					text       : rule.reserve_flags.join(', '),
					attribute  : { title: rule.reserve_flags.join(', ').truncate(256) }
				};
			} else {
				row.cell.reserve_flags = {
					className: 'default',
					sortKey  : 0,
					text     : 'any'
				};
			}

			if (rule.ignore_flags) {
				row.cell.ignore_flags = {
					text       : rule.ignore_flags.join(', '),
					attribute  : { title: rule.ignore_flags.join(', ').truncate(256) }
				};
			} else {
				row.cell.ignore_flags = {
					className: 'default',
					sortKey  : 0,
					text     : 'none'
				};
			}

			if (rule.hour) {
				row.cell.hour = {
					sortKey  : rule.hour.start || 0,
					text     : [rule.hour.start || 0, rule.hour.end || 0].invoke('toPaddedString', 2).join('~')
				};
			} else {
				row.cell.hour = {
					className: 'default',
					sortKey  : 0,
					text     : 'all'
				};
			}

			if (rule.duration) {
				row.cell.duration = {
					sortKey  : rule.duration.min || 0,
					text     : [
						Math.round((rule.duration.min || 0) / 60),
						Math.round((rule.duration.max || 0) / 60)
					].invoke('toPaddedString', 2).join('~')
				};
			} else {
				row.cell.duration = {
					className: 'default',
					sortKey  : 0,
					text     : 'all'
				};
			}

			if (rule.reserve_titles) {
				row.cell.reserve_titles = {
					text       : rule.reserve_titles.join(', '),
					attribute  : { title: rule.reserve_titles.join(', ').truncate(256) }
				};
			} else {
				row.cell.reserve_titles = {
					className: 'default',
					sortKey  : 0,
					text     : 'any'
				};
			}

			if (rule.ignore_titles) {
				row.cell.ignore_titles = {
					text       : rule.ignore_titles.join(', '),
					attribute  : { title: rule.ignore_titles.join(', ').truncate(256) }
				};
			} else {
				row.cell.ignore_titles = {
					className: 'default',
					sortKey  : 0,
					text     : 'none'
				};
			}

			if (rule.reserve_descriptions) {
				row.cell.reserve_descriptions = {
					text       : rule.reserve_descriptions.join(', '),
					attribute  : { title: rule.reserve_descriptions.join(', ').truncate(256) }
				};
			} else {
				row.cell.reserve_descriptions = {
					className: 'default',
					sortKey  : 0,
					text     : 'any'
				};
			}

			if (rule.ignore_descriptions) {
				row.cell.ignore_descriptions = {
					text       : rule.ignore_descriptions.join(', '),
					attribute  : { title: rule.ignore_descriptions.join(', ').truncate(256) }
				};
			} else {
				row.cell.ignore_descriptions = {
					className: 'default',
					sortKey  : 0,
					text     : 'none'
				};
			}

			if (rule.allowEndLack === true) {
				row.cell.allow_end_lack = {
					sortKey  : 1,
					html     : '<span class="label label-warning" title="チャンネル切替時に録画末尾が短くなることを許可します">許可</span>'
				};
			} else {
				row.cell.allow_end_lack = {
					className: 'default',
					sortKey  : 0,
					text     : '-'
				};
			}

			if (rule.recorded_format) {
				row.cell.recorded_format = {
					text       : rule.recorded_format,
					attribute  : { title: rule.recorded_format.truncate(256) }
				};
			} else {
				row.cell.recorded_format = {
					className: 'default',
					sortKey  : 0,
					text     : 'default'
				};
			}

			rows.push(row);
		});

		this.setGridPagePosition(this.getPageNumber() - 1, false);

		this.grid.splice(0, void 0, rows).each(function(row) {
			this.grid.deselect(row);
		}.bind(this));

		return this;
	}
});
