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

// LINE 返信（quickReply 任意、flex メッセージにも対応）
// result.flexMessage があればそれを送る、なければ text を送る
function sendReply(replyToken, result) {
  const config = getConfig();
  let message;
  if (result.flexMessage) {
    message = result.flexMessage;
  } else {
    message = { type: "text", text: result.replyText };
  }
  const qr = buildQuickReply(result.quickReplyLabels);
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
  if (!event) return empty;

  // Bot がグループ/トークに招待された瞬間にウェルカム + メニューを送る
  if (event.type === "join") {
    return {
      shouldReply: true,
      replyText:
        "こんにちは！割り勘Botです 🧳\n\n" +
        "このグループでの支払いを記録して、最後に精算できるよ。\n" +
        "下のボタンから始めよう！",
      quickReplyLabels: MENU_LABELS,
    };
  }

  if (event.type !== "message" || !event.message || event.message.type !== "text") {
    return empty;
  }

  const receivedText = event.message.text.trim();
  const sourceId = event.source.groupId || event.source.userId;
  const senderId = event.source.userId;

  if (receivedText === "ヘルプ" || receivedText === "使い方") {
    return { shouldReply: true, replyText: MENU_TEXT, quickReplyLabels: MENU_LABELS };
  }

  // 「精算しよう」等の自然な会話で誤発火しないよう、完全一致 or 改行付きのみ受け付ける
  const isSettleExact = receivedText === "精算" || receivedText === "清算";
  const isSettleMultiline = receivedText.startsWith("精算\n") || receivedText.startsWith("清算\n");
  if (isSettleMultiline) {
    const r = computeSettlement(sourceId, receivedText);
    if (r.ok) {
      return {
        shouldReply: true,
        replyText: formatSettlementText(r.data),
        flexMessage: buildSettlementFlex(r.data),
        quickReplyLabels: ["履歴"],
      };
    }
    return { shouldReply: true, replyText: r.error, quickReplyLabels: ["ヘルプ"] };
  }
  if (isSettleExact) {
    // 履歴のメンバーで自動精算を提案
    const payers = getKnownPayers(sourceId);
    if (payers.length === 0) {
      return {
        shouldReply: true,
        replyText: "まだ精算する記録がないみたいだよ。",
        quickReplyLabels: ["記録の仕方", "履歴"],
      };
    }
    return {
      shouldReply: true,
      replyText:
        "未精算の履歴に出てくるメンバーで精算するよ：\n\n" +
        payers.map(function (n) { return "・" + n; }).join("\n") +
        "\n\nこれで OK？\n（0円の参加者がいる場合は「メンバーを追加して精算」を選んでね）",
      quickReplyLabels: ["このメンバーで精算", "メンバーを追加して精算"],
    };
  }

  if (receivedText === "このメンバーで精算") {
    const payers = getKnownPayers(sourceId);
    if (payers.length === 0) {
      return {
        shouldReply: true,
        replyText: "精算する記録がないみたい。",
        quickReplyLabels: ["記録の仕方", "履歴"],
      };
    }
    const r = computeSettlement(sourceId, "精算\n" + payers.join("\n"));
    if (r.ok) {
      return {
        shouldReply: true,
        replyText: formatSettlementText(r.data),
        flexMessage: buildSettlementFlex(r.data),
        quickReplyLabels: ["履歴"],
      };
    }
    return { shouldReply: true, replyText: r.error, quickReplyLabels: ["ヘルプ"] };
  }

  if (receivedText === "メンバーを追加して精算") {
    return {
      shouldReply: true,
      replyText:
        "0円参加者も含めて精算するときは、参加者を全員列挙して送ってね：\n\n" +
        "精算\n（参加者A）\n（参加者B）\n...\n\n" +
        "（払った人だけでよければ「このメンバーで精算」を選んでね）",
      quickReplyLabels: ["履歴"],
    };
  }

  if (receivedText === "メンバー") {
    return { shouldReply: true, replyText: showMembers(sourceId), quickReplyLabels: ["履歴", "ヘルプ"] };
  }

  if (receivedText === "履歴") {
    return { shouldReply: true, replyText: showHistory(sourceId), quickReplyLabels: ["メンバー", "ヘルプ"] };
  }

  if (receivedText === "取消" || receivedText === "取り消し") {
    const records = getRecentRecords(sourceId, 5);
    if (records.length === 0) {
      return {
        shouldReply: true,
        replyText: "取消できる記録がないみたい。",
        quickReplyLabels: ["記録の仕方", "履歴"],
      };
    }
    const lines = records.map(function (r, idx) {
      let line = (idx + 1) + ". " + r.payer + " " + r.amount + "円";
      if (r.content) line += " " + r.content;
      if (r.targets) line += " (対象: " + r.targets.replace(/,/g, ", ") + ")";
      return line;
    });
    const labels = records.map(function (_, idx) { return "取消" + (idx + 1); });
    labels.push("キャンセル");
    return {
      shouldReply: true,
      replyText:
        "最近の記録（最新" + records.length + "件）:\n\n" +
        lines.join("\n") +
        "\n\nどれを取消する？",
      quickReplyLabels: labels,
    };
  }

  const cancelMatch = receivedText.match(/^取消([1-5])$/);
  if (cancelMatch) {
    const idx = parseInt(cancelMatch[1], 10) - 1;
    const records = getRecentRecords(sourceId, 5);
    if (idx >= records.length) {
      return {
        shouldReply: true,
        replyText: "その番号の記録が見つからないみたい。\nもう一度「取消」で一覧を出してね。",
        quickReplyLabels: ["取消", "履歴"],
      };
    }
    const target = records[idx];
    cancelRecordByRow(target.rowNumber);
    let msg = "取消したよ。\n" + target.payer + " " + target.amount + "円";
    if (target.content) msg += " " + target.content;
    return { shouldReply: true, replyText: msg, quickReplyLabels: ["履歴"] };
  }

  if (receivedText === "キャンセル") {
    return {
      shouldReply: true,
      replyText: "OK、取消しなかったよ。",
      quickReplyLabels: ["履歴"],
    };
  }

  // 「＃」は「@」のエイリアスとして扱う（後方互換）。プレフィックスを @ に正規化。
  if (receivedText.startsWith("#") || receivedText.startsWith("＃")) {
    const normalized = "@" + receivedText.substring(1);
    return registerPayment(normalized, sourceId, senderId, config);
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
        "@（支払った人）\n（金額）\n（内容）\n（対象者A）\n（対象者B）\n...\n\n" +
        "※ 4行目以降に対象者を書くと、その人たちだけで割り勘になります\n\n" +
        "▼ 例\n@たろう\n6000\nカラオケ\nたろう\nはなこ",
      quickReplyLabels: ["履歴", "ヘルプ"],
    };
  }

  if (event.message.mention && event.message.mention.mentionees && event.message.mention.mentionees.length > 0) {
    const botMentioned = event.message.mention.mentionees.some(function (m) {
      return m.isSelf === true;
    });
    if (botMentioned) {
      return { shouldReply: true, replyText: MENU_TEXT, quickReplyLabels: MENU_LABELS };
    }
    return empty;
  }

  if (receivedText.startsWith("@") || receivedText.startsWith("＠")) {
    return registerPayment(receivedText, sourceId, senderId, config);
  }

  return empty;
}

// @コマンドの記録処理（@ と ＃ の統合版）
// 1行目: @ + 支払い人, 2行目: 金額, 3行目: 内容（任意）, 4行目以降: 対象者リスト（あれば限定割り勘）
function registerPayment(receivedText, sourceId, senderId, config) {
  const fmtError = {
    shouldReply: true,
    replyText:
      "ごめん、フォーマットが違うみたい。\n\n" +
      "@（支払った人）\n（金額）\n（内容）※任意\n（対象者A）\n（対象者B）...\n\n" +
      "金額は「数字」で送ってね！\n対象を絞らないなら3行までで OK。",
    quickReplyLabels: ["記録の仕方"],
  };

  const parts = receivedText.split("\n");
  parts[0] = parts[0].substring(1).trim();
  if (parts.length < 2) return fmtError;

  const payer = parts[0];
  const amountString = parts[1].trim();
  const hankaku = zenkakuToHankaku(amountString).replace(/[^0-9]/g, "");
  if (!payer || !hankaku || isNaN(hankaku)) return fmtError;

  const amount = Number(hankaku);
  const content = parts.length >= 3 ? parts[2].trim() : "";
  const targets = parts.length >= 4
    ? parts.slice(3).map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; })
    : [];
  const limitedMembersString = targets.length > 0 ? targets.join(",") : "";

  // 記録前にタイポチェック（記録後だと新規入力の名前と一致してしまう）
  const similar = findSimilarPayer(payer, sourceId);

  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  sheet.appendRow([new Date(), sourceId, senderId, payer, amount, content, "記録済", limitedMembersString]);

  let replyText = `【記録しました！】\n支払った人： ${payer}\n金額： ${amount}円`;
  if (content) replyText += `\n内容： ${content}`;
  if (targets.length > 0) {
    replyText += `\n\n★対象者 ( ${targets.length}名 )\n${targets.join(", ")}`;
  }
  if (similar) {
    replyText += `\n\n⚠ もしかして「${similar}」のこと？\n違うなら気にしないでOK。\nタイポなら「取消」で消して入れ直してね。`;
  }
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
    sendReply(replyToken, result);
  }

  return ContentService.createTextOutput(
    JSON.stringify({ status: "ok" })
  ).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------------
// 精算（割り勘）計算
// computeSettlement: シート読み込み + 計算 + ステータス更新（副作用あり）→ 構造化データを返す
// formatSettlementText: 構造化データ → 文字列（altText / フォールバック用）
// buildSettlementFlex: 構造化データ → Flex Message
// calculateSettlement: 後方互換（テキスト）
// ---------------------------------------------------------------------------------

function computeSettlement(sourceId, receivedText) {
  const lines = receivedText.split("\n");
  if (lines.length < 2) {
    return { ok: false, error: "「精算」コマンドの使い方が違うみたい！\n\n精算\n（参加者A）\n（参加者B）\n（参加者C）\n\nのように、改行して「参加者全員」の名前を送ってね。" };
  }

  const participantSet = new Set();
  for (let i = 1; i < lines.length; i++) {
    const name = lines[i].trim();
    if (name) participantSet.add(name);
  }
  const participantList = Array.from(participantSet);
  if (participantList.length === 0) {
    return { ok: false, error: "参加者が誰も指定されてないみたい...。\n\n精算\n（参加者A）\n（参加者B）\n\nのように送ってね！" };
  }

  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  const allData = sheet.getDataRange().getValues();

  let totalAmount = 0;
  const targetRows = [];
  let onlyAtCommandsUsed = true;
  const payments = {};
  const burdens = {};
  participantList.forEach((name) => { payments[name] = 0; burdens[name] = 0; });

  for (let i = 1; i < allData.length; i++) {
    const row = allData[i];
    const rowSourceId = row[1];
    const payer = row[3];
    const amount = row[4];
    const status = row[6];
    const limitedMembersString = row[7];

    if (rowSourceId !== sourceId || status !== "記録済") continue;
    if (typeof amount !== "number" || isNaN(amount)) continue;

    totalAmount += amount;
    payments[payer] = (payments[payer] || 0) + amount;
    targetRows.push(i + 1);

    let targetSplitList;
    if (limitedMembersString) {
      onlyAtCommandsUsed = false;
      targetSplitList = limitedMembersString.split(",").map((n) => n.trim());
    } else {
      targetSplitList = participantList;
    }

    const validBurdenMembers = participantList.filter((name) => targetSplitList.includes(name));
    if (validBurdenMembers.length > 0) {
      const num = validBurdenMembers.length;
      const floorCost = Math.floor(amount / num);
      let remainder = amount % num;
      validBurdenMembers.forEach((name) => {
        let cost = floorCost;
        if (remainder > 0) { cost += 1; remainder--; }
        burdens[name] += cost;
      });
    }
  }

  if (targetRows.length === 0) {
    return { ok: false, error: "精算する記録が何もないみたいだよ。" };
  }

  // 貸し借り精算（最小回数の支払い指示を greedy で算出）
  const creditors = [];
  const debtors = [];
  participantList.forEach((name) => {
    const balance = (payments[name] || 0) - (burdens[name] || 0);
    if (balance > 0) creditors.push({ name: name, amount: balance });
    else if (balance < 0) debtors.push({ name: name, amount: -balance });
  });

  const transactions = [];
  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const transfer = Math.min(c.amount, d.amount);
    if (transfer < 1) {
      if (c.amount < d.amount) ci++; else di++;
      continue;
    }
    const rounded = Math.round(transfer);
    if (rounded > 0) {
      transactions.push({ from: d.name, to: c.name, amount: rounded });
    }
    c.amount -= transfer;
    d.amount -= transfer;
    if (c.amount < 1) ci++;
    if (d.amount < 1) di++;
  }

  // ステータスを「精算済」に更新
  targetRows.forEach((rowNumber) => sheet.getRange(rowNumber, 7).setValue("精算済"));

  const numParticipants = participantList.length;
  return {
    ok: true,
    data: {
      totalAmount: totalAmount,
      participants: participantList,
      transactions: transactions,
      isUniform: onlyAtCommandsUsed,
      averagePerPerson: onlyAtCommandsUsed ? Number((totalAmount / numParticipants).toFixed(0)) : null,
      hasFractionalRemainder: onlyAtCommandsUsed && (totalAmount % numParticipants !== 0),
    },
  };
}

function formatSettlementText(data) {
  let m = `【精算結果】\n\n`;
  m += `◆ 支払総額 (記録済)： ${data.totalAmount} 円\n`;
  m += `◆ 精算メンバー ( ${data.participants.length} 人 )：\n`;
  m += `（${data.participants.join(", ")}）\n`;
  if (data.isUniform) {
    m += `◆ 1人あたり： 約 ${data.averagePerPerson} 円\n`;
    if (data.hasFractionalRemainder) m += `（1円単位の端数調整あり）\n`;
  }
  m += `\n`;
  if (data.transactions.length > 0) {
    m += `--- 支払い指示 (最小回数) ---\n`;
    m += data.transactions.map((t) => `${t.from} → ${t.to} に ${t.amount}円`).join("\n");
  } else {
    m += `--- 貸し借りなし！ ---\nみんなピッタリだね！`;
  }
  return m;
}

function buildSettlementFlex(data) {
  function fmtYen(n) { return n.toLocaleString() + " 円"; }
  function summaryRow(label, value, color) {
    return {
      type: "box",
      layout: "horizontal",
      contents: [
        { type: "text", text: label, size: "sm", color: "#888888", flex: 4 },
        { type: "text", text: value, size: "md", weight: "bold", align: "end", flex: 6, wrap: true, color: color || "#111111" },
      ],
    };
  }

  const summaryContents = [
    summaryRow("支払総額", fmtYen(data.totalAmount), "#06C755"),
    summaryRow("メンバー", data.participants.length + " 人"),
  ];
  if (data.isUniform) {
    summaryContents.push(summaryRow("1人あたり", "約 " + fmtYen(data.averagePerPerson)));
    if (data.hasFractionalRemainder) {
      summaryContents.push({
        type: "text", text: "※ 1円単位の端数調整あり",
        size: "xxs", color: "#999999", align: "end", margin: "xs",
      });
    }
  }

  const bodyContents = [
    { type: "box", layout: "vertical", spacing: "sm", contents: summaryContents },
    {
      type: "text", text: "メンバー: " + data.participants.join(", "),
      size: "xxs", color: "#aaaaaa", wrap: true, margin: "sm",
    },
    { type: "separator", margin: "lg" },
  ];

  if (data.transactions.length > 0) {
    bodyContents.push({
      type: "text", text: "💸 支払い指示 (最小回数)",
      weight: "bold", size: "md", margin: "lg",
    });
    bodyContents.push({
      type: "box", layout: "vertical", spacing: "sm", margin: "md",
      contents: data.transactions.map(function (t) {
        return {
          type: "box", layout: "horizontal", spacing: "sm",
          contents: [
            { type: "text", text: t.from, size: "sm", flex: 3, color: "#555555", wrap: true },
            { type: "text", text: "→", size: "sm", flex: 1, align: "center", color: "#888888" },
            { type: "text", text: t.to, size: "sm", flex: 3, weight: "bold", wrap: true },
            { type: "text", text: fmtYen(t.amount), size: "sm", flex: 3, align: "end", color: "#06C755", weight: "bold" },
          ],
        };
      }),
    });
  } else {
    bodyContents.push({
      type: "box", layout: "vertical", margin: "lg",
      contents: [
        { type: "text", text: "🎉 貸し借りなし！", weight: "bold", size: "md", align: "center", color: "#06C755" },
        { type: "text", text: "みんなピッタリだね", size: "sm", align: "center", color: "#888888", margin: "sm" },
      ],
    });
  }

  const altText = `【精算結果】合計 ${fmtYen(data.totalAmount)} / 支払い指示 ${data.transactions.length} 件`;

  return {
    type: "flex",
    altText: altText,
    contents: {
      type: "bubble",
      header: {
        type: "box", layout: "vertical",
        backgroundColor: "#06C755", paddingAll: "16px",
        contents: [
          { type: "text", text: "🧾 精算結果", color: "#FFFFFF", weight: "bold", size: "lg" },
        ],
      },
      body: {
        type: "box", layout: "vertical", spacing: "md",
        contents: bodyContents,
      },
    },
  };
}

// 後方互換（テキストで返す）
function calculateSettlement(sourceId, receivedText) {
  const r = computeSettlement(sourceId, receivedText);
  return r.ok ? formatSettlementText(r.data) : r.error;
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

// グループ内の最新 N 件の「記録済」レコードを返す（新しい順、行番号付き）
function getRecentRecords(sourceId, limit) {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const records = [];
  for (let i = data.length - 1; i >= 1 && records.length < limit; i--) {
    const row = data[i];
    if (row[1] === sourceId && row[6] === "記録済") {
      records.push({
        rowNumber: i + 1,
        payer: row[3],
        amount: row[4],
        content: row[5] || "",
        targets: row[7] || "",
      });
    }
  }
  return records;
}

// 指定した行のステータスを「取消済」に変更
function cancelRecordByRow(rowNumber) {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  sheet.getRange(rowNumber, 7).setValue("取消済");
}

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
// 名前を正規化（全角英数→半角、全角スペース→半角、カタカナ→ひらがな、trim）
function normalizeName(s) {
  if (!s) return "";
  let r = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  });
  r = r.replace(/　/g, " ").trim();
  r = r.replace(/[ァ-ヶ]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0x60);
  });
  return r;
}

// 既存の払った人の中で、正規化したら一致するけど元の表記が違う名前があれば返す
// 例: "タロウ" を新規入力したとき履歴に "たろう" があれば "たろう" を返す
function findSimilarPayer(newName, sourceId) {
  const normalized = normalizeName(newName);
  if (!normalized) return null;
  const payers = getKnownPayers(sourceId);
  for (let i = 0; i < payers.length; i++) {
    const existing = payers[i];
    if (existing === newName) return null; // 完全一致は警告不要
    if (normalizeName(existing) === normalized) return existing;
  }
  return null;
}

// 未精算の履歴に出てくる「払った人」のユニーク一覧を返す
function getKnownPayers(sourceId) {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const set = new Set();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[1] === sourceId && row[6] === "記録済" && row[3]) {
      set.add(row[3]);
    }
  }
  return Array.from(set);
}

// メインのメニュー文言（ヘルプとBotメンションで共通）
const MENU_TEXT =
  "【割り勘Botのメニュー】\n" +
  "何をする？下のボタンから選んでね。\n\n" +
  "（記録は @（払った人）で送ってね）";
const MENU_LABELS = ["記録の仕方", "履歴", "精算", "メンバー", "取消"];