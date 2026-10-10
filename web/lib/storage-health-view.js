(function (root, factory) {
	'use strict';

	var api = factory();
	if (typeof module === 'object' && module.exports) {
		module.exports = api;
	} else {
		root.chinachuStorageHealthView = api;
	}
})(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	var UNAVAILABLE = {
		'not-mounted': true,
		'wrong-storage': true,
		'broken-link': true,
		'missing': true,
		'read-only': true
	};

	function formatAvailable(bytes) {
		if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return null;
		var gib = bytes / 1024 / 1024 / 1024;
		return gib >= 1024 ? (gib / 1024).toFixed(2) + ' TB' : gib.toFixed(1) + ' GB';
	}

	function storageName(storage) {
		return String(storage.name || storage.id || 'Default');
	}

	function issueFor(storage, thresholds) {
		var status = storage && storage.status;
		if (status === 'ok' || status === 'stale' || status === 'unobserved') return null;
		if (UNAVAILABLE[status]) {
			return {
				priority: 4,
				level: 'critical',
				code: status,
				label: status === 'not-mounted' ? '未マウント' :
					status === 'wrong-storage' ? 'ストレージ不一致' :
					status === 'broken-link' ? 'リンク切れ' :
					status === 'missing' ? 'パスなし' : '読み取り専用',
				message: status === 'not-mounted' || status === 'wrong-storage' ?
					'録画先ストレージに異常があります。この状態では録画を開始できません。' :
					'録画先を利用できません。ストレージの状態を確認してください。'
			};
		}
		if (status === 'low-space') {
			if (storage.lowSpacePhase === 'warning') {
				if (!thresholds || thresholds.warningEnabled !== true ||
					typeof thresholds.warningMB !== 'number' || !isFinite(thresholds.warningMB) ||
					typeof thresholds.cleanupMB !== 'number' || !isFinite(thresholds.cleanupMB) ||
					thresholds.warningMB <= thresholds.cleanupMB) return null;
				return {
					priority: 2,
					level: 'warning',
					code: 'warning',
					label: '容量警告',
					message: 'ストレージの空き容量が少なくなっています。状態を確認してください。'
				};
			}
			return {
				priority: 3,
				level: 'critical',
				code: thresholds && thresholds.action === 'remove' && storage.stopNewRecordings !== true ? 'low-remove' : 'low-stop',
				label: '容量不足',
				message: thresholds && thresholds.action === 'remove' && storage.stopNewRecordings !== true ?
					'ストレージの容量が不足しています。自動削除の状況を確認してください。' :
					'ストレージの容量が不足しており、録画が制限されています。'
			};
		}
		return {
			priority: 1,
			level: 'unknown',
			code: 'unknown',
			label: '状態確認不能',
			message: 'ストレージの状態を確認できません。'
		};
	}

	function identityFor(storage, issue) {
		var identity = storage.filesystemId || storage.expectedMount || storage.resolvedPath ||
			storage.path || storage.configuredPath || storage.id || storageName(storage);
		return issue.code + '|' + identity;
	}

	function summarize(storageData, options) {
		options = options || {};
		if (options.requestFailed === true || !storageData || !Array.isArray(storageData.storages)) {
			return {
				priority: 1,
				level: 'unknown',
				code: 'api-failure',
				count: 1,
				mark: '?',
				message: 'ストレージ情報を取得できません。',
				title: 'ストレージ情報：取得失敗',
				apiFailure: true
			};
		}

		var thresholds = storageData.thresholds || {};
		var seen = {};
		var issues = [];
		storageData.storages.forEach(function (storage, index) {
			var issue = issueFor(storage, thresholds);
			if (!issue) return;
			var identity = identityFor(storage, issue);
			if (seen[identity]) return;
			seen[identity] = true;
			issue.storage = storage;
			issue.index = index;
			issues.push(issue);
		});
		if (issues.length === 0) return null;

		issues.sort(function (a, b) {
			return b.priority - a.priority || a.index - b.index;
		});
		var primary = issues[0];
		var name = storageName(primary.storage);
		var available = primary.code === 'warning' ? formatAvailable(primary.storage.available) : null;
		var detail = name + (available ? '・空き ' + available : '');
		var message = primary.message + '（' + detail + '）';
		if (issues.length > 1) message += '（ほか' + (issues.length - 1) + '件の警告）';

		return {
			priority: primary.priority,
			level: primary.level,
			code: primary.code,
			count: issues.length,
			mark: primary.level === 'unknown' ? '?' : '!',
			message: message,
			title: issues.length > 1 ? 'ストレージ異常：' + issues.length + '件' : name + '：' + primary.label,
			storage: primary.storage,
			apiFailure: false
		};
	}

	return {
		formatAvailable: formatAvailable,
		summarize: summarize
	};
});
