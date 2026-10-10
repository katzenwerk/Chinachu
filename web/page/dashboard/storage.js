P = Class.create(P, {

	init: function _initPage() {
		this.view.content.className = 'storage-health-page loading';
		this.storageData = null;
		this.storageRequest = null;
		this.storageRefreshRequest = null;
		this.storageRefreshMessage = null;

		this.onNotify = this.refresh.bindAsEventListener(this);
		document.observe('chinachu:storage', this.onNotify);
		this.initToolbar();
		this.loadStorage();
		return this;
	}
	,
	initToolbar: function _initToolbar() {
		this.view.toolbar.add({
			key: 'refresh-all',
			ui: new sakura.ui.Button({
				label: 'すべて更新',
				icon: './icons/arrow-circle-315.png',
				onClick: this.requestCapacityRefresh.bind(this, null)
			})
		});
		return this;
	}
	,
	refresh: function _refresh() {
		this.loadStorage();
		return this;
	}
	,
	deinit: function _deinit() {
		document.stopObserving('chinachu:storage', this.onNotify);
		if (this.storageRequest && this.storageRequest.transport) {
			this.storageRequest.transport.abort();
		}
		if (this.storageRefreshRequest && this.storageRefreshRequest.transport) {
			this.storageRefreshRequest.transport.abort();
		}
		this.storageRequest = null;
		this.storageRefreshRequest = null;
		return this;
	}
	,
	loadStorage: function _loadStorage() {
		if (this.storageRequest) return this;
		this.view.content.addClassName('loading');
		this.storageRequest = new Ajax.Request('./api/storage.json', {
			method: 'get',
			onSuccess: function (t) {
				try {
					this.storageData = t.responseText.evalJSON();
				} catch (_) {
					this.storageData = null;
				}
			}.bind(this),
			onFailure: function () {
				this.storageData = null;
			}.bind(this),
			onComplete: function () {
				this.storageRequest = null;
				this.draw();
			}.bind(this)
		});
		return this;
	}
	,
	setRefreshButtonsDisabled: function _setRefreshButtonsDisabled(disabled) {
		this.view.content.select('.storage-health-refresh-button').each(function (button) {
			button.disabled = disabled;
			button.toggleClassName('storage-health-refreshing', disabled);
		});
		var refreshAll = this.view.toolbar.one('refresh-all');
		if (refreshAll) {
			if (disabled) refreshAll.disable();
			else refreshAll.enable();
		}
	}
	,
	requestCapacityRefresh: function _requestCapacityRefresh(storage) {
		if (this.storageRefreshRequest) return this;
		var all = !storage;
		var message = all ?
			'すべての録画先の容量情報を更新します。複数のHDDがスリープ中の場合、スピンアップする可能性があります。' :
			'容量情報を更新します。HDDがスリープ中の場合、スピンアップする可能性があります。';
		if (!window.confirm(message)) return this;

		this.storageRefreshMessage = null;
		this.setRefreshButtonsDisabled(true);
		this.storageRefreshRequest = new Ajax.Request('./api/storage/refresh.json', {
			method: 'post',
			contentType: 'application/json',
			postBody: Object.toJSON(all ? { all: true } : { storageId: storage.id || null }),
			onSuccess: function (t) {
				var result;
				try { result = t.responseText.evalJSON(); } catch (_) { result = null; }
				if (!result) {
					this.storageRefreshMessage = { error: true, text: '更新結果を取得できませんでした。' };
					return;
				}
				this.storageRefreshMessage = {
					error: result.failed > 0,
					text: result.total + '件中' + result.updated + '件更新、' + result.failed + '件失敗'
				};
			}.bind(this),
			onFailure: function (t) {
				var result;
				try { result = t.responseText.evalJSON(); } catch (_) { result = null; }
				this.storageRefreshMessage = {
					error: true,
					text: result && result.message || '容量情報を更新できませんでした。'
				};
			}.bind(this),
			onComplete: function () {
				this.storageRefreshRequest = null;
				this.loadStorage();
			}.bind(this)
		});
		return this;
	}
	,
	statusLabel: function _statusLabel(storage) {
		var status = storage && storage.status;
		if (status === 'stale' && storage.observedStatus === 'low-space') {
			return storage.observedLowSpacePhase === 'warning' ? '参考値（前回：警告）' : '参考値（前回：容量不足）';
		}
		if (status === 'low-space') {
			return storage.lowSpacePhase === 'warning' ? '警告' : '容量不足';
		}
		return {
			'ok': '正常',
			'unobserved': '未取得',
			'stale': '参考値',
			'not-mounted': '未マウント',
			'wrong-storage': 'ストレージ不一致',
			'broken-link': 'リンク切れ',
			'missing': 'パスなし',
			'read-only': '読み取り専用',
			'unknown': '取得不可'
		}[status] || '取得不可';
	}
	,
	formatCapacityPair: function _formatCapacityPair(used, total) {
		if (typeof used !== 'number' || !isFinite(used) || typeof total !== 'number' || !isFinite(total) || total <= 0) {
			return '容量取得不可';
		}
		var divisor = total >= 1000 * 1000 * 1000 * 1000 ? 1000 * 1000 * 1000 * 1000 : 1000 * 1000 * 1000;
		var unit = divisor === 1000 * 1000 * 1000 * 1000 ? 'TB' : 'GB';
		return (used / divisor).toFixed(2) + ' / ' + (total / divisor).toFixed(2) + ' ' + unit;
	}
	,
	formatCapacity: function _formatCapacity(value, total) {
		if (typeof value !== 'number' || !isFinite(value) || typeof total !== 'number' || !isFinite(total) || total <= 0) {
			return '容量取得不可';
		}
		var divisor = total >= 1000 * 1000 * 1000 * 1000 ? 1000 * 1000 * 1000 * 1000 : 1000 * 1000 * 1000;
		var unit = divisor === 1000 * 1000 * 1000 * 1000 ? 'TB' : 'GB';
		return (value / divisor).toFixed(2) + ' ' + unit;
	}
	,
	formatFileSize: function _formatFileSize(value) {
		if (typeof value !== 'number' || !isFinite(value) || value < 0) return '不明';
		if (value >= 1000 * 1000 * 1000) return (value / 1000 / 1000 / 1000).toFixed(2) + ' GB';
		if (value >= 1000 * 1000) return (value / 1000 / 1000).toFixed(1) + ' MB';
		return (value / 1000).toFixed(1) + ' KB';
	}
	,
	formatThreshold: function _formatThreshold(thresholdMB) {
		if (thresholdMB >= 1024) {
			var gb = thresholdMB / 1024;
			return (Math.round(gb * 10) / 10).toString(10) + 'GB';
		}
		return thresholdMB + 'MB';
	}
	,
	createThresholdLine: function _createThresholdLine(kind, thresholdMB, total, label) {
		if (typeof thresholdMB !== 'number' || !isFinite(thresholdMB) || thresholdMB <= 0 || total <= 0) {
			return null;
		}
		var thresholdBytes = thresholdMB * 1024 * 1024;
		var left = Math.max(0, Math.min(100, (1 - thresholdBytes / total) * 100));
		var line = new Element('span', {
			className: 'storage-health-threshold storage-health-threshold-' + kind,
			title: label + '：空き' + this.formatThreshold(thresholdMB) + '以下'
		}).setStyle({ left: left + '%' });
		return line;
	}
	,
	draw: function _draw() {
		this.view.content.className = 'storage-health-page';
		this.view.content.update();

		if (!this.storageData || !Object.isArray(this.storageData.storages)) {
			this.view.content.insert(new Element('div', { className: 'storage-health-message storage-health-message-error' }).update('Storage情報を取得できませんでした。'));
			return this;
		}

		var thresholds = this.storageData.thresholds || {};
		var warningLineEnabled = thresholds.warningEnabled === true &&
			typeof thresholds.warningMB === 'number' && isFinite(thresholds.warningMB) &&
			typeof thresholds.cleanupMB === 'number' && isFinite(thresholds.cleanupMB) &&
			thresholds.warningMB > thresholds.cleanupMB;
		if (this.storageData.storages.length === 0) {
			this.view.content.insert(new Element('div', { className: 'storage-health-message' }).update('録画先が設定されていません。'));
			return this;
		}
		if (this.storageRefreshMessage) {
			this.view.content.insert(new Element('div', {
				className: 'storage-health-refresh-result' + (this.storageRefreshMessage.error ? ' storage-health-refresh-result-error' : '')
			}).update(String(this.storageRefreshMessage.text).escapeHTML()));
		}

		this.storageData.storages.each(function (storage) {
			var reliable = storage.capacityReliable === true;
			var abnormal = storage.status !== 'ok' && storage.status !== 'low-space' && storage.status !== 'stale';
			var row = new Element('section', { className: 'storage-health-row' + (abnormal ? ' storage-health-row-disabled' : '') });
			var header = new Element('div', { className: 'storage-health-header' });
			var title = new Element('div', { className: 'storage-health-title' }).update(String(storage.name || storage.id || 'Default').escapeHTML());
			var stateClass = storage.status === 'low-space' ? 'low-space-' + String(storage.lowSpacePhase || 'cleanup') : String(storage.status || 'unknown');
			var state = new Element('span', { className: 'storage-health-state storage-health-state-' + stateClass }).update(this.statusLabel(storage));
			var headerActions = new Element('div', { className: 'storage-health-header-actions' });
			var refreshOne = new Element('button', {
				type: 'button',
				className: 'storage-health-refresh-button storage-health-refresh-one',
				disabled: !!this.storageRefreshRequest
			}).update('<span class="glyphicon glyphicon-refresh" aria-hidden="true"></span> 更新');
			refreshOne.observe('click', this.requestCapacityRefresh.bind(this, storage));
			var pathLine = new Element('div', { className: 'storage-health-path' }).update(String(storage.configuredPath || storage.path || '').escapeHTML());
			var checkedLine = new Element('div', { className: 'storage-health-checked-at' }).update(
				storage.capacityCheckedAt ?
					('最終確認：' + new Date(storage.capacityCheckedAt).toLocaleString() + (storage.capacityStale ? '（参考値）' : '')) :
					'最終確認：未取得'
			);
			var mountLine = new Element('div', { className: 'storage-health-mount' });
			var gauge = new Element('div', { className: 'storage-health-gauge' + (!reliable ? ' storage-health-gauge-disabled' : '') });
			var gaugeFill = new Element('span', { className: 'storage-health-gauge-fill' });
			var details = new Element('div', { className: 'storage-health-values' });
			var capacityDetails = new Element('div', { className: 'storage-health-capacity-values' });
			var thresholdDetails = new Element('div', { className: 'storage-health-threshold-values' });
			var hasThresholdDetails = false;

			header.insert(title);
			headerActions.insert(refreshOne);
			headerActions.insert(state);
			header.insert(headerActions);
			row.insert(header);
			row.insert(pathLine);
			row.insert(checkedLine);
			if (storage.mountPoint) {
				mountLine.update(('mount: ' + storage.mountPoint + (storage.mountSource ? ' (' + storage.mountSource + ')' : '')).escapeHTML());
			} else if (storage.expectedMount) {
				mountLine.update(('expectedMount: ' + storage.expectedMount).escapeHTML());
			}
			if (mountLine.innerHTML) row.insert(mountLine);

			if (reliable) {
				var occupied = Math.max(0, storage.total - storage.available);
				var percent = Math.max(0, Math.min(100, occupied / storage.total * 100));
				gaugeFill.setStyle({ width: percent + '%' });
				gaugeFill.update(percent.toFixed(1) + '%');
				gauge.insert(gaugeFill);
				if (storage.lowStorageManaged && warningLineEnabled) {
					var warningLine = this.createThresholdLine('warning', thresholds.warningMB, storage.total, '警告');
					if (warningLine) gauge.insert(warningLine);
				}
				if (storage.lowStorageManaged) {
					var cleanupLabel = thresholds.action === 'remove' ? '自動削除' : '録画停止';
					var cleanupLine = this.createThresholdLine(thresholds.action === 'remove' ? 'cleanup-remove' : 'cleanup-stop', thresholds.cleanupMB, storage.total, cleanupLabel);
					if (cleanupLine) gauge.insert(cleanupLine);
				}
			} else {
				gauge.insert(new Element('span', { className: 'storage-health-gauge-unavailable' }).update(
					storage.capacityCheckedAt ? '容量不明' : '容量未取得'
				));
			}
			row.insert(gauge);

			capacityDetails.insert(new Element('span').update(('使用量: ' + this.formatCapacityPair(storage.used, storage.total)).escapeHTML()));
			capacityDetails.insert(new Element('span').update(('空き: ' + this.formatCapacity(storage.available, storage.total)).escapeHTML()));
			details.insert(capacityDetails);
			if (storage.lowStorageManaged) {
				if (warningLineEnabled) {
					thresholdDetails.insert(new Element('span', { className: 'storage-health-threshold-value storage-health-threshold-value-warning' }).update(
						('警告：空き' + this.formatThreshold(thresholds.warningMB) + '以下').escapeHTML()
					));
					hasThresholdDetails = true;
				}
				if (typeof thresholds.cleanupMB === 'number' && isFinite(thresholds.cleanupMB) && thresholds.cleanupMB > 0) {
					var cleanupDescription = thresholds.action === 'remove' ? '自動削除' : '録画停止';
					thresholdDetails.insert(new Element('span', { className: 'storage-health-threshold-value storage-health-threshold-value-cleanup' }).update(
						(cleanupDescription + '：空き' + this.formatThreshold(thresholds.cleanupMB) + '以下').escapeHTML()
					));
					hasThresholdDetails = true;
				}
			}
			if (hasThresholdDetails) details.insert(thresholdDetails);
			row.insert(details);

			if (!abnormal && storage.lowStorageManaged && storage.status === 'low-space') {
				var guidance = new Element('div', { className: 'storage-health-guidance' });
				if (storage.lowSpacePhase === 'warning' && thresholds.action === 'remove') {
					guidance.insert(new Element('p').update('空き容量が少なくなっています。不要な録画ファイルの整理をご検討ください。'));
					guidance.insert(new Element('p').update('さらに空き容量が減少すると、以下の録画ファイルが自動削除の候補となります。'));
				} else if (storage.lowSpacePhase === 'cleanup' && thresholds.action === 'remove') {
					guidance.insert(new Element('p').update('容量不足のため、古い録画ファイルから自動削除して空き容量を確保します。'));
					guidance.insert(new Element('p').update('削除できない場合は、このストレージへの録画を停止します。'));
				} else if (storage.lowSpacePhase === 'warning') {
					guidance.insert(new Element('p').update('空き容量が少なくなっています。不要な録画ファイルの整理をご検討ください。さらに減少すると、このストレージへの録画が停止されます。'));
				} else {
					guidance.insert(new Element('p').update('容量不足のため、このストレージへの録画を停止します。'));
				}

				if (thresholds.action === 'remove' && storage.cleanupCandidateSource === true) {
					var candidates = storage.cleanupCandidates;
					var candidateBox = new Element('div', { className: 'storage-health-candidates' });
					candidateBox.insert(new Element('div', { className: 'storage-health-candidates-title' }).update('削除候補（参考情報）'));
					if (!Object.isArray(candidates)) {
						candidateBox.insert(new Element('div').update('削除候補はまだ取得されていません。'));
					} else if (candidates.length === 0) {
						candidateBox.insert(new Element('div').update('安全に削除できる候補はありません。'));
					} else {
						var list = new Element('ol');
						candidates.slice(0, 5).each(function (candidate) {
							list.insert(new Element('li').update((String(candidate.name || '不明') + ' — ' + this.formatFileSize(candidate.size)).escapeHTML()));
						}.bind(this));
						candidateBox.insert(list);
					}
					if (storage.cleanupCandidatesCheckedAt) {
						candidateBox.insert(new Element('div', { className: 'storage-health-candidates-meta' }).update('取得: ' + new Date(storage.cleanupCandidatesCheckedAt).toLocaleString()));
					}
					candidateBox.insert(new Element('div', { className: 'storage-health-candidates-meta' }).update('表示は削除予約ではありません。削除直前にOperatorが安全条件を再評価します。'));
					guidance.insert(candidateBox);
				}
				row.insert(guidance);
			}
			this.view.content.insert(row);
		}.bind(this));

		return this;
	}
});
