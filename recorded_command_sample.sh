#!/bin/sh
set -eu

# recordedCommand用の汎用サンプル。
# $1: 録画ファイルの絶対パス
# $2: 録画番組情報のJSON文字列（この例では未使用）
# config.jsonの例（配置先に合わせて絶対パスを変更）:
#   "recordedCommand": "/path/to/Chinachu/recorded_command_sample.sh"
# スクリプトには実行権限が必要: chmod +x /path/to/Chinachu/recorded_command_sample.sh
# 設定変更はOperator再起動後に反映。recordedCommandSerialはONで直列、OFFで並列。
# 正常終了以外に、録画開始後の手動中止・短縮録画でも起動され得ます。
# 再起動をまたぐ要求の保存や、完全な重複実行防止はこのサンプルの対象外です。

# 独自の録画後処理に置き換えて使用してください。
# この例はパスをシステムログへ記録するだけで、録画ファイルを変更・移動・削除しません。
logger -t chinachu-recorded -- "Recorded: $1"
