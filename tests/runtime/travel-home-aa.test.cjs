"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const editor = fs.readFileSync(path.join(root, "travel-content-editor.js"), "utf8");
const ledger = fs.readFileSync(path.join(root, "ledger.js"), "utf8");
const ledgerCss = fs.readFileSync(path.join(root, "ledger.css"), "utf8");

test("homepage order places the title first and outbound/return before every other travel section", () => {
  const title = html.indexOf("id=\"trip-title\"");
  const flights = html.indexOf("id=\"flights\"");
  const route = html.indexOf("id=\"route\"");
  const itinerary = html.indexOf("id=\"itinerary\"");
  const drive = html.indexOf("id=\"drive\"");
  const prep = html.indexOf("id=\"prep\"");
  assert.ok(title >= 0 && title < flights);
  assert.ok(flights < route && route < itinerary && itinerary < drive && drive < prep);
  assert.match(html.slice(flights, route), /去程与回程交通/);
});

test("home always shows two empty add prompts without inventing transport, and each prompt opens a role-specific editor", () => {
  assert.match(app, /if \(element\.id === "flights" \|\| element\.id === "ledger-navigation-link"\)\s*\{\s*element\.hidden = false/s);
  assert.match(app, /openTransportForRole\?\.\(addTransport\.dataset\.addTransport\)/);
  assert.match(editor, /function openTransportForRole\(role\)/);
  assert.match(editor, /openForm\("transportRecords", \{ type: "other", journeyRole \}\)/);
  const view = fs.readFileSync(path.join(root, "travel-content-view.js"), "utf8");
  assert.match(view, /尚未添加 · 添加\$\{label\}交通/);
  assert.match(view, /data-add-transport="\$\{role\}"/);
});

test("AA navigation is always available and cloud mode is explicitly passed to the existing ledger", () => {
  assert.match(html, /id="ledger-navigation-link"[^>]*>AA \/ 账本/);
  assert.match(html, /id="ledger-root"/);
  assert.match(app, /if \(name === "ledger"\) return true/);
  assert.match(app, /sharedCollections: \["ledger"\]/);
  assert.match(ledger, /function createD1Adapter\(/);
  assert.match(ledger, /function calculateStats\(/);
  assert.match(ledger, /function calculateBillShares\(/);
  assert.match(ledger, /data-ledger-action="edit-bill"/);
  assert.match(ledger, /data-ledger-action="delete-bill"/);
  assert.match(ledger, /谁需要转给谁/);
});

test("AA narrow layouts constrain width and reflow forms and settlement details", () => {
  assert.match(ledgerCss, /\.ledger-app\s*\{[^}]*width:\s*min\(100%,\s*720px\)/s);
  assert.match(ledgerCss, /@media\s*\(max-width:\s*420px\)/);
  assert.match(ledgerCss, /\.ledger-split-mode-options\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(ledgerCss, /\.ledger-transfer-list|\.ledger-transfer/);
  assert.match(ledgerCss, /min-width:\s*0/);
});
