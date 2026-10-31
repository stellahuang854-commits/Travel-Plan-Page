"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "../../travel-content-editor.js"), "utf8");

function createEditorRuntime() {
  const documentListeners = new Map();
  const panelListeners = new Map();
  const panel = {
    innerHTML: "",
    addEventListener(type, handler) { panelListeners.set(type, handler); },
    contains(target) { return target === button; },
  };
  const section = { hidden: true };
  const document = {
    addEventListener(type, handler) { documentListeners.set(type, handler); },
    querySelector(selector) {
      if (selector === "#travel-content-panel") return panel;
      if (selector === "#travel-content-tools") return section;
      return null;
    },
    querySelectorAll() { return []; }
  };
  const travelers = [{ id: "traveler-a", name: "A" }, { id: "traveler-b", name: "B" }];
  const content = {
    version: 1, tripId: "interaction-trip", metadata: { title: "" },
    accommodations: [], restaurants: [], transportRecords: [], days: [], todoCategories: [], connections: []
  };
  const window = {
    TravelContentStore: {
      TRANSPORT_TYPES: ["train", "other"],
      normalizeTransportType: (value) => value || "other",
      normalizeJourneyRole: (value) => ["outbound", "return", "other"].includes(value) ? value : "",
      journeyRoleFor: (record) => record?.journeyRole || "",
      normalizePassengerJourneys(record, options = {}) {
        if (Array.isArray(record.passengerJourneys)) return record.passengerJourneys.map((journey, index) => ({ ...journey, id: journey.id || `legacy-${index + 1}`, travelerIds: journey.travelerIds || [], type: journey.type || record.type || "other", ticketIds: journey.ticketIds || [] }));
        if (options.ensureOne) return [{ id: "generated-legacy", travelerIds: [], type: record.type || "other", ticketIds: [] }];
        return [];
      },
      createStore() { return { async load() { return structuredClone(content); } }; },
    },
    TravelLedger: { getSnapshot() { return { travelers }; } },
    addEventListener() {},
  };
  const moduleForEditor = { exports: {} };
  new Function("module", "exports", "window", "document", "FormData", `${source}\nreturn module.exports;`)(moduleForEditor, moduleForEditor.exports, window, document, global.FormData);
  const button = {
    type: "button",
    closest(selector) { return selector === "[data-add-passenger-journey]" ? this : selector === 'form[data-editor-form="transportRecords"]' ? form : null; }
  };
  const rows = [{ querySelector() { return { focus() {} }; } }];
  const host = {
    querySelectorAll() { return rows; },
    insertAdjacentHTML(_position, html) {
      rows.push({ html, querySelector() { return { focus() {} }; } });
    }
  };
  const form = {
    elements: { type: { value: "train" } },
    querySelector(selector) { return selector === "[data-passenger-journeys]" ? host : null; },
  };
  return { window, document, panel, section, documentListeners, panelListeners, button, rows, host, form, content, travelers };
}

test("a real delegated click on the passenger add control appends independent groups in place", async () => {
  const runtime = createEditorRuntime();
  await runtime.window.TravelContentEditor.init({ data: { metadata: { tripId: "interaction-trip" }, accommodations: [], restaurants: [], days: [] } });
  runtime.panel.innerHTML = '<form data-editor-form="transportRecords"><div data-passenger-journeys></div><button type="button" data-add-passenger-journey>＋ 添加另一组乘客 / 班次</button></form>';
  const click = () => {
    let prevented = false;
    runtime.panelListeners.get("click")({ target: runtime.button, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  };
  assert.equal(runtime.rows.length, 1);
  click();
  assert.equal(runtime.rows.length, 2, "one group becomes two from a click event");
  click();
  assert.equal(runtime.rows.length, 3, "the list supports a third group without a fixed limit");
  const markup = runtime.rows.slice(1).map((row) => row.html);
  assert.match(markup[0], /data-journey-field="travelerIds"/);
  assert.match(markup[0], />A</);
  assert.match(markup[1], />B</);
  for (const field of ["type", "serviceNumber", "from", "to", "date", "arrivalDate", "startTime", "endTime", "seat", "note"]) {
    assert.ok(markup.every((row) => row.includes(`data-journey-field="${field}"`)), `new groups expose ${field}`);
  }
  const ids = markup.map((row) => row.match(/data-passenger-journey-id="([^"]+)"/)?.[1]);
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length, "each appended group receives an independent stable id");
  assert.match(runtime.panel.innerHTML, /data-add-passenger-journey/);
  assert.ok(runtime.documentListeners.has("click"), "the rest of the editor remains delegated at document level");
});

test("a legacy transport without passengerJourneys still normalizes to an editable first group", () => {
  const runtime = createEditorRuntime();
  const legacy = { id: "legacy-rail", type: "train", serviceNumber: "G123", from: "Florence", to: "Milan" };
  const journeys = runtime.window.TravelContentStore.normalizePassengerJourneys(legacy, { ensureOne: true });
  assert.equal(journeys.length, 1);
  assert.equal(journeys[0].id, "generated-legacy");
  assert.equal(journeys[0].serviceNumber, undefined);
});
