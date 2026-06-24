P = Class.create(P, {
	init: function _initPage() {
		this.view.content.className = 'loading';
		this.data.config = {};
		this.data.services = [];
		this.data.serviceLoaded = false;
		this.data.servicePaste = '';
		this.initToolbar();
		this.draw();
		return this;
	},

	deinit: function _deinit() {
		return this;
	},

	initToolbar: function _initToolbar() {
		this.view.toolbar.add({
			key: 'reload',
			ui : new sakura.ui.Button({
				label : 'RELOAD'.__(),
				icon  : './icons/arrow-circle-315.png',
				onClick: function () {
					this.draw();
				}.bind(this)
			})
		});

		this.view.toolbar.add({
			key: 'load_services',
			ui : new sakura.ui.Button({
				label : 'LOAD SERVICES',
				icon  : './icons/server.png',
				onClick: function () {
					this.loadServices();
				}.bind(this)
			}).disable()
		});

		this.view.toolbar.add({
			key: 'save',
			ui : new sakura.ui.Button({
				label : 'SAVE'.__(),
				icon  : './icons/disk.png',
				onClick: function () {
					this.confirmSave();
				}.bind(this)
			}).disable()
		});

		return this;
	},

	draw: function _draw() {
		this.view.content.className = '';
		this.view.content.update();

		new Ajax.Request('./api/config.json', {
			method: 'get',
			onSuccess: function (t) {
				try {
					this.data.config = t.responseText.evalJSON();
				} catch (e) {
					flagrate.createModal({
						title: '設定読込エラー',
						text : 'config.json のJSON解析に失敗しました。既存のテキスト編集画面で確認してください。'
					}).open();
					this.data.config = {};
				}

				this.render();
				this.view.toolbar.one('save').enable();
				this.view.toolbar.one('load_services').enable();
			}.bind(this),
			onFailure: function (t) {
				this.view.content.updateText('config.json の読み込みに失敗しました (' + t.status + ')');
			}.bind(this)
		});

		return this;
	},

	render: function _render() {
		var container = new Element('div', { className: 'config2-page' }).setStyle({
			padding  : '10px',
			maxWidth : '1280px',
			boxSizing: 'border-box'
		});

		var notice = new Element('div', { className: 'sakura-alert sakura-alert-info' });
		notice.insert(new Element('div').update(
			'Gamma Configuration を基準にした構造化設定画面です。保存時は既存の config.json 形式へ戻します。' +
			'不明なキーは保持します。旧Twitter通知系はoperator本体から切り離し済みです。詳細編集は従来の config.json 画面を使用してください。'
		));
		container.insert(notice);

		container.insert(this.createBasicSection());
		container.insert(this.createRecordingSection());
		container.insert(this.createHistorySection());
		container.insert(this.createWuiSection());
		container.insert(this.createServiceSection());
		container.insert(this.createRawSection());

		this.view.content.update();
		this.view.content.insert(container);
		this.updateRawPreview();
		return this;
	},

	createPanel: function _createPanel(title, note) {
		var panel = new Element('div', { className: 'panel panel-default config2-panel' }).setStyle({
			marginBottom: '12px',
			background  : '#fff',
			border     : '1px solid #ddd',
			borderRadius: '3px',
			overflow    : 'hidden'
		});
		var head = new Element('div', { className: 'panel-heading' }).setStyle({
			padding   : '7px 10px',
			background: '#f2f2f2',
			borderBottom: '1px solid #ddd',
			fontWeight: 'bold'
		});
		var body = new Element('div', { className: 'panel-body' }).setStyle({
			padding: '10px'
		});

		head.update(title.escapeHTML ? title.escapeHTML() : title);
		panel.insert(head);
		if (note) {
			body.insert(new Element('div').setStyle({
				fontSize: '12px',
				color: '#666',
				marginBottom: '8px'
			}).update(note.escapeHTML ? note.escapeHTML() : note));
		}
		panel.insert(body);
		panel.body = body;
		return panel;
	},

	createHelpButton: function _createHelpButton(title, text) {
		var button = new Element('button', {
			type     : 'button',
			className: 'config2-help-button',
			title    : ''
		}).setStyle({
			width       : '18px',
			minWidth    : '18px',
			height      : '18px',
			lineHeight  : '16px',
			padding     : '0',
			margin      : '0 0 0 5px',
			border      : '1px solid #aaa',
			borderRadius: '9px',
			background  : '#f7f7f7',
			color       : '#555',
			fontSize    : '11px',
			fontWeight  : 'bold',
			cursor      : 'help',
			textAlign   : 'center',
			flex        : '0 0 auto',
			position    : 'relative'
		});
		var popup = null;
		var closeTimer = null;
		var closePopup = function _closePopup() {
			if (closeTimer) {
				clearTimeout(closeTimer);
				closeTimer = null;
			}
			closeTimer = setTimeout(function () {
				if (popup) {
					popup.remove();
					popup = null;
				}
			}, 120);
		};
		var openPopup = function _openPopup() {
			var rect;
			if (closeTimer) {
				clearTimeout(closeTimer);
				closeTimer = null;
			}
			if (popup) {
				return;
			}
			popup = new Element('div', { className: 'config2-help-popup' }).setStyle({
				position    : 'fixed',
				zIndex      : '30000',
				maxWidth    : '420px',
				minWidth    : '260px',
				padding     : '8px 10px',
				background  : 'rgba(40,40,40,0.96)',
				color       : '#fff',
				borderRadius: '4px',
				boxShadow   : '0 2px 8px rgba(0,0,0,0.35)',
				fontSize    : '12px',
				lineHeight   : '1.55',
				whiteSpace   : 'pre-wrap',
				wordBreak    : 'break-word'
			});
			popup.insert(new Element('div').setStyle({
				fontWeight   : 'bold',
				marginBottom : '4px',
				color        : '#d7fff8'
			}).update(String(title || '説明').escapeHTML()));
			popup.insert(new Element('div').update(String(text || '').escapeHTML()));
			document.body.insert(popup);
			rect = button.getBoundingClientRect();
			popup.setStyle({
				left: Math.min(rect.left + 22, window.innerWidth - 440).toString(10) + 'px',
				top : Math.min(rect.top - 4, window.innerHeight - popup.getHeight() - 12).toString(10) + 'px'
			});
			popup.observe('mouseenter', function () {
				if (closeTimer) {
					clearTimeout(closeTimer);
					closeTimer = null;
				}
			});
			popup.observe('mouseleave', closePopup);
		};

		button.update('?');
		button.observe('mouseenter', openPopup);
		button.observe('mouseleave', closePopup);
		button.observe('focus', openPopup);
		button.observe('blur', closePopup);
		button.observe('click', function (e) {
			e.stop();
			openPopup();
		});

		return button;
	},

	createFieldRow: function _createFieldRow(label, key, input, note) {
		var row = new Element('div', { className: 'config2-row' }).setStyle({
			display: 'flex',
			alignItems: 'center',
			gap: '8px',
			marginBottom: '7px',
			minHeight: '28px'
		});
		var labelWrap = new Element('div', { className: 'config2-label-wrap' }).setStyle({
			display: 'flex',
			alignItems: 'center',
			width: '230px',
			minWidth: '230px',
			boxSizing: 'border-box'
		});
		var lab = new Element('label').setStyle({
			flex: '1 1 auto',
			minWidth: '0',
			fontWeight: 'normal',
			margin: '0',
			overflow: 'hidden',
			whiteSpace: 'nowrap',
			textOverflow: 'ellipsis'
		}).update(label);
		var inputWrap = new Element('div').setStyle({
			flex: '1 1 auto',
			minWidth: '0'
		});

		if (key) {
			input.writeAttribute('data-config-key', key);
			input.addClassName('config2-input');
		}
		inputWrap.insert(input);
		if (note) {
			labelWrap.insert(lab);
			labelWrap.insert(this.createHelpButton(label, note));
		} else {
			labelWrap.insert(lab);
		}
		row.insert(labelWrap);
		row.insert(inputWrap);
		return row;
	},

	textInput: function _textInput(key, width) {
		var input = new Element('input', { type: 'text' }).setStyle({
			width: width || '100%',
			boxSizing: 'border-box'
		});
		var val = this.data.config[key];
		input.value = (typeof val === 'undefined' || val === null) ? '' : String(val);
		return input;
	},

	numberInput: function _numberInput(key, width) {
		var input = new Element('input', { type: 'number' }).setStyle({
			width: width || '140px',
			boxSizing: 'border-box'
		});
		var val = this.data.config[key];
		input.value = (typeof val === 'undefined' || val === null) ? '' : String(val);
		return input;
	},

	checkboxInput: function _checkboxInput(key) {
		var label = new Element('label').setStyle({ margin: '0' });
		var input = new Element('input', { type: 'checkbox' });
		input.checked = this.data.config[key] === true;
		input.writeAttribute('data-config-key', key);
		input.addClassName('config2-input');
		label.insert(input);
		label.insert(' 有効');
		return label;
	},

	checkboxDefaultTrueInput: function _checkboxDefaultTrueInput(key) {
		var label = new Element('label').setStyle({ margin: '0' });
		var input = new Element('input', { type: 'checkbox' });
		input.checked = this.data.config[key] !== false;
		input.writeAttribute('data-config-key', key);
		input.addClassName('config2-input');
		label.insert(input);
		label.insert(' 有効');
		return label;
	},

	selectInput: function _selectInput(key, options, emptyLabel) {
		var select = new Element('select').setStyle({ width: '360px', maxWidth: '100%', boxSizing: 'border-box' });
		var current = this.data.config[key];
		var empty = new Element('option', { value: '' }).update(emptyLabel || '(未指定)');
		select.insert(empty);
		options.each(function (opt) {
			var o = new Element('option', { value: opt.value }).update(opt.label);
			if (String(current) === String(opt.value)) {
				o.selected = true;
			}
			select.insert(o);
		});
		return select;
	},

	textareaInput: function _textareaInput(key, rows) {
		var textarea = new Element('textarea').setStyle({
			width: '100%',
			height: ((rows || 4) * 22).toString(10) + 'px',
			boxSizing: 'border-box',
			fontFamily: 'monospace'
		});
		var val = this.data.config[key];
		if (typeof val === 'undefined' || val === null) {
			textarea.value = '';
		} else if (typeof val === 'string') {
			textarea.value = val;
		} else {
			textarea.value = Object.toJSON(val);
		}
		return textarea;
	},

	createBasicSection: function _createBasicSection() {
		var panel = this.createPanel('基本設定', 'uid/gid、Mirakurun接続、VAAPIなど。空欄の任意項目は保存時に削除します。');
		panel.body.insert(this.createFieldRow('uid', 'uid', this.textInput('uid', '220px'), 'rootで起動した場合の降格先uid。'));
		panel.body.insert(this.createFieldRow('gid', 'gid', this.textInput('gid', '220px'), 'VAAPI利用時などに必要。例: video'));
		panel.body.insert(this.createFieldRow('mirakurunPath', 'mirakurunPath', this.textInput('mirakurunPath'), '例: http+unix://%2Fvar%2Frun%2Fmirakurun.sock/ または http://127.0.0.1:40772/'));
		panel.body.insert(this.createFieldRow('vaapiEnabled', null, this.checkboxInput('vaapiEnabled'), 'ffmpegでVAAPIを使う場合に有効化。'));
		panel.body.insert(this.createFieldRow('vaapiDevice', 'vaapiDevice', this.textInput('vaapiDevice'), '例: /dev/dri/renderD128'));
		return panel;
	},

	createRecordingSection: function _createRecordingSection() {
		var panel = this.createPanel('録画設定', '保存先、録画ファイル名、囲み文字置換、Unicode正規化、空き容量処理。');
		panel.body.insert(this.createFieldRow('recordedDir', 'recordedDir', this.textInput('recordedDir'), '録画保存先。相対パスまたはフルパス。'));
		panel.body.insert(this.createFieldRow('temporaryDir', 'temporaryDir', this.textInput('temporaryDir'), '録画中や一時処理で使う保存先。recordedDir と分ける場合に指定。'));
		panel.body.insert(this.createFieldRow('recordedFormat', 'recordedFormat', this.textInput('recordedFormat'), '録画ファイル名フォーマット。番組名、日時、チャンネル名などを使った保存名の規則。'));
		panel.body.insert(this.createFieldRow('recordedNameReplaceEnclosingCharacters', null, this.checkboxInput('recordedNameReplaceEnclosingCharacters'), '録画ファイル名に含まれる番組表の囲み文字を、[字] [再] [新] などの表記へ置き換えます。対象例: 🈑→[字]、🈞→[再]、🈟→[新]、🈡→[終]、🈓→[デ]、🈔→[二]、🈕→[多]、🈖→[解]、🈙→[映]、㊙→[秘]、㊗→[祝] など。録画ファイル名だけに効き、番組データ自体は変更しません。'));
		panel.body.insert(this.createFieldRow('recordedNameEnclosingCharacterMap', 'recordedNameEnclosingCharacterMap', this.textareaInput('recordedNameEnclosingCharacterMap', 4), '囲み文字置換の追加・上書き用JSONオブジェクトです。空欄の場合は既定の置き換え一覧を使用します。指定したキーは既定値へ追加・上書きされます。例: {"🈑":"[字幕]","SS":"[SS]"}'));
		panel.body.insert(this.createFieldRow('recordedCommand', 'recordedCommand', this.textareaInput('recordedCommand', 3), '録画コマンド。空欄ならChinachu標準の録画処理を使用。独自ffmpeg/rivarun等を使う場合のみ指定。'));
		panel.body.insert(this.createFieldRow('normalizationForm', 'normalizationForm', this.selectInput('normalizationForm', [
			{ value: 'NFC', label: 'NFC - くっつける・標準' },
			{ value: 'NFD', label: 'NFD - バラバラにする' },
			{ value: 'NFKC', label: 'NFKC - 見た目もそろえて・くっつける（既定）' },
			{ value: 'NFKD', label: 'NFKD - 見た目もそろえて・バラバラにする' }
		], '(未指定: NFKC)'), '予約ルールと番組情報をマッチさせるため、比較前に全角・半角などの文字の取扱いをそろえる設定です。既定はNFKCです。\nNFC: 「か」+「゛」を1文字の「が」にします。一般的なWebサイトやシステムでよく使われる形です。\nNFD: 1文字の「が」を「か」+「゛」に分けます。Macのファイルシステム内部処理などで見られる形です。\nNFKC: 全角/半角の違いや特殊記号を普通の文字に寄せてからくっつけます。検索や入力フォームの表記ゆれ対策向きです。\nNFKD: 特殊記号を普通の文字に寄せたうえで、さらにバラバラに分けます。録画ファイル名の置換とは別です。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceThresholdMB', 'storageLowSpaceThresholdMB', this.numberInput('storageLowSpaceThresholdMB'), '空き容量の閾値(MB)。この値を下回った場合に storageLowSpaceAction が動作対象になります。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceAction', 'storageLowSpaceAction', this.selectInput('storageLowSpaceAction', [
			{ value: 'none', label: 'none - ログのみ（削除しない）' },
			{ value: 'stop', label: 'stop - 録画中番組を停止' },
			{ value: 'remove', label: 'remove' }
		], '(未指定)'), '空き容量が閾値を下回ったときの本体動作です。removeは config.recordedDir 直下の通常ファイルから、最も古い .ts / .m2ts を1件だけ削除します。サブフォルダ、シンボリックリンク、リンク先、別マウント配下は追跡しません。これらを使う構成では remove を使わず、none と storageLowSpaceCommand 等で個別対応してください。storageLowSpaceCommand と storageLowSpaceNotifyTo はこの値とは独立して動作します。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceNotifyTo', 'storageLowSpaceNotifyTo', this.textInput('storageLowSpaceNotifyTo'), '空き容量が閾値を下回ったときに送るメール通知の宛先です。storageLowSpaceAction が remove の場合は、config.recordedDir 直下の最も古い .ts / .m2ts を1件削除する処理とは別に通知します。旧メール通知のため、今後はWebhookや外部コマンド通知への置き換え推奨です。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceCommand', 'storageLowSpaceCommand', this.textareaInput('storageLowSpaceCommand', 3), '空き容量不足時に実行するコマンド。Slack/Webhook通知スクリプトや削除処理を外部化する場合に使用します。'));
		return panel;
	},

	createHistorySection: function _createHistorySection() {
		var panel = this.createPanel('履歴・照合設定', 'match.json / reserves2.json / recorded.json の履歴保持設定です。0は整理しない、未指定時は内部デフォルト365日です。録画ファイル自体は削除しません。');
		panel.body.insert(this.createFieldRow('matchRetentionDays', 'matchRetentionDays', this.numberInput('matchRetentionDays'), 'match.json の保持日数。予約履歴と録画結果の照合台帳を何日残すかを指定します。0なら整理しません。未指定時は365日です。'));
		panel.body.insert(this.createFieldRow('reserves2RetentionDays', 'reserves2RetentionDays', this.numberInput('reserves2RetentionDays'), 'reserves2.json の保持日数。予約履歴スナップショットを何日残すかを指定します。0なら整理しません。未指定時は365日です。'));
		panel.body.insert(this.createFieldRow('recordedHistoryRetentionDays', 'recordedHistoryRetentionDays', this.numberInput('recordedHistoryRetentionDays'), 'recorded.json 上の録画済み履歴エントリの保持日数です。実TSファイルや録画保存先ファイルは削除しません。0なら整理しません。未指定時は365日です。'));
		panel.body.insert(this.createFieldRow('matchKeepRecordedSnapshot', null, this.checkboxDefaultTrueInput('matchKeepRecordedSnapshot'), 'recorded.json の情報を match.json の recordingResult に厚めに残します。recorded.json を短くする運用では有効推奨です。未指定時は有効扱いです。'));
		panel.body.insert(this.createFieldRow('programViewShowMatchDebug', null, this.checkboxInput('programViewShowMatchDebug'), '番組詳細画面に match.json の詳細メタ情報（recordingResult / reservationMeta / recd_flg / sources など）を表示します。通常運用では無効推奨です。'));
		return panel;
	},

	createWuiSection: function _createWuiSection() {
		var panel = this.createPanel('WUI/API設定', 'Gammaでは wuiOpen* が主、wuiHost/wuiPort/wuiUsers 等は廃止予定扱いです。');
		panel.body.insert(this.createFieldRow('wuiOpenServer', null, this.checkboxInput('wuiOpenServer'), 'LAN用の無認証サーバー。'));
		panel.body.insert(this.createFieldRow('wuiOpenHost', 'wuiOpenHost', this.textInput('wuiOpenHost'), '自動でうまくいかない場合のIPv4アドレス。'));
		panel.body.insert(this.createFieldRow('wuiOpenPort', 'wuiOpenPort', this.numberInput('wuiOpenPort'), '例: 20772'));
		panel.body.insert(this.createFieldRow('wuiHost', 'wuiHost', this.textInput('wuiHost'), '廃止予定。'));
		panel.body.insert(this.createFieldRow('wuiPort', 'wuiPort', this.numberInput('wuiPort'), '廃止予定。'));
		panel.body.insert(this.createFieldRow('wuiUsers', 'wuiUsers', this.textareaInput('wuiUsers', 4), 'JSON配列で指定。廃止予定。'));
		panel.body.insert(this.createFieldRow('wuiAllowCountries', 'wuiAllowCountries', this.textareaInput('wuiAllowCountries', 3), 'JSON配列で指定。廃止予定。'));
		panel.body.insert(this.createFieldRow('wuiTlsKeyPath', 'wuiTlsKeyPath', this.textInput('wuiTlsKeyPath'), '廃止予定。'));
		panel.body.insert(this.createFieldRow('wuiTlsCertPath', 'wuiTlsCertPath', this.textInput('wuiTlsCertPath'), '廃止予定。'));
		panel.body.insert(this.createFieldRow('wuiXFF', null, this.checkboxInput('wuiXFF'), 'X-Forwarded-For。廃止予定。'));
		return panel;
	},

	createServiceSection: function _createServiceSection() {
		var panel = this.createPanel('サービス設定', 'Mirakurun /api/services を読み込み、excludeServices / serviceOrder へ保存します。除外サービスはボタンから一覧画面を開いて選択します。');
		var buttonRow = new Element('div').setStyle({
			display: 'flex',
			gap: '4px',
			alignItems: 'center',
			marginBottom: '8px',
			flexWrap: 'wrap'
		});
		var selectButton = new Element('button', { type: 'button' }).update('除外サービスを選択');
		var summary = new Element('div').setStyle({ fontSize: '12px', color: '#666', margin: '6px 0' });

		this.view.serviceSummary = summary;
		this.view.serviceGrid = null;
		this.view.serviceSearch = null;
		this.view.serviceTypeSelect = null;
		this.view.serviceOnlyExcluded = null;
		this.view.serviceOnlyNonType1 = null;

		buttonRow.insert(selectButton);
		panel.body.insert(buttonRow);
		panel.body.insert(summary);

		selectButton.observe('click', function () {
			this.openServiceSelectorWithLoad();
		}.bind(this));

		this.updateServiceSummary();
		return panel;
	},

	createRawSection: function _createRawSection() {
		var panel = this.createPanel('保存プレビュー', '保存時に生成する config.json の確認用です。');
		var pre = new Element('textarea', { readonly: 'readonly' }).setStyle({
			width: '100%',
			height: '220px',
			boxSizing: 'border-box',
			fontFamily: 'monospace',
			fontSize: '12px'
		});
		this.view.rawPreview = pre;
		var button = new Element('button', { type: 'button' }).update('プレビュー更新').setStyle({ marginBottom: '6px' });
		button.observe('click', function () { this.updateRawPreview(); }.bind(this));
		panel.body.insert(button);
		panel.body.insert(pre);
		return panel;
	},

	loadServices: function _loadServices(callback) {
		var path = String(this.data.config.mirakurunPath || '').replace(/\/$/, '');
		if (!path) {
			flagrate.createModal({ title: 'Mirakurun未設定', text: 'mirakurunPath が未設定です。JSON貼り付けで読み込むか、mirakurunPath を設定してください。' }).open();
			if (callback) { callback(false); }
			return;
		}

		new Ajax.Request(path + '/api/services', {
			method: 'get',
			onSuccess: function (t) {
				var ok = this.readServicesFromText(t.responseText);
				if (callback) { callback(ok === true); }
			}.bind(this),
			onFailure: function (t) {
				flagrate.createModal({
					title: 'サービス取得失敗',
					text : 'Mirakurun /api/services の取得に失敗しました (' + t.status + ')。ブラウザから直接読めない場合は、Chinachu側に中継APIを追加する必要があります。'
				}).open();
				if (callback) { callback(false); }
			}.bind(this)
		});
	},

	readServicesFromText: function _readServicesFromText(text) {
		var raw;
		try {
			raw = text.evalJSON();
		} catch (e) {
			flagrate.createModal({ title: 'JSON解析失敗', text: 'services JSON の解析に失敗しました。' }).open();
			return false;
		}
		if (!Object.isArray(raw)) {
			flagrate.createModal({ title: '形式エラー', text: 'services JSON は配列である必要があります。' }).open();
			return false;
		}
		this.data.services = this.normalizeServices(raw);
		this.data.serviceLoaded = true;
		this.renderServices();
		return true;
	},

	normalizeServices: function _normalizeServices(raw) {
		var exclude = this.data.config.excludeServices || [];
		var order = this.data.config.serviceOrder || [];
		var orderMap = {};
		var excludeMap = {};
		var result = [];

		exclude.each(function (id) { excludeMap[String(id)] = true; });
		order.each(function (id, index) { orderMap[String(id)] = index + 1; });

		raw.each(function (s) {
			var ch = s.channel || {};
			result.push({
				id        : Number(s.id),
				name      : String(s.name || ''),
				type      : String(ch.type || ''),
				channel   : String(ch.channel || ''),
				serviceId : Number(s.serviceId),
				networkId : Number(s.networkId),
				serviceType: Number(s.type),
				remoteControlKeyId: (typeof s.remoteControlKeyId === 'undefined') ? '' : String(s.remoteControlKeyId),
				hasLogoData: s.hasLogoData === true,
				excluded  : excludeMap[String(s.id)] === true,
				order     : orderMap[String(s.id)] || ''
			});
		});

		result.sort(function (a, b) {
			var typeOrder = { GR: 1, BS: 2, CS: 3, SKY: 4 };
			var ao = typeOrder[a.type] || 99;
			var bo = typeOrder[b.type] || 99;
			if (ao !== bo) { return ao - bo; }
			if (a.channel !== b.channel) { return a.channel.localeCompare(b.channel); }
			if (a.serviceId !== b.serviceId) { return a.serviceId - b.serviceId; }
			return a.name.localeCompare(b.name);
		});

		return result;
	},

	updateServiceSummary: function _updateServiceSummary() {
		if (!this.view.serviceSummary) { return; }
		if (!this.data.services || this.data.services.length === 0) {
			this.view.serviceSummary.update('services 未読込');
			return;
		}
		this.view.serviceSummary.update('services: ' + this.data.services.length + ' 件 / 除外選択: ' + this.data.services.findAll(function (s) { return s.excluded === true; }).length + ' 件');
	},

	openServiceSelectorWithLoad: function _openServiceSelectorWithLoad() {
		var loadingModal;

		if (this.data.services && this.data.services.length > 0) {
			this.openServiceSelector();
			return;
		}

		loadingModal = flagrate.createModal({
			title: 'services 読込中',
			text : 'Mirakurun から services を読み込んでいます...'
		}).open();

		this.loadServices(function (ok) {
			try { loadingModal.close(); } catch (e) {}
			if (ok === true) {
				this.openServiceSelector();
			}
		}.bind(this));
	},


	openServiceSelector: function _openServiceSelector() {
		var wrapper;
		var toolbar;
		var selectNonType1Button;
		var clearExcludeButton;
		var clearOrderButton;
		var summary;
		var listWrap;
		var modal;
		var getColumnCount;
		var render;

		if (!this.data.services || this.data.services.length === 0) {
			flagrate.createModal({ title: 'services 未読込', text: '先に Mirakurun から services を読み込んでください。' }).open();
			return;
		}

		wrapper = new Element('div').setStyle({
			width: '100%',
			maxWidth: '100%',
			boxSizing: 'border-box',
			minWidth: '0',
			overflowX: 'hidden'
		});
		toolbar = new Element('div').setStyle({
			display: 'flex',
			gap: '6px',
			alignItems: 'center',
			marginBottom: '6px',
			flexWrap: 'wrap',
			maxWidth: '100%',
			boxSizing: 'border-box'
		});
		selectNonType1Button = new Element('button', { type: 'button' }).update('特殊サービスを除外');
		clearExcludeButton = new Element('button', { type: 'button' }).update('除外をクリア');
		clearOrderButton = new Element('button', { type: 'button' }).update('順序をクリア');
		summary = new Element('div').setStyle({ fontSize: '12px', color: '#666', margin: '4px 0 6px' });
		listWrap = new Element('div', { className: 'config2-service-list-wrap' }).setStyle({
			width: '100%',
			maxWidth: '100%',
			boxSizing: 'border-box',
			minWidth: '0',
			overflowX: 'hidden',
			overflowY: 'auto',
			maxHeight: 'calc(100vh - 260px)',
			border: '1px solid #ddd',
			padding: '6px',
			background: '#fafafa'
		});

		getColumnCount = function _getColumnCount() {
			var width = window.innerWidth || document.documentElement.clientWidth || 1024;

			// 幅の実測値は flagrate.Modal 内部の要素と見た目の白枠でズレる場合があるため、
			// ここでは列数だけをビューポート幅から安全側に決める。
			// table-layout: fixed により、列は白枠内へ均等に収める。
			if (width >= 900) {
				return 3;
			}
			if (width >= 620) {
				return 2;
			}
			return 1;
		};

		toolbar.insert(selectNonType1Button);
		toolbar.insert(clearExcludeButton);
		toolbar.insert(clearOrderButton);
		wrapper.insert(toolbar);
		wrapper.insert(summary);
		wrapper.insert(listWrap);

		render = function () {
			var count = 0;
			var columns = getColumnCount();
			var table = new Element('table').setStyle({
				width: '100%',
				maxWidth: '100%',
				tableLayout: 'fixed',
				borderCollapse: 'separate',
				borderSpacing: '5px',
				boxSizing: 'border-box'
			});
			var tbody = new Element('tbody');
			var row = null;
			var col = 0;

			listWrap.update();
			this.data.services.each(function (svc) {
				var cell;
				if (col === 0) {
					row = new Element('tr');
					tbody.insert(row);
				}
				cell = new Element('td').setStyle({
					width: (100 / columns).toString(10) + '%',
					verticalAlign: 'top',
					padding: '0',
					boxSizing: 'border-box',
					minWidth: '0',
					maxWidth: '0',
					overflow: 'hidden'
				});
				cell.insert(this.createServiceCard(svc, render));
				row.insert(cell);
				count++;
				col++;
				if (col >= columns) {
					col = 0;
				}
			}.bind(this));

			if (row && col > 0) {
				while (col < columns) {
					row.insert(new Element('td').setStyle({ padding: '0' }));
					col++;
				}
			}

			table.insert(tbody);
			listWrap.insert(table);
			summary.update('表示: ' + count + ' 件 / 除外選択: ' + this.data.services.findAll(function (s) { return s.excluded === true; }).length + ' 件');
			this.updateServiceSummary();
			this.updateRawPreview();
		}.bind(this);

		selectNonType1Button.observe('click', function () {
			this.data.services.each(function (svc) {
				if (Number(svc.serviceType) !== 1) {
					svc.excluded = true;
				}
			});
			render();
		}.bind(this));
		clearExcludeButton.observe('click', function () {
			this.data.services.each(function (svc) { svc.excluded = false; });
			render();
		}.bind(this));
		clearOrderButton.observe('click', function () {
			this.data.services.each(function (svc) { svc.order = ''; });
			render();
		}.bind(this));

		modal = flagrate.createModal({
			title: '除外サービス選択',
			text: '',
			buttons: [
				{
					label: '閉じる',
					onSelect: function (e, modal) { modal.close(); }
				}
			]
		}).open();

		// モーダル外枠の幅を無理に広げず、flagrate が作った白枠の実幅内だけで描画する。
		modal.content.update();
		modal.content.setStyle({
			boxSizing: 'border-box',
			maxWidth: '100%',
			overflowX: 'hidden'
		});
		modal.content.insert(wrapper);

		// flagrate.Modal のDOM反映後に実測する。即時描画だと幅が小さく取られ、1列判定になる場合がある。
		setTimeout(render, 0);
	},


	renderServices: function _renderServices() {
		var grid = this.view.serviceGrid;
		if (!grid) {
			this.updateServiceSummary();
			return;
		}
		var keyword = this.view.serviceSearch ? String(this.view.serviceSearch.value || '').toLowerCase() : '';
		var filterType = this.view.serviceTypeSelect ? String(this.view.serviceTypeSelect.value || '') : '';
		var onlyExcluded = this.view.serviceOnlyExcluded && this.view.serviceOnlyExcluded.checked;
		var onlyNonType1 = this.view.serviceOnlyNonType1 && this.view.serviceOnlyNonType1.checked;
		var count = 0;
		var excludedCount = 0;

		grid.update();

		if (!this.data.services || this.data.services.length === 0) {
			grid.insert(new Element('div').setStyle({ color: '#777', padding: '8px' }).update('Mirakurun services を読み込んでください。'));
			if (this.view.serviceSummary) {
				this.view.serviceSummary.update('services 未読込');
			}
			return;
		}

		this.data.services.each(function (svc) {
			var hay = [svc.id, svc.name, svc.type, svc.channel, svc.serviceId, svc.networkId, svc.serviceType].join(' ').toLowerCase();
			if (filterType && svc.type !== filterType) { return; }
			if (onlyExcluded && !svc.excluded) { return; }
			if (onlyNonType1 && Number(svc.serviceType) === 1) { return; }
			if (keyword && hay.indexOf(keyword) === -1) { return; }

			count++;
			if (svc.excluded) { excludedCount++; }
			grid.insert(this.createServiceCard(svc));
		}.bind(this));

		if (this.view.serviceSummary) {
			this.view.serviceSummary.update('表示: ' + count + ' 件 / 除外選択: ' + this.data.services.findAll(function (s) { return s.excluded; }).length + ' 件');
		}
	},


	createServiceLogo: function _createServiceLogo(svc) {
		var basePath = String(this.data.config.mirakurunPath || '').replace(/\/$/, '');
		var box = new Element('span', { className: 'config2-service-logo' }).setStyle({
			width: '32px',
			minWidth: '32px',
			height: '24px',
			display: 'inline-flex',
			alignItems: 'center',
			justifyContent: 'center',
			border: '1px solid #ddd',
			background: '#fff',
			boxSizing: 'border-box',
			overflow: 'hidden',
			fontSize: '11px',
			color: '#999'
		});
		var img;

		if (!svc.hasLogoData || !basePath || /^http\+unix:/.test(basePath) || /^http:\/\/unix:/.test(basePath)) {
			box.update('□');
			return box;
		}

		img = new Element('img', {
			src: basePath + '/api/services/' + svc.id + '/logo',
			alt: String(svc.name || '')
		}).setStyle({
			maxWidth: '30px',
			maxHeight: '22px',
			display: 'block'
		});
		img.observe('error', function () {
			box.update('▣');
		});
		box.insert(img);
		return box;
	},

	createServiceCard: function _createServiceCard(svc, onChange) {
		var card = new Element('div', { className: 'config2-service-card' }).setStyle({
			display: 'flex',
			alignItems: 'flex-start',
			gap: '5px',
			padding: svc.excluded ? '4px 5px' : '5px 6px',
			border: svc.excluded ? '2px solid #0b7d77' : '1px solid #ccc',
			background: svc.excluded ? '#e9f6f4' : '#fff',
			borderRadius: '3px',
			boxSizing: 'border-box',
			minWidth: '0',
			maxWidth: '100%',
			overflow: 'hidden',
			cursor: 'pointer'
		});
		var check = new Element('input', { type: 'checkbox' }).setStyle({
			marginTop: '4px',
			flex: '0 0 auto'
		});
		var icon = this.createServiceLogo(svc).setStyle({
			marginTop: '0',
			flex: '0 0 auto'
		});
		var body = new Element('div').setStyle({
			flex: '1 1 auto',
			minWidth: '0',
			overflow: 'hidden'
		});
		var firstLine = new Element('div').setStyle({
			display: 'flex',
			alignItems: 'center',
			gap: '6px',
			minWidth: '0'
		});
		var title = new Element('div').setStyle({
			flex: '1 1 auto',
			minWidth: '0',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			fontWeight: svc.excluded ? 'bold' : 'normal'
		}).update(String(svc.name || '').escapeHTML());
		var orderWrap = new Element('label').setStyle({
			display: 'inline-flex',
			alignItems: 'center',
			gap: '3px',
			fontSize: '11px',
			color: '#666',
			whiteSpace: 'nowrap',
			flex: '0 0 auto',
			margin: '0'
		});
		var meta = new Element('div').setStyle({
			fontSize: '11px',
			color: '#666',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			marginTop: '1px'
		}).update((svc.channel + ' SID' + svc.serviceId + ' type:' + svc.serviceType).escapeHTML());
		var order = new Element('input', { type: 'number', min: '1', placeholder: '-' }).setStyle({
			width: '42px',
			boxSizing: 'border-box',
			height: '20px'
		});

		var refresh = function () {
			if (typeof onChange === 'function') {
				onChange();
			} else {
				this.renderServices();
			}
		}.bind(this);

		check.checked = svc.excluded === true;
		order.value = svc.order ? String(svc.order) : '';

		check.observe('change', function () {
			svc.excluded = check.checked;
			refresh();
		}.bind(this));
		order.observe('change', function () {
			svc.order = String(order.value || '');
			refresh();
		}.bind(this));
		order.observe('keyup', function () {
			svc.order = String(order.value || '');
			refresh();
		}.bind(this));
		card.observe('click', function (e) {
			var tag = e.target && e.target.tagName;
			if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA') {
				return;
			}
			svc.excluded = !svc.excluded;
			refresh();
		}.bind(this));

		orderWrap.insert('順');
		orderWrap.insert(order);
		firstLine.insert(title);
		firstLine.insert(orderWrap);
		body.insert(firstLine);
		body.insert(meta);
		card.insert(check);
		card.insert(icon);
		card.insert(body);
		card.writeAttribute('title', [svc.name, svc.type + '/' + svc.channel, 'SID:' + svc.serviceId, 'network:' + svc.networkId, 'service type:' + svc.serviceType, 'id:' + svc.id].join(' / '));
		return card;
	},

	collectConfig: function _collectConfig() {
		var config = Object.extend({}, this.data.config || {});
		var inputs = this.view.content.select('.config2-input');
		var optionalObjectKeys = {
			wuiUsers: true,
			wuiAllowCountries: true,
			recordedNameEnclosingCharacterMap: true
		};
		var numericKeys = {
			wuiOpenPort: true,
			wuiPort: true,
			storageLowSpaceThresholdMB: true,
			matchRetentionDays: true,
			reserves2RetentionDays: true,
			recordedHistoryRetentionDays: true
		};
		var booleanKeys = {
			vaapiEnabled: true,
			recordedNameReplaceEnclosingCharacters: true,
			wuiOpenServer: true,
			wuiXFF: true,
			matchKeepRecordedSnapshot: true,
			programViewShowMatchDebug: true
		};
		var errors = [];

		inputs.each(function (input) {
			var key = input.readAttribute('data-config-key');
			var value;
			if (!key) { return; }
			if (booleanKeys[key]) {
				config[key] = input.checked === true;
				return;
			}
			value = String(input.value || '');
			if (value === '') {
				delete config[key];
				return;
			}
			if (numericKeys[key]) {
				config[key] = Number(value);
				return;
			}
			if (optionalObjectKeys[key]) {
				try {
					config[key] = value.evalJSON();
				} catch (e) {
					errors.push(key + ' は正しいJSONで指定してください。');
				}
				return;
			}
			config[key] = value;
		});

		['matchRetentionDays', 'reserves2RetentionDays', 'recordedHistoryRetentionDays'].each(function (key) {
			if (typeof config[key] === 'undefined') {
				return;
			}

			if (isNaN(config[key]) || config[key] < 0 || Math.floor(config[key]) !== config[key]) {
				errors.push(key + ' は0以上の整数で指定してください。');
			}
		});

		if (this.data.services && this.data.services.length > 0) {
			config.excludeServices = this.data.services.findAll(function (svc) {
				return svc.excluded === true;
			}).map(function (svc) {
				return Number(svc.id);
			});

			config.serviceOrder = this.data.services.findAll(function (svc) {
				return String(svc.order || '') !== '';
			}).sort(function (a, b) {
				return Number(a.order) - Number(b.order);
			}).map(function (svc) {
				return Number(svc.id);
			});
		}

		if (errors.length > 0) {
			throw new Error(errors.join('\n'));
		}
		return config;
	},

	updateRawPreview: function _updateRawPreview() {
		if (!this.view.rawPreview) { return; }
		try {
			this.view.rawPreview.value = JSON.stringify(this.collectConfig(), null, '\t');
		} catch (e) {
			this.view.rawPreview.value = 'ERROR: ' + e.message;
		}
	},

	confirmSave: function _confirmSave() {
		var config;
		var json;
		try {
			config = this.collectConfig();
			json = JSON.stringify(config, null, '\t');
		} catch (e) {
			flagrate.createModal({ title: '入力エラー', text: e.message }).open();
			return;
		}
		var modal = flagrate.createModal({
			title: '設定の保存',
			text : 'config.json を保存します。設定を反映させるにはサービスの再起動やスケジューラー再実行が必要な場合があります。',
			buttons: [
				{
					label: '保存',
					color: '@orange',
					onSelect: function (e, modal) {
						modal.buttons.each(function (a) { a.button.disable(); });
						this.saveConfig(json, modal);
					}.bind(this)
				},
				{
					label: 'キャンセル',
					onSelect: function (e, modal) { modal.close(); }
				}
			]
		}).open();
	},

	saveConfig: function _saveConfig(json, modal) {
		modal.content.updateText('設定を保存しています...');
		new Ajax.Request('./api/config.json', {
			method: 'put',
			parameters: { json: json },
			onComplete: function () {
				modal.close();
			},
			onSuccess: function () {
				flagrate.createModal({ title: '完了', text: '設定を保存しました。反映には再起動またはスケジューラー再実行が必要な場合があります。' }).open();
				this.data.config = json.evalJSON();
				this.render();
			}.bind(this),
			onFailure: function (t) {
				flagrate.createModal({ title: '失敗', text: '設定の保存に失敗しました (' + t.status + ')' }).open();
			}
		});
	}
});
