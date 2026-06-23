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
		var select = new Element('select').setStyle({ width: '180px' });
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
		panel.body.insert(this.createFieldRow('recordedNameReplaceEnclosingCharacters', null, this.checkboxInput('recordedNameReplaceEnclosingCharacters'), '録画ファイル名に含まれる番組表の囲み文字を [字] [再] [新] などの表記へ置換します。録画ファイル名だけに効き、番組データ自体は変更しません。'));
		panel.body.insert(this.createFieldRow('recordedNameEnclosingCharacterMap', 'recordedNameEnclosingCharacterMap', this.textareaInput('recordedNameEnclosingCharacterMap', 4), '囲み文字置換の追加・上書き用JSONオブジェクト。例: {"🈑":"[字]","🈞":"[再]","SS":"[SS]"}。通常は空欄で既定mapを使用します。'));
		panel.body.insert(this.createFieldRow('recordedCommand', 'recordedCommand', this.textareaInput('recordedCommand', 3), '録画コマンド。空欄ならChinachu標準の録画処理を使用。独自ffmpeg/rivarun等を使う場合のみ指定。'));
		panel.body.insert(this.createFieldRow('normalizationForm', 'normalizationForm', this.selectInput('normalizationForm', [
			{ value: 'NFC', label: 'NFC - 正準合成' },
			{ value: 'NFD', label: 'NFD - 正準分解' },
			{ value: 'NFKC', label: 'NFKC - 互換分解後に合成' },
			{ value: 'NFKD', label: 'NFKD - 互換分解' }
		], '(無変換)'), '予約ルール照合時の文字列正規化。録画ファイル名の置換とは別です。未指定なら変換しません。NFKCは全角英数・互換文字なども寄せるため日本語の表記揺れ対策に向きますが、見た目や文字幅が変わる場合があります。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceThresholdMB', 'storageLowSpaceThresholdMB', this.numberInput('storageLowSpaceThresholdMB'), '空き容量の閾値(MB)。この値を下回った場合に storageLowSpaceAction が動作対象になります。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceAction', 'storageLowSpaceAction', this.selectInput('storageLowSpaceAction', [
			{ value: 'none', label: 'none - ログのみ' },
			{ value: 'stop', label: 'stop - 録画中番組を停止' },
			{ value: 'remove', label: 'remove - 古い録画を削除' }
		], '(未指定)'), '閾値を下回ったときの本体動作。removeは自動削除を伴うため注意。storageLowSpaceCommand と storageLowSpaceNotifyTo はこの値とは独立して動作します。'));
		panel.body.insert(this.createFieldRow('storageLowSpaceNotifyTo', 'storageLowSpaceNotifyTo', this.textInput('storageLowSpaceNotifyTo'), '旧メール通知の送信先。nodemailer依存を外す場合は無効化対象。今後はWebhookや外部コマンド通知へ置き換え推奨です。'));
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
		var panel = this.createPanel('サービス設定', 'Mirakurun /api/services を直接読み込み、excludeServices / serviceOrder へ保存します。除外は一覧カードから選択します。');
		var toolbar = new Element('div').setStyle({
			display: 'flex',
			gap: '6px',
			alignItems: 'center',
			marginBottom: '8px',
			flexWrap: 'wrap'
		});
		var search = new Element('input', { type: 'text', placeholder: '検索' }).setStyle({ width: '240px' });
		var typeSelect = new Element('select').setStyle({ width: '90px' });
		var onlyExcluded = new Element('label').setStyle({ margin: '0 8px 0 0' });
		var onlyNonType1 = new Element('label').setStyle({ margin: '0 8px 0 0' });
		var grid = new Element('div', { className: 'config2-service-grid' }).setStyle({
			display: 'grid',
			gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
			gap: '5px',
			maxHeight: '420px',
			overflowY: 'auto',
			border: '1px solid #ddd',
			padding: '6px',
			background: '#fafafa'
		});
		var loadButton = new Element('button', { type: 'button' }).update('Mirakurunから読み込む').setStyle({ marginRight: '4px' });
		var selectNonType1Button = new Element('button', { type: 'button' }).update('type != 1 を除外選択').setStyle({ marginRight: '4px' });
		var clearExcludeButton = new Element('button', { type: 'button' }).update('除外をクリア').setStyle({ marginRight: '4px' });
		var clearOrderButton = new Element('button', { type: 'button' }).update('順序をクリア');
		var summary = new Element('div').setStyle({ fontSize: '12px', color: '#666', margin: '6px 0' });

		['すべて', 'GR', 'BS', 'CS', 'SKY'].each(function (type) {
			var opt = new Element('option', { value: type === 'すべて' ? '' : type }).update(type);
			typeSelect.insert(opt);
		});
		onlyExcluded.insert(new Element('input', { type: 'checkbox' }));
		onlyExcluded.insert(' 除外のみ');
		onlyNonType1.insert(new Element('input', { type: 'checkbox' }));
		onlyNonType1.insert(' type!=1');

		this.view.serviceSearch = search;
		this.view.serviceTypeSelect = typeSelect;
		this.view.serviceOnlyExcluded = onlyExcluded.down('input');
		this.view.serviceOnlyNonType1 = onlyNonType1.down('input');
		this.view.serviceGrid = grid;
		this.view.serviceSummary = summary;

		toolbar.insert(search);
		toolbar.insert(typeSelect);
		toolbar.insert(onlyExcluded);
		toolbar.insert(onlyNonType1);
		panel.body.insert(toolbar);
		panel.body.insert(new Element('div').setStyle({ marginBottom: '6px' }).insert(loadButton).insert(selectNonType1Button).insert(clearExcludeButton).insert(clearOrderButton));
		panel.body.insert(summary);
		panel.body.insert(grid);

		search.observe('keyup', this.renderServices.bind(this));
		typeSelect.observe('change', this.renderServices.bind(this));
		this.view.serviceOnlyExcluded.observe('change', this.renderServices.bind(this));
		this.view.serviceOnlyNonType1.observe('change', this.renderServices.bind(this));

		loadButton.observe('click', function () {
			this.loadServices();
		}.bind(this));
		selectNonType1Button.observe('click', function () {
			this.data.services.each(function (svc) {
				if (Number(svc.serviceType) !== 1) {
					svc.excluded = true;
				}
			});
			this.renderServices();
		}.bind(this));
		clearExcludeButton.observe('click', function () {
			this.data.services.each(function (svc) { svc.excluded = false; });
			this.renderServices();
		}.bind(this));
		clearOrderButton.observe('click', function () {
			this.data.services.each(function (svc) { svc.order = ''; });
			this.renderServices();
		}.bind(this));

		this.renderServices();
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

	loadServices: function _loadServices() {
		var path = String(this.data.config.mirakurunPath || '').replace(/\/$/, '');
		if (!path) {
			flagrate.createModal({ title: 'Mirakurun未設定', text: 'mirakurunPath が未設定です。JSON貼り付けで読み込むか、mirakurunPath を設定してください。' }).open();
			return;
		}

		new Ajax.Request(path + '/api/services', {
			method: 'get',
			onSuccess: function (t) {
				this.readServicesFromText(t.responseText);
			}.bind(this),
			onFailure: function (t) {
				flagrate.createModal({
					title: 'サービス取得失敗',
					text : 'Mirakurun /api/services の取得に失敗しました (' + t.status + ')。ブラウザから直接読めない場合は、Chinachu側に中継APIを追加する必要があります。'
				}).open();
			}.bind(this)
		});
	},

	readServicesFromText: function _readServicesFromText(text) {
		var raw;
		try {
			raw = text.evalJSON();
		} catch (e) {
			flagrate.createModal({ title: 'JSON解析失敗', text: 'services JSON の解析に失敗しました。' }).open();
			return;
		}
		if (!Object.isArray(raw)) {
			flagrate.createModal({ title: '形式エラー', text: 'services JSON は配列である必要があります。' }).open();
			return;
		}
		this.data.services = this.normalizeServices(raw);
		this.data.serviceLoaded = true;
		this.renderServices();
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

	renderServices: function _renderServices() {
		var grid = this.view.serviceGrid;
		if (!grid) { return; }
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

	createServiceCard: function _createServiceCard(svc) {
		var card = new Element('div', { className: 'config2-service-card' }).setStyle({
			display: 'flex',
			alignItems: 'center',
			gap: '6px',
			padding: svc.excluded ? '5px 6px' : '6px 7px',
			border: svc.excluded ? '2px solid #0b7d77' : '1px solid #ccc',
			background: svc.excluded ? '#e9f6f4' : '#fff',
			borderRadius: '3px',
			boxSizing: 'border-box',
			minWidth: '0'
		});
		var check = new Element('input', { type: 'checkbox' });
		var icon = new Element('span').setStyle({
			width: '28px',
			minWidth: '28px',
			textAlign: 'center',
			fontSize: '12px',
			opacity: svc.hasLogoData ? '1' : '0.45'
		}).update(svc.hasLogoData ? '▣' : '□');
		var name = new Element('div').setStyle({
			flex: '1 1 auto',
			minWidth: '0',
			overflow: 'hidden'
		});
		var title = new Element('div').setStyle({
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			fontWeight: svc.excluded ? 'bold' : 'normal'
		}).update(String(svc.name || '').escapeHTML());
		var meta = new Element('div').setStyle({
			fontSize: '11px',
			color: '#666',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis'
		}).update((svc.type + '/' + svc.channel + ' SID' + svc.serviceId + ' type:' + svc.serviceType + ' id:' + svc.id).escapeHTML());
		var order = new Element('input', { type: 'number', min: '1', placeholder: '-' }).setStyle({
			width: '54px',
			boxSizing: 'border-box'
		});

		check.checked = svc.excluded === true;
		order.value = svc.order ? String(svc.order) : '';

		check.observe('change', function () {
			svc.excluded = check.checked;
			this.renderServices();
		}.bind(this));
		order.observe('change', function () {
			svc.order = String(order.value || '');
		}.bind(this));
		order.observe('keyup', function () {
			svc.order = String(order.value || '');
		}.bind(this));

		name.insert(title);
		name.insert(meta);
		card.insert(check);
		card.insert(icon);
		card.insert(name);
		card.insert(new Element('span').setStyle({ fontSize: '11px', color: '#666' }).update('順'));
		card.insert(order);
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
