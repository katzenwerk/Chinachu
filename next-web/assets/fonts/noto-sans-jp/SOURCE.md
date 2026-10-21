# Local comparison fonts

The PC home sample loads these static TrueType faces through `font.css`:

| Family | File | Weight | SHA-256 |
| --- | --- | ---: | --- |
| Noto Sans JP | `NotoSansJP-Thin.ttf` | 100 | `aad0a5194366fece00859d83385e9d374a1e968f2d452b264cb4ad35b14261d6` |
| Noto Sans JP | `NotoSansJP-Light.ttf` | 300 | `c0e4ebff62a7b659cf70bf4aa66a4fefc46d88d6b4c4b4698b764aa383bf66f3` |
| Noto Sans JP | `NotoSansJP-Regular.ttf` | 400 | `6255ea4692e97ef27330304fb96fd650f9111f868cd585fcf2802d42823930e5` |
| BIZ UDPGothic | `BIZUDPGothic-Regular.ttf` | 400 | `22f41ce68f1ce62477ca4ec1e2c0c400cc545ddff31d713e8edf87808614aeb2` |

All four files were supplied locally by the user and were confirmed as static,
non-variable faces from their embedded metadata. Their original download URLs
were not independently verified during this work.

Noto Sans JP official Google Fonts metadata:
<https://github.com/google/fonts/tree/main/ofl/notosansjp>

The Noto Sans JP license text is retained in `OFL.txt`. The origin and license
document for the locally supplied BIZ UDPGothic file were not added or verified
as part of this sample-only change.
