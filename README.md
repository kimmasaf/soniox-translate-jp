# Soniox 翻訳(soniox-translate-jp)

**[Even Realities G2](https://www.evenrealities.com) スマートグラス向けの、リアルタイム翻訳字幕アプリです。**

相手が話すそばから、翻訳がメガネのレンズに字幕として出ます。原文もあわせて表示できます。
[Even Hub](https://hub.evenrealities.com) アプリとして動き、音声認識と翻訳には [Soniox](https://soniox.com) のリアルタイム音声 AI(60 以上の言語に対応)を使います。

このリポジトリは [intelc/soniox-translate](https://github.com/intelc/soniox-translate) のフォークで、日本語で使う人向けに機能を追加・変更しています(下の「元のプロジェクトからの主な変更」を参照)。

<p align="center">
  <img src="assets/screenshots/preview-2.png" width="46%" alt="G2 の表示例(中国語 → 英語)" />
  <img src="assets/screenshots/preview-1.png" width="46%" alt="G2 の表示例(スペイン語 → 英語)" />
</p>

> メガネの表示は 576×288、4 ビットのグレースケールです(透明なレンズの上に緑の文字)。

## 主な機能

- **リアルタイム翻訳**:話した言葉がほぼ遅れずに字幕になります。翻訳先の初期値は日本語です
- **表示モード**(メガネとスマホの両方に反映)
  - 上下分割(原文 2 行):上に原文、下に翻訳
  - 上下分割(原文 3:翻訳 7):原文 3 行、翻訳 7 行
  - 対訳(Bilingual Paired):原文の次の行に「→ 翻訳」
  - 翻訳のみ(全画面)
- **翻訳先と同じ言語の発話は 1 回だけ表示**:日本語への翻訳中に日本語で話した内容は、翻訳欄にだけ出ます
- **一時停止**:メガネのシングルタップで聞き取りと一時停止を切り替えます。起動時は一時停止です。一時停止中はマイクを止め、Soniox への接続も切るので、利用料がかかりません
- **話者の識別**:「話者1」「話者2」などのラベルをスマホにだけ表示します。メガネには表示しません
- **会話履歴**:会話を対訳の形でスマホのアプリ内に自動保存します(最新 50 件)。各組の先頭に時刻を付け、「コピー」で全文をクリップボードにコピーできます
- **認識精度の調整**:話される言語(言語ヒント)と文脈(話題、用語、訳語の指定、背景情報)を設定できます
- **日本語のスマホ画面**:一般的なスマホの設定画面と同じ形式です。ライト/ダークモードに対応しています
- **自分の Soniox キーで使う**:API キーはそのスマホ内にだけ保存され、利用料は自分のアカウントに付きます
- **安定した接続**:切断時の自動再接続、通信が詰まったときの音声の間引き、メガネとの通信を 1 つずつ順番に送る処理

## メガネでの操作

| 操作 | 動き |
|---|---|
| シングルタップ | 聞き取り開始 ⇔ 一時停止(起動時は一時停止) |
| ダブルタップ | 会話を保存してから終了確認を表示 |

## 設定(スマホの「⚙︎ 設定」)

設定は SDK のストレージに保存され、次回起動時も引き継がれます。

| 項目 | 初期値 | 説明 |
|---|---|---|
| API キー | なし | 自分の Soniox キー([console.soniox.com](https://console.soniox.com) で取得)。入力するまで使えません |
| 翻訳先 | 日本語 | 「なし」にすると文字起こしだけになります |
| 翻訳しない言語 | なし | 翻訳せずそのまま表示する言語のコード(例: `en, zh`) |
| 話される言語 | `ja, en` | Soniox の `language_hints`。指定した言語の認識が良くなります(ほかの言語も認識されます)。空欄なら指定なし |
| 話題・分野 | なし | Soniox の `context.general` |
| 用語・固有名詞 | なし | `context.terms`。1 行に 1 つ、またはカンマ区切り |
| 訳語の指定 | なし | `context.translation_terms`。1 行に「原語=訳語」。名前を訳さず残すには `Kiro=Kiro` |
| 背景情報 | なし | `context.text`。議題や資料の要点など。文脈は合計で約 9,000 文字まで |
| 表示モード | 上下分割(原文 2 行) | 上記の 4 つから選びます |
| 文ごとに改行 | オン | 文の終わりで改行します |
| 文字の配置/表示の基準/行間/表示幅/最大行数 | 左寄せ/下から/標準/全幅/自動 | メガネの表示の調整 |
| 話者を識別 | オフ | スマホにだけ話者ラベルを表示します |

文脈と言語ヒントの項目は、空欄にすると Soniox に送りません。

## 仕組み

```
G2 のマイク ─(PCM s16le 16kHz)─▶ WebView のアプリ ─▶ Soniox リアルタイム WebSocket(stt-rt-v6)
                                    │                       │ 原文と翻訳のトークン
                                    ◀───────────────────────┘
                                    ▼
             メガネ:テキスト枠 1〜2 個(576×288)  ＋  スマホ:字幕・設定・履歴の画面
```

アプリは HTML と TypeScript(Vite)だけで作ったページで、Even アプリの WebView の中で動き、Even Hub SDK でメガネとやりとりします。マイクの音声(G2 の形式そのままの PCM 16kHz)を Soniox の WebSocket API に直接送ります。返ってきたトークンを原文と翻訳に分け、さらに原文と翻訳を組にしてから表示します。Soniox はどの翻訳がどの原文に対応するかを返さないため、組はアプリ側で推定しています。

## 開発の始め方

Node 20 以上と、Soniox の API キーが必要です。

```bash
npm install
cp .env.example .env.local        # VITE_STT_API_KEY にキーを入れる(開発時だけ使われます)
npm run dev                       # Vite 開発サーバー(http://localhost:5173)
npm run simulate                  # デスクトップ版の G2 シミュレーター
```

> `.env.local` のキーは開発サーバーが配信する JS に埋め込まれ、同じネットワークの人から見えます。信頼できるネットワークでだけ使ってください。本番ビルドには含まれません。

### 画面のない Linux でシミュレーターを動かす

Docker と Node があれば、シミュレーターをコンテナの仮想ディスプレイで動かし、テスト音声を仮想マイクに流して確認できます。

```bash
sim/run.sh                                                   # 起動してスクリーンショットを撮る
AUDIO="tap /app/test-audio/ja.wav tap" sim/run.sh            # タップで開始 → 日本語の音声 → タップで一時停止
AUDIO="tap /app/test-audio/dialog.wav" SPEAKERS=1 MODE=paired sim/run.sh   # 2 人の会話を対訳モードで
```

結果(スクリーンショット、コンソールログ、シミュレーターのログ)は `sim/out/` に保存されます。オプション:`TARGET`(翻訳先)、`SPEAKERS=1`、`MODE`(`split` / `split37` / `paired` / `translation`)、`CLICKS` / `POST_CLICKS`(画面上の座標をクリック、`scrollN` でスクロール)。

### Soniox 単体での確認とテスト音声

```bash
node scripts/make-test-audio.mjs                                   # Soniox TTS でテスト音声(英語・日本語・2 人の会話)を作る
AUDIO_FILE=test-audio/en.wav SONIOX_TRANSLATE_TO=ja node scripts/soniox-smoke.mjs   # 音声認識と翻訳だけを試す
```

`soniox-smoke.mjs` では、`SONIOX_LANGUAGES`(言語ヒント)と `SONIOX_CONTEXT`(文脈の JSON)も指定できます。

## 実機で動かす

手順は [docs/実機テスト手順書.md](docs/実機テスト手順書.md) にまとめています。

- **ローカルテスト**:PC で開発サーバーを動かし、`npx evenhub qr --url "http://<PC の IP>:5173"` で表示した QR を Even アプリで読み取ります
- **プライベートビルド**:パッケージ(`.ehpk`)を作って Even Hub にアップロードし、スマホからインストールします

```bash
npm run build
npx evenhub pack app.json dist -o release/soniox-translate.ehpk
npx evenhub upload release/soniox-translate.ehpk -m "変更内容"   # 先に app.json の version を上げる
```

本番ビルドには API キーが含まれません(`grep -r <キーの一部> dist/` で何も出ないことを確認できます)。

## ファイル構成

| パス | 内容 |
|---|---|
| `src/asr/stt.ts` | Soniox リアルタイム接続(翻訳、言語ヒント・文脈、再接続、音声の間引き、原文と翻訳の組の推定) |
| `src/main.ts` | メガネの画面構成、文字の折り返しと表示、タップでの一時停止、通信の順番待ち、履歴の保存 |
| `src/ui.ts` | スマホ画面(字幕、設定、履歴) |
| `src/paired.ts` | 対訳の組の表示用データとテキスト化(時刻付き) |
| `src/history.ts` | 会話履歴の保存・読み込み・削除 |
| `src/settings.ts`, `src/languages.ts` | 設定の定義(文脈の組み立てを含む)と翻訳先の言語一覧 |
| `app.json` | Even Hub のマニフェスト(`com.kimmasaf.sonioxtranslatejp`、マイクとネットワークの権限) |
| `sim/` | 画面なしで動かすシミュレーター(Docker、Xvfb、PulseAudio の仮想マイク) |
| `scripts/` | テスト音声の作成、Soniox 単体テスト、アイコンの作成 |
| `test-audio/` | テスト音声(16kHz モノラル WAV) |
| `assets/` | アイコン(24×24 のストア用を含む)とスクリーンショット |
| `docs/実機テスト手順書.md` | 実機での確認手順 |

## 元のプロジェクトからの主な変更

- Even Hub SDK 0.0.16 / CLI 0.2.0 / シミュレーター 0.9.5、Soniox `stt-rt-v6` に更新
- スマホ画面を日本語化し、一般的なスマホの設定画面の形式に作り直し
- 表示モード(3:7 分割、対訳)、一時停止、会話履歴、言語ヒントと文脈の設定を追加
- 話者ラベルをスマホだけに表示、翻訳先と同じ言語の発話の重複表示をなくした
- 画面なしの Linux で動くシミュレーター環境とテスト音声を追加

## プライバシー

- マイクの音声は聞き取り中だけ Soniox に送られます。一時停止中と、アプリを開いていないときは送りません
- API キー、設定、会話履歴は、そのスマホの Even アプリ内にだけ保存されます。履歴は履歴画面から削除できます

## クレジット

- [Even Realities](https://www.evenrealities.com) / [Even Hub](https://hub.evenrealities.com):G2 と SDK
- [Soniox](https://soniox.com):リアルタイム音声認識・翻訳と音声合成(テスト音声)
- 元のプロジェクト:[intelc/soniox-translate](https://github.com/intelc/soniox-translate)
- 文字幅の計測:[`@evenrealities/pretext`](https://www.npmjs.com/package/@evenrealities/pretext)

## ライセンス

[MIT](LICENSE)。Even Realities および Soniox とは関係がなく、両社の承認を受けたものでもありません。
