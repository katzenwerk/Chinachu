P = Class.create(P, {

	init: function _initPage() {

		this.view.content.className = 'health-status-page loading';
		this.diagnostics = null;
		this.diagnosticsLoading = true;
		this.diagnosticsRequest = null;
		this.diagnosticsDetailsOpen = false;
		this.serviceControl = null;
		this.serviceControlLoading = true;
		this.serviceControlRequest = null;
		this.serviceRestartRequest = null;
		this.servicePollRequest = null;
		this.servicePollTimer = null;
		this.servicePollDeadline = 0;
		this.servicePollTarget = null;
		this.servicePollOperation = null;
		this.serviceOperation = { operator: null, wui: null };

		this.onNotify = this.refresh.bindAsEventListener(this);
		document.observe('chinachu:status', this.onNotify);

		this.draw();
		this.loadDiagnostics(false);
		this.loadServiceControl();

		return this;
	}
	,
	refresh: function() {

		this.draw();

		return this;
	}
	,
	deinit: function _deinit() {

		document.stopObserving('chinachu:status', this.onNotify);
		if (this.diagnosticsRequest && this.diagnosticsRequest.transport) {
			this.diagnosticsRequest.transport.abort();
		}
		this.diagnosticsRequest = null;
		if (this.serviceControlRequest && this.serviceControlRequest.transport) {
			this.serviceControlRequest.transport.abort();
		}
		if (this.serviceRestartRequest && this.serviceRestartRequest.transport) {
			this.serviceRestartRequest.transport.abort();
		}
		if (this.servicePollRequest && this.servicePollRequest.transport) {
			this.servicePollRequest.transport.abort();
		}
		if (this.servicePollTimer) clearTimeout(this.servicePollTimer);
		this.serviceControlRequest = null;
		this.serviceRestartRequest = null;
		this.servicePollRequest = null;
		this.servicePollTimer = null;

		return this;
	}
	,
	loadServiceControl: function _loadServiceControl() {
		if (this.serviceControlRequest || this.servicePollRequest) return this;
		this.serviceControlLoading = true;
		this.serviceControlRequest = new Ajax.Request('./api/service-control.json', {
			method: 'get',
			onSuccess: function(t) {
				try {
					this.serviceControl = t.responseText.evalJSON();
				} catch (_) {
					this.serviceControl = null;
				}
			}.bind(this),
			onFailure: function() {
				this.serviceControl = null;
			}.bind(this),
			onComplete: function() {
				this.serviceControlRequest = null;
				this.serviceControlLoading = false;
				this.draw();
			}.bind(this)
		});
		return this;
	}
	,
	refreshAll: function _refreshAll() {
		this.loadDiagnostics(true);
		this.loadServiceControl();
		return this;
	}
	,
	draw: function _draw() {

		this.captureDiagnosticsDetailsState();
		this.view.content.className = 'health-status-page';
		this.view.content.update();

		this.drawToolbar();
		this.drawRuntimePanel();
		this.drawServicePanel();
		this.drawEnvironmentPanel();
		this.drawDiagnosticsDetails();

		return this;
	}
	,
	loadDiagnostics: function _loadDiagnostics(force) {
		if (this.diagnosticsRequest) {
			return this;
		}

		this.diagnosticsLoading = true;
		this.draw();
		this.diagnosticsRequest = new Ajax.Request('./api/diagnostics.json' + (force ? '?refresh=1' : ''), {
			method: 'get',
			onSuccess: function(t) {
				try {
					this.diagnostics = t.responseText.evalJSON();
				} catch (_) {
					this.diagnostics = null;
				}
			}.bind(this),
			onFailure: function() {
				this.diagnostics = null;
			}.bind(this),
			onComplete: function() {
				this.diagnosticsRequest = null;
				this.diagnosticsLoading = false;
				this.draw();
			}.bind(this)
		});

		return this;
	}
	,
	statusLabel: function _statusLabel(status) {
		return { normal: '正常', warning: '注意', error: '異常', unknown: '未確認' }[status] || '未確認';
	}
	,
	formatElapsed: function _formatElapsed(milliseconds) {
		if (typeof milliseconds !== 'number' || !isFinite(milliseconds) || milliseconds < 0) {
			return '未取得';
		}
		var seconds = Math.floor(milliseconds / 1000);
		if (seconds < 60) return seconds + '秒';
		var minutes = Math.floor(seconds / 60);
		if (minutes < 60) return minutes + '分';
		var hours = Math.floor(minutes / 60);
		if (hours < 24) return hours + '時間' + (minutes % 60) + '分';
		return Math.floor(hours / 24) + '日' + (hours % 24) + '時間';
	}
	,
	formatDate: function _formatDate(value) {
		return typeof value === 'number' && isFinite(value) && value > 0
			? chinachu.dateToString(new Date(value), 'short')
			: '未取得';
	}
	,
	createPanel: function _createPanel(title, iconClass) {
		var panel = new Element('section', { 'class': 'health-panel' });
		var heading = new Element('div', { 'class': 'health-panel-heading' });
		heading.update(
			'<span class="glyphicon ' + iconClass + '" aria-hidden="true"></span>' +
			'<span>' + String(title).escapeHTML() + '</span>'
		);
		panel.insert(heading);
		panel.insert(new Element('div', { 'class': 'health-panel-grid' }));
		this.view.content.insert(panel);
		return panel;
	}
	,
	addMetric: function _addMetric(container, options) {
		options = options || {};
		var status = options.status || 'unknown';
		var metric = new Element('div', {
			'class': 'health-metric' + (options.showStatus ? ' health-status-' + status : '')
		});
		var header = new Element('div', { 'class': 'health-metric-header' });
		header.insert(new Element('div', { 'class': 'health-metric-label' }).update(
			String(options.label || '').escapeHTML()
		));
		if (options.showStatus) {
			header.insert(new Element('span', { 'class': 'health-state-label' }).update(
				this.statusLabel(status).escapeHTML()
			));
		}
		metric.insert(header);
		metric.insert(new Element('div', { 'class': 'health-metric-value' }).update(
			String(options.value === undefined || options.value === null ? '未取得' : options.value).escapeHTML()
		));
		if (options.note) {
			metric.insert(new Element('div', { 'class': 'health-metric-note' }).update(
				String(options.note).escapeHTML()
			));
		}
		container.insert(metric);
		return metric;
	}
	,
	captureDiagnosticsDetailsState: function _captureDiagnosticsDetailsState() {
		var details = this.view.content.down && this.view.content.down('.health-details');
		if (details) {
			this.diagnosticsDetailsOpen = details.open === true;
		}
		return this.diagnosticsDetailsOpen;
	}
	,
	drawToolbar: function _drawToolbar() {
		var toolbar = new Element('div', { 'class': 'health-toolbar' });
		var checkedAt = this.diagnostics && this.diagnostics.schemaVersion === 1
			? this.formatDate(this.diagnostics.checkedAt)
			: '未取得';

		toolbar.insert(new Element('span', { 'class': 'health-checked-at' }).update(
			'最終確認: ' + checkedAt.escapeHTML()
		));
		flagrate.createButton({
			labelHTML: '<span class="glyphicon glyphicon-refresh" aria-hidden="true"></span> ' +
				(this.diagnosticsLoading ? '確認中...' : '再確認'),
			className: 'health-refresh-button',
			isDisabled: this.diagnosticsLoading,
			onSelect: function() { this.refreshAll(); }.bind(this)
		}).insertTo(toolbar);
		this.view.content.insert(toolbar);

		if (this.diagnosticsLoading && !this.diagnostics) {
			this.view.content.insert(new Element('div', { 'class': 'health-inline-message' }).update(
				'診断情報を確認しています…'
			));
		} else if (!this.diagnostics || this.diagnostics.schemaVersion !== 1) {
			this.view.content.insert(new Element('div', { 'class': 'health-inline-message health-status-error' }).update(
				'診断情報を取得できません。Operatorの状態は個別に表示しています。'
			));
		}
	}
	,
	drawRuntimePanel: function _drawRuntimePanel() {
		var panel = this.createPanel('稼働状態', 'glyphicon-dashboard');
		var grid = panel.down('.health-panel-grid');
		var report = this.diagnostics && this.diagnostics.schemaVersion === 1 ? this.diagnostics : {};
		var operator = global.chinachu.status && global.chinachu.status.operator;
		var operatorStatus = !operator ? 'unknown' : operator.alive === true ? 'normal' : 'error';
		var operatorNote = 'PIDによる簡易確認';
		if (operator && operator.pid !== null && operator.pid !== undefined) {
			operatorNote = 'PID ' + operator.pid + ' · ' + operatorNote;
		}
		this.addMetric(grid, {
			label: 'Operator',
			value: !operator ? '未確認' : operator.alive === true ? '稼働中' : '停止',
			note: operatorNote,
			status: operatorStatus,
			showStatus: true
		});

		var schedulerDiagnostic = report.scheduler || { status: 'unknown', summary: '診断情報を取得できません' };
		var scheduler = schedulerDiagnostic.data || {};
		var schedulerNote = typeof scheduler.elapsedMs === 'number' && scheduler.elapsedMs >= 0
			? this.formatElapsed(scheduler.elapsedMs) + '前'
			: schedulerDiagnostic.status === 'normal' ? '' : schedulerDiagnostic.summary;
		this.addMetric(grid, {
			label: 'Scheduler',
			value: this.formatDate(scheduler.lastSuccessAt),
			note: schedulerNote,
			status: schedulerDiagnostic.status,
			showStatus: true
		});

		var recordingDiagnostic = report.recording || { status: 'unknown', summary: '診断情報を取得できません' };
		var recording = recordingDiagnostic.data || {};
		this.addMetric(grid, {
			label: '録画中',
			value: typeof recording.count === 'number' ? recording.count + '件' : '未取得',
			note: recordingDiagnostic.status === 'normal' ? '' : recordingDiagnostic.summary,
			status: recordingDiagnostic.status,
			showStatus: true
		});

		var mirakurunDiagnostic = report.mirakurun || { status: 'unknown', summary: '診断情報を取得できません' };
		var mirakurun = mirakurunDiagnostic.data || {};
		this.addMetric(grid, {
			label: 'Mirakurun',
			value: mirakurunDiagnostic.status === 'normal' ? '接続正常' : this.statusLabel(mirakurunDiagnostic.status),
			note: mirakurun.version ? 'Server version ' + mirakurun.version :
				(mirakurunDiagnostic.status === 'normal' ? 'Server version 未取得' : mirakurunDiagnostic.summary),
			status: mirakurunDiagnostic.status,
			showStatus: true
		});
	}
	,
	drawServicePanel: function _drawServicePanel() {
		var panel = this.createPanel('サービス操作', 'glyphicon-off');
		panel.addClassName('health-service-panel');
		var grid = panel.down('.health-panel-grid');
		var report = this.serviceControl && this.serviceControl.schemaVersion === 1 ? this.serviceControl : {};
		var targets = report.targets || {};
		[
			{ target: 'operator', label: 'Operator', button: 'Operatorを再起動' },
			{ target: 'wui', label: 'WUI', button: 'WUIを再起動' }
		].each(function(action) {
			var target = targets[action.target] || {
				manager: 'unknown', operable: false,
				summary: this.serviceControlLoading ? '管理先を確認しています' : 'PM2の管理先を確認できません'
			};
			var operation = this.serviceOperation[action.target];
			var busy = this.serviceRestartRequest !== null || this.servicePollTarget !== null;
			var item = new Element('div', { 'class': 'health-service-action' });
			var copy = new Element('div', { 'class': 'health-service-action-copy' });
			copy.insert(new Element('div', { 'class': 'health-metric-label' }).update(action.label.escapeHTML()));
			copy.insert(new Element('div', { 'class': 'health-service-manager' }).update(
				this.serviceManagerLabel(target.manager, target.operable).escapeHTML()
			));
			copy.insert(new Element('div', { 'class': 'health-metric-note' }).update(
				String(operation && operation.message || target.summary || '管理先を確認できません').escapeHTML()
			));
			item.insert(copy);
			flagrate.createButton({
				label: action.button,
				className: 'health-service-button',
				isDisabled: !target.operable || busy,
				title: target.summary || '',
				onSelect: function() { this.confirmServiceRestart(action.target); }.bind(this)
			}).insertTo(item);
			grid.insert(item);
		}.bind(this));
	}
	,
	serviceManagerLabel: function _serviceManagerLabel(manager, operable) {
		if (manager === 'pm2-user') return operable ? 'PM2管理' : 'PM2管理・操作不可';
		if (manager === 'pm2-sudo') return 'sudo PM2管理';
		if (manager === 'unavailable') return 'PM2接続不可';
		if (manager === 'unsupported') return '未対応の管理方式';
		return '管理先未確認';
	}
	,
	confirmServiceRestart: function _confirmServiceRestart(target) {
		if (target !== 'operator' && target !== 'wui') return this;
		var label = target === 'operator' ? 'Operator' : 'WUI';
		var impact = target === 'operator'
			? '録画中・開始準備中はサーバー側で拒否されます。'
			: '一時的に画面との接続が切れます。復旧を確認するまで再送しません。';
		flagrate.createModal({
			title: label + 'の再起動',
			text: label + 'だけを再起動します。' + impact,
			buttons: [
				{
					label: '再起動', color: '@orange',
					onSelect: function(e, modal) {
						modal.buttons.each(function(button) { button.button.disable(); });
						modal.close();
						this.requestServiceRestart(target);
					}.bind(this)
				},
				{ label: 'キャンセル', onSelect: function(e, modal) { modal.close(); } }
			]
		}).open();
		return this;
	}
	,
	requestServiceRestart: function _requestServiceRestart(target) {
		if ((target !== 'operator' && target !== 'wui') || this.serviceRestartRequest || this.servicePollTarget) return this;
		var current = this.serviceControl && this.serviceControl.targets && this.serviceControl.targets[target];
		if (!current || current.operable !== true) return this;
		this.serviceOperation[target] = { state: 'requesting', message: '再起動を受け付けています' };
		this.draw();
		this.serviceRestartRequest = new Ajax.Request('./api/service-control/' + target + '.json', {
			method: 'post',
			onSuccess: function(t) {
				var result = null;
				try { result = t.responseText.evalJSON(); } catch (_) {}
				if (!result || result.accepted !== true || !result.operation) {
					return this.finishServiceRestart(target, false, '再起動要求を受け付けられません');
				}
				this.serviceOperation[target] = { state: 'accepted', message: '受付済み・再起動中です' };
				this.startServiceReconnectCheck(target, result.operation);
			}.bind(this),
			onFailure: function(t) {
				if (t && t.status === 0) {
					this.serviceOperation[target] = { state: 'reconnecting', message: '接続断を確認中です' };
					return this.startServiceReconnectCheck(target, {
						id: null,
						before: this.serviceGeneration(current)
					});
				}
				this.finishServiceRestart(target, false, this.serviceResponseMessage(t));
			}.bind(this),
			onComplete: function() {
				this.serviceRestartRequest = null;
				this.draw();
			}.bind(this)
		});
		return this;
	}
	,
	serviceResponseMessage: function _serviceResponseMessage(response) {
		try {
			var result = response.responseText.evalJSON();
			if (result && result.message) return String(result.message);
		} catch (_) {}
		return '再起動要求を受け付けられません';
	}
	,
	serviceGeneration: function _serviceGeneration(target) {
		return {
			pid: target && target.pid || null,
			restartCount: target && target.restartCount,
			startedAt: target && target.startedAt
		};
	}
	,
	serviceGenerationChanged: function _serviceGenerationChanged(before, after) {
		if (!before || !after) return false;
		return (before.pid !== null && after.pid !== null && before.pid !== after.pid) ||
			(typeof before.restartCount === 'number' && typeof after.restartCount === 'number' && after.restartCount > before.restartCount) ||
			(typeof before.startedAt === 'number' && typeof after.startedAt === 'number' && after.startedAt > before.startedAt);
	}
	,
	startServiceReconnectCheck: function _startServiceReconnectCheck(target, operation) {
		if (this.servicePollTarget) return this;
		this.servicePollTarget = target;
		this.servicePollOperation = operation;
		this.servicePollDeadline = Date.now() + 30000;
		this.serviceOperation[target] = { state: 'reconnecting', message: '再接続を確認しています' };
		this.draw();
		this.scheduleServiceReconnectCheck(1000);
		return this;
	}
	,
	scheduleServiceReconnectCheck: function _scheduleServiceReconnectCheck(delay) {
		if (this.servicePollTimer) clearTimeout(this.servicePollTimer);
		this.servicePollTimer = setTimeout(function() {
			this.servicePollTimer = null;
			this.pollServiceReconnect();
		}.bind(this), delay);
	}
	,
	pollServiceReconnect: function _pollServiceReconnect() {
		var target = this.servicePollTarget;
		var operation = this.servicePollOperation;
		if (!target || this.servicePollRequest) return this;
		if (Date.now() > this.servicePollDeadline) {
			return this.finishServiceRestart(target, false, '復旧を確認できません');
		}
		this.servicePollRequest = new Ajax.Request('./api/service-control.json', {
			method: 'get',
			onSuccess: function(t) {
				var report;
				try { report = t.responseText.evalJSON(); } catch (_) { return; }
				if (!report || report.schemaVersion !== 1) return;
				this.serviceControl = report;
				var current = report.targets && report.targets[target];
				var serverOperation = report.operations && report.operations[target];
				if (serverOperation && operation.id && serverOperation.id === operation.id && serverOperation.state === 'failed') {
					return this.finishServiceRestart(target, false, serverOperation.message || '再起動に失敗しました');
				}
				if (current && current.operable === true && current.status === 'online' &&
					this.serviceGenerationChanged(operation.before, this.serviceGeneration(current))) {
					return this.finishServiceRestart(target, true, '再起動後の稼働を確認しました');
				}
			}.bind(this),
			onComplete: function() {
				this.servicePollRequest = null;
				if (this.servicePollTarget) this.scheduleServiceReconnectCheck(1500);
			}.bind(this)
		});
		return this;
	}
	,
	finishServiceRestart: function _finishServiceRestart(target, succeeded, message) {
		if (this.servicePollTimer) clearTimeout(this.servicePollTimer);
		this.servicePollTimer = null;
		this.servicePollTarget = null;
		this.servicePollOperation = null;
		this.servicePollDeadline = 0;
		this.serviceOperation[target] = {
			state: succeeded ? 'succeeded' : 'failed',
			message: message
		};
		this.draw();
		if (succeeded) {
			this.loadDiagnostics(true);
			this.loadServiceControl();
		}
		return this;
	}
	,
	drawEnvironmentPanel: function _drawEnvironmentPanel() {
		var panel = this.createPanel('実行環境', 'glyphicon-cog');
		panel.addClassName('health-environment-panel');
		var grid = panel.down('.health-panel-grid');
		var report = this.diagnostics && this.diagnostics.schemaVersion === 1 ? this.diagnostics : {};
		var basic = report.basic && report.basic.data || {};

		this.addMetric(grid, { label: 'Chinachu version', value: basic.chinachuVersion || '未取得' });
		this.addMetric(grid, { label: 'Node.js version', value: basic.nodeVersion || '未取得' });
		this.addMetric(grid, { label: 'Commit', value: basic.commit ? String(basic.commit).slice(0, 12) : '未取得' });
	}
	,
	diagnosticNote: function _diagnosticNote(diagnostic, scope) {
		if (!diagnostic || diagnostic.status === 'normal') {
			return scope;
		}
		return String(diagnostic.summary || '詳細を取得できません') + ' · ' + scope;
	}
	,
	diagnosticsIssueCounts: function _diagnosticsIssueCounts(report) {
		var counts = { warning: 0, error: 0 };
		var json = report && report.json || {};
		[ json.config, json.rules, json.schedulerState ].forEach(function(diagnostic) {
			if (diagnostic && (diagnostic.status === 'warning' || diagnostic.status === 'error')) {
				counts[diagnostic.status]++;
			}
		});
		return counts;
	}
	,
	drawDiagnosticsDetails: function _drawDiagnosticsDetails() {
		var report = this.diagnostics && this.diagnostics.schemaVersion === 1 ? this.diagnostics : {};
		var json = report.json || {};
		var issueCounts = this.diagnosticsIssueCounts(report);
		var details = new Element('details', { 'class': 'health-details' });
		var summary = new Element('summary', { 'class': 'health-details-summary' });
		summary.update('<span class="glyphicon glyphicon-info-sign" aria-hidden="true"></span> 診断詳細');
		if (issueCounts.error > 0) {
			summary.insert(new Element('span', { 'class': 'health-details-count health-details-count-error' }).update(
				'異常 ' + issueCounts.error
			));
		}
		if (issueCounts.warning > 0) {
			summary.insert(new Element('span', { 'class': 'health-details-count health-details-count-warning' }).update(
				'注意 ' + issueCounts.warning
			));
		}
		details.insert(summary);
		details.open = this.diagnosticsDetailsOpen === true;
		details.observe('toggle', function() {
			this.diagnosticsDetailsOpen = details.open === true;
		}.bind(this));
		var grid = new Element('div', { 'class': 'health-panel-grid health-details-grid' });
		details.insert(grid);

		[
			{
				label: 'config.json',
				diagnostic: json.config,
				scope: '読込み / JSON / object型'
			},
			{
				label: 'rules.json',
				diagnostic: json.rules,
				scope: '読込み / JSON / 配列型 / ruleUid形式・重複'
			},
			{
				label: 'scheduler-state.json',
				diagnostic: json.schedulerState,
				scope: '読込み / JSON / object型 / state形式'
			}
		].each(function(check) {
			var diagnostic = check.diagnostic || { status: 'unknown' };
			this.addMetric(grid, {
				label: check.label,
				value: diagnostic.status === 'normal' ? '検査済み' : this.statusLabel(diagnostic.status),
				note: this.diagnosticNote(diagnostic, check.scope),
				status: diagnostic.status,
				showStatus: true
			});
		}.bind(this));

		this.addMetric(grid, {
			label: 'Matching成功情報',
			value: '未計測'
		});
		this.addMetric(grid, {
			label: 'Scheduler trigger source',
			value: '未計測'
		});

		details.insert(new Element('div', { 'class': 'health-details-meta' }).update(
			'取得元: config.json / rules.json / data/scheduler-state.json / data/recording.json / Mirakurun status' +
			'<br>確認時刻: ' + this.formatDate(report.checkedAt).escapeHTML()
		));
		this.view.content.insert(details);
	}
});
