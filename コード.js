// ★★★ 設定値を安全に取得する関数 ★★★
function getConfig() {
  const properties = PropertiesService.getScriptProperties();
  const config = {
    CHANNEL_ACCESS_TOKEN: properties.getProperty('CHANNEL_ACCESS_TOKEN'),
    SPREADSHEET_ID: properties.getProperty('SPREADSHEET_ID'),
    SHEET_NAME: properties.getProperty('SHEET_NAME') || 'シート1' // デフォルト値
  };
  
  // 必要な設定が取得できているかチェック
  if (!config.CHANNEL_ACCESS_TOKEN || !config.SPREADSHEET_ID) {
    throw new Error('必要な設定値が見つかりません。プロジェクト設定を確認してください。');
  }
  
  return config;
}

// LINEの返信APIのURL
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";

// Quick Reply ボタンを組み立てる（ラベル文字列＝送信される文字列）
function buildQuickReply(labels) {
  if (!labels || labels.length === 0) return null;
  return {
    items: labels.map(function (label) {
      return {
        type: "action",
        action: { type: "message", label: label, text: label },
      };
    }),
  };
}

// LINE 返信（quickReply 任意）
function sendReply(replyToken, text, quickReplyLabels) {
  const config = getConfig();
  const message = { type: "text", text: text };
  const qr = buildQuickReply(quickReplyLabels);
  if (qr) message.quickReply = qr;
  UrlFetchApp.fetch(REPLY_URL, {
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      Authorization: "Bearer " + config.CHANNEL_ACCESS_TOKEN,
    },
    method: "post",
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: [message],
    }),
  });
}

// LINEイベント → 返信内容（{shouldReply, replyText, quickReplyLabels}）を返す純粋関数。
// LINE API は呼ばないのでテストしやすい。スプレッドシートI/Oは内側の関数に閉じている。
function handleEvent(event, config) {
  const empty = { shouldReply: false, replyText: "", quickReplyLabels: [] };
  if (!event || event.type !== "message" || !event.message || event.message.type !== "text") {
    return empty;
  }

  const receivedText = event.message.text.trim();
  const sourceId = event.source.groupId || event.source.userId;
  const senderId = event.source.userId;

  if (receivedText === "ヘルプ" || receivedText === "使い方") {
    return { shouldReply: true, replyText: getHelpMessage(), quickReplyLabels: ["履歴", "メンバー"] };
  }

  if (receivedText.startsWith("精算") || receivedText.startsWith("清算")) {
    if (receivedText.includes("\n")) {
      const text = calculateSettlement(sourceId, receivedText);
      const labels = text.indexOf("【精算結果】") === 0 ? ["履歴"] : ["ヘルプ"];
      return { shouldReply: true, replyText: text, quickReplyLabels: labels };
    }
    return {
      shouldReply: true,
      replyText: "「精算」コマンドの使い方が違うみたい！\n\n精算\n（参加者A）\n（参加者B）\n（参加者C）\n\nのように、改行して「参加者全員」の名前を送ってね。",
      quickReplyLabels: ["メンバー", "ヘルプ"],
    };
  }

  if (receivedText === "リセット") {
    return { shouldReply: true, replyText: resetAllRecords(sourceId), quickReplyLabels: [] };
  }

  if (receivedText === "メンバー") {
    return { shouldReply: true, replyText: showMembers(sourceId), quickReplyLabels: ["履歴", "ヘルプ"] };
  }

  if (receivedText === "履歴") {
    return { shouldReply: true, replyText: showHistory(sourceId), quickReplyLabels: ["メンバー", "ヘルプ"] };
  }

  if (receivedText === "取消" || receivedText === "取り消し") {
    return { shouldReply: true, replyText: cancelLastRecord(senderId), quickReplyLabels: ["履歴"] };
  }

  // 限定割り勘 (＃) — 「@」より先に判定する
  if (receivedText.startsWith("#") || receivedText.startsWith("＃")) {
    const text = registerLimitedPayment(receivedText, sourceId, senderId, config);
    const labels = text.indexOf("【限定記録しました！】") === 0 ? ["履歴", "取消"] : ["ヘルプ"];
    return { shouldReply: true, replyText: text, quickReplyLabels: labels };
  }

  if (receivedText === "記録の仕方") {
    return {
      shouldReply: true,
      replyText:
        "誰が割り勘の対象になる？\n\n" +
        "・全員で割るなら → [全員で割る]\n" +
        "・一部の人だけで割るなら → [一部だけで割る]",
      quickReplyLabels: ["全員で割る", "一部だけで割る"],
    };
  }

  if (receivedText === "全員で割る") {
    return {
      shouldReply: true,
      replyText:
        "【全員で割る場合の記録方法】\n\n" +
        "下のように送ってね（改行して2〜3行）：\n\n" +
        "@（支払った人）\n（金額）\n（内容）※任意\n\n" +
        "▼ 例\n@たろう\n3000\nランチ",
      quickReplyLabels: ["履歴", "ヘルプ"],
    };
  }

  if (receivedText === "一部だけで割る") {
    return {
      shouldReply: true,
      replyText:
        "【一部の人だけで割る場合の記録方法】\n\n" +
        "下のように送ってね（4行目以降に対象者を全員列挙）：\n\n" +
        "＃（支払った人）\n（金額）\n（内容）\n（対象者A）\n（対象者B）\n...\n\n" +
        "▼ 例\n＃たろう\n6000\nカラオケ\nたろう\nはなこ",
      quickReplyLabels: ["履歴", "ヘルプ"],
    };
  }

  if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
    const botMentioned = event.message.mention.mentionees.some(function (m) {
      return m.isSelf === true;
    });
    if (botMentioned) {
      return {
        shouldReply: true,
        replyText: "呼んでくれてありがとう！\n何をしたい？\n下のボタンから選んでね。",
        quickReplyLabels: ["記録の仕方", "履歴", "メンバー", "ヘルプ"],
      };
    }
    return empty;
  }

  if (receivedText.startsWith("@") || receivedText.startsWith("＠")) {
    return registerSimplePayment(receivedText, sourceId, senderId, config);
  }

  return empty;
}

// @ コマンドの記録処理（handleEventから切り出し、{replyText, quickReplyLabels, shouldReply}を返す）
function registerSimplePayment(receivedText, sourceId, senderId, config) {
  const fmtError2or3 = {
    shouldReply: true,
    replyText: "ごめん、フォーマットが違うみたい。\n\n@（支払った人）\n（金額）\n（内容は任意）\n\nの2行か3行で送ってね！",
    quickReplyLabels: ["ヘルプ"],
  };
  const fmtErrorAmount = {
    shouldReply: true,
    replyText: "ごめん、フォーマットが違うみたい。\n\n@（支払った人）\n（金額）\n（内容は任意）\n\n金額はちゃんと「数字」で送ってね！",
    quickReplyLabels: ["ヘルプ"],
  };

  const parts = receivedText.split("\n");
  parts[0] = parts[0].substring(1).trim();
  if (parts.length !== 2 && parts.length !== 3) return fmtError2or3;

  const payer = parts[0];
  const amountString = parts[1].trim();
  let hankaku = zenkakuToHankaku(amountString).replace(/[^0-9]/g, "");
  if (!payer || !hankaku || isNaN(hankaku)) return fmtErrorAmount;

  const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);
  const amount = Number(hankaku);
  const content = parts.length === 3 ? parts[2].trim() : "";
  sheet.appendRow([new Date(), sourceId, senderId, payer, amount, content, "記録済", ""]);

  let replyText = `【記録しました！】\n支払った人： ${payer}\n金額： ${amount}円`;
  if (content) replyText += `\n内容： ${content}`;
  return { shouldReply: true, replyText: replyText, quickReplyLabels: ["履歴", "取消"] };
}

// LINEからメッセージが来た時に実行される関数（薄いI/Oラッパー）
function doPost(e) {
  let replyToken = "";
  let result = { shouldReply: false, replyText: "", quickReplyLabels: [] };

  try {
    const config = getConfig();
    const event = JSON.parse(e.postData.contents).events[0];
    replyToken = event.replyToken;
    result = handleEvent(event, config);
  } catch (err) {
    result = {
      shouldReply: true,
      replyText: "ごめん、エラーが発生しちゃったみたい...",
      quickReplyLabels: [],
    };
    try {
      const config = getConfig();
      const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
      sheet.appendRow([new Date(), "ERROR", err.message, "Request received"]);
    } catch (e2) {}
  }

  if (replyToken && result.shouldReply) {
    sendReply(replyToken, result.replyText, result.quickReplyLabels);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ status: "ok" })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------------
// ★★★ ここから下が【Ver2】「限定割り勘」対応の「精算計算」関数 ★★★
// ---------------------------------------------------------------------------------
function calculateSettlement(sourceId, receivedText) {
  // ----------------
  // 0. 参加者リストの解析 (ここはVer1と同じ)
  // ----------------
  const lines = receivedText.split("\n");
  if (lines.length < 2) {
    return "「精算」コマンドの使い方が違うみたい！\n\n精算\n（参加者A）\n（参加者B）\n（参加者C）\n\nのように、改行して「参加者全員」の名前を送ってね。";
  }

  const participants = new Set();
  for (let i = 1; i < lines.length; i++) {
    const name = lines[i].trim();
    if (name) {
      participants.add(name);
    }
  }
  const participantList = Array.from(participants); // 最終的な精算参加者リスト
  const numParticipants = participantList.length;

  if (numParticipants === 0) {
    return "参加者が誰も指定されてないみたい...。\n\n精算\n（参加者A）\n（参加者B）\n\nのように送ってね！";
  }

  // ----------------
  // 1. スプレッドシートから支払いデータを取得
  // ----------------
  const config = getConfig();
  const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);
  const allData = sheet.getDataRange().getValues();

  let totalAmount = 0; // 支払総額（サマリー表示用）
  const targetRows = []; // 精算対象の「行番号」

  // ★★★【NEW!!】「@」コマンドだけが使われたかのフラグ ★★★
  let onlyAtCommandsUsed = true;

  // ★★★【変更点 1】★★★
  // 「支払額」と「負担額」を別々に集計するオブジェクトを用意
  const payments = {}; // 誰がいくら【支払ったか】
  const burdens = {};  // 誰がいくら【負担すべきか】

  // 精算参加者リスト（participantList）全員分を0で初期化
  participantList.forEach((name) => {
    payments[name] = 0;
    burdens[name] = 0;
  });

  // ----------------
  // 2. 割り勘計算（★1行ずつ処理）
  // ----------------

  // 1行目（ヘッダー）を飛ばして2行目からチェック
  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const rowSourceId = row[1]; // B列: グループID
    const payer = row[3]; // D列: 支払った人
    const amount = row[4]; // E列: 金額
    const status = row[6]; // G列: ステータス
    // ★★★【変更点 2】★★★
    const limitedMembersString = row[7]; // H列: 限定対象者リスト（カンマ区切り）

    // 「グループIDが一致」かつ「ステータスが "記録済"」の行だけ
    if (rowSourceId === sourceId && status === "記録済") {
      if (typeof amount === "number" && !isNaN(amount)) {
        
        // (A) 支払総額（サマリー用）に加算
        totalAmount += amount;
        
        // (B) 「支払者」を集計（Ver1と同じ）
        // ※精算メンバー外の人が支払った場合も考慮するため、初期化(L196)とは別に集計
        if (payments[payer]) {
          payments[payer] += amount;
        } else {
          payments[payer] = amount;
        }

        // (C) 精算対象の行番号を保存
        targetRows.push(i + 1); //

        // ★★★【変更点 3】★★★
        // (D) 「負担額」を割り振る
        
        let targetSplitList = []; // 今回の割り勘対象者

        if (limitedMembersString) {
          // (D-1) H列に指定がある場合 (＃コマンド)

          // ★★★【NEW!!】「＃」が1件でもあればフラグをfalseに ★★★
          onlyAtCommandsUsed = false;
          
          targetSplitList = limitedMembersString.split(',').map(name => name.trim());
        } else {
          // (D-2) H列が空欄の場合 (＠コマンド)
          targetSplitList = participantList; // 精算メンバー全員が対象
        }

        // 「精算メンバー(participantList)」かつ「今回の支払対象者(targetSplitList)」
        // ＝『今回、負担すべき人たち』
        const validBurdenMembers = participantList.filter(name =>
          targetSplitList.includes(name)
        );

        // 負担すべき人が1人以上いる場合のみ、負担額を計算
        if (validBurdenMembers.length > 0) {
          const numValidBurdens = validBurdenMembers.length;
          
          // 1円の誤差も出ないように割り勘額を計算 (Ver1のL225-L238 のロジック)
          const averageCost_floor = Math.floor(amount / numValidBurdens);
          let remainder = amount % numValidBurdens;

          // 『今回、負担すべき人たち』の burdens に金額を加算
          validBurdenMembers.forEach(name => {
            let cost = averageCost_floor;
            if (remainder > 0) {
              cost += 1;
              remainder--;
            }
            burdens[name] += cost; // ★個人の負担総額に加算！
          });
        }
        // (もし validBurdenMembers が0人 = 精算メンバー外での割り勘なら、
        //  精算メンバーの負担額(burdens)は誰も増えない。これでOK)
      }
    }
  }

  // 精算対象のデータがあるかチェック (Ver1と同じ)
  if (targetRows.length === 0) {
    return "精算する記録が何もないみたいだよ。"; //
  }

  // ----------------
  // 3. 貸し借り（精算）の計算
  // ----------------
  
  // ★★★【変更点 4】★★★
  // Ver1の「総額÷人数」の計算 (L224-L238) は丸ごと削除！
  // 代わりに、集計した「支払額」と「負担額」で差額を計算

  const balances = {}; // 貸し借り
  
  // 「精算メンバー」全員の貸し借りを計算
  participantList.forEach((name) => {
    const paid = payments[name] || 0; // その人が支払った総額
    const burden = burdens[name] || 0; // その人が負担すべき総額
    
    balances[name] = paid - burden; // (支払った額 - 負担総額)
  });


  // ----------------
  // 貸し借り（精算）の計算ロジック (ここはVer1と全く同じ)
  // ----------------
  const creditors = []; // プラスの人
  const debtors = []; // マイナスの人

  for (const name in balances) {
    const balance = balances[name];
    if (balance > 0) {
      creditors.push({ name: name, amount: balance });
    } else if (balance < 0) {
      debtors.push({ name: name, amount: -balance });
    }
  }

  const transactions = [];
  let creditorIndex = 0;
  let debtorIndex = 0;

  while (creditorIndex < creditors.length && debtorIndex < debtors.length) {
    const creditor = creditors[creditorIndex];
    const debtor = debtors[debtorIndex];
    const transferAmount = Math.min(creditor.amount, debtor.amount);

    if (transferAmount < 1) {
      if (creditor.amount < debtor.amount) creditorIndex++;
      else debtorIndex++;
      continue;
    }

    const roundedAmount = Math.round(transferAmount);
    if (roundedAmount > 0) {
      transactions.push(
        `${debtor.name} → ${creditor.name} に ${roundedAmount}円`
      );
    }

    creditor.amount -= transferAmount;
    debtor.amount -= transferAmount;

    if (creditor.amount < 1) creditorIndex++;
    if (debtor.amount < 1) debtorIndex++;
  }

  // ----------------
  // 4. 返信メッセージを作成
  // ----------------
  
  // ★★★【変更点 5】★★★
  // 「1人あたり」は人によって違うので、サマリーから削除
  
  let replyMessage = `【精算結果】\n\n`;
  replyMessage += `◆ 支払総額 (記録済)： ${totalAmount} 円\n`;
  replyMessage += `◆ 精算メンバー ( ${numParticipants} 人 )：\n`;
  replyMessage += `（${participantList.join(", ")}）\n`;
  
  // ★★★【NEW!!】「@」コマンドだけだったら「1人あたり」を表示 ★★★
  if (onlyAtCommandsUsed) {
    const displayAverage = (totalAmount / numParticipants).toFixed(0);
    replyMessage += `◆ 1人あたり： 約 ${displayAverage} 円\n`;
    if (totalAmount % numParticipants !== 0) {
      replyMessage += `（1円単位の端数調整あり）\n`;
    }
  }

  // 元のL325 の改行は、ここに入れる
  replyMessage += `\n`;

  if (transactions.length > 0) {
    replyMessage += `--- 支払い指示 (最小回数) ---\n`;
    replyMessage += transactions.join("\n");
  } else {
    replyMessage += `--- 貸し借りなし！ ---\nみんなピッタリだね！`;
  }

  // ----------------
  // 5. ステータスを「精算済」に更新 (Ver1と同じ)
  // ----------------
  targetRows.forEach((rowNumber) => {
    sheet.getRange(rowNumber, 7).setValue("精算済");
  });

  return replyMessage;
}

// ---------------------------------------------------------------------------------
// ★★★ ここから下が新しく追加した「全角数字を半角にする」専用の関数 ★★★
// ---------------------------------------------------------------------------------
function zenkakuToHankaku(str) {
  if (!str) return "";
  return str.replace(/[０-９]/g, function (s) {
    return String.fromCharCode(s.charCodeAt(0) - 0xfee0);
  });
}

// ---------------------------------------------------------------------------------
// ★★★ ここから下が新しく追加した「直前の記録を取消」専用の関数 ★★★
// ---------------------------------------------------------------------------------
function cancelLastRecord(senderId) {
  const config = getConfig();
  const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);

  // シートの全データを取得
  const allData = sheet.getDataRange().getValues();

  // シートの「下から上へ」とスキャンしていく（一番最後の記録を見つけるため）
  for (let i = allData.length - 1; i >= 1; i--) {
    // i=0 はヘッダーなので無視
    const row = allData[i];
    const rowSenderId = row[2]; // C列: 送信者ID
    const status = row[6]; // G列: ステータス

    // 「コマンドを送った本人」の、
    // 「まだ精算されてない（記録済）」の記録を見つけたら
    if (rowSenderId === senderId && status === "記録済") {
      const rowNumber = i + 1; // 配列のインデックス(0始まり)を行番号(1始まり)に変換

      // G列（7列目）のステータスを「取消済」に変更
      sheet.getRange(rowNumber, 7).setValue("取消済");

      // ユーザーにどの記録を消したか通知
      const payer = row[3];
      const amount = row[4];
      const content = row[5] || "（内容なし）";

      return `【記録を取消しました】\n${payer}: ${amount}円 (${content})`;
    }
  }

  // ループを全部回っても見つからなかった場合
  return "取消できる、あなた自身の「未精算の記録」が見つかりませんでした。";
}

// ---------------------------------------------------------------------------------
// ★★★ ここから下が新しく追加した「全記録リセット」専用の関数 ★★★
// ---------------------------------------------------------------------------------
function resetAllRecords(sourceId) {
  const config = getConfig();
  const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);

  // シートの全データを取得
  const allData = sheet.getDataRange().getValues();

  const targetRows = []; // リセット対象の「行番号」

  // 1行目（ヘッダー）を飛ばして2行目からチェック（上から全部スキャン）
  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const rowSourceId = row[1]; // B列: グループID
    const status = row[6]; // G列: ステータス

    // 「グループIDが一致」かつ「ステータスが "記録済"」の行を対象にする
    if (rowSourceId === sourceId && status === "記録済") {
      targetRows.push(i + 1); // (iは0始まり、行番号は1始まりなので +1)
    }
  }

  // ----------------
  // リセット対象があるかチェック
  // ----------------
  if (targetRows.length === 0) {
    return "リセットする「記録済」のデータはありませんでした。";
  }

  // ----------------
  // ステータスを「リセット済」に更新
  // ----------------
  targetRows.forEach((rowNumber) => {
    // G列（7列目）のステータスを書き換える
    sheet.getRange(rowNumber, 7).setValue("リセット済");
  });

  return `【リセット完了】\n${targetRows.length}件の未精算データをすべてリセットしました。`;
}

// ---------------------------------------------------------------------------------
// ★★★ ここから下が新しく追加した「履歴表示」専用の関数 ★★★
// ---------------------------------------------------------------------------------
function showHistory(sourceId) {
  const config = getConfig();
  const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);

  // シートの全データを取得
  const allData = sheet.getDataRange().getValues();

  let totalAmount = 0; // 支払総額
  const historyList = []; // 履歴メッセージの配列

  // 1行目（ヘッダー）を飛ばして2行目からチェック
  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const rowSourceId = row[1]; // B列: グループID
    const payer = row[3]; // D列: 支払った人
    const amount = row[4]; // E列: 金額
    const content = row[5] || "内容なし"; // F列: 内容（なければデフォルト）
    const status = row[6]; // G列: ステータス

    // 「グループIDが一致」かつ「ステータスが "記録済"」の行だけ
    if (rowSourceId === sourceId && status === "記録済") {
      // データが正常か（金額が数値か）チェック
      if (typeof amount === "number" && !isNaN(amount)) {
        totalAmount += amount;
        historyList.push(`・ ${payer}: ${amount}円 (${content})`);
      }
    }
  }

  // ----------------
  // 履歴があるかチェック
  // ----------------
  if (historyList.length === 0) {
    return "まだ「記録済」のデータは1件もないみたいだよ。";
  }

  // ----------------
  // 返信メッセージを作成
  // ----------------
  let replyMessage = `【未精算の履歴】\n\n`;
  replyMessage += historyList.join("\n"); // 履歴を改行で連結
  replyMessage += `\n\n----------------\n合計: ${totalAmount}円`;

  return replyMessage;
}

// ★★★ ここから下が「"記録済"の」メンバー一覧を表示する関数 ★★★
// ---------------------------------------------------------------------------------
function showMembers(sourceId) {
  const config = getConfig();
  const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
  const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);

  // シートの全データを取得
  const allData = sheet.getDataRange().getValues();

  // Set を使って、名前の重複を自動的に排除する
  const memberSet = new Set();

  // 1行目（ヘッダー）を飛ばして2行目からチェック
  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const rowSourceId = row[1]; // B列: グループID
    const payer = row[3]; // D列: 支払った人
    const status = row[6]; // G列: ステータス

    // ★★★ 「グループIDが一致」かつ「ステータスが "記録済"」の行だけ ★★★
    if (rowSourceId === sourceId && status === "記録済") {
      if (payer) {
        // 支払者名が空欄じゃないことを確認
        memberSet.add(payer);
      }
    }
  }

  // ----------------
  // メンバーがいるかチェック
  // ----------------
  if (memberSet.size === 0) {
    return "現在「記録済」の支払いをしたメンバーはいないみたいだよ。";
  }

  // ----------------
  // 返信メッセージを作成
  // ----------------
  // Set を配列に変換して、リスト化
  const memberList = Array.from(memberSet);

  let replyMessage = `【現在の支払いメンバー（未精算）】\n\n`;
  replyMessage += memberList.map((name) => `・ ${name}`).join("\n"); // 「・ 名前」のリストにする
  replyMessage += `\n\n（↑「精算」コマンドで、支払い0円の人を追加するのを忘れないでね！）`;

  return replyMessage;
}

// ---------------------------------------------------------------------------------
// ★★★ ここから下が新しく追加した「ヘルプ」専用の関数 ★★★
// ---------------------------------------------------------------------------------
function getHelpMessage() {
  let message = `【割り勘Botの使い方】\n\n`; // タイトル

  message += `◆ 支払い記録\n`;
  message += `@（支払った人）\n`;
  message += `（金額）\n`;
  message += `（内容）※任意\n\n`;

  message += `◆ 精算（参加者全員で）\n`;
  message += `精算\n`;
  message += `（参加者A）\n`;
  message += `（参加者B）\n`;
  message += `...\n\n`;

  message += `◆ 未精算の履歴\n`;
  message += `履歴\n\n`;

  message += `◆ 記録メンバーの確認\n`;
  message += `メンバー\n\n`;

  message += `◆ 直前の記録を消す\n`;
  message += `取消 or 取り消し\n\n`;

  message += `◆ 全記録をリセット\n`;
  message += `リセット`;

  return message;
}

// ＃コマンドで限定割り勘を登録する関数
function registerLimitedPayment(receivedText, sourceId, senderId, config) {
  const parts = receivedText.split("\n");
  parts[0] = parts[0].substring(1).trim(); // 「#」を取り除く

  // ★「限定」は最低4行（支払者、金額、内容、対象者1）が必要
  if (parts.length < 4) {
    return "ごめん、限定割り勘のフォーマットが違うみたい。\n\n＃（支払った人）\n（金額）\n（内容）\n（対象者A）\n（対象者B）...\n\nのように、対象者を「4行目以降」に指定してね！";
  }

  const payer = parts[0];
  const amountString = parts[1].trim();
  let hankakuAmountString = zenkakuToHankaku(amountString); //
  hankakuAmountString = hankakuAmountString.replace(/[^0-9]/g, "");

  // ★対象者リスト（4行目以降）を取得
  const targetMembers = [];
  for (let i = 3; i < parts.length; i++) {
    const name = parts[i].trim();
    if (name) { // 空白行は無視
      targetMembers.push(name);
    }
  }

  // 必須項目（支払者、金額、対象者1人以上）のチェック
  if (payer && hankakuAmountString && !isNaN(hankakuAmountString) && targetMembers.length > 0) {
    const spreadSheet = SpreadsheetApp.openById(config.SPREADSHEET_ID);
    const sheet = spreadSheet.getSheetByName(config.SHEET_NAME);
    const amount = Number(hankakuAmountString);
    const content = parts[2].trim() || "（内容なし）"; // 3行目が空でもOK
    const status = "記録済";
    
    // ★H列（8列目）に「カンマ区切り」の文字列で保存
    const limitedMembersString = targetMembers.join(","); 

    sheet.appendRow([
      new Date(),
      sourceId,
      senderId,
      payer,
      amount,
      content,
      status,
      limitedMembersString // ★H列に保存！
    ]);

    let replyText = `【限定記録しました！】\n支払った人： ${payer}\n金額： ${amount}円`;
    if (content !== "（内容なし）") {
      replyText += `\n内容： ${content}`;
    }
    replyText += `\n\n★対象者 ( ${targetMembers.length}名 )\n${targetMembers.join(", ")}`;
    
    return replyText;

  } else {
    // 項目が足りない場合
    return "ごめん、フォーマットが違うか、対象者が指定されてないみたい。\n\n＃（支払った人）\n（金額）\n（内容）\n（対象者A）\n...\n\n金額は「数字」、対象者は「1人以上」指定してね！";
  }
}