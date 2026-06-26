P = Class.create(P, {

	init: function() {

		this.view.content.className = 'loading';

		this.program = chinachu.util.getProgramById(this.self.query.id);
		this.matchApiUrl = './api/match.json';
		this.matchItems = [];
		this.matchItem = null;
		this.matchInfoTarget = null;
		this.previewTarget = null;
		this.fallbackFromMatch = false;
		this.programViewShowMatchDebug = false;
		this.recordingPreviewImage = null;
		this.recordedFileStateTarget = null;
		this.recordedFileStateAlert = null;

		this.onNotify = this.handleNotify.bindAsEventListener(this);
		document.observe('chinachu:schedule', this.onNotify);
		document.observe('chinachu:reserves', this.onNotify);
		document.observe('chinachu:recording', this.onNotify);
		document.observe('chinachu:recorded', this.onNotify);

		this.loadWuiConfig();

		if (this.program === null) {
			this.loadMatchFallback();
			return this;
		}

		this.initToolbar();
		this.draw();
		this.loadMatch();

		// ホットキー
		// 予約済み一覧の文脈だけ左右移動を有効にする。
		// 録画済み・match履歴では、一覧の並びと詳細の前後関係がずれやすいため使わない。
		if (this.program && this.program._isReserves && !this.fallbackFromMatch) {
			sakura.shortcut.add("Left", function () {
				try { $("program-view-link-to-prev").click(); } catch (e) {}
			});
			sakura.shortcut.add("Right", function () {
				try { $("program-view-link-to-next").click(); } catch (e) {}
			});
		}

		return this;
	},

	deinit: function() {

		// ホットキー
		sakura.shortcut.remove("Left");
		sakura.shortcut.remove("Right");

		document.stopObserving('chinachu:schedule', this.onNotify);
		document.stopObserving('chinachu:reserves', this.onNotify);
		document.stopObserving('chinachu:recording', this.onNotify);
		document.stopObserving('chinachu:recorded', this.onNotify);

		this.clearRecordingPreviewTimer();
		this.recordingPreviewImage = null;

		this.app.view.mainBody.entity.style.backgroundImage = '';

		return this;
	},

	refresh: function() {

		this.app.pm.realizeHash(true);

		return this;
	},

	handleNotify: function(ev) {

		var program;

		// 録画中イベントでは画面全体を再描画せず、サムネイルだけを差し替える。
		// 録画が終了している場合は通常 refresh に戻し、録画済み表示へ遷移させる。
		if (ev && ev.type === 'chinachu:recording' && this.program && this.program._isRecording) {
			program = chinachu.util.getProgramById(this.program.id);

			if (program && program._isRecording) {
				this.program = program;
				this.updateRecordingPreview();
				return this;
			}
		}

		return this.refresh();
	},



	loadWuiConfig: function _loadWuiConfig() {

		new Ajax.Request('./api/config.json', {
			method: 'get',
			onSuccess: function(t) {
				var json;

				if (this.app.pm.p.id !== this.id) return;

				try {
					json = t.responseText.evalJSON();
				} catch (e) {
					json = {};
				}

				this.programViewShowMatchDebug = json && json.programViewShowMatchDebug === true;

				if (this.matchInfoTarget) {
					this.renderMatchInfo();
				}
			}.bind(this),
			onFailure: function() {
				if (this.app.pm.p.id !== this.id) return;

				this.programViewShowMatchDebug = false;
			}.bind(this)
		});

		return this;
	},

	loadMatchFallback: function _loadMatchFallback() {

		new Ajax.Request(this.matchApiUrl, {
			method: 'get',
			onSuccess: function(t) {
				var json;

				if (this.app.pm.p.id !== this.id) return;

				try {
					json = t.responseText.evalJSON();
				} catch (e) {
					json = [];
				}

				if (!Object.isArray(json)) {
					json = [];
				}

				this.matchItems = json;
				this.matchItem = this.findMatchItem(json, null);

				if (!this.matchItem) {
					this.timer.notFound = setTimeout(function () {
						window.location.hash = '!/dashboard/top/';
					}, 3000);
					return;
				}

				this.program = this.buildProgramFromMatch(this.matchItem);
				this.fallbackFromMatch = true;

				if (!this.program) {
					this.timer.notFound = setTimeout(function () {
						window.location.hash = '!/dashboard/top/';
					}, 3000);
					return;
				}

				this.initToolbar();
				this.draw();
				this.renderMatchInfo();
			}.bind(this),
			onFailure: function() {
				if (this.app.pm.p.id !== this.id) return;

				this.timer.notFound = setTimeout(function () {
					window.location.hash = '!/dashboard/top/';
				}, 3000);
			}.bind(this)
		});

		return this;
	},

	buildProgramFromMatch: function _buildProgramFromMatch(item) {

		var p = item && item.program || {};
		var r = item && item.recordingResult || {};
		var program = Object.extend({}, p || {});
		var path = r.path || r.recorded || program.recorded || '';
		var id = r.recordedId || r.id || r.programId || program.id || program.origId || program.programId || this.self.query.id;

		if (!item) {
			return null;
		}

		program.id = id;
		program.origId = program.origId || r.origId || r.programId || id;
		program.programId = program.programId || r.programId || program.origId || id;
		program.title = program.title || r.title || '';
		program.fullTitle = program.fullTitle || r.fullTitle || program.title || '';
		program.detail = program.detail || r.detail || r.description || '';
		program.description = program.description || r.description || '';
		program.category = program.category || r.category || 'etc';
		program.channel = program.channel || r.channel || item.channel || {};
		program.subTitle = (typeof program.subTitle === 'undefined') ? (typeof r.subTitle === 'undefined' ? null : r.subTitle) : program.subTitle;
		program.episode = (typeof program.episode === 'undefined') ? (typeof r.episode === 'undefined' ? null : r.episode) : program.episode;
		program.flags = program.flags || r.flags || [];
		program.start = Number(program.start || r.start || 0);
		program.seconds = Number(program.seconds || r.seconds || 0);
		program.end = Number(program.end || r.end || (program.start && program.seconds ? program.start + program.seconds * 1000 : 0));
		program.command = program.command || r.command || '';
		program.tuner = program.tuner || r.tuner || { isScrambling: false };
		program.recordedFormat = program.recordedFormat || r.recordedFormat || '';
		program.recorded = path;
		this.copyOperatorTiming(program, r);

		if (item.status === 'RECORDED' || item.status === 'RECORDED_UNTRACKED' || path) {
			program._isRecorded = true;
		}

		return program;
	},

	decorateProgramWithMatch: function _decorateProgramWithMatch(item) {

		var r = item && item.recordingResult || {};
		var path = r.path || r.recorded || '';

		if (!this.program || !item) {
			return this;
		}

		if ((item.status === 'RECORDED' || item.status === 'RECORDED_UNTRACKED' || path) && !this.program._isRecorded) {
			this.program._isRecorded = true;
		}

		if (path && !this.program.recorded) {
			this.program.recorded = path;
		}

		if (r.tuner && !this.program.tuner) {
			this.program.tuner = r.tuner;
		}

		this.copyOperatorTiming(this.program, r);

		if (!this.program.tuner) {
			this.program.tuner = { isScrambling: false };
		}

		return this;
	},

	loadMatch: function _loadMatch() {

		new Ajax.Request(this.matchApiUrl, {
			method: 'get',
			onSuccess: function(t) {
				var json;

				if (this.app.pm.p.id !== this.id) return;

				try {
					json = t.responseText.evalJSON();
				} catch (e) {
					json = [];
				}

				if (!Object.isArray(json)) {
					json = [];
				}

				this.matchItems = json;
				this.matchItem = this.findMatchItem(json, this.program);
				this.decorateProgramWithMatch(this.matchItem);
				this.renderRecordedFileStateAlert();
				this.renderMatchInfo();
			}.bind(this),
			onFailure: function() {
				if (this.app.pm.p.id !== this.id) return;

				this.matchItems = [];
				this.matchItem = null;
				this.renderMatchInfo();
			}.bind(this)
		});

		return this;
	},

	findMatchItem: function _findMatchItem(items, program) {

		var key = this.self.query.key || this.self.query.matchKey || '';
		var id = this.self.query.id || '';
		var ids = [];
		var decodedKey;
		var i, l, item;

		try {
			decodedKey = decodeURIComponent(key);
		} catch (e) {
			decodedKey = key;
		}

		if (decodedKey) {
			for (i = 0, l = items.length; i < l; i++) {
				item = items[i];
				if (item && item.key === decodedKey) {
					return item;
				}
			}
		}

		if (program) {
			ids = [
				program.id,
				program.origId,
				program.programId
			].compact().map(function(value) { return String(value); });
		}

		if (id && ids.indexOf(String(id)) === -1) {
			ids.push(String(id));
		}

		for (i = 0, l = items.length; i < l; i++) {
			item = items[i] || {};
			if (this.matchItemHasAnyId(item, ids)) {
				return item;
			}
		}

		return null;
	},

	matchItemHasAnyId: function _matchItemHasAnyId(item, ids) {

		var p = item.program || {};
		var r = item.recordingResult || {};
		var candidates = [
			p.id,
			p.origId,
			p.programId,
			r.id,
			r.recordedId,
			r.origId,
			r.programId
		];
		var i, l;

		ids = ids || [];
		for (i = 0, l = candidates.length; i < l; i++) {
			if (typeof candidates[i] !== 'undefined' && candidates[i] !== null && ids.indexOf(String(candidates[i])) !== -1) {
				return true;
			}
		}

		return false;
	},

	hasRecordedResult: function _hasRecordedResult(item, program) {

		var r = item && item.recordingResult || {};
		var p = item && item.program || {};
		var path = r.path || r.recorded || p.recorded || program && program.recorded || '';
		var cleanupState = r.cleanupState || p.cleanupState || program && program.cleanupState || '';
		var fileExists = (typeof r.fileExists !== 'undefined') ? r.fileExists : ((typeof p.fileExists !== 'undefined') ? p.fileExists : program && program.fileExists);

		if (cleanupState === 'deleted' || cleanupState === 'missing' || fileExists === false) {
			return false;
		}

		return !!path || r.operatorActualSeconds > 0 || p.operatorActualSeconds > 0 || program && program._isRecorded;
	}
	,
	getEffectiveMatchStatus: function _getEffectiveMatchStatus(item) {

		if (!item) {
			return '';
		}

		if (this.hasRecordedResult(item, this.program) && item.status === 'MISSED') {
			return 'RECORDED';
		}

		return item.status || '';
	}
	,
	getStatusLabel: function _getStatusLabel(status) {

		switch (status) {
		case 'RECORDED':
			return '録画済';
		case 'RECORDED_UNTRACKED':
			return '録画済（予約履歴なし）';
		case 'MISSED':
			return 'NG';
		case 'SKIPPED_ONLY':
			return 'スキップ';
		case 'RESERVED':
			return '予約履歴あり';
		default:
			return status || '-';
		}
	},

	getStatusAlertType: function _getStatusAlertType(status) {

		switch (status) {
		case 'RECORDED':
			return 'green';
		case 'RECORDED_UNTRACKED':
			return 'yellow';
		case 'MISSED':
			return 'red';
		case 'SKIPPED_ONLY':
			return 'yellow';
		case 'RESERVED':
			return 'blue';
		default:
			return 'white';
		}
	},

	getStatusBody: function _getStatusBody(item) {

		var status = this.getEffectiveMatchStatus(item);
		var r = item && item.recordingResult || {};

		switch (status) {
		case 'RECORDED':
		case 'RECORDED_UNTRACKED':
			return r.path || r.recorded || '録画済みです。';
		case 'MISSED':
			return '予約履歴はありますが、録画結果がありません。';
		case 'SKIPPED_ONLY':
			return 'この番組はスキップとして記録されています。';
		case 'RESERVED':
			return 'この番組は予約履歴として記録されています。';
		default:
			return 'match.json 由来の照合情報です。';
		}
	},

	formatJson: function _formatJson(obj) {

		try {
			return JSON.stringify(obj || {}, null, '  ');
		} catch (e) {
			return String(obj || '');
		}
	},

	renderMatchInfo: function _renderMatchInfo() {

		var target = this.matchInfoTarget;
		var item = this.matchItem;
		var recordingResult;
		var reservationMeta;
		var matchMeta;
		var recdFlg;
		var warnings;

		if (!target) {
			return this;
		}

		if (this.matchInfoBox) {
			try { this.matchInfoBox.remove(); } catch (e) {}
		}

		this.matchInfoBox = flagrate.createElement('div', { 'class': 'match-info' }).insertTo(target);

		if (!item) {
			new sakura.ui.Alert({
				title       : '録画照合情報',
				type        : 'white',
				body        : 'match.json に該当する照合情報はありません。',
				disableClose: true
			}).render(this.matchInfoBox);
			return this;
		}

		recordingResult = item.recordingResult || null;
		reservationMeta = item.reservationMeta || {};
		matchMeta = item.matchMeta || {};
		recdFlg = item.recd_flg || {};
		warnings = matchMeta && matchMeta.warnings || [];

		new sakura.ui.Alert({
			title       : '録画照合: ' + this.getStatusLabel(this.getEffectiveMatchStatus(item)),
			type        : this.getStatusAlertType(this.getEffectiveMatchStatus(item)),
			body        : this.getStatusBody(item),
			disableClose: true
		}).render(this.matchInfoBox);

		if (item.key) {
			new sakura.ui.Alert({
				title       : '録画結果キー',
				type        : 'white',
				body        : item.key,
				disableClose: true
			}).render(this.matchInfoBox);
		}

		if (warnings && warnings.length > 0) {
			new sakura.ui.Alert({
				title       : '照合警告',
				type        : 'yellow',
				body        : warnings.join(', '),
				disableClose: true
			}).render(this.matchInfoBox);
		}

		if (this.programViewShowMatchDebug !== true) {
			return this;
		}

		if (matchMeta && Object.keys(matchMeta).length > 0) {
			new sakura.ui.Alert({
				title       : '照合メタ情報',
				type        : matchMeta.hasMismatch ? 'yellow' : 'white',
				body        : '<pre>' + this.formatJson(matchMeta).escapeHTML() + '</pre>',
				disableClose: true
			}).render(this.matchInfoBox);
		}

		if (recordingResult) {
			new sakura.ui.Alert({
				title       : '録画結果情報',
				type        : 'white',
				body        : '<pre>' + this.formatJson(recordingResult).escapeHTML() + '</pre>',
				disableClose: true
			}).render(this.matchInfoBox);
		}

		new sakura.ui.Alert({
			title       : '予約メタ情報',
			type        : 'white',
			body        : '<pre>' + this.formatJson(reservationMeta).escapeHTML() + '</pre>',
			disableClose: true
		}).render(this.matchInfoBox);

		new sakura.ui.Alert({
			title       : '照合フラグ',
			type        : 'white',
			body        : '<pre>' + this.formatJson(recdFlg).escapeHTML() + '</pre>',
			disableClose: true
		}).render(this.matchInfoBox);

		if (item.sources) {
			new sakura.ui.Alert({
				title       : 'データ出所',
				type        : 'white',
				body        : '<pre>' + this.formatJson(item.sources).escapeHTML() + '</pre>',
				disableClose: true
			}).render(this.matchInfoBox);
		}

		return this;
	},

	initToolbar: function _initToolbar() {

		var program = this.program;
		var recordedFileState = this.getRecordedFileState(program, this.matchItem);

		this.view.toolbar.add({
			key: null,
			ui : new sakura.ui.Button({
				label  : 'ルールを作成',
				icon   : './icons/regular-expression.png',
				onClick: function() {
					new chinachu.ui.CreateRuleByProgram(program.id);
				}
			})
		});

		if (program._isReserves) {
			if (program.isManualReserved) {
				this.view.toolbar.add({
					key: null,
					ui : new sakura.ui.Button({
						label   : '予約取消',
						icon    : './icons/cross-script.png',
						onClick: function() {
							new chinachu.ui.Unreserve(program.id);
						}
					})
				});
			} else {
				if (program.isSkip) {
					this.view.toolbar.add({
						key: null,
						ui : new sakura.ui.Button({
							label   : 'スキップの取消',
							icon    : './icons/tick-circle.png',
							onClick: function() {
								new chinachu.ui.Unskip(program.id);
							}
						})
					});
				} else {
					this.view.toolbar.add({
						key: null,
						ui : new sakura.ui.Button({
							label   : 'スキップ',
							icon    : './icons/exclamation-red.png',
							onClick: function() {
								new chinachu.ui.Skip(program.id);
							}
						})
					});
				}
			}
		} else {
			if (!program._isRecorded) {
				this.view.toolbar.add({
					key: null,
					ui : new sakura.ui.Button({
						label   : '手動予約',
						icon    : './icons/plus-circle.png',
						onClick: function() {
							new chinachu.ui.Reserve(program.id);
						}
					})
				});
			}
		}

		if (program._isRecording) {
			this.view.toolbar.add({
				key: null,
				ui : new sakura.ui.Button({
					label   : '録画中止',
					icon    : './icons/cross.png',
					onClick: function() {
						new chinachu.ui.StopRecord(program.id);
					}
				})
			});
		}

		if (program._isRecorded && recordedFileState !== 'deleted') {
			this.view.toolbar.add({
				key: null,
				ui : new sakura.ui.Button({
					label  : '削除',
					icon   : './icons/cross-script.png',
					onClick: function() {
						var recordedApiId = this.getRecordedApiId(program, this.matchItem) || program.id;
						new chinachu.ui.RemoveRecordedProgram(recordedApiId);
					}.bind(this)
				})
			});
		}

		var recordedApiIdForToolbar = this.getRecordedApiId(program, this.matchItem) || program.id;

		if (recordedApiIdForToolbar && program.recorded && recordedFileState !== 'deleted' && recordedFileState !== 'missing') {
			if (global.chinachu.status.feature.filer) {
				this.view.toolbar.add({
					key: 'download',
					ui : new sakura.ui.Button({
						label  : 'ダウンロード',
						icon   : './icons/disk.png',
						onClick: function() {
							new chinachu.ui.DownloadRecordedFile(recordedApiIdForToolbar);
						}
					})
				});
			}

			if (global.chinachu.status.feature.streamer && !(program.tuner && program.tuner.isScrambling)) {
				this.view.toolbar.add({
					key: 'streaming',
					ui : new sakura.ui.Button({
						label  : 'ストリーミング再生',
						icon   : './icons/film-youtube.png',
						onClick: function() {
							new chinachu.ui.Streamer(recordedApiIdForToolbar);
						}
					})
				});
			}
		}

		return this;
	},



	getRecordedFileState: function _getRecordedFileState(program, item) {

		var r = item && item.recordingResult || {};
		var p = item && item.program || {};
		var cleanupState = r.cleanupState || p.cleanupState || program && program.cleanupState || '';
		var deleted = r.deleted === true || p.deleted === true || program && program.deleted === true;
		var fileExists = null;

		if (typeof r.fileExists !== 'undefined' && r.fileExists !== null) {
			fileExists = r.fileExists;
		} else if (typeof p.fileExists !== 'undefined' && p.fileExists !== null) {
			fileExists = p.fileExists;
		} else if (program && typeof program.fileExists !== 'undefined' && program.fileExists !== null) {
			fileExists = program.fileExists;
		}

		if (cleanupState === 'deleted' || deleted) {
			return 'deleted';
		}

		if (fileExists === false || cleanupState === 'missing') {
			return 'missing';
		}

		if (program && program._isRecorded && this.fallbackFromMatch) {
			return 'matchRecorded';
		}

		if (program && program._isRecorded) {
			return 'recorded';
		}

		return '';
	},

	getOperatorRecordingState: function _getOperatorRecordingState(program, item) {

		var r = item && item.recordingResult || {};
		var p = item && item.program || {};

		if (program && program.operatorAbort === true || r.operatorAbort === true || p.operatorAbort === true) {
			return {
				key   : 'abort',
				title : '中止',
				body  : 'この録画は中止操作により番組終了前に終了しました'
			};
		}

		if (program && program.operatorEndLack === true || r.operatorEndLack === true || p.operatorEndLack === true) {
			return {
				key   : 'endLack',
				title : '尻切れ',
				body  : '次の録画へ切り替えるため、許可された録画として番組終了前に終了しました'
			};
		}

		return null;
	}
	,
	getRecordedFileStateAlert: function _getRecordedFileStateAlert(state, program) {

		var recordedPath = program && program.recorded || '';
		var operatorState = this.getOperatorRecordingState(program, this.matchItem);

		switch (state) {
		case 'recorded':
			return {
				title: operatorState ? '録画済（' + operatorState.title + '）' : '録画済',
				type : operatorState ? 'yellow' : 'green',
				body : recordedPath || (operatorState ? operatorState.body : 'この番組は録画済みです')
			};
		case 'matchRecorded':
			return {
				title: operatorState ? '録画済（match履歴・' + operatorState.title + '）' : '録画済（match履歴）',
				type : operatorState ? 'yellow' : 'green',
				body : recordedPath || (operatorState ? operatorState.body : 'この番組は録画履歴として記録されています')
			};
		case 'deleted':
			return {
				title: '削除済',
				type : 'red',
				body : 'この番組の録画ファイルは録画後に削除されています'
			};
		case 'missing':
			return {
				title: 'ファイルなし',
				type : 'red',
				body : '録画履歴はありますが、録画ファイルが見つかりません'
			};
		default:
			return null;
		}
	},

	renderRecordedFileStateAlert: function _renderRecordedFileStateAlert(forcedState) {

		var state = forcedState || this.getRecordedFileState(this.program, this.matchItem);
		var alert = this.getRecordedFileStateAlert(state, this.program);

		if (!this.recordedFileStateTarget) {
			return this;
		}

		this.recordedFileStateTarget.update();

		if (!alert) {
			return this;
		}

		this.recordedFileStateAlert = new sakura.ui.Alert({
			title       : alert.title,
			type        : alert.type,
			body        : alert.body,
			disableClose: true
		});

		this.recordedFileStateAlert.render(this.recordedFileStateTarget);

		return this;
	},


	copyOperatorTiming: function _copyOperatorTiming(target, source) {

		var keys = [
			'operatorPrepareStart',
			'operatorRecordingStart',
			'operatorRecordingEnd',
			'operatorActualSeconds',
			'operatorAbort',
			'operatorAbortReason',
			'operatorAbortAt',
			'operatorEndLack',
			'operatorEndLackReason',
			'operatorEndLackAt'
		];

		if (!target || !source) {
			return target;
		}

		keys.each(function(key) {
			if ((typeof target[key] === 'undefined' || target[key] === null || target[key] === '') &&
					typeof source[key] !== 'undefined' && source[key] !== null && source[key] !== '') {
				target[key] = source[key];
			}
		});

		return target;
	},

	toFiniteNumber: function _toFiniteNumber(value) {

		var number = Number(value);

		return isFinite(number) ? number : 0;
	},

	pickOperatorTimingValue: function _pickOperatorTimingValue(key, fileJson, program, item) {

		var r = item && item.recordingResult || {};
		var p = item && item.program || {};
		var sources = [fileJson || {}, program || {}, r, p];
		var i, value;

		for (i = 0; i < sources.length; i++) {
			value = sources[i][key];
			if (typeof value !== 'undefined' && value !== null && value !== '') {
				return value;
			}
		}

		return 0;
	},

	getOperatorTiming: function _getOperatorTiming(fileJson, program, item) {

		var timing = {
			prepareStart  : this.toFiniteNumber(this.pickOperatorTimingValue('operatorPrepareStart', fileJson, program, item)),
			recordingStart: this.toFiniteNumber(this.pickOperatorTimingValue('operatorRecordingStart', fileJson, program, item)),
			recordingEnd  : this.toFiniteNumber(this.pickOperatorTimingValue('operatorRecordingEnd', fileJson, program, item)),
			actualSeconds : this.toFiniteNumber(this.pickOperatorTimingValue('operatorActualSeconds', fileJson, program, item))
		};

		if (timing.actualSeconds <= 0 && timing.recordingStart > 0 && timing.recordingEnd > timing.recordingStart) {
			timing.actualSeconds = Math.floor((timing.recordingEnd - timing.recordingStart) / 1000);
		}

		return timing;
	},

	formatDuration: function _formatDuration(seconds) {

		var s = Math.floor(Number(seconds) || 0);
		var h, m;

		if (s <= 0) {
			return '';
		}

		h = Math.floor(s / 3600);
		m = Math.floor((s % 3600) / 60);
		s = s % 60;

		if (h > 0) {
			return h + '時間' + m + '分' + ('0' + s).slice(-2) + '秒';
		}

		return m + '分' + ('0' + s).slice(-2) + '秒';
	},

	buildRecordedFileInfoBody: function _buildRecordedFileInfoBody(fileJson, program, item) {

		var size = this.toFiniteNumber(fileJson && fileJson.size);
		var timing = this.getOperatorTiming(fileJson, program, item);
		var body = size > 0 ? (size / 1024 / 1024 / 1024 / 1).toFixed(2) + 'GB' : '-';
		var durationText = this.formatDuration(timing.actualSeconds);

		if (durationText) {
			body += '　' + durationText;
		}

		return body;
	},

	renderOperatorTimingWarning: function _renderOperatorTimingWarning(target, fileJson, program, item) {

		var timing = this.getOperatorTiming(fileJson, program, item);
		var expectedSeconds = this.toFiniteNumber(program && program.seconds);
		var programStart = this.toFiniteNumber(program && program.start);
		var programEnd = this.toFiniteNumber(program && program.end);
		var messages = [];
		var headDelaySeconds;
		var tailShortageSeconds;

		if (!target || timing.actualSeconds <= 0) {
			return this;
		}

		if (programStart > 0 && timing.recordingStart > programStart + 1000) {
			headDelaySeconds = Math.ceil((timing.recordingStart - programStart) / 1000);
			messages.push('頭切れの可能性: 番組開始より ' + this.formatDuration(headDelaySeconds) + ' 遅れて録画開始');
		}

		if (programEnd > 0 && timing.recordingEnd > 0 && timing.recordingEnd < programEnd - 1000) {
			tailShortageSeconds = Math.ceil((programEnd - timing.recordingEnd) / 1000);
			messages.push('尻切れの可能性: 番組終了より ' + this.formatDuration(tailShortageSeconds) + ' 早く録画終了');
		}

		if (messages.length === 0 && expectedSeconds > 0 && timing.actualSeconds < expectedSeconds - 1) {
			messages.push('予定時間 ' + this.formatDuration(expectedSeconds) + ' に対して、録画実績は ' + this.formatDuration(timing.actualSeconds) + ' です。');
		}

		if (messages.length > 0) {
			new sakura.ui.Alert({
				title       : '録画時間警告',
				type        : 'yellow',
				body        : messages.join('<br>'),
				disableClose: true
			}).render(target);
		}

		return this;
	},

	renderOperatorRecordingStateAlert: function _renderOperatorRecordingStateAlert(target, program, item) {

		var operatorState = this.getOperatorRecordingState(program, item);

		if (!target || !operatorState) {
			return this;
		}

		new sakura.ui.Alert({
			title       : operatorState.title === '中止' ? '録画中止' : '尻切れ許可',
			type        : 'yellow',
			body        : operatorState.body,
			disableClose: true
		}).render(target);

		return this;
	},

	getMatchTitle: function _getMatchTitle(item) {

		var p = item && item.program || {};
		var r = item && item.recordingResult || {};

		return p.title || r.title || item && item.key || '(no title)';
	},

	getMatchFullTitle: function _getMatchFullTitle(item) {

		var p = item && item.program || {};
		var r = item && item.recordingResult || {};

		return p.fullTitle || r.fullTitle || this.getMatchTitle(item);
	},

	getMatchHref: function _getMatchHref(item) {

		if (!item) {
			return '#!/dashboard/top/';
		}

		if (item.key) {
			return '#!/program/view/key=' + encodeURIComponent(item.key) + '/';
		}

		var p = item.program || {};
		var r = item.recordingResult || {};
		var id = r.recordedId || r.id || r.programId || p.id || p.origId || p.programId || '';

		if (id) {
			return '#!/program/view/id=' + encodeURIComponent(id) + '/';
		}

		return '#!/dashboard/top/';
	},

	getRecordedApiId: function _getRecordedApiId(program, item) {

		var r = item && item.recordingResult || {};

		return r.recordedId ||
			r.id ||
			r.programId ||
			program && program.recordedId ||
			program && program.id ||
			program && program.origId ||
			program && program.programId ||
			this.self.query.id ||
			'';
	},

	getPreviewPositions: function _getPreviewPositions(program) {

		var seconds = Number(program && program.seconds || 0);
		var last;
		var positions;

		if (!seconds || seconds < 1) {
			return [0];
		}

		last = Math.max(0, seconds - 1);
		positions = [
			30,
			Math.floor(seconds / 2),
			Math.max(30, seconds - 30)
		].map(function(pos) {
			pos = Number(pos) || 0;
			pos = Math.max(0, pos);
			pos = Math.min(last, pos);
			return Math.floor(pos);
		}).uniq();

		return positions;
	},


	getCurrentMatchIndex: function _getCurrentMatchIndex() {

		var key = this.matchItem && this.matchItem.key || '';
		var id = this.program && this.program.id || this.self.query.id || '';
		var i, item;

		for (i = 0; i < this.matchItems.length; i++) {
			item = this.matchItems[i] || {};

			if (key && item.key === key) {
				return i;
			}

			if (!key && this.matchItemHasAnyId(item, [String(id)])) {
				return i;
			}
		}

		return -1;
	},

	getRecordingPreviewUrl: function _getRecordingPreviewUrl(program) {

		return './api/recording/' + encodeURIComponent(program.id) + '/preview.jpg?width=480&height=270&_n=' + (new Date()).getTime();
	},

	clearRecordingPreviewTimer: function _clearRecordingPreviewTimer() {

		if (this.timer && this.timer.recordingPreview) {
			clearInterval(this.timer.recordingPreview);
			delete this.timer.recordingPreview;
		}

		return this;
	},

	startRecordingPreviewTimer: function _startRecordingPreviewTimer() {

		this.clearRecordingPreviewTimer();

		if (!this.program || !this.program._isRecording) {
			return this;
		}

		this.timer.recordingPreview = setInterval(function() {
			this.updateRecordingPreview();
		}.bind(this), 1000 * 30);

		return this;
	},

	updateRecordingPreview: function _updateRecordingPreview() {

		var program = this.program;
		var src;
		var image;

		if (!program || !program._isRecording || !this.recordingPreviewImage) {
			return this;
		}

		if (this.app.pm.p.id !== this.id) {
			this.clearRecordingPreviewTimer();
			return this;
		}

		src = this.getRecordingPreviewUrl(program);
		image = new Image();

		// 先に裏で読み込み、成功後に既存 img の src だけ差し替える。
		// preview API が 404 の場合は現画像を維持し、白抜けを避ける。
		image.onload = function() {
			if (this.app.pm.p.id !== this.id) return;
			if (!this.recordingPreviewImage) return;

			this.recordingPreviewImage.src = src;
		}.bind(this);

		image.src = src;

		return this;
	},

	draw: function() {

		console.log(this.program);

		var program = this.program;

		this.clearRecordingPreviewTimer();
		this.recordingPreviewImage = null;

		this.view.content.className = 'ex';
		this.view.content.update();
		this.recordedFileStateTarget = flagrate.createElement('div', { 'class': 'program-recorded-file-state' }).insertTo(this.view.content);
		this.recordedFileStateAlert = null;

		program.flags = program.flags || [];
		program.channel = program.channel || {};
		program.tuner = program.tuner || { isScrambling: false };

		this.renderRecordedFileStateAlert();

		var titleHtml = program.flags.invoke('sub', /.+/, '<span class="flag #{0}">#{0}</span>').join('') + program.title;
		if (program.subTitle && program.title.indexOf(program.subTitle) === -1) {
			titleHtml += ' <span class="subtitle">' + program.subTitle + '</span>';
		}
		if (typeof program.episode !== 'undefined' && program.episode !== null) {
			titleHtml += ' <span class="episode">#' + program.episode + '</span>';
		}
		titleHtml += ' <span class="id">#' + program.id + '</span>';

		if (program.isManualReserved) {
			titleHtml = ' <span class="flag manual">手動</span>' + titleHtml;
		}

		if (program.isSkip) {
			titleHtml = ' <span class="flag skip">スキップ</span>' + titleHtml;
		}

		setTimeout(function() {
			this.view.title.update(titleHtml);
		}.bind(this), 0);

		if (program._isReserves) {
			if (program.isSkip) {
				new sakura.ui.Alert({
					title       : 'スキップ',
					type        : 'yellow',
					body        : 'この番組は自動録画予約されましたがスキップするように設定されています',
					disableClose: true
				}).render(this.view.content);
			} else if (program.isConflict) {
				new sakura.ui.Alert({
					title       : '競合',
					type        : 'red',
					body        : 'この番組は録画予約されていますが競合のため録画できない可能性があります',
					disableClose: true
				}).render(this.view.content);
			} else {
				new sakura.ui.Alert({
					title       : '予約済',
					type        : 'blue',
					body        : 'この番組は録画予約されています',
					disableClose: true
				}).render(this.view.content);
			}
		}

		if (program._isRecording) {
			new sakura.ui.Alert({
				title       : '録画中',
				type        : 'red',
				body        : program.recorded,
				disableClose: true
			}).render(this.view.content);
		}

		// create layout grid
		var container = flagrate.createElement("div", { "class": "container-fluid" }).insertTo(this.view.content);
		var r1 = flagrate.createElement("div", { "class": "row" }).insertTo(container);
		var r1L = flagrate.createElement("div", { "class": "col-md-8" }).insertTo(r1);
		var r1R = flagrate.createElement("div", { "class": "col-md-4" }).insertTo(r1);
		this.previewTarget = flagrate.createElement("div", { "class": "program-preview" }).insertTo(r1R);
		this.matchInfoTarget = flagrate.createElement("div", { "class": "program-match-info" }).insertTo(r1R);
		var r2 = flagrate.createElement("div", { "class": "row" }).insertTo(container);
		var r2F = flagrate.createElement("div", { "class": "col-md-12" }).insertTo(r2);

		var meta = new flagrate.Element('div', { 'class': 'program-meta' }).update(
			' &ndash; ' +
			dateFormat(new Date(program.end), 'HH:MM') +
			' (' + (program.seconds / 60) + '分間)<br>' +
			'<small><span class="label label-cat-' + program.category + '">' + program.category + '</span> ' +
			'<span class="label label-type-' + program.channel.type + '">' + program.channel.type + ': ' +
			'<a href="#!/search/top/skip=1&chid=' + program.channel.id + '/">' + program.channel.name + '</a></span>' +
			'</small>'
		).insertTo(r1L);

		meta.insert({ top:
			new chinachu.ui.DynamicTime({
				tagName: 'span',
				type   : 'full',
				time   : program.start
			}).entity
		});

		// 番組情報
		new flagrate.Element('p', { 'class': 'program-detail' }).update(
			(program.detail || program.description || '')
				.stripScripts().escapeHTML()
				.replace(/(https?:\/\/[\x21-\x7e]+)/gi, function (url) {
					// リンク
					return '<a href="' + url + '" target="_blank">' + url + '</a>';
				})
				.replace(/(ｈｔｔｐｓ?：／／[\uFF01-\uFF5E]+)/g, function (src) {
					// 全角を半角に直してリンク
					var url = src
						.replace(/(.)/g, function (s) {
							return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
						})
						.stripScripts().stripTags();
					return '<a href="' + url + '" target="_blank">' + src + '</a>';
				})
		).insertTo(r1L);

		new sakura.ui.Alert({
			title       : '完全なタイトル',
			type        : 'white',
			body        : program.fullTitle,
			disableClose: true
		}).render(r1L);

		if (program.command) {
			new sakura.ui.Alert({
				title       : '録画パラメーター',
				type        : 'white',
				body        : program.command,
				disableClose: true
			}).render(r1L);
		}

		if (program._isRecorded) {
			var recordedApiId = this.getRecordedApiId(program, this.matchItem);

			if (recordedApiId) {
				new Ajax.Request('./api/recorded/' + encodeURIComponent(recordedApiId) + '/file.json', {
					method: 'get',
					onSuccess: function(t) {

						if (this.app.pm.p.id !== this.id) return;

						var fileJson = t.responseJSON || {};

						new sakura.ui.Alert({
							title       : 'ファイルサイズ',
							type        : 'white',
							body        : this.buildRecordedFileInfoBody(fileJson, program, this.matchItem),
							disableClose: true
						}).render(r1L);

						this.renderOperatorRecordingStateAlert(r1L, program, this.matchItem);
						this.renderOperatorTimingWarning(r1L, fileJson, program, this.matchItem);

						// 録画済みサムネイル
						var imgurl = "./api/recorded/" + encodeURIComponent(recordedApiId) + "/preview.jpg?width=480&height=270";
						var previewTarget = this.previewTarget || r1R;

						this.getPreviewPositions(program).each(function(pos) {
							flagrate.createElement("img", {
								"class": "img-thumbnail img-responsive",
								src: imgurl + "&pos=" + pos
							}).insertTo(previewTarget);
						});
					}.bind(this),
					onFailure: function(t) {

						if (this.app.pm.p.id !== this.id) return;

						if (t.status === 404 || t.status === 410) {
							this.renderRecordedFileStateAlert(this.getRecordedFileState(program, this.matchItem) || 'missing');

							try { this.view.toolbar.one('download').disable(); } catch (e) {}
							try { this.view.toolbar.one('streaming').disable(); } catch (e) {}
						}
					}.bind(this)
				});
			}
		}

		if (program._isRecording) {
			// 録画中サムネイル
			this.recordingPreviewImage = flagrate.createElement("img", {
				"class": "img-thumbnail img-responsive",
				src: this.getRecordingPreviewUrl(program)
			}).insertTo(this.previewTarget || r1R);

			this.startRecordingPreviewTimer();
		}

		// pager
		// 左右移動は予約済み一覧だけに限定する。
		// 録画済みやmatch履歴は、recorded.json / match.json / 一覧画面の並びが一致しないため前後移動を出さない。
		if (program._isReserves && !this.fallbackFromMatch) {
			var nav = flagrate.createElement("nav").insertTo(r2F);
			var pager = flagrate.createElement("ul", { "class": "pager" }).insertTo(nav);
			var programs = global.chinachu.reserves;
			var prev = null;
			var next = null;

			if (programs !== null) {
				for (var i = 0, l = programs.length; i < l; i++) {
					if (programs[i].id === program.id) {
						if (i >= 0) {
							prev = programs[i - 1];
						}
						if (i < l) {
							next = programs[i + 1];
						}
						break;
					}
				}

				var prevLi = flagrate.createElement("li", { "class": "previous" }).insertTo(pager);
				var nextLi = flagrate.createElement("li", { "class": "next" }).insertTo(pager);

				if (prev) {
					flagrate.createElement("a", {
						id: "program-view-link-to-prev",
						title: prev.fullTitle,
						href: "#!/program/view/id=" + prev.id + "/"
					})
						.insert("<span>&larr;</span> " + prev.title)
						.insertTo(prevLi);
				}
				if (next) {
					flagrate.createElement("a", {
						id: "program-view-link-to-next",
						title: next.fullTitle,
						href: "#!/program/view/id=" + next.id + "/"
					})
						.insert(next.title + " <span>&rarr;</span>")
						.insertTo(nextLi);
				}

				flagrate.createElement("p", {
					className: "muted"
				}).insert("ホットキー [予約済みページ移動]: <code>←</code> / <code>→</code>").insertTo(r2F);
			}
		}

		return this;
	}
});
