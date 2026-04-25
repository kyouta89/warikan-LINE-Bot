// ============================================================
// テスト用ハーネス（本番コードには影響しない）
// sourceId を "TEST_GROUP_001" にして、本番シート内で論理分離する
//
// 実行方法:
//   1) clasp push
//   2) GASエディタ or `clasp run __test_runAll` で関数を呼ぶ
//   3) `clasp logs` で Logger.log の出力を確認
//
// ※ テスト後は __test_cleanup() でテスト行を削除する
// ============================================================

const TEST_SOURCE_ID = 'TEST_GROUP_001';
const TEST_SENDER_ID = 'TEST_USER_001';

// テスト行を物理削除（本番データには触れない）
function __test_cleanup() {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  let deleted = 0;
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === TEST_SOURCE_ID) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  Logger.log('[cleanup] deleted ' + deleted + ' test rows');
}

// @コマンド相当: 通常の支払い記録を直接シートに追加
function __test_seed_at_records() {
  const config = getConfig();
  const sheet = SpreadsheetApp.openById(config.SPREADSHEET_ID).getSheetByName(config.SHEET_NAME);
  sheet.appendRow([new Date(), TEST_SOURCE_ID, TEST_SENDER_ID, 'Alice', 3000, 'lunch', '記録済', '']);
  sheet.appendRow([new Date(), TEST_SOURCE_ID, TEST_SENDER_ID, 'Bob',   1500, 'snack', '記録済', '']);
  sheet.appendRow([new Date(), TEST_SOURCE_ID, TEST_SENDER_ID, 'Alice', 4500, 'dinner','記録済', '']);
  Logger.log('[seed @] 3 rows added');
}

// 限定割り勘相当: 4行目以降に対象者を書いて登録（@ 統合済みの新フォーマット）
function __test_seed_limited() {
  const config = getConfig();
  const text = '@Carol\n6000\nKaraoke\nAlice\nCarol';
  const result = registerPayment(text, TEST_SOURCE_ID, TEST_SENDER_ID, config);
  Logger.log('[seed limited] ' + result.replyText);
}

function __test_history() {
  Logger.log('[履歴]\n' + showHistory(TEST_SOURCE_ID));
}

function __test_members() {
  Logger.log('[メンバー]\n' + showMembers(TEST_SOURCE_ID));
}

// 「精算\nAlice\nBob\nCarol」相当
function __test_settlement_all() {
  const text = '精算\nAlice\nBob\nCarol';
  Logger.log('[精算]\n' + calculateSettlement(TEST_SOURCE_ID, text));
}

// ============================================================
// handleEvent の自動テスト（純粋関数なので LINE API 不要）
// ============================================================

// LINE webhook の偽イベントを作るヘルパー
function __mkEvent(text, opts) {
  opts = opts || {};
  const event = {
    type: "message",
    replyToken: "DUMMY_TOKEN",
    source: { groupId: TEST_SOURCE_ID, userId: TEST_SENDER_ID, type: "group" },
    message: { type: "text", text: text },
  };
  if (opts.mention) event.message.mention = opts.mention;
  return event;
}

// 簡易アサート（失敗したら throw）
function __assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}
function __assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("ASSERT FAILED: " + msg + "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual));
  }
}

function __test_handleEvent_dispatch() {
  const config = getConfig();
  let r;
  let pass = 0, fail = 0;
  function check(name, fn) {
    try { fn(); pass++; Logger.log("  ✅ " + name); }
    catch (err) { fail++; Logger.log("  ❌ " + name + " — " + err.message); }
  }

  // 事前: テストデータを少し入れておく（履歴/メンバー系のテスト用）
  __test_cleanup();
  __test_seed_at_records();

  Logger.log("--- handleEvent dispatch tests ---");

  check("ヘルプ → メニュー化された返信", function () {
    r = handleEvent(__mkEvent("ヘルプ"), config);
    __assert(r.shouldReply === true, "should reply");
    __assertEq(r.quickReplyLabels, ["記録の仕方", "履歴", "精算", "メンバー", "取消"], "menu labels");
    __assert(r.replyText.indexOf("【割り勘Botのメニュー】") === 0, "menu text");
  });

  check("使い方（ヘルプの別名）", function () {
    r = handleEvent(__mkEvent("使い方"), config);
    __assert(r.replyText.indexOf("【割り勘Botのメニュー】") === 0, "alias works");
  });

  check("履歴", function () {
    r = handleEvent(__mkEvent("履歴"), config);
    __assertEq(r.quickReplyLabels, ["メンバー", "ヘルプ"], "labels");
    __assert(r.replyText.indexOf("【未精算の履歴】") === 0, "history text");
  });

  check("メンバー", function () {
    r = handleEvent(__mkEvent("メンバー"), config);
    __assertEq(r.quickReplyLabels, ["履歴", "ヘルプ"], "labels");
  });

  check("精算（成功パス）", function () {
    r = handleEvent(__mkEvent("精算\nAlice\nBob"), config);
    __assert(r.replyText.indexOf("【精算結果】") === 0, "altText fallback");
    __assert(r.flexMessage && r.flexMessage.type === "flex", "flex message present");
    __assert(r.flexMessage.contents.type === "bubble", "flex bubble");
    __assert(r.flexMessage.altText.indexOf("【精算結果】") === 0, "altText set");
    __assertEq(r.quickReplyLabels, ["履歴"], "success labels");
    // 後始末: テスト中に追加した行を「精算済」にされたので、cleanup 用にもう一度 seed
    __test_cleanup();
    __test_seed_at_records();
  });

  check("computeSettlement の構造化データ", function () {
    // seed: Alice=3000, Bob=1500, Alice=4500
    const cs = computeSettlement(TEST_SOURCE_ID, "精算\nAlice\nBob");
    __assert(cs.ok === true, "ok");
    __assertEq(cs.data.totalAmount, 9000, "total");
    __assertEq(cs.data.participants.length, 2, "participants count");
    __assert(cs.data.isUniform === true, "all @ records → isUniform");
    __assertEq(cs.data.averagePerPerson, 4500, "average");
    __assertEq(cs.data.transactions.length, 1, "one transaction");
    __assertEq(cs.data.transactions[0], { from: "Bob", to: "Alice", amount: 3000 }, "Bob → Alice 3000");
    __test_cleanup();
    __test_seed_at_records();
  });

  check("buildSettlementFlex のJSON構造", function () {
    const data = {
      totalAmount: 1000,
      participants: ["X", "Y"],
      transactions: [{ from: "Y", to: "X", amount: 500 }],
      isUniform: true,
      averagePerPerson: 500,
      hasFractionalRemainder: false,
    };
    const flex = buildSettlementFlex(data);
    __assert(flex.type === "flex", "flex type");
    __assert(flex.contents.type === "bubble", "bubble");
    __assert(flex.contents.header.backgroundColor === "#06C755", "green header");
    __assert(JSON.stringify(flex).indexOf("Y") >= 0, "from name in JSON");
    __assert(JSON.stringify(flex).indexOf("500") >= 0, "amount in JSON");
  });

  check("buildSettlementFlex 貸し借りなしレイアウト", function () {
    const data = {
      totalAmount: 1000,
      participants: ["X", "Y"],
      transactions: [],
      isUniform: true,
      averagePerPerson: 500,
      hasFractionalRemainder: false,
    };
    const flex = buildSettlementFlex(data);
    __assert(JSON.stringify(flex).indexOf("貸し借りなし") >= 0, "no-debt layout");
  });

  check("記録の仕方", function () {
    r = handleEvent(__mkEvent("記録の仕方"), config);
    __assertEq(r.quickReplyLabels, ["全員で割る", "一部だけで割る"], "guide labels");
  });

  check("全員で割る", function () {
    r = handleEvent(__mkEvent("全員で割る"), config);
    __assert(r.replyText.indexOf("【全員で割る場合の記録方法】") === 0, "guide text");
    __assertEq(r.quickReplyLabels, ["履歴", "ヘルプ"], "labels");
  });

  check("一部だけで割る", function () {
    r = handleEvent(__mkEvent("一部だけで割る"), config);
    __assert(r.replyText.indexOf("【一部の人だけで割る場合の記録方法】") === 0, "guide text");
  });

  check("Bot メンション → メニュー（ヘルプと同じ）", function () {
    r = handleEvent(__mkEvent("@Bot こんにちは", {
      mention: { mentionees: [{ index: 0, length: 4, isSelf: true }] }
    }), config);
    __assert(r.shouldReply === true, "should reply");
    __assertEq(r.quickReplyLabels, ["記録の仕方", "履歴", "精算", "メンバー", "取消"], "menu labels");
    __assert(r.replyText.indexOf("【割り勘Botのメニュー】") === 0, "menu text");
  });

  check("他メンバーへのメンション → 無視", function () {
    r = handleEvent(__mkEvent("@Alice ねえ", {
      mention: { mentionees: [{ index: 0, length: 6, isSelf: false }] }
    }), config);
    __assert(r.shouldReply === false, "ignored");
  });

  check("@ 記録（成功）— レコード追加される", function () {
    r = handleEvent(__mkEvent("@TestPayer\n100\nメモ"), config);
    __assert(r.replyText.indexOf("【記録しました！】") === 0, "success");
    __assertEq(r.quickReplyLabels, ["履歴", "取消"], "labels");
  });

  check("@ 記録 フォーマットエラー（行数不足）", function () {
    r = handleEvent(__mkEvent("@TestPayer"), config);
    __assert(r.replyText.indexOf("ごめん") === 0, "error");
    __assertEq(r.quickReplyLabels, ["記録の仕方"], "labels point to guide");
  });

  check("@ 記録 金額が文字列", function () {
    r = handleEvent(__mkEvent("@TestPayer\nabc\nメモ"), config);
    __assert(r.replyText.indexOf("ごめん") === 0, "error");
    __assertEq(r.quickReplyLabels, ["記録の仕方"], "labels point to guide");
  });

  check("@ 全角金額の正規化", function () {
    r = handleEvent(__mkEvent("@TestPayer\n３０００"), config);
    __assert(r.replyText.indexOf("3000円") >= 0, "zenkaku → hankaku");
  });

  check("@ 4行以上で限定割り勘になる（新統合フォーマット）", function () {
    r = handleEvent(__mkEvent("@TestPayer\n500\n限定\nAlice\nBob"), config);
    __assert(r.replyText.indexOf("【記録しました！】") === 0, "success");
    __assert(r.replyText.indexOf("★対象者") >= 0, "targets shown");
    __assertEq(r.quickReplyLabels, ["履歴", "取消"], "labels");
  });

  check("＃ は @ のエイリアス（後方互換）", function () {
    r = handleEvent(__mkEvent("＃TestPayer\n500\n限定\nAlice\nBob"), config);
    __assert(r.replyText.indexOf("【記録しました！】") === 0, "alias works");
    __assert(r.replyText.indexOf("★対象者") >= 0, "targets recognized");
  });

  check("不明なコマンド → 無視", function () {
    r = handleEvent(__mkEvent("こんにちは"), config);
    __assert(r.shouldReply === false, "ignored");
  });

  check("「精算しよう」等の会話に誤反応しない", function () {
    r = handleEvent(__mkEvent("精算しよう"), config);
    __assert(r.shouldReply === false, "should be ignored");
    r = handleEvent(__mkEvent("精算するよ"), config);
    __assert(r.shouldReply === false, "ignored");
    r = handleEvent(__mkEvent("清算しないと"), config);
    __assert(r.shouldReply === false, "清算 variant ignored");
  });

  check("「精算」単体は履歴メンバーで自動提案", function () {
    r = handleEvent(__mkEvent("精算"), config);
    __assert(r.shouldReply === true, "should reply");
    __assert(r.replyText.indexOf("未精算の履歴") === 0, "auto proposal");
    __assertEq(r.quickReplyLabels, ["このメンバーで精算", "メンバーを追加して精算"], "labels");
  });

  check("「このメンバーで精算」で実行される", function () {
    r = handleEvent(__mkEvent("このメンバーで精算"), config);
    __assert(r.shouldReply === true, "should reply");
    __assert(r.replyText.indexOf("【精算結果】") === 0, "executes settlement");
    __assert(r.flexMessage && r.flexMessage.type === "flex", "flex returned");
    // 後始末
    __test_cleanup();
    __test_seed_at_records();
  });

  check("「メンバーを追加して精算」で手動フォーマット案内", function () {
    r = handleEvent(__mkEvent("メンバーを追加して精算"), config);
    __assert(r.shouldReply === true, "should reply");
    __assert(r.replyText.indexOf("0円参加者") === 0, "manual guide");
  });

  check("精算する記録がない場合、「精算」単体は記録への案内を返す", function () {
    __test_cleanup();
    r = handleEvent(__mkEvent("精算"), config);
    __assert(r.replyText.indexOf("まだ精算する記録がない") === 0, "no record guidance");
    __assertEq(r.quickReplyLabels, ["記録の仕方", "履歴"], "labels");
    __test_seed_at_records();  // 後続テストのために再 seed
  });

  check("テキスト以外（スタンプ等） → 無視", function () {
    const stickerEvent = __mkEvent("dummy");
    stickerEvent.message.type = "sticker";
    r = handleEvent(stickerEvent, config);
    __assert(r.shouldReply === false, "ignored");
  });

  check("normalizeName: 全角英数→半角、カナ→ひら、空白trim", function () {
    __assertEq(normalizeName("タロウ"), "たろう", "kata→hira");
    __assertEq(normalizeName("Ｔａｒｏ"), "Taro", "fullwidth→halfwidth");
    __assertEq(normalizeName("　たろう　"), "たろう", "trim and zenkaku space");
    __assertEq(normalizeName("たろう"), "たろう", "passthrough");
  });

  check("findSimilarPayer: カタ違いを検知", function () {
    // seed には Alice, Bob があるので、それと衝突しない名前で検証
    // まず履歴に "たろう" を入れる
    handleEvent(__mkEvent("@たろう\n100"), config);
    // "タロウ" を新規追加すると "たろう" が類似として返る想定
    __assertEq(findSimilarPayer("タロウ", TEST_SOURCE_ID), "たろう", "kata variant detected");
    // 完全一致はnull
    __assertEq(findSimilarPayer("たろう", TEST_SOURCE_ID), null, "exact match → no warning");
    // 別人はnull
    __assertEq(findSimilarPayer("はなこ", TEST_SOURCE_ID), null, "different name → no warning");
    // 短い別名（旅行で簡略化）も誤検知しない
    __assertEq(findSimilarPayer("たろき", TEST_SOURCE_ID), null, "1-char-different name not flagged");
    __test_cleanup();
    __test_seed_at_records();
  });

  check("@ 記録時に類似名があれば警告を返信に追記", function () {
    handleEvent(__mkEvent("@たろう\n100"), config);  // 既存
    r = handleEvent(__mkEvent("@タロウ\n200"), config);  // タイポっぽい新規
    __assert(r.replyText.indexOf("【記録しました！】") === 0, "still records");
    __assert(r.replyText.indexOf("もしかして「たろう」") >= 0, "warning appended");
    __test_cleanup();
    __test_seed_at_records();
  });

  check("@ 記録時に類似名がなければ警告なし", function () {
    r = handleEvent(__mkEvent("@TestPayer123\n100"), config);
    __assert(r.replyText.indexOf("もしかして") === -1, "no warning");
    __test_cleanup();
    __test_seed_at_records();
  });

  check("join イベント → ウェルカム + メニュー", function () {
    const joinEvent = {
      type: "join",
      replyToken: "DUMMY",
      source: { type: "group", groupId: TEST_SOURCE_ID },
    };
    r = handleEvent(joinEvent, config);
    __assert(r.shouldReply === true, "should reply");
    __assert(r.replyText.indexOf("こんにちは") === 0, "welcome message");
    __assertEq(r.quickReplyLabels, ["記録の仕方", "履歴", "精算", "メンバー", "取消"], "menu labels");
  });

  __test_cleanup();
  Logger.log("--- result: " + pass + " passed / " + fail + " failed ---");
}

// 一括実行: cleanup → seed → 各クエリ → 精算 → cleanup
function __test_runAll() {
  Logger.log('===== test start =====');
  __test_cleanup();
  __test_seed_at_records();
  __test_seed_limited();
  __test_history();
  __test_members();
  __test_settlement_all();
  __test_cleanup();
  Logger.log('===== test end =====');
}
