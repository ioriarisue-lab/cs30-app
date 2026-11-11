# 歩行角度解析（iPhone・iPad用オフラインPWA）

gait_analysis.py をブラウザ版に移植したアプリです。iPhone・iPadで撮影→端末内に保存→膝・股関節の2D屈曲角度を解析します。
解析はすべて端末上で行い、動画や結果を外部へ送信しません。

## 公開（GitHub Pages）
1. GitHubで新しいリポジトリ（例: gait-app）を作り、このフォルダの中身をすべてアップロード
2. Settings → Pages → Branch を main / (root) にして保存
3. 表示されたURL（例: https://ioriarisue-lab.github.io/gait-app/）をiPhone・iPadのSafariで開く

## 初回設定（端末ごと）（ネット接続が必要なのはここだけ）
1. Safariで開き、共有ボタン →「ホーム画面に追加」
2. ホーム画面のアイコンから起動 →「設定」タブ →「モデル(.task)を取り込む」で pose_landmarker_heavy.task を選ぶ
   （ファイルAppにモデルを入れておく）
3. 以後は機内モードでも使えます

## iPhoneでの注意
- 端末ごとにモデルの取り込みが必要です（iPadで取り込んだものは共有されません）
- 撮影は横向き推奨。縦向きだと警告が出ます
- 解析中は画面を消さないでください（アプリを切り替えると止まることがあります）
- 長い動画は時間がかかります。10秒前後の歩行区間に切ると扱いやすいです

## 使い方
- 撮影：横向きに固定し、真横から全身と足先を撮影 →「録画開始/停止」で端末内に保存
- 動画：写真Appの動画も読み込み可。「解析」で進行方向とfpsを確認して開始
- 結果：グラフ、スティックピクチャー動画を表示。「保存/共有」から CSV・Excel・PNG・MP4 をファイルAppや写真Appへ保存

## 出力（Python版と同じ）
- *_gait_angles.csv / .xlsx（フレーム別角度・正規化グラフ用・推定接地・説明）
- *_gait_angles_graph.png
- *_gait_angles_stick_figure.mp4

## 一歩行周期ごとの解析（v1.5.0〜）
- 解析設定で「一歩行周期ごとの結果を出す」と基準足（右/左）を選ぶ
- 周期の開始：基準足が対側足より前にあるとき、最も前に出た時点で踵とつま先の高さを比較。踵が低ければ踵、つま先が低ければつま先の上下座標が最下点に達した最初のフレーム
- 出力：周期一覧（開始の種類・時間・各関節の最大/最小/可動域）、周期別の正規化データ、周期ごとのCSVとグラフ

## 往復歩行（v1.6.0〜）
- 進行方向で「往復 右→左」「往復 左→右」を選ぶ
- 最初の向きに最も進んだ時点を折り返し点とし、骨盤中心の水平速度が歩行時の30%未満の区間（＋前後0.2秒）を方向転換として除外
- 往路・復路それぞれで周期を検出（方向転換をまたぐ周期は作らない）。複数人が映る場合は、往路・復路それぞれの進行方向で先頭の人物を追跡

## RTMPose（v1.7.0〜）
解析設定の「解析エンジン」でMediaPipe／RTMPoseを切り替え（撮影中のリアルタイム表示はMediaPipe）。
rtmlib の BodyWithFeet と同じ構成（人物検出YOLOX＋RTMPose Halpe26）。前処理・後処理もrtmlibに準拠（姿勢推定の入力はRGB正規化）。

モデル（zipを解凍して中の end2end.onnx を使う）
- 軽量（スマホ・タブレット向け、おすすめ）
  - 人物検出: https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_tiny_8xb8-300e_humanart-6f3252f9.zip
  - 姿勢推定: https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-s_simcc-body7_pt-body7-halpe26_700e-256x192-7f134165_20230605.zip
- 標準（PC向け、精度優先）
  - 人物検出: https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/yolox_m_8xb8-300e_humanart-c2c7a14a.zip
  - 姿勢推定: https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-body7_pt-body7-halpe26_700e-256x192-4d3e73dd_20230605.zip

「設定」→RTMPoseで2つの end2end.onnx をそれぞれ取り込み →「分割して書き出す」→ できた rtm_det.onnx.partN / rtm_pose.onnx.partN をGitHubに置くと、ほかの端末でも自動で読み込まれる。
計算はWebGPU（使えない端末はCPU）。可視性の閾値はRTMPoseでは0.3（rtmlibの既定値）。foot_index列は母趾。

## 対象者の追跡（v1.8.0〜）
- 最初に選んだ人（進行方向の先頭の人、またはタップで指定した人）を、フレームをまたいで追跡。見えないフレームは別の人に乗り換えず空欄
- 解析設定の「対象者をタップで指定」で、動画の中の人をタップして指定できる。撮影中もカメラ映像の人をタップするとその人を追跡
- MediaPipeの検出人数を3人、検出のしきい値を0.3に変更

## 解析区間の指定（v1.9.0〜）
- 解析設定で開始・終了の秒を指定（「今の位置を開始に／終了に」、バーをタップして移動、「区間を再生」で確認）
- 指定した区間だけを解析するので速くなる。frame・time_seconds・接地の時刻は元の動画の通し番号・時刻のまま
- 区間の最初と最後で途中になっている周期は使われないので、前後に少し余裕を持たせる

## 光刺激の検出（v1.10.0〜）
- 解析設定で「光が点いた瞬間を検出する」をオンにし、「光の位置を囲む」で光が映る場所を指でなぞって囲む（範囲は動画ごとに保存）
- 範囲の平均輝度から点灯・消灯を判定し、点灯した瞬間のフレーム番号・時刻を出力
- 出力：*_light_events.csv（回ごとの点灯・消灯フレームと時刻）、メインのCSVに light_brightness・light_on 列、Excelに「光刺激」シート
- 時刻の精度は1フレーム（30fpsで約33ms、60fpsで約17ms）

## Python版との違い
- 動画はフレームレート（解析画面で指定、既定は録画時の値）に沿って時刻で読み出します
- 歩行周期を検出できない場合もエラー終了せず、フレーム別の結果と時間軸グラフを出力します
- 横からの単眼動画による推定であり、臨床測定・診断には使用できません

ファイルを更新したら sw.js の VERSION を変えてください（端末側のキャッシュが更新されます）。
同梱ライブラリ：onnxruntime-web 1.22.0（MIT）、@mediapipe/tasks-vision 1.2.0（Apache-2.0、利用統計送信を無効化）、SheetJS（Apache-2.0）、mp4-muxer（MIT）
