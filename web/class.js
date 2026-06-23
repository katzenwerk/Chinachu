/*jslint browser:true, nomen:true, plusplus:true, regexp:true, vars:true */
/*global $, Prototype, Ajax, Class, Element, sakura, flagrate, dateFormat */
(function () {

	"use strict";

	// for debug
	var PARAM = window.location.search.replace('?', '').toQueryParams();
	var DEBUG = (PARAM.debug === 'on');
	var console = {};
	if ((typeof window.console !== 'object') || (DEBUG === false)) {
		console = {
			log       : Prototype.emptyFunction,
			debug     : Prototype.emptyFunction,
			info      : Prototype.emptyFunction,
			warn      : Prototype.emptyFunction,
			error     : Prototype.emptyFunction,
			assert    : Prototype.emptyFunction,
			dir       : Prototype.emptyFunction,
			dirxml    : Prototype.emptyFunction,
			trace     : Prototype.emptyFunction,
			group     : Prototype.emptyFunction,
			groupEnd  : Prototype.emptyFunction,
			time      : Prototype.emptyFunction,
			timeEnd   : Prototype.emptyFunction,
			profile   : Prototype.emptyFunction,
			profileEnd: Prototype.emptyFunction,
			count     : Prototype.emptyFunction
		};
	} else {
		console = window.console;
	}

	// global
	var global = window.global;

	// chinachu global scope
	if (typeof window.chinachu !== 'undefined') {
		console.error('[conflict]', 'chinachu is already defined.');

		return false;
	}
	var chinachu = window.chinachu = {};

	console.info('[welcome]', 'initializing chinachu class.');

	// Objectをディープコピー
	var objectCloner = chinachu.objectCloner = function _objectCloner(object) {
		return Object.toJSON(object).evalJSON();
	};

	// Dateオブジェクトを見やすい文字列に変換する
	var dateToString = chinachu.dateToString = function _dateToString(date, type) {
		var d = date;

		var dStr = (d.getMonth() + 1).toPaddedString(2) + "/" + d.getDate().toPaddedString(2);

		if (d.getFullYear() !== new Date().getFullYear()) {
			dStr = d.getFullYear().toString(10).slice(2) + "/" + dStr;
		}

		var weekDays = ["日", "月", "火", "水", "木", "金", "土"];
		dStr += " (" + weekDays[d.getDay()] + ")";

		dStr += ' ' + [
			d.getHours().toPaddedString(2),
			d.getMinutes().toPaddedString(2)
		].join(':');

		var dDelta = ((new Date().getTime() - d.getTime()) / 1000);
		var dDeltaStr = '';

		if (dDelta < 0) {
			dDelta -= dDelta * 2;

			if (dDelta < 60) {
				dDeltaStr = 'after {0} seconds'.__([Math.round(dDelta) || '0']);
			} else {
				dDelta = dDelta / 60;

				if (dDelta < 60) {
					dDeltaStr = 'after {0} minutes'.__([Math.round(dDelta) || '0']);
				} else {
					dDelta = dDelta / 60;

					if (dDelta < 24) {
						dDeltaStr = 'after {0} hours'.__([Math.round(dDelta * 10) / 10 || '0']);
					} else {
						dDelta = dDelta / 24;

						dDeltaStr = 'after {0} days'.__([Math.round(dDelta) || '0']);
					}
				}
			}
		} else {
			if (dDelta < 60) {
				dDeltaStr = '{0} seconds ago'.__([Math.round(dDelta) || '0']);
			} else {
				dDelta = dDelta / 60;

				if (dDelta < 60) {
					dDeltaStr = '{0} minutes ago'.__([Math.round(dDelta) || '0']);
				} else {
					dDelta = dDelta / 60;

					if (dDelta < 24) {
						dDeltaStr = '{0} hours ago'.__([Math.round(dDelta * 10) / 10 || '0']);
					} else {
						dDelta = dDelta / 24;

						dDeltaStr = '{0} days ago'.__([Math.round(dDelta) || '0']);
					}
				}
			}
		}

		if (typeof type === 'undefined' || type === 'full') {
			return dStr + ' [' + dDeltaStr + ']';
		} else if (type === 'short') {
			return dStr;
		} else if (type === 'delta') {
			return dDeltaStr;
		}
	};

	// inputType
	var createTextElement = function _createTextElement(tagName, text, attr) {
		var element = new Element(tagName, attr || {});
		element.appendChild(document.createTextNode((typeof text === 'undefined' || text === null) ? '' : String(text)));
		return element;
	};

	var normalizeArray = function _normalizeArray(val) {
		if (!val) {
			return [];
		}
		if (Object.prototype.toString.call(val) === '[object Array]') {
			return val.compact ? val.compact() : val;
		}
		return [val];
	};

	var getChannelsForSelector = function _getChannelsForSelector() {
		var channels = normalizeArray(global.chinachu.schedule);
		var typeOrder = {
			GR : 1,
			BS : 2,
			CS : 3,
			SKY: 4
		};

		channels = channels.slice(0);
		channels.sort(function (a, b) {
			var aType = typeOrder[a.type] || 99;
			var bType = typeOrder[b.type] || 99;
			var aName = a.name || a.channel || a.id || '';
			var bName = b.name || b.channel || b.id || '';

			if (aType !== bType) {
				return aType - bType;
			}
			if ((a.channel || '') !== (b.channel || '')) {
				return String(a.channel || '').localeCompare(String(b.channel || ''));
			}
			return String(aName).localeCompare(String(bName));
		});

		return channels;
	};

	var getChannelSelectorValues = function _getChannelSelectorValues(ch, values) {
		var keys = [];
		if (ch.id) {
			keys.push(String(ch.id));
		}
		if (ch.channel) {
			keys.push(String(ch.channel));
		}
		if (ch.type && (typeof ch.sid !== 'undefined')) {
			keys.push(String(ch.type) + '_' + String(ch.sid));
		}

		var i;
		for (i = 0; i < keys.length; i++) {
			if (values.indexOf(keys[i]) !== -1) {
				return true;
			}
		}

		return false;
	};

	var makeChannelSelectorMeta = function _makeChannelSelectorMeta(ch) {
		var type = ch.type || '-';
		var sid = (typeof ch.sid === 'undefined' || ch.sid === null) ? '-' : String(ch.sid);
		var channel = (typeof ch.channel === 'undefined' || ch.channel === null) ? '' : String(ch.channel);
		var channelDigits = channel.replace(/\D/g, '');

		if (type === 'GR' && channelDigits !== '') {
			return type + sid;
		}

		return type + sid;
	};


	var createChannelSelectorLogo = function _createChannelSelectorLogo(ch, id) {
		var createFallback = function _createFallback() {
			return createTextElement('span', '▣', { className: 'channel-selector-logo' }).setStyle({
				width      : '22px',
				minWidth   : '22px',
				height     : '18px',
				lineHeight  : '18px',
				textAlign  : 'center',
				marginRight: '5px',
				fontSize   : '10px',
				opacity    : '0.8',
				flex       : '0 0 auto'
			});
		};

		var channelId = String(id || (ch && ch.id) || '');
		var logo;

		if (!ch || ch.hasLogoData !== true || channelId === '') {
			return createFallback();
		}

		logo = new Element('img', {
			className: 'channel-selector-logo',
			src      : './api/channel/' + encodeURIComponent(channelId) + '/logo.png'
		}).setStyle({
			width      : '34px',
			minWidth   : '34px',
			height     : '22px',
			objectFit  : 'contain',
			marginRight: '6px',
			flex       : '0 0 auto'
		});

		logo.observe('error', function () {
			logo.replace(createFallback());
		});

		return logo;
	};

	var openChannelSelector = function _openChannelSelector(title, currentValues, onApply, sourceElement) {
		var values = normalizeArray(currentValues).map(function (v) {
			return String(v);
		});
		var selected = {};
		var channels = getChannelsForSelector();
		var getBaseModalWidth = function _getBaseModalWidth(el) {
			var node = el;
			var width = 0;
			var rect;
			var i = 0;

			while (node && node !== document.body && i < 16) {
				if (node.getBoundingClientRect) {
					rect = node.getBoundingClientRect();

					if (rect.width > width && rect.width > 600 && rect.width < window.innerWidth - 40) {
						width = rect.width;
					}
				}

				node = node.parentNode;
				i++;
			}

			if (!width) {
				width = Math.min(1180, Math.max(760, window.innerWidth - 220));
			}

			return Math.floor(width);
		};
		var baseSelectorWidth = getBaseModalWidth(sourceElement);
		var selectorWidth = Math.max(760, Math.min(baseSelectorWidth - 24, window.innerWidth - 220));

		var content = new Element('div', { className: 'channel-selector' }).setStyle({
			width     : '100%',
			maxWidth  : '100%',
			boxSizing : 'border-box',
			overflowX : 'hidden'
		});
		var toolbar = new Element('div', { className: 'channel-selector-toolbar' }).setStyle({
			marginBottom: '8px',
			display     : 'flex',
			alignItems  : 'center',
			gap         : '8px',
			width       : '100%',
			boxSizing   : 'border-box'
		});
		var search = new Element('input', {
			type       : 'text',
			placeholder: '検索'
		}).setStyle({
			width    : '260px',
			maxWidth : 'calc(100% - 100px)',
			boxSizing: 'border-box'
		});
		var typeSelect = new Element('select').setStyle({
			width: '90px'
		});
		var columnCount = 4;

		if (selectorWidth < 1000) {
			columnCount = 3;
		}
		if (selectorWidth < 740) {
			columnCount = 2;
		}
		if (selectorWidth < 520) {
			columnCount = 1;
		}

		var grid = new Element('div', { className: 'channel-selector-grid' }).setStyle({
			display            : 'grid',
			gridTemplateColumns: 'repeat(' + columnCount + ', minmax(0, 1fr))',
			gap                : '4px 4px',
			maxHeight          : 'calc(100vh - 260px)',
			paddingRight       : '30px',
			paddingLeft       : '10px',
			overflowY          : 'auto',
			overflowX          : 'hidden',
			boxSizing           : 'border-box',
			width              : '100%',
			maxWidth           : '100%'
		});
		var i;

		['すべて', 'GR', 'BS', 'CS', 'SKY'].each(function (type) {
			var option = new Element('option', { value: type === 'すべて' ? '' : type });
			option.appendChild(document.createTextNode(type));
			typeSelect.insert(option);
		});

		for (i = 0; i < channels.length; i++) {
			if (getChannelSelectorValues(channels[i], values)) {
				selected[String(channels[i].id)] = true;
			}
		}

		var render = function _render() {
			var keyword = String(search.value || '').toLowerCase();
			var filterType = String(typeSelect.value || '');

			grid.update();

			channels.each(function (ch) {
				var id = String(ch.id || '');
				var name = String(ch.name || ch.channel || ch.id || '');
				var meta = makeChannelSelectorMeta(ch);
				var haystack = [
					id,
					name,
					ch.type || '',
					ch.channel || '',
					meta
				].join(' ').toLowerCase();

				if (filterType && ch.type !== filterType) {
					return;
				}
				if (keyword && haystack.indexOf(keyword) === -1) {
					return;
				}

				var label = new Element('div', { className: 'channel-selector-item' }).setStyle({
					display     : 'flex',
					alignItems  : 'center',
					minHeight   : '30px',
					padding     : '3px 5px',
					border      : '1px solid #ccc',
					borderRadius: '3px',
					cursor      : 'pointer',
					boxSizing   : 'border-box',
					overflow    : 'hidden',
					userSelect  : 'none',
					minWidth    : '0',
					maxWidth    : '100%',
					width       : '100%'
				});

				var logo = createChannelSelectorLogo(ch, id);
				var text = new Element('span', { className: 'channel-selector-text' }).setStyle({
					display    : 'flex',
					alignItems : 'center',
					whiteSpace : 'nowrap',
					overflow   : 'hidden',
					fontSize   : '11px',
					lineHeight  : '1.25',
					minWidth   : '0',
					width      : '100%',
					flex       : '1 1 auto'
				});
				var nameSpan = createTextElement('span', name, { className: 'channel-selector-name' }).setStyle({
					marginRight : '3px',
					overflow    : 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace  : 'nowrap',
					minWidth    : '0',
					flex        : '1 1 auto'
				});
				var metaSpan = createTextElement('span', meta, { className: 'channel-selector-meta' }).setStyle({
					opacity   : '0.75',
					marginLeft: '5px',
					minWidth  : '52px',
					textAlign : 'right',
					fontSize  : '10px',
					whiteSpace: 'nowrap',
					flex      : '0 0 auto'
				});

				var updateSelectedStyle = function _updateSelectedStyle() {
					if (selected[id]) {
						label.setStyle({
							border    : '2px solid #0b7d77',
							padding   : '2px 4px',
							background: '#e9f6f4'
						});
					} else {
						label.setStyle({
							border    : '1px solid #ccc',
							padding   : '3px 5px',
							background: '#fff'
						});
					}
				};

				label.observe('click', function () {
					if (selected[id]) {
						delete selected[id];
					} else {
						selected[id] = true;
					}
					updateSelectedStyle();
				});

				label.writeAttribute('title', [
					name,
					meta,
					'channel: ' + (ch.channel || '-'),
					'id: ' + id,
					'nid: ' + (typeof ch.nid === 'undefined' ? '-' : ch.nid)
				].join(' / '));

				text.insert(nameSpan);
				text.insert(metaSpan);

				label.insert(logo);
				label.insert(text);
				updateSelectedStyle();

				grid.insert(label);
			});
		};

		search.observe('keyup', render);
		typeSelect.observe('change', render);

		toolbar.insert(search);
		toolbar.insert(typeSelect);
		content.insert(toolbar);
		content.insert(grid);

		render();

		var modal = new flagrate.Modal({
			title  : title || 'チャンネル選択',
			element: content,
			buttons: [
				{
					label  : '反映',
					className: 'primary-teal',
					onSelect: function (e, modal) {
						var result = [];

						channels.each(function (ch) {
							var id = String(ch.id || '');
							if (selected[id]) {
								result.push(id);
							}
						});

						onApply(result);
						modal.close();
					}
				},
				{
					label: 'キャンセル',
					onSelect: function (e, modal) {
						modal.close();
					}
				}
			]
		}).show();

		setTimeout(function () {
			var width = selectorWidth;
			var node = content.parentNode;
			var rect;
			var i = 0;

			while (node && node !== document.body && i < 8) {
				if (node.getBoundingClientRect && node.setStyle) {
					rect = node.getBoundingClientRect();

					if (rect.width > 0 && rect.width < window.innerWidth - 80) {
						node.setStyle({
							width    : width + 'px',
							maxWidth : 'calc(100vw - 220px)',
							boxSizing: 'border-box'
						});
					}
				}

				node = node.parentNode;
				i++;
			}

			content.setStyle({
				width    : '100%',
				maxWidth : '100%',
				boxSizing: 'border-box'
			});
		}, 0);
	};

	var formInputTypeChannels = {
		create: function () {
			var tokenizer = flagrate.createTokenizer({
				placeholder: '...',
				tokenize: function (input) {
					var candidates = global.chinachu.schedule.pluck('id').concat(global.chinachu.schedule.pluck('channel'));

					var i, l;
					for (i = 0, l = global.chinachu.schedule.length; i < l; i++) {
						candidates.push(global.chinachu.schedule[i]['type'] + '_' + global.chinachu.schedule[i]['sid']);
					}

					for (i = 0, l = candidates.length; i < l; i++) {
						if (input.match(/^[a-z0-9_]+$/i) === null) {
							candidates[i] = null;
						} else if (candidates[i].match(new RegExp('^' + input)) === null) {
							candidates[i] = null;
						}
					}

					candidates = candidates.compact();

					return candidates;
				}
			});
			var wrapper = new Element('div', { className: 'channel-tokenizer-with-selector' }).setStyle({
				display   : 'flex',
				alignItems: 'center',
				gap       : '6px',
				width     : '100%'
			});
			var button = new Element('button', {
				type     : 'button',
				className: 'channel-selector-button'
			}).setStyle({
				minWidth: '56px'
			});

			button.appendChild(document.createTextNode('選択'));

			if (tokenizer.setStyle) {
				tokenizer.setStyle({
					flex: '1 1 auto'
				});
			} else if (tokenizer.element && tokenizer.element.setStyle) {
				tokenizer.element.setStyle({
					flex: '1 1 auto'
				});
			}

			if (tokenizer.insertTo) {
				tokenizer.insertTo(wrapper);
			} else {
				wrapper.insert(tokenizer.element || tokenizer);
			}

			wrapper.insert(button);

			button.observe('click', function () {
				openChannelSelector('チャンネル選択', tokenizer.getValues(), function (values) {
					tokenizer.setValues(values);
				}, wrapper);
			});

			wrapper.getValues = function () {
				return tokenizer.getValues();
			};
			wrapper.setValues = function (val) {
				tokenizer.setValues(val || []);
				return wrapper;
			};
			wrapper.enable = function () {
				if (tokenizer.enable) {
					tokenizer.enable();
				}
				button.disabled = false;
				return wrapper;
			};
			wrapper.disable = function () {
				if (tokenizer.disable) {
					tokenizer.disable();
				}
				button.disabled = true;
				return wrapper;
			};

			return wrapper;
		},
		getVal: function () {
			return this.element.getValues();
		},
		setVal: function (val) {
			this.element.setValues(val);
		},
		enable: function () {
			this.element.enable();
		},
		disable: function () {
			this.element.disable();
		}
	};
	var formInputTypeStrings = {
		create: function () {
			return flagrate.createTokenizer({
				placeholder: '...'
			});
		},
		getVal: function () {
			return this.element.getValues();
		},
		setVal: function (val) {
			this.element.setValues(val);
		},
		enable: function () {
			this.element.enable();
		},
		disable: function () {
			this.element.disable();
		}
	};

	var util = chinachu.util = {};

	/** section: util
	 * class util
	**/

	/**
	 *  util.scotify(program) -> String
	 *  - program (Program Object): Program Data.
	 *
	 *  プログラムデータをSCOT形式の文字列にします
	**/
	util.scotify = function (program) {
		var scot = '';

		scot = program.channel.name + ': ' + program.title +
			' (' + dateToString(new Date(program.start), 'short') + ') ' +
			'[chinachu://' + program.id + ']';

		return scot;
	};

	/**
	 *  util.getProgramById(programId) -> Program Object | null
	 *  - programId (String): Program ID.
	 *
	 *  プログラムIDでプログラムデータを取得します
	**/
	util.getProgramById = function (id) {
		var i, l, j, m;

		for (i = 0, l = global.chinachu.recorded.length; i < l; i++) {
			if (global.chinachu.recorded[i].id === id) {
				global.chinachu.recorded[i]._isRecorded = true;
				return global.chinachu.recorded[i];
			}
		}

		for (i = 0, l = global.chinachu.recording.length; i < l; i++) {
			if ((global.chinachu.recording[i].id === id) && (global.chinachu.recording[i].pid)) {
				global.chinachu.recording[i]._isRecording = true;
				return global.chinachu.recording[i];
			}
		}

		for (i = 0, l = global.chinachu.reserves.length; i < l; i++) {
			if (global.chinachu.reserves[i].id === id) {
				global.chinachu.reserves[i]._isReserves = true;
				return global.chinachu.reserves[i];
			}
		}

		for (i = 0; i < global.chinachu.schedule.length; i++) {
			for (j = 0, m = global.chinachu.schedule[i].programs.length; j < m; j++) {
				if (global.chinachu.schedule[i].programs[j].id === id) {
					return global.chinachu.schedule[i].programs[j];
				}
			}
		}

		return null;
	};

	/**
	 *  util.getNextProgramById(programId) -> Program Object | null
	 *  - programId (String): Program ID.
	 *
	 *  プログラムIDの次のプログラムを取得します
	**/
	util.getNextProgramById = function (id) {
		var i, l, j, m;

		for (i = 0, l = global.chinachu.schedule.length; i < l; i++) {
			for (j = 0, m = global.chinachu.schedule[i].programs.length; j < m; j++) {
				if (global.chinachu.schedule[i].programs[j].id === id) {
					if (typeof global.chinachu.schedule[i].programs[j + 1] !== 'undefined') {
						return util.getProgramById(global.chinachu.schedule[i].programs[j + 1].id);
					}
				}
			}
		}

		return null;
	};

	/**
	 *  util.getPrevProgramById(programId) -> Program Object | null
	 *  - programId (String): Program ID.
	 *
	 *  プログラムIDの前のプログラムを取得します
	**/
	util.getPrevProgramById = function (id) {
		var i, l, j, m;

		for (i = 0, l = global.chinachu.schedule.length; i < l; i++) {
			for (j = 0, m = global.chinachu.schedule[i].programs.length; j < m; j++) {
				if (global.chinachu.schedule[i].programs[j].id === id) {
					if (j - 1 < 0) { return null; }

					if (typeof global.chinachu.schedule[i].programs[j - 1] !== 'undefined') {
						return util.getProgramById(global.chinachu.schedule[i].programs[j - 1].id);
					}
				}
			}
		}

		return null;
	};

	var api = chinachu.api = {};

	/** section: api
	 * class chinachu.api.Client
	**/
	api.Client = Class.create({

		/**
		 *  new chinachu.api.Client(parameter) -> chinachu.api.Client
		 *  - parameter (Object)
		 *
		 *  ##### Parameter
		 *
		 *  * `apiRoot`          (String; default `"./"`):
		 *  * `retryCount`       (Number; default `0`):
		 *  * `onRequest`        (Function):
		 *  * `onRequested`      (Function):
		**/
		initialize: function _initApiClient(p) {
			this.apiRoot = p.apiRoot || './';

			this.onCreateRequest   = p.onCreateRequest   || Prototype.emptyFunction;
			this.onCompleteRequest = p.onCompleteRequest || Prototype.emptyFunction;

			this.requestCount = 0;
			this.requestTable = [];

			this.optionalRequestHeaders = [];
			this.optionalRequestParameter = {};

			return this;
		},

		request: function _requestApiClient(url, p, retryCount) {
			// 完全なURLかどうかを判定
			if (url.match(/^http/) === null) {
				url = this.apiRoot + url;
			}

			var param  = p.param  || {};
			var method = p.method || 'get';

			var requestHeaders = [
				'X-Chinachu-Client-Version', '3'
			].concat(this.optionalRequestHeaders);

			param = Object.extend(param, {
				Count: param.Count || 0
			});

			param = Object.extend(param, this.optionalRequestParameter);

			// インクリメント
			++this.requestCount;

			retryCount  = retryCount || this.retryCount;

			var requestState = this.requestTable[this.requestCount] = {
				id         : this.requestCount,
				requestedAt: new Date().getTime(),
				createdAt  : null,
				completedAt: null,
				latency    : null,
				execution  : null,
				transport  : null,
				param      : param,
				method     : method.toUpperCase(),
				headers    : requestHeaders,
				url        : url,
				p          : p,
				status     : 'init'
			};

			var dummy = new Ajax.Request(url, {
				method        : method,
				requestHeaders: requestHeaders,
				parameters    : Object.toJSON(param).replace(/%/g, '\\u0025'),

				// リクエスト作成時
				onCreate: function _onCreateRequest(t) {
					requestState.status    = 'create';
					requestState.transport = t;

					console.log('api.Client', 'req#' + requestState.id, '(create)', '->', requestState.method, url.replace(this.apiRoot, ''), t);

					requestState.createdAt = new Date().getTime();

					if (p.onCreate) { p.onCreate(t); }

					this.onCreateRequest(t);

					document.fire('chinachu:api:client:request:create', requestState);
				}.bind(this),

				// リクエスト完了時
				onComplete: function _onCompleteRequest(t) {
					requestState.status      = 'complete';
					requestState.transport   = t;
					requestState.completedAt = new Date().getTime();
					requestState.execution   = Math.round((t.getHeader('X-Sakura-Proxy-Microtime') || 0) / 1000);
					requestState.latency     = requestState.completedAt - requestState.createdAt;

					var time = [requestState.execution, requestState.latency].join('|') + 'ms';

					console.log('api.Client', 'req#' + requestState.id, time, '<-', requestState.method, url.replace(this.apiRoot, ''), t.status, t.statusText, t);

					var res = t.responseJSON || {};

					// 結果を評価
					var isSuccess = ((t.status >= 200) && (t.status < 300));
					if (isSuccess) {

						// 成功コールバック
						if (p.onSuccess) { p.onSuccess(t, res); }
					}

					var isFailure = !isSuccess;
					if (isFailure) {

						// 失敗コールバック
						if (p.onFailure) { p.onFailure(t, res); }
					}

					// 最後に完了時の処理を
					if (p.onComplete) { p.onComplete(t, res); }

					this.onCompleteRequest(t, res);

					document.fire('chinachu:api:client:request:complete', requestState);
				}.bind(this)
			});

			return this;
		}
	});

	var ui = chinachu.ui = {};

	ui.ContentLoading = Class.create({
		initialize: function (opt) {
			if (!opt) { opt = {}; }

			this.progress   = 0;
			this.target     = document.body;
			this.onComplete = opt.onComplete || function _empty() {};

			this.create();

			return this;
		},
		create: function _draw() {
			this.entity = {
				container: new Element('div', {className: 'content-loading'}),
				frame    : new Element('div'),
				bar      : new Element('div')
			};

			this.entity.container.insert(this.entity.frame);
			this.entity.frame.insert(this.entity.bar);

			this.redraw();

			return this;
		},
		update: function _update(num) {
			if (num >= 100) {
				setTimeout(this.onComplete, 0);

				num = 100;
			}

			this.progress = num;

			this.redraw();

			return this;
		},
		redraw: function _redraw() {
			this.entity.bar.setStyle({width: this.progress.toString(10) + '%'});

			return this;
		},
		render: function _render(target) {
			$(target.entity || target || this.target).insert({top: this.entity.container});

			return this;
		},
		remove: function _remove() {
			this.entity.bar.remove();
			this.entity.frame.remove();
			this.entity.container.remove();

			this.entity.bar       = null;
			this.entity.frame     = null;
			this.entity.container = null;

			delete this.entity;
			delete this.target;
			delete this.progress;

			return true;
		}
	});

	ui.DynamicTime = Class.create(sakura.ui.Element, {

		init: function (opt) {

			this.tagName = opt.tagName || 'span';

			this.time  = opt.time;
			this.timer = 0;
			this.type  = opt.type || 'delta';

			return this;
		},

		create: function () {

			var wait = 1;

			if (this.entity) {
				if (flagrate.Element.exists(this.entity) === false) {
					this.remove();
					return;
				}
			} else {
				this.entity = new Element(this.tagName, this.attr);
			}

			if (this.id !== null) { this.entity.id = this.id; }

			if (this.style !== null) { this.entity.setStyle(this.style); }

			this.entity.className = 'dynamic-time';

			if (this.className !== null) { this.entity.addClassName(this.className); }

			this.entity.update(chinachu.dateToString(new Date(this.time), this.type));

			var delta = ((new Date().getTime() - this.time) / 1000);

			if (delta < 0) { delta -= delta * 2; }

			if (delta < 9600) { wait = 60 * 60; }
			if (delta < 4800) { wait = 60 * 30; }
			if (delta < 2400) { wait = 60 * 10; }
			if (delta < 1200) {
				wait = 60 * 5;
				this.entity.addClassName('soon');
			}
			if (delta < 360) { wait = 60; }
			if (delta < 120) {
				wait = 30;
				this.entity.addClassName('now');
			}
			if (delta < 60) { wait = 10; }
			if (delta < 30) { wait = 5; }
			if (delta < 10) { wait = 1; }

			this.timer = setTimeout(this.create.bind(this), wait * 1000);

			return this;
		},

		remove: function () {

			clearTimeout(this.timer);

			try {
				this.entity.remove();
				this.entity.fire('sakura:remove');
			} catch (e) {
				//console.debug(e);
			}

			return this;
		}
	});

	ui.ExecuteScheduler = Class.create({
		initialize: function () {
			this.create();

			return this;
		},
		create: function () {
			this.modal = new flagrate.Modal({
				title: 'スケジューラーの実行',
				text : '全てのルールと手動予約から競合を検出してスケジューリングを行います',
				buttons: [
					{
						label   : '実行',
						color   : '@orange',
						onSelect: function (e, modal) {
							this.button.disable();

							var dummy = new Ajax.Request('./api/scheduler.json', {
								method    : 'put',
								onComplete: function () {
									modal.close();
								},
								onSuccess: function (response) {
									var json = response.responseJSON;
									var conflictMsg = '';
									var title = '成功';
									if (Array.isArray(json.conflicts) && json.conflicts.length > 0) {
										conflictMsg = '。競合が' + json.conflicts.length + '件ありました';
										title = '競合検出';
									}
									new flagrate.Modal({
										title: title,
										text : 'スケジューラーを実行しました' + conflictMsg
									}).show();
								},
								onFailure: function (t) {
									new flagrate.Modal({
										title: '失敗',
										text : 'スケジューラーが失敗しました (' + t.status + ')'
									}).show();
								}
							});
						}
					},
					{
						label   : '中止',
						onSelect: function (e, modal) {
							modal.close();
						}
					}
				]
			});

			this.modal.show();

			return this;
		}
	});

	ui.Reserve = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) {
				this.modal = new flagrate.Modal({
					title: 'エラー',
					text : '番組が見つかりませんでした'
				});
			} else {
				var buttons = [];

				buttons.push({
					label   : '予約',
					color   : '@red',
					onSelect: function (e, modal) {
						e.targetButton.disable();

						var dummy = new Ajax.Request('./api/program/' + this.program.id + '.json', {
							method    : 'put',
							onComplete: function () {
								modal.close();
							},
							onSuccess: function () {
								new flagrate.Modal({
									title: '成功',
									text : '予約しました。'
								}).show();
							},
							onFailure: function (t) {
								new flagrate.Modal({
									title: '失敗',
									text : '予約に失敗しました (' + t.status + ')'
								}).show();
							}
						});
					}.bind(this)
				});

				if (false && this.program.channel.type === 'GR') {
					buttons.push({
						label   : '予約 (ワンセグ)',
						color   : '@red',
						onSelect: function (e, modal) {
							e.targetButton.disable();

							var dummy = new Ajax.Request('./api/program/' + this.program.id + '.json', {
								method    : 'put',
								parameters: {
									mode: '1seg'
								},
								onComplete: function () {
									modal.close();
								},
								onSuccess: function () {
									new flagrate.Modal({
										title: '成功',
										text : '予約しました。'
									}).show();
								},
								onFailure: function (t) {
									new flagrate.Modal({
										title: '失敗',
										text : '予約に失敗しました (' + t.status + ')'
									}).show();
								}
							});
						}.bind(this)
					});
				}

				buttons.push({
					label   : 'キャンセル',
					onSelect: function (e, modal) {
						modal.close();
					}
				});

				var bitrate = 0;
				if (this.program.channel.type === "GR") {
					bitrate = 16.851;
				} else if (this.program.channel.type === "SKY") {
					bitrate = 8;
				} else {
					bitrate = 24;
				}
				var size = Math.round(this.program.seconds * bitrate / 8);

				this.modal = new flagrate.Modal({
					title   : '手動予約',
					subtitle: this.program.title + ' #' + this.program.id,
					text    : '予約しますか？ (目安容量: ' + size + ' MB)',
					buttons : buttons
				});
			}

			this.modal.show();

			return this;
		}
	});

	ui.Unreserve = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) {
				this.modal = new flagrate.Modal({
					title: 'エラー',
					text : '番組が見つかりませんでした'
				});
			} else {
				this.modal = new flagrate.Modal({
					title   : '手動予約の取消',
					subtitle: this.program.title + ' #' + this.program.id,
					text    : '予約を取り消しますか？',
					buttons: [
						{
							label   : '予約取消',
							color   : '@red',
							onSelect: function (e, modal) {
								e.targetButton.disable();

								var dummy = new Ajax.Request('./api/reserves/' + this.program.id + '.json', {
									method    : 'delete',
									onComplete: function () {
										modal.close();
									},
									onSuccess: function () {
										new flagrate.Modal({
											title: '成功',
											text : '予約を取り消しました。'
										}).show();
									},
									onFailure: function (t) {
										new flagrate.Modal({
											title: '失敗',
											text : '予約の取消に失敗しました (' + t.status + ')'
										}).show();
									}
								});
							}.bind(this)
						},
						{
							label   : 'キャンセル',
							onSelect: function (e, modal) {
								modal.close();
							}
						}
					]
				});
			}

			this.modal.show();

			return this;
		}
	});

	ui.Skip = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) {
				this.modal = new flagrate.Modal({
					title: 'エラー',
					text : '番組が見つかりませんでした'
				});
			} else {
				this.modal = new flagrate.Modal({
					title   : 'スキップ',
					subtitle: this.program.title + ' #' + this.program.id,
					text    : '自動予約された今回の番組をスキップしますか？',
					buttons: [
						{
							label   : 'スキップ',
							color   : '@red',
							onSelect: function (e, modal) {
								e.targetButton.disable();

								var dummy = new Ajax.Request('./api/reserves/' + this.program.id + '/skip.json', {
									method    : 'put',
									onComplete: function () {
										modal.close();
									},
									onSuccess: function () {
										new flagrate.Modal({
											title: '成功',
											text : 'スキップを有効にしました。'
										}).show();
									},
									onFailure: function (t) {
										new flagrate.Modal({
											title: '失敗',
											text : 'スキップに失敗しました (' + t.status + ')'
										}).show();
									}
								});
							}.bind(this)
						},
						{
							label   : 'キャンセル',
							onSelect: function (e, modal) {
								modal.close();
							}
						}
					]
				});
			}

			this.modal.show();

			return this;
		}
	});

	ui.Unskip = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) {
				this.modal = new flagrate.Modal({
					title: 'エラー',
					text : '番組が見つかりませんでした'
				});
			} else {
				this.modal = new flagrate.Modal({
					title   : 'スキップの取消',
					subtitle: this.program.title + ' #' + this.program.id,
					text    : 'スキップを取り消しますか？',
					buttons: [
						{
							label   : 'スキップの取消',
							color   : '@red',
							onSelect: function (e, modal) {
								e.targetButton.disable();

								var dummy = new Ajax.Request('./api/reserves/' + this.program.id + '/unskip.json', {
									method    : 'put',
									onComplete: function () {
										modal.close();
									},
									onSuccess: function () {
										new flagrate.Modal({
											title: '成功',
											text : 'スキップを取り消しました。'
										}).show();
									},
									onFailure: function (t) {
										new flagrate.Modal({
											title: '失敗',
											text : 'スキップの取消に失敗しました (' + t.status + ')'
										}).show();
									}
								});
							}.bind(this)
						},
						{
							label   : 'キャンセル',
							onSelect: function (e, modal) {
								modal.close();
							}
						}
					]
				});
			}

			this.modal.show();

			return this;
		}
	});

	ui.StopRecord = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) {
				this.modal = new flagrate.Modal({
					title: 'エラー',
					text : '番組が見つかりませんでした'
				});
			} else {
				this.modal = new flagrate.Modal({
					title   : '録画中止',
					subtitle: this.program.title + ' #' + this.program.id,
					text    : '本当によろしいですか？',
					buttons: [
						{
							label   : '録画中止',
							color   : '@red',
							onSelect: function (e, modal) {
								e.targetButton.disable();

								var dummy = new Ajax.Request('./api/recording/' + this.program.id + '.json', {
									method    : 'delete',
									onComplete: function () {
										modal.close();
									},
									onSuccess: function () {
										new flagrate.Modal({
											title: '成功',
											text : '録画を中止しました'
										}).show();
									},
									onFailure: function (t) {
										new flagrate.Modal({
											title: '失敗',
											text : '録画中止に失敗しました (' + t.status + ')'
										}).show();
									}
								});
							}.bind(this)
						},
						{
							label   : 'キャンセル',
							onSelect: function (e, modal) {
								modal.close();
							}
						}
					]
				});
			}

			this.modal.show();

			return this;
		}
	});

	ui.RemoveRecordedProgram = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) {
				this.modal = new flagrate.Modal({
					title: 'エラー',
					text : '番組が見つかりませんでした'
				});
			} else {
				this.modal = new flagrate.Modal({
					title   : '録画履歴とファイルの削除',
					subtitle: this.program.title + ' #' + this.program.id,
					text    : '録画履歴とファイルを削除しますか？この操作は元に戻せません。',

					buttons: [
						{
							label  : '削除',
							color  : '@red',
							onSelect: function (e, modal) {
								e.targetButton.disable();

								new Ajax.Request('./api/recorded/' + this.program.id + '.json', {
									method    : 'delete',
									onComplete: function () {
										modal.close();
									},
									onSuccess: function () {
										new flagrate.Modal({
											title: '成功',
											text : '削除に成功しました'
										}).show();
									},
									onFailure: function (t) {
										new flagrate.Modal({
											title: '失敗',
											text : '削除に失敗しました (' + t.status + ')'
										}).show();
									}
								});
							}.bind(this)
						},
						{
							label  : 'キャンセル',
							onSelect: function (e, modal) {
								modal.close();
							}
						}
					]
				});
			}

			this.modal.show();

			return this;
		}
	});

	ui.DownloadRecordedFile = Class.create({
		initialize: function _init(id) {
			window.open('./api/recorded/' + id + '/file.m2ts');
			return this;
		}
	});

	ui.RemoveRecordedFile = Class.create({
		initialize: function _init(id) {
			return new ui.RemoveRecordedProgram(id);
		}
	});

	ui.Cleanup = Class.create({
		initialize: function _init() {
			this.create();

			return this;
		},
		create: function _create() {
			this.modal = new flagrate.Modal({
				title: 'クリーンアップ',
				text : '全ての録画履歴の中から録画ファイルを見失った項目を削除します。',
				buttons: [
					{
						label  : 'クリーンアップ',
						color  : '@red',
						onSelect: function (e, modal) {
							e.targetButton.disable();

							var dummy = new Ajax.Request('./api/recorded.json', {
								method    : 'put',
								onComplete: function () {
									modal.close();
								},
								onSuccess: function () {
									new flagrate.Modal({
										title: '成功',
										text : 'クリーンアップに成功しました'
									}).show();
								},
								onFailure: function (t) {
									new flagrate.Modal({
										title: '失敗',
										text : 'クリーンアップに失敗しました (' + t.status + ')'
									}).show();
								}
							});
						}.bind(this)
					},
					{
						label  : 'キャンセル',
						onSelect: function (e, modal) {
							modal.close();
						}
					}
				]
			});

			this.modal.show();

			return this;
		}
	});

	ui.Streamer = Class.create({
		initialize: function _init(id) {

			window.location.hash = '!/program/watch/id=' + id + '/';

			return this;
		}
	});

	ui.EditRule = Class.create({
		initialize: function _init(ruleNum) {
			this.num = ruleNum;

			this.create();

			return this;
		},
		create: function _create() {
			if (this.num === null) {
				var modal = new flagrate.Modal({
					title: 'エラー',
					text : 'ルールの指定が不正です。'
				}).show();
			} else {
				// フォームに表示させるルールを読み込む
				var num = this.num;
				new Ajax.Request('./api/rules/' + num + '.json', {
					method   : 'get',
					onSuccess: function (t) {

						var rule = t.responseJSON;

						var form = flagrate.createForm({
							fields: [
								{
									key  : 'types',
									label: 'タイプ',
									input: {
										type : 'checkboxes',
										val  : rule.types,
										items: ['GR', 'BS', 'CS', 'SKY']
									}
								},
								{
									key  : 'categories',
									label: 'ジャンル',
									input: {
										type : 'checkboxes',
										val  : rule.categories,
										items: [
											'anime', 'information', 'news', 'sports', 'variety', 'documentary',
											'drama', 'music', 'cinema', 'theater', 'hobby', 'welfare', 'etc'
										]
									}
								},
								{
									key  : 'channels',
									label: '対象CH',
									input: {
										type : formInputTypeChannels,
										style: { width: '100%' },
										val  : rule.channels
									}
								},
								{
									key  : 'ignore_channels',
									label: '無視CH',
									input: {
										type : formInputTypeChannels,
										style: { width: '100%' },
										val  : rule.ignore_channels
									}
								},
								{
									key  : 'reserve_flags',
									label: '対象フラグ',
									input: {
										type : 'checkboxes',
										val  : rule.reserve_flags,
										items: ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ']
									}
								},
								{
									key  : 'ignore_flags',
									label: '無視フラグ',
									input: {
										type : 'checkboxes',
										val  : rule.ignore_flags,
										items: ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ']
									}
								},
								{
									key  : 'start',
									point: '/hour/start',
									label: '何時から',
									input: {
										type     : 'number',
										style    : { width: '60px' },
										maxLength: 2,
										max      : 24,
										min      : 0,
										val      : !!rule.hour ? rule.hour.start : 0
									}
								},
								{
									key   : 'end',
									point : '/hour/end',
									label : '何時まで',
									input : {
										type     : 'number',
										style    : { width: '60px' },
										maxLength: 2,
										max      : 24,
										min      : 0,
										val      : !!rule.hour ? rule.hour.end : 24
									}
								},
								{
									key  : 'mini',
									point: '/duration/min',
									label: '最短長さ(秒)',
									input: {
										type : 'number',
										style: { width: '80px' },
										val  : !!rule.duration ? rule.duration.min : void 0
									}
								},
								{
									key   : 'maxi',
									point: '/duration/max',
									label : '最長長さ(秒)',
									input : {
										type : 'number',
										style: { width: '80px' },
										val  : !!rule.duration ? rule.duration.max : void 0
									}
								},
								{
									key   : 'reserve_titles',
									label : '対象タイトル',
									input : {
										type : formInputTypeStrings,
										style: { width: '100%' },
										val  : rule.reserve_titles
									}
								},
								{
									key   : 'ignore_titles',
									label : '無視タイトル',
									input : {
										type : formInputTypeStrings,
										style: { width: '100%' },
										val  : rule.ignore_titles
									}
								},
								{
									key   : 'reserve_descriptions',
									label : '対象説明文',
									input : {
										type : formInputTypeStrings,
										style: { width: '100%' },
										val  : rule.reserve_descriptions
									}
								},
								{
									key   : 'ignore_descriptions',
									label : '無視説明文',
									input : {
										type : formInputTypeStrings,
										style: { width: '100%' },
										val  : rule.ignore_descriptions
									}
								},
								{
									key	: 'recorded_format',
									label	: '録画ファイル名フォーマット',
									input	: {
										type	: 'text',
										style	: { width: '100%' },
										val	: rule.recorded_format
									}
								},
								{
									key   : 'isEnabled',
									label : 'ルールの状態',
									input : {
										type : 'checkbox',
										label: '有効にする',
										val  : !rule.isDisabled
									}
								}
							]
						});

						var modal = new flagrate.Modal({
							title: 'ルール編集',
							element: form.element,
							buttons: [
								{
									label  : '変更',
									className: 'primary-teal',
									onSelect: function (e, modal) {
										e.targetButton.disable();

										var query = form.getResult();

										if (!query.duration.min) {
											delete query.duration.min;
										}
										if (!query.duration.max) {
											delete query.duration.max;
										}
										if (!query.duration.min && !query.duration.max) {
											delete query.duration;
										}

										var i;
										for (i in query) {
											if (typeof query[i] === 'object' && query[i].length === 0) {
												delete query[i];
											}
										}

										console.log(query);

										var xhr = new XMLHttpRequest();

										xhr.addEventListener('load', function () {
											if (xhr.status === 200) {
												flagrate.createModal({
													title: '成功',
													text : 'ルール変更に成功しました'
												}).show();
											} else {
												flagrate.createModal({
													title: '失敗',
													text : 'ルール変更に失敗しました (' + xhr.status + ')'
												}).show();
											}
											modal.close();
										});

										xhr.open('PUT', './api/rules/' + num + '.json');
										xhr.setRequestHeader('Content-Type', 'application/json');
										xhr.send(JSON.stringify(query));
									}
								},
								{
									label  : 'キャンセル',
									onSelect: function(e, modal) {
										modal.close();
									}
								}
							]
						}).show();
					}.bind(this),
					onFailure: function(t) {
					}
				});
			}

			return this;
		}
	});

	ui.NewRule = Class.create({
		initialize: function _init() {

			this.create();

			return this;
		},
		create: function _create() {
			if (false) { //のちにエラー処理を追加
				var modal = new flagrate.Modal({
					title: 'エラー',
					text : '不正なアクセスです。'
				}).show();
			} else {
				var form = flagrate.createForm({
					fields: [
						{
							key  : 'types',
							label: 'タイプ',
							input: {
								type : 'checkboxes',
								items: ['GR', 'BS', 'CS', 'SKY']
							}
						},
						{
							key  : 'categories',
							label: 'ジャンル',
							input: {
								type : 'checkboxes',
								items: [
									'anime', 'information', 'news', 'sports', 'variety', 'documentary',
									'drama', 'music', 'cinema', 'theater', 'hobby', 'welfare', 'etc'
								]
							}
						},
						{
							key  : 'channels',
							label: '対象CH',
							input: {
								type : formInputTypeChannels,
								style: { width: '100%' }
							}
						},
						{
							key  : 'ignore_channels',
							label: '無視CH',
							input: {
								type : formInputTypeChannels,
								style: { width: '100%' }
							}
						},
						{
							key  : 'reserve_flags',
							label: '対象フラグ',
							input: {
								type : 'checkboxes',
								items: ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ']
							}
						},
						{
							key  : 'ignore_flags',
							label: '無視フラグ',
							input: {
								type : 'checkboxes',
								items: ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ']
							}
						},
						{
							key  : 'start',
							point: '/hour/start',
							label: '何時から',
							input: {
								type     : 'number',
								style    : { width: '60px' },
								maxLength: 2,
								max      : 24,
								min      : 0,
								val      : 0
							}
						},
						{
							key   : 'end',
							point : '/hour/end',
							label : '何時まで',
							input : {
								type     : 'number',
								style    : { width: '60px' },
								maxLength: 2,
								max      : 24,
								min      : 0,
								val      : 24
							}
						},
						{
							key  : 'mini',
							point: '/duration/min',
							label: '最短長さ(秒)',
							input: {
								type : 'number',
								style: { width: '80px' }
							}
						},
						{
							key   : 'maxi',
							point: '/duration/max',
							label : '最長長さ(秒)',
							input : {
								type : 'number',
								style: { width: '80px' }
							}
						},
						{
							key   : 'reserve_titles',
							label : '対象タイトル',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key   : 'ignore_titles',
							label : '無視タイトル',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key   : 'reserve_descriptions',
							label : '対象説明文',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key   : 'ignore_descriptions',
							label : '無視説明文',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key	: 'recorded_format',
							label	: '録画ファイル名フォーマット',
							input	: {
								type	: 'text',
								style	: { width: '100%' },
							}
						},
						{
							key   : 'isEnabled',
							label : 'ルールの状態',
							input : {
								type : 'checkbox',
								label: '有効にする',
								val  : true
							}
						}
					]
				});

				var modal = flagrate.createModal({
					title: '新規作成',
					element: form.element,
					buttons: [
						{
							label  : '作成',
							className: 'primary-teal',
							onSelect: function(e, modal) {
								e.targetButton.disable();

								var query = form.getResult();

								if (!query.duration.min) {
									delete query.duration.min;
								}
								if (!query.duration.max) {
									delete query.duration.max;
								}
								if (!query.duration.min && !query.duration.max) {
									delete query.duration;
								}

								var i;
								for (i in query) {
									if (typeof query[i] === 'object' && query[i].length === 0) {
										delete query[i];
									}
								}

								console.log(query);

								var xhr = new XMLHttpRequest();

								xhr.addEventListener('load', function () {
									if (xhr.status === 201) {
										flagrate.createModal({
											title: '成功',
											text : 'ルール作成に成功しました',
										}).show();
									} else {
										flagrate.createModal({
											title: '失敗',
											text : 'ルール作成に失敗しました (' + xhr.status + ')'
										}).show();
									}
									modal.close();
								});

								xhr.open('POST', './api/rules.json');
								xhr.setRequestHeader('Content-Type', 'application/json');
								xhr.send(JSON.stringify(query));
							}
						},
						{
							label  : 'キャンセル',
							onSelect: function(e, modal) {
								modal.close();
							}
						}
					]
				}).show();
			}

			return this;
		}
	});

	ui.CreateRuleByProgram = Class.create({
		initialize: function _init(id) {
			this.program = util.getProgramById(id);

			this.create();

			return this;
		},
		create: function _create() {
			if (this.program === null) { //のちにエラー処理を追加
				var modal = new flagrate.Modal({
					title: 'エラー',
					text : '不正なアクセスです。'
				}).show();
			} else {
				var program = this.program;

				var form = flagrate.createForm({
					fields: [
						{
							key  : 'types',
							label: 'タイプ',
							input: {
								type : 'checkboxes',
								items: ['GR', 'BS', 'CS', 'SKY'],
								val  : [program.channel.type]
							}
						},
						{
							key  : 'categories',
							label: 'ジャンル',
							input: {
								type : 'checkboxes',
								items: [
									'anime', 'information', 'news', 'sports', 'variety', 'documentary',
									'drama', 'music', 'cinema', 'theater', 'hobby', 'welfare', 'etc'
								],
								val  : [program.category]
							}
						},
						{
							key  : 'channels',
							label: '対象CH',
							input: {
								type : formInputTypeChannels,
								style: { width: '100%' },
								val  : [program.channel.id]
							}
						},
						{
							key  : 'ignore_channels',
							label: '無視CH',
							input: {
								type : formInputTypeChannels,
								style: { width: '100%' }
							}
						},
						{
							key  : 'reserve_flags',
							label: '対象フラグ',
							input: {
								type : 'checkboxes',
								items: ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ']
							}
						},
						{
							key  : 'ignore_flags',
							label: '無視フラグ',
							input: {
								type : 'checkboxes',
								items: ['新', '終', '再', '字', 'デ', '解', '無', '二', 'Ｓ']
							}
						},
						{
							key  : 'start',
							point: '/hour/start',
							label: '何時から',
							input: {
								type     : 'number',
								style    : { width: '60px' },
								maxLength: 2,
								max      : 24,
								min      : 0,
								val      : 0
							}
						},
						{
							key   : 'end',
							point : '/hour/end',
							label : '何時まで',
							input : {
								type     : 'number',
								style    : { width: '60px' },
								maxLength: 2,
								max      : 24,
								min      : 0,
								val      : 24
							}
						},
						{
							key  : 'mini',
							point: '/duration/min',
							label: '最短長さ(秒)',
							input: {
								type : 'number',
								style: { width: '80px' }
							}
						},
						{
							key   : 'maxi',
							point: '/duration/max',
							label : '最長長さ(秒)',
							input : {
								type : 'number',
								style: { width: '80px' }
							}
						},
						{
							key   : 'reserve_titles',
							label : '対象タイトル',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' },
								val  : [this.program.title]
							}
						},
						{
							key   : 'ignore_titles',
							label : '無視タイトル',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key   : 'reserve_descriptions',
							label : '対象説明文',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key   : 'ignore_descriptions',
							label : '無視説明文',
							input : {
								type : formInputTypeStrings,
								style: { width: '100%' }
							}
						},
						{
							key	: 'recorded_format',
							label	: '録画ファイル名フォーマット',
							input	: {
								type	: 'text',
								style	: { width: '100%' },
							}
						},
						{
							key   : 'isEnabled',
							label : 'ルールの状態',
							input : {
								type : 'checkbox',
								label: '有効にする',
								val  : true
							}
						}
					]
				});

				var modal = flagrate.createModal({
					title: '新規作成',
					element: form.element,
					buttons: [
						{
							label  : '作成',
							className: 'primary-teal',
							onSelect: function(e, modal) {
								e.targetButton.disable();

								var query = form.getResult();

								if (!query.duration.min) {
									delete query.duration.min;
								}
								if (!query.duration.max) {
									delete query.duration.max;
								}
								if (!query.duration.min && !query.duration.max) {
									delete query.duration;
								}

								var i;
								for (i in query) {
									if (typeof query[i] === 'object' && query[i].length === 0) {
										delete query[i];
									}
								}

								console.log(query);

								var xhr = new XMLHttpRequest();

								xhr.addEventListener('load', function () {
									if (xhr.status === 201) {
										flagrate.createModal({
											title: '成功',
											text : 'ルール作成に成功しました',
										}).show();
									} else {
										flagrate.createModal({
											title: '失敗',
											text : 'ルール作成に失敗しました (' + xhr.status + ')'
										}).show();
									}
									modal.close();
								});

								xhr.open('POST', './api/rules.json');
								xhr.setRequestHeader('Content-Type', 'application/json');
								xhr.send(JSON.stringify(query));
							}
						},
						{
							label  : 'キャンセル',
							onSelect: function(e, modal) {
								modal.close();
							}
						}
					]
				}).show();
			}

			return this;
		}
	});

	ui.copyStr = function (string) {

		var span = flagrate.createElement("span")
			.insertText(string)
			.insertTo(document.body);

		var range = document.createRange();
		range.selectNode(span);

		var selection = window.getSelection()
		selection.removeAllRanges();
		selection.addRange(range);

		document.execCommand("copy");

		span.remove();
	};

})();
