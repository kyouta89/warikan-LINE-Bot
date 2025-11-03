# 割り勘LINE Bot (Warikan LINE Bot)

これは Google Apps Script (GAS) で動作する、割り勘管理用のLINE Botです。

## ✨ できること

* グループLINEでの支払い記録 (`@` コマンド)
* メンバーを指定した限定的な割り勘 (`＃` コマンド)
* 最小回数での精算
* 履歴の確認やリセット

## 🔧 使い方 (コマンド一覧)

(ここに `getHelpMessage()` の内容をコピペして貼る)

## 🚀 セットアップ方法

これがGASプロジェクトでは一番大事！
もしキミがこのBotを「他の人にも使ってもらいたい」とか「将来、別のGoogleアカウントで再設定する」時に、絶対に必要になるメモだよ。

1.  LINE Developers で... (Messaging API のチャネルを作成)
2.  Google スプレッドシートを... (新規作成する)
3.  GASプロジェクトを... (新規作成し、`clasp push` する)
4.  GASの「スクリプトプロパティ」に、以下の2つを設定する。
    * `CHANNEL_ACCESS_TOKEN`: (LINE Developersから取得したトークン)
    * `SPREADSHEET_ID`: (スプレッドシートのURLから取得したID)
5.  GASプロジェクトを「ウェブアプリ」として「デプロイ」し、`doPost` が動くようにする。
6.  デプロイして取得した「ウェブアプリURL」を、LINE Developers の「Webhook URL」に設定する。
