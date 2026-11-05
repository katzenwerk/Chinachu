# Node.js 26 本番切替記録（2026-11-04）

> **歴史的な中間記録です。現在の操作手順ではありません。** 以下の数値・検証結果・旧24保持や退避物に関する記述は2026-11-04当時の記録として残しています。その後の指示でNode 26への完全移行（旧24撤去）が確定し、OS再起動の実施も報告されています。旧24保持・復元方針は廃止されました。現在の手順は[README](../README.md)と[移行手順](node26-performance.md#移行診断受入)を参照してください。今回の文書整理で実機の再確認は行っていません。

## 切替結果

`/home/mint/Chinachu` のローカル作業ツリーを維持して移行した。Git更新・commit・pushは行っていない。切替前HEADは `b86305dba6a8095ee2c3284d2e1c757ea5d56b70`。録画0件・有効な再開待ちなし・停止前10分以内の予約なしを確認し、既存Local PM2（mint、UID 1000）のOperator／WUIだけを停止・起動した。

| 項目 | 切替前 | 切替後 |
|---|---|---|
| Nave node/npm | installed/24.20.0/bin | installed/26.13.0/bin |
| Operator（PM2 id 2） | Node 24.20.0 | Node 26.13.0、PID 722479 |
| WUI（PM2 id 1） | Node 24.20.0 | Node 26.13.0、PID 722480 |
| npm | 11.19.0 | 26同梱の11.20.0 |
| PM2デーモン | Node 24.20.0 | 維持 |
| pm2-logrotate | PID 1052、再起動0回 | 維持 |

PM2子プロセスからのバージョン報告に加え、最終確認では両PIDの `/proc/PID/exe` が `.nave/installed/26.13.0/bin/node` であることを確認した。確認中の再起動回数はOperator 6・WUI 13で増加せず、stderrログのサイズも切替前から増えていない。PM2パッケージは7.0.4。Root PM2の登録・サービスは操作していない。

## 依存関係と実装変更

- 公式Nodeバイナリを既存リンクを変えず準備した。libatomic.so.1を含む共有ライブラリに不足なし。
- 変更していないlockfileを使い、対象Node/npmで `npm ci` を隔離実行した。停止後に新しいnode_modulesを公開し、旧依存は復旧先へ保持した。commonの依存はルートで解決し、chinachu-commonはfile:commonリンク。
- Mirakurun Client 4.2.1を維持。今回の最終統一作業ではpackage.json・common/package.json・lockfileのバージョンを追加変更していない。既存未コミットの26向けengines・依存変更を維持した。
- ネイティブ依存は@node-rs/crc32 1.4.3のNode-APIプリビルド（GNU/musl）。GNU実体のロードとCRC32既知値が成功。V8 ABI依存のソース再ビルドは不要だった。新しい依存ツリーのABI stampは147。
- chinachuにdependencies-prepare/publishを追加。prepareは稼働中の依存を置換しない。publishは停止確認、manifest一致、依存検証を経てrenameし、置換失敗時に旧依存を戻す。停止状態不明も拒否する。
- standalone installer verifyのBootstrap Node初期化不足を修正。VerifyのためにBootstrapで本番データを作り直していない。
- lib/pm2-runtime-client.jsは所有者確認済みの既存RPCへ接続し、デーモンを新規起動しない。既存Chinachu登録ID・script・cwd・停止状態を確認し、interpreterとPATHだけを更新して起動する。
- lib/service-setup.shは読み取り専用RPCでactiveを取得でき、PID名前空間で確認できない状態を空の既知状態として扱わない。lib/runtime-diagnostics.jsは実体が読めない場合の子プロセス報告を補助証拠として区別する。
- tools/ts-analyzerはリポジトリのNave Nodeを使用する。SchedulerのPATH、Workerの継承、Node子プロセスのprocess.execPathも26の経路を確認した。
- 既存Installer／Upgradeテストを修正し、新しい恒久ケース数は増やしていない。

## PM2永続化

activeのChinachu 2件はinterpreterを絶対パス `/home/mint/Chinachu/.nave/node` とし、PATH・env.PATHの先頭を `.nave` とした。自リポジトリの旧installed/version/binはPATHから除いた。

`/home/mint/.pm2/dump.pm2` と `dump.pm2.bak` は原本を保管し、Chinachuの同じ3フィールドだけを原子的に更新した。これらを除いた深い比較で他設定・他プロセス・saved-only集合の保持を確認した。`pm2 save`は実行していない。

Local／Rootのstartup unitは原本とバイト比較し、未変更を確認した。Local unitにはデーモン起動用の旧Node依存があるが、保存済みChinachuは絶対interpreterと安定PATHで26を使用する構成。旧Nodeを保持することが前提であり、OS再起動による実復元は未試験。

最終 `runtime-check` はexit 2。唯一のissueは `startup-old-runtime`（pm2-mint.service）。両アプリの実行Nodeは26として検出し、saved/backup不整合は検出していない。Root PM2の私有状態はsudo環境の制限で未検査だが、実際の管理先はLocalと確認済み。

## 検証

- 新しい26向け依存を使った隔離ソースで、許可範囲154件／154件成功。Node 26の `npm run check` 成功。
- 最終Installer／Upgrade／runtime migrationテストはNode 26.13.0・システムNode 24.22.2双方で11件／11件成功。24は補助比較であり正式運用対象ではない。
- 最新ソースによる新規Full：Node未導入の/tmpから、実際の公式バイナリ取得・展開、npm ci、公開、Bootstrap、Verify、Mirakurun/commonロード、SQLiteメモリDB読み書きまで成功。任意PM2登録と認証案内だけをモックし、本番と分離した。26以外のNode導入やソースビルドなし。
- 隔離Upgrade：Git/PM2/npmをモックし、実Nodeとファイル置換で24→26成功を確認。26導入済み・依存正常ではNode準備・リンク切替・依存再導入が呼ばれないことを確認。アプリソース更新時の停止・起動は維持する。既存異常系でVerify失敗後の旧依存・復旧情報保持も成功。
- 本番standalone installer verify成功。bash -n、変更JSのnode --check、git diff --check成功。
- 本番WUIのroot・認証状態・番組表・予約・録画中・録画結果・シリーズstatus/overviewはHTTP 200。ホームとシリーズ一覧はブラウザーでも表示確認。認証設定を変更していない。
- WUI診断はNode 26、Mirakurun正常、録画0、Scheduler正常。起動後の自然なScheduler完了を確認し、手動の更新・録画は起動していない。シリーズの辞書／チャンネルマップ／ProgLookupはready。
- 本番辞書SQLiteをreadOnlyで開きquick_check=ok、8,092作品／151,501話。シリーズWorker経路もready。TS Analyzerは--helpまでで、録画ファイルを読んでいない。
- config・rules・manifest・lockのhashは切替前と一致。録画結果のID集合と順序は12件のまま保持。アプリ起動による通常のScheduler更新以外に、台帳・SQLite・録画ファイルを手動編集していない。

全npm testは未実施。loopbackを必要とするmodule.operator-prep-record、module.operator-recording、module.operator-recorded-id、module.wui-access-modelの4ファイルは作業制約により実行していない。OS再起動、実録画開始・終了、実TSファイル解析、録画中の競合負荷・DROP、実ソースコンパイルも未実施。通常予約の録画で受け入れ確認する。

検証ログは `/tmp/chinachu-node26-validation/`（cutover-new-dependencies-tests.log、cutover-check.log、cutover-final-targeted{24,26}.log、fresh-full-final.log、lifecycle-{24-to-26,already-26}.log、runtime-check-after.json）。/tmpは恒久保管先ではない。

## 当時の復旧材料と残る受入（現在の操作には使用しない）

> この節は当時の方針の記録です。現在は旧24や移行バックアップを復元せず、Node 26側で修復します。旧24は移行中に削除し、サービス起動の成功まで保持する構成ではありません。記載された退避領域の現在の存在を保証しません。

`/home/mint/Chinachu/.upgrade-recovery.SDHmuiQL` に旧node_modules、manifest、旧リンク・revision、PM2 active／dump原本、startup unit原本、ローカルソースのtarと作業差分を保持した。旧Node `.nave/installed/24.20.0` も維持する。復旧先には非公開の環境情報を含むため公開・commitしない。

異常時はまず録画／再開待ち／直近予約と現在のPM2状態を確認する。26側を修復するか、同じソース・manifest・旧依存・旧Node・PM2設定を一組で復旧する。リンクだけ24へ戻さない。切替後データとの互換性を確認できない場合は自動rollbackせず、停止可能なChinachuだけを安全に止めて修復する。バックアップ台帳で現在の録画履歴を上書きしない。

次の通常予約で開始・終了、Scheduler後の台帳、Worker後処理を確認し、保守時間にOS再起動でLocal管理先・26の実体・保存状態を確認する。その後に限り旧依存の整理を判断する。PM2デーモン／unit自体の26移行は他PM2プロセスへの影響を伴うため別作業とし、変更・再起動受入前に旧Nodeを削除しない。
