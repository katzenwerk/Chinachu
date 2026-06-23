P = Class.create(P, {

	init: function () {

		this.view.content.className = 'loading';

		this.draw();

		this.onSchedule = this.drawChannels.bindAsEventListener(this);
		document.observe('chinachu:schedule', this.onSchedule);
		this.timer.channels = setInterval(this.onSchedule, 1000 * 15);

		this.onReserves = this.drawReserves.bindAsEventListener(this);
		document.observe('chinachu:reserves', this.onReserves);

		this.onRecording = this.drawRecording.bindAsEventListener(this);
		document.observe('chinachu:recording', this.onRecording);
		this.timer.recording = setInterval(this.onRecording, 1000 * 30);

		this.onRecorded = this.drawRecorded.bindAsEventListener(this);
		document.observe('chinachu:recorded', this.onRecorded);

		return this;
	},

	deinit: function () {

		document.stopObserving('chinachu:schedule', this.onSchedule);
		document.stopObserving('chinachu:reserves', this.onReserves);
		document.stopObserving('chinachu:recording', this.onRecording);
		document.stopObserving('chinachu:recorded', this.onRecorded);

		return this;
	},

	draw: function () {

		this.view.content.className = "ex";
		this.view.content.update();

		// create layout grid
		var container = flagrate.createElement("div", { "class": "container-fluid" }).insertTo(this.view.content);
		var r1 = flagrate.createElement("div", { "class": "row" }).insertTo(container);
		var r1F = flagrate.createElement("div", { "class": "col-md-12" }).insertTo(r1);
		var r2 = this.r2 = flagrate.createElement("div", { "class": "row channel-cards" }).insertTo(container);
		var r3 = flagrate.createElement("div", { "class": "row program-cards" }).insertTo(container);
		this.r3L = flagrate.createElement("div", { "class": "col-md-4" }).insertTo(r3);
		this.r3C = flagrate.createElement("div", { "class": "col-md-4" }).insertTo(r3);
		this.r3R = flagrate.createElement("div", { "class": "col-md-4" }).insertTo(r3);

		var toggleChannels = flagrate.createButton({
			labelHTML: "<span class='glyphicon glyphicon-flag'></span>放送中の番組とライブ視聴...",
			className: "toggle-channels",
			onSelect: function () {

				toggleChannels.toggleClassName("dent");
				r2.toggle();

				if (localStorage.getItem("dashboard.showChannels") === "yes") {
					localStorage.setItem("dashboard.showChannels", "no");
				} else {
					localStorage.setItem("dashboard.showChannels", "yes");
					this.drawChannels();
				}
			}.bind(this)
		}).insertTo(r1F);

		if (localStorage.getItem("dashboard.showChannels") === "yes") {
			toggleChannels.addClassName("dent");
		} else {
			r2.hide();
		}

		this.hideChannels = JSON.parse(localStorage.getItem('schedule.hide.channels') || '[]');

		setTimeout(this.drawChannels.bind(this), 0);
		setTimeout(this.drawReserves.bind(this), 0);
		setTimeout(this.drawRecording.bind(this), 0);
		setTimeout(this.drawRecorded.bind(this), 0);

		return this;
	},

	drawChannels: function () {

		if (document.hidden) {
			return;
		}

		if (localStorage.getItem("dashboard.showChannels") !== "yes") {
			return this;
		}

		var r2 = this.r2;
		var hideChannels = this.hideChannels;
		var now = Date.now();

		r2.update();

		global.chinachu.schedule.each(function (channel) {

			if (hideChannels.indexOf(channel.id) !== -1) {
				return;
			}

			var onair = null;

			channel.programs.each(function (program) {
				if (now >= program.start && now < program.end) {
					onair = program;
					throw $break;
				}
			});

			if (!onair) { return; }
			if (onair.title === "放送休止") { return; }

			var col = flagrate.createElement("div", { "class": "col-sm-3" }).insertTo(r2);
			var card = flagrate.createElement("div", { "class": "channel-card" }).insertTo(col);

			var ch = flagrate.createElement("div", {
				"class": "channel label-type-" + channel.type
			}).setStyle({
				display   : "flex",
				alignItems: "center",
				width     : "100%",
				minWidth  : "0",
				overflow  : "hidden",
				boxSizing : "border-box",
				padding   : "2px 4px"
			}).insertTo(card);

			var chMain = flagrate.createElement("span", {
				"class": "channel-main"
			}).setStyle({
				display   : "flex",
				alignItems: "center",
				minWidth  : "0",
				flex      : "1 1 auto",
				overflow  : "hidden"
			}).insertTo(ch);

			if (channel.hasLogoData === true) {
				flagrate.createElement("img", {
					"class": "channel-logo",
					src    : "./api/channel/" + channel.id + "/logo.png"
				}).setStyle({
					width      : "26px",
					height     : "16px",
					objectFit  : "contain",
					marginRight: "4px",
					flex       : "0 0 auto"
				}).insertTo(chMain);
			}

			flagrate.createElement("a", {
				href: "#!/search/top/skip=1&chid=" + channel.id
			}).setStyle({
				display     : "block",
				minWidth    : "0",
				overflow    : "hidden",
				whiteSpace  : "nowrap",
				textOverflow: "ellipsis",
				flex        : "1 1 auto"
			}).insertText(channel.name).insertTo(chMain);

			var liveButton = flagrate.createElement("button", {
				"class": "live channel-live-button",
				type   : "button",
				title  : "ライブ視聴"
			}).setStyle({
				flex       : "0 0 auto",
				marginLeft : "auto",
				padding    : "1px 6px",
				fontSize   : "10px",
				lineHeight  : "1.2",
				minWidth   : "34px",
				maxWidth   : "42px",
				whiteSpace : "nowrap",
				overflow   : "hidden",
				boxSizing  : "border-box",
				cursor     : "pointer"
			}).insertText("視聴").insertTo(ch);

			liveButton.observe("click", function () {
				location.hash = "!/channel/watch/id=" + channel.id;
			});

			flagrate.createProgress({
				value: Date.now() - onair.start,
				max: onair.end - onair.start
			}).insertTo(card);

			var programButton = flagrate.createElement("div", {
				"class": "program channel-program-button",
				title  : onair.fullTitle + "\n\n" + onair.detail.truncate(300)
			}).setStyle({
				display   : "block",
				width     : "100%",
				boxSizing : "border-box",
				padding   : "4px 6px 5px 6px",
				textAlign : "left",
				overflow  : "hidden",
				cursor    : "pointer",
				minHeight : "36px"
			}).insertTo(card);

			programButton.observe("click", function () {
				location.hash = "!/program/view/id=" + onair.id;
			});

			flagrate.createElement("div", {
				"class": "program-category-line"
			}).setStyle({
				display    : "block",
				margin     : "0 0 3px 0",
				padding    : "0",
				lineHeight : "1.1",
				whiteSpace : "nowrap",
				overflow   : "hidden"
			}).insert(
				"<span class='label-cat-" + onair.category + "'>" + onair.category + "</span>"
			).insertTo(programButton);

			flagrate.createElement("div", {
				"class": "program-title-line"
			}).setStyle({
				display     : "block",
				maxWidth    : "100%",
				overflow    : "hidden",
				whiteSpace  : "nowrap",
				textOverflow: "ellipsis",
				lineHeight  : "1.25"
			}).insertText(onair.title).insertTo(programButton);
		});

		return this;
	},

	drawReserves: function () {

		this.drawPrograms(
			"RESERVES".__(),
			"reserves",
			"panel-primary",
			this.r3L,
			global.chinachu.reserves
		);

		return this;
	},

	drawRecording: function () {

		if (document.hidden) {
			return;
		}

		this.drawPrograms(
			"RECORDING".__(),
			"recording",
			"panel-danger",
			this.r3C,
			global.chinachu.recording
		);

		return this;
	},

	drawRecorded: function () {

		new Ajax.Request('./api/match.json', {
			method: 'get',
			onSuccess: function (t) {
				var items = [];

				try {
					items = t.responseText.evalJSON();
				} catch (e) {
					items = [];
				}

				if (!Object.isArray(items)) {
					items = [];
				}

				this.drawMatchRecorded(
					"RECORDED".__(),
					"recorded",
					"panel-success",
					this.r3R,
					items
				);
			}.bind(this),
			onFailure: function () {
				this.drawMatchRecorded(
					"RECORDED".__(),
					"recorded",
					"panel-success",
					this.r3R,
					[]
				);
			}.bind(this)
		});

		return this;
	},

	getMatchProgram: function (item) {

		return item.program || item.recorded || item.reserve || {};
	},

	getMatchEnd: function (item) {

		var program = this.getMatchProgram(item);
		var start = program.start || 0;
		var seconds = program.seconds || 0;

		return program.end || (start + (seconds * 1000));
	},

	isFinishedMatch: function (item) {

		var end = this.getMatchEnd(item);

		return end > 0 && Date.now() > end;
	},

	getRecordedHistoryCounts: function (items) {

		var counts = { recorded: 0, ng: 0 };

		(items || []).each(function (item) {
			if (!this.isFinishedMatch(item)) {
				return;
			}

			if (item.status === 'RECORDED') {
				counts.recorded++;
			} else if (item.status === 'MISSED') {
				counts.ng++;
			}
		}.bind(this));

		return counts;
	},

	getRecordedHistoryItems: function (items) {

		return (items || []).findAll(function (item) {
			if (!this.isFinishedMatch(item)) {
				return false;
			}

			return item.status === 'RECORDED' || item.status === 'MISSED';
		}.bind(this));
	},

	drawMatchRecorded: function (title, type, className, container, matchItems) {

		container.update();

		var panel = flagrate.createElement("div", {
			"class": "panel " + className
		}).insertTo(container);

		var counts = this.getRecordedHistoryCounts(matchItems);
		var heading = flagrate.createElement("div", {
			"class": "panel-heading"
		}).insertTo(panel);

		heading.insertText(title + ' 録画済 ' + counts.recorded.toString(10) + ' / ');
		flagrate.createElement("span", {
			"class": "recorded-history-ng-count",
			title: 'NG'
		}).setStyle({
			color     : '#d33',
			fontWeight: 'bold'
		}).insertText('NG ' + counts.ng.toString(10)).insertTo(heading);

		var programs = this.getRecordedHistoryItems(matchItems);

		if (programs.length === 0) {
			return this;
		}

		programs.sort(function (a, b) {
			var pa = a.program || a.recorded || a.reserve || {};
			var pb = b.program || b.recorded || b.reserve || {};
			return (pb.start || 0) - (pa.start || 0);
		});

		var ul = flagrate.createElement("ul", { "class": "list-group" }).insertTo(panel);
		var hasMore = false;

		programs.each(function (item, i) {
			if (i > 10) {
				hasMore = true;
				throw $break;
			}

			var program = this.getMatchProgram(item);
			var channel = item.channel || program.channel || {};
			var result = item.recordingResult || {};
			var key = item.key || [channel.id || '-', program.start || 0, program.seconds || 0].join('|');
			var titleText = program.title || result.title || '-';
			var fullTitle = program.fullTitle || titleText;
			var detail = program.detail || '';
			var flags = program.flags || [];

			var li = flagrate.createElement("li", {
				"class": "list-group-item" + (item.status === 'MISSED' ? ' conflict' : ''),
				title: fullTitle + "\n\n" + String(detail).truncate(300)
			}).insertTo(ul);

			li.onclick = function () {
				location.hash = "!/program/view/key=" + encodeURIComponent(key) + "/";
			};

			var lineTitle = flagrate.createElement("div", { "class": "title" }).insertTo(li);
			var titleTextHtml = String(titleText).escapeHTML();

			if (item.status === 'MISSED') {
				titleTextHtml = '<span class="recorded-history-ng-title" style="color:#d33;font-weight:bold;">' + titleTextHtml + '</span>';
			}

			lineTitle.insert(
				"<span class='label-cat-" + (program.category || 'etc') + "'>" + (program.category || 'etc') + "</span>" +
				(flags.invoke ? flags.invoke('sub', /.+/, '<span rel="#{0}">#{0}</span>').join('') : '') +
				titleTextHtml
			);

			if (program.episode) {
				lineTitle.insert('<span class="episode">#' + program.episode + '</span>');
			}

			var dt = new chinachu.ui.DynamicTime({
				tagName: 'span',
				type   : 'full',
				time   : this.getMatchEnd(item)
			}).entity;
			li.insert(dt);

			li.insert(
				'<span class="label label-type-' + (channel.type || '-') + '">' +
				(channel.type || '-') + ': ' + String(channel.name || '-').escapeHTML() + '</span>'
			);

			flagrate.createContextMenu({
				target: li,
				items : [
					{
						label   : '録画結果詳細...',
						icon    : './icons/document-page-next.png',
						onSelect: function () {
							location.hash = "!/program/view/key=" + encodeURIComponent(key) + "/";
						}
					},
					'------------------------------------------',
					{
						label   : 'タイトルをコピー...',
						onSelect: function () {
							chinachu.ui.copyStr(titleText);
						}
					},
					{
						label   : '説明をコピー...',
						onSelect: function () {
							chinachu.ui.copyStr(detail);
						}
					},
					'------------------------------------------',
					{
						label   : 'Google検索',
						icon    : './icons/ui-search-field.png',
						onSelect: function () {
							window.open("https://www.google.com/search?q=" + titleText);
						}
					}
				]
			});
		}.bind(this));

		if (hasMore) {
			flagrate.createElement("div", {
				"class": "panel-footer"
			}).insert(
				'<span class="glyphicon glyphicon-chevron-right"></span> <a href="#!/' + type + '/list/">すべて表示</a>'
			).insertTo(panel);
		}

		return this;
	},

	drawPrograms: function (title, type, className, container, programs) {

		container.update();

		var panel = flagrate.createElement("div", {
			"class": "panel " + className
		}).insertTo(container);

		flagrate.createElement("div", {
			"class": "panel-heading"
		}).insertText(
			'OF{0} {1}'.__([programs.length.toString(10), title])
		).insertTo(panel);

		if (programs.length === 0) {
			return this;
		}

		var ul = flagrate.createElement("ul", { "class": "list-group" }).insertTo(panel);

		var now = Date.now();
		var hasMore = false;

		programs.each(function (program, i) {

			if (i > 10) {
				hasMore = true;
				throw $break;
			}

			program = chinachu.util.getProgramById(program.id);

			var li = flagrate.createElement("li", {
				"class": "list-group-item",
				title: program.fullTitle + "\n\n" + program.detail.truncate(300)
			}).insertTo(ul);
			li.onclick = function () {
				location.hash = "!/program/view/id=" + program.id;
			}

			var title = flagrate.createElement("div", { "class": "title" }).insertTo(li);
			title.insert(
				"<span class='label-cat-" + program.category + "'>" + program.category + "</span>" +
				program.flags.invoke('sub', /.+/, '<span rel="#{0}">#{0}</span>').join('') +
				program.title
			);
			if (program.episode) {
				title.insert('<span class="episode">#' + program.episode + '</span>');
			}

			if (program._isRecording && program.pid) {
				flagrate.createElement("img", {
					"class": "img-rounded img-responsive",
					src: "./api/recording/" + program.id + "/preview.jpg?width=480&height=270&_n=" + now
				}).insertTo(li);
			}

			var dt = new chinachu.ui.DynamicTime({
				tagName: 'span',
				type   : 'full',
				time   : (now > program.end) ? program.end : program.start
			}).entity;
			li.insert(dt);

			li.insert(
				'<span class="label label-type-' + program.channel.type + '">' + program.channel.type + ': ' +
				program.channel.name + '</span>'
			);

			var contextMenuItems = [
				{
					label   : 'ルール作成...',
					icon    : './icons/regular-expression.png',
					onSelect: function () {
						new chinachu.ui.CreateRuleByProgram(program.id);
					}
				},
				'------------------------------------------',
				{
					label   : 'ツイート...',
					onSelect: function () {
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
					onSelect: function (e) {
						chinachu.ui.copyStr(chinachu.util.scotify(program));
					}
				},
				{
					label   : 'IDをコピー...',
					onSelect: function () {
						chinachu.ui.copyStr(program.id);
					}
				},
				{
					label   : 'タイトルをコピー...',
					onSelect: function () {
						chinachu.ui.copyStr(program.title);
					}
				},
				{
					label   : '説明をコピー...',
					onSelect: function () {
						chinachu.ui.copyStr(program.detail);
					}
				},
				'------------------------------------------',
				{
					label   : '関連サイト',
					icon    : './icons/document-page-next.png',
					onSelect: function () {
						window.open("https://www.google.com/search?btnI=I'm+Feeling+Lucky&q=" + program.title);
					}
				},
				{
					label   : 'Google検索',
					icon    : './icons/ui-search-field.png',
					onSelect: function () {
						window.open("https://www.google.com/search?q=" + program.title);
					}
				},
				{
					label   : 'Wikipedia',
					icon    : './icons/book-open-text-image.png',
					onSelect: function () {
						window.open("https://ja.wikipedia.org/wiki/" + program.title);
					}
				}
			];

			contextMenuItems.unshift("---");

			if (program._isRecorded) {
				contextMenuItems.unshift({
					label   : '削除...',
					icon    : './icons/cross-script.png',
					onSelect: function () {
						new chinachu.ui.RemoveRecordedProgram(program.id);
					}
				});
			} else if (program._isRecording) {
				contextMenuItems.unshift({
					label   : '録画中止...',
					icon    : './icons/cross.png',
					onSelect: function () {
						new chinachu.ui.StopRecord(program.id);
					}
				});
			} else if (program._isReserves) {
				if (program.isConflict) {
					li.addClassName('conflict');
				}
				if (program.isManualReserved) {
					contextMenuItems.unshift({
						label   : '予約取消...',
						icon    : './icons/cross-script.png',
						onSelect: function () {
							new chinachu.ui.Unreserve(program.id);
						}
					});
				} else {
					if (program.isSkip) {
						li.addClassName('skip');
						contextMenuItems.unshift({
							label   : 'スキップの取消...',
							icon    : './icons/tick-circle.png',
							onSelect: function () {
								new chinachu.ui.Unskip(program.id);
							}
						});
					} else {
						contextMenuItems.unshift({
							label   : 'スキップ...',
							icon    : './icons/exclamation-red.png',
							onSelect: function () {
								new chinachu.ui.Skip(program.id);
							}
						});
					}
				}
			}

			flagrate.createContextMenu({
				target: li,
				items : contextMenuItems
			});
		});

		if (hasMore) {
			flagrate.createElement("div", {
				"class": "panel-footer"
			}).insert(
				'<span class="glyphicon glyphicon-chevron-right"></span> <a href="#!/' + type + '/list/">すべて表示</a>'
			).insertTo(panel);
		}

		return this;
	}
});