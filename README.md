# work-bot

Discordで /room [Name] [Time(オプション)] を受け取って一時的なボイスチャンネルを作る最小実装です。

使い方

- .env を作成して `DISCORD_TOKEN` と `CLIENT_ID` を設定
- `npm install` して `npm start` で起動

Northflank

- Northflank に Docker イメージをデプロイすることを想定しています。Dockerfile が含まれているので、Image をビルドして環境変数を設定してください（DISCORD_TOKEN, CLIENT_ID）。

注意点

- 現状は最小実装です。チャンネル削除のキャンセル機能や永続ストレージは未実装です。

作業鯖で使えそうなアイデア

- 一時VCで会議用タイマーを表示する（作成時に終了時間をメンション）
- VC入退出時のログをチャンネルに送信して議事録補助
- 特定役職のみ作成できるように権限管理
- 参加者が0人になったら自動削除