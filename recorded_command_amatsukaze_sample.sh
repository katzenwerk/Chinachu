#!/bin/sh
set -eu

# rigaya版AmatsukazeAddTaskによるキュー登録サンプル（同じLinux PCでの利用例）。
# 別PCのAmatsukazeServerを使う場合はSERVER_IPを変更してください。
# サーバー側から録画ファイルを参照でき、OUTPUT_DIRもサーバー側で有効な必要があります。
# 両PCで録画ファイルのパスが異なる場合はパス変換が必要です（この例には未実装）。
# --remote-dirはディレクトリ指定用で、複数階層の任意のパス変換は自動で行いません。

# 必ず実際の実行ファイル・サーバー側出力先・既存プロファイル名に変更してください。
ADD_TASK='/path/to/Amatsukaze/AmatsukazeAddTask'
SERVER_IP='127.0.0.1'
SERVER_PORT='32768'
PROFILE='YOUR_PROFILE'
OUTPUT_DIR='/path/to/encoded'

# $1: 録画ファイルの絶対パス / $2: 録画番組情報のJSON文字列（未使用）
# config.jsonのrecordedCommandに、このスクリプトの絶対パスを指定してください。
# 例: "recordedCommand": "/path/to/Chinachu/recorded_command_amatsukaze_sample.sh"
# 実行権限が必要: chmod +x /path/to/Chinachu/recorded_command_amatsukaze_sample.sh
# 設定変更はOperator再起動後に反映。recordedCommandSerialはONで直列、OFFで並列。
# 直列化の対象は登録コマンドであり、Amatsukaze側のエンコード処理ではありません。
# 正常終了以外に、録画開始後の手動中止・短縮録画でも起動され得ます。
# 登録成功はエンコード完了を意味しません。進捗確認・完了待ちは行いません。
# 再起動をまたぐ登録要求の保存や、完全な重複登録防止は対象外です。
# 入力TSのコピー・移動・削除は行わず、execでAddTaskの終了コードをそのまま返します。

exec "$ADD_TASK" \
  -f "$1" \
  -o "$OUTPUT_DIR" \
  -s "$PROFILE" \
  --ip "$SERVER_IP" \
  -p "$SERVER_PORT"
