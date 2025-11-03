# 割り勘LINE Bot (Warikan LINE Bot)

これは Google Apps Script (GAS) で動作する、割り勘管理用のLINE Botです。

## ✨ できること

* グループLINEでの支払い記録 (`@` コマンド)
* メンバーを指定した限定的な割り勘 (`＃` コマンド)
* 最小回数での精算
* 履歴の確認やリセット

## 🔧 使い方 (コマンド一覧)

【割り勘Botの使い方】

◆ 支払い記録
@（支払った人）
（金額）
（内容）※任意

◆ 精算（参加者全員で）
精算
（参加者A）
（参加者B）
...

◆ 未精算の履歴
履歴

◆ 記録メンバーの確認
メンバー

◆ 直前の記録を消す
取消 or 取り消し

◆ 全記録をリセット
リセット

## 🚀 セットアップ方法

1.  LINE Developers で... (Messaging API のチャネルを作成)
2.  Google スプレッドシートを... (新規作成する)
3.  GASプロジェクトを... (新規作成し、`clasp push` する)
4.  GASの「スクリプトプロパティ」に、以下の2つを設定する。
    * `CHANNEL_ACCESS_TOKEN`: (LINE Developersから取得したトークン)
    * `SPREADSHEET_ID`: (スプレッドシートのURLから取得したID)
5.  GASプロジェクトを「ウェブアプリ」として「デプロイ」し、`doPost` が動くようにする。
6.  デプロイして取得した「ウェブアプリURL」を、LINE Developers の「Webhook URL」に設定する。
