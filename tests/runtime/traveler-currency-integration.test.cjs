"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const ledgerSource = fs.readFileSync(path.join(root, "ledger.js"), "utf8");
const editorSource = fs.readFileSync(path.join(root, "travel-content-editor.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("add traveler button reaches the delegated click handler and opens the member editor", () => {
  assert.match(ledgerSource, /data-ledger-action="open-members"/);
  assert.match(ledgerSource, /ledgerRoot\.addEventListener\("click", handleRootClick\)/);
  assert.match(ledgerSource, /if \(action === "open-members"\)[\s\S]*?showDialog\("members"\)/);
  assert.match(ledgerSource, /catch \(error\) \{[\s\S]*?dialog\.setAttribute\("open", ""\)/);
  assert.match(html, /ledger\.js\?v=20261031-phase7-1/);
});

test("one ledger traveler ID is reused in transport passenger journey selectors", () => {
  assert.match(editorSource, /function travelerOptions\(\) \{ return window\.TravelLedger\?\.getSnapshot\?\.\(\)\?\.travelers/);
  assert.match(editorSource, /option value="\$\{esc\(person\.id\)\}"/);
  assert.match(ledgerSource, /next\.travelers\.push\(traveler\)/);
  assert.match(ledgerSource, /window\.dispatchEvent\(new CustomEvent\("travel-ledger:travelers-changed"/);
  assert.match(editorSource, /window\.addEventListener\("travel-ledger:travelers-changed", \(event\) => \{[\s\S]*?refreshTravelerSelectors\(event\)/);
  assert.match(editorSource, /refreshInspirationApprovals\(\)/);
});

test("traveler deletion is blocked while transport, AA bills or inspiration votes refer to the ID", () => {
  assert.match(ledgerSource, /bill\.payerId === id \|\| bill\.participantIds\.includes\(id\)/);
  assert.match(ledgerSource, /journey\.travelerIds \|\| \[\]/);
  assert.match(ledgerSource, /content\?\.inspirations \|\| \[\]/);
  assert.match(ledgerSource, /种草投票/);
  assert.match(ledgerSource, /为保护现有记录，不能删除/);
});

test("currency UI supports manual ISO code, rate preview, and missing-rate status without network calls", () => {
  assert.match(ledgerSource, /其他 ISO 4217 代码/);
  assert.match(ledgerSource, /name="exchangeRate"/);
  assert.match(ledgerSource, /汇率由你手动填写，不会联网查询/);
  assert.match(ledgerSource, /缺少汇率 · 尚未计入基准币种结算/);
  assert.doesNotMatch(ledgerSource, /fetch\([^\n]*(?:exchange|currency-rate)/i);
});
