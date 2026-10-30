"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.resolve(__dirname, "../../ledger.js"), "utf8");
const moduleForLedger = { exports: {} };
const ledger = new Function("module", "exports", `${source}\nreturn module.exports;`)(moduleForLedger, moduleForLedger.exports);

const travelers = ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase() }));
function data(bills) {
  return ledger.normalizeData({ settings: { baseCurrency: "CNY", commonCurrencies: ["EUR"] }, travelers, bills });
}
function bill({ id = "bill", amount = 10000, participants = ["a", "b"], payer = "a", splitMode = "equal", splitValues = {}, currency = "CNY", original = amount } = {}) {
  return { id, originalAmountCents: original, baseAmountCents: amount, currency, category: "餐饮", payerId: payer, participantIds: participants, splitMode, splitValues };
}
function shares(snapshot, record) {
  return Object.fromEntries(ledger.calculateBillShares(record, snapshot.travelers));
}

test("two-person and three-plus equal splits conserve every cent", () => {
  const two = data([bill()]);
  assert.deepEqual(shares(two, two.bills[0]), { a: 5000, b: 5000 });
  const three = data([bill({ amount: 100, participants: ["a", "b", "c"] })]);
  assert.deepEqual(shares(three, three.bills[0]), { a: 34, b: 33, c: 33 });
  assert.equal(Object.values(shares(three, three.bills[0])).reduce((sum, cents) => sum + cents, 0), 100);
});

test("specified amounts support partial participation and require exact total", () => {
  const snapshot = data([bill({ amount: 10001, participants: ["a", "c"], splitMode: "amount", splitValues: { a: 6000, c: 4001 } })]);
  assert.deepEqual(shares(snapshot, snapshot.bills[0]), { a: 6000, c: 4001 });
  const invalid = data([bill({ amount: 10001, participants: ["a", "c"], splitMode: "amount", splitValues: { a: 6000, c: 4000 } })]);
  assert.equal(invalid.bills[0].splitMode, "equal", "invalid legacy/corrupt split safely falls back to equal");
});

test("ratio splits use integer weights and largest remainders", () => {
  const snapshot = data([bill({ amount: 10001, participants: ["a", "b", "c"], splitMode: "ratio", splitValues: { a: 100, b: 200, c: 100 } })]);
  assert.deepEqual(shares(snapshot, snapshot.bills[0]), { a: 2500, b: 5001, c: 2500 });
  assert.equal(Object.values(shares(snapshot, snapshot.bills[0])).reduce((sum, cents) => sum + cents, 0), 10001);
  assert.equal(ledger.ratioToPoints("1.25"), 125);
  assert.equal(ledger.ratioToPoints("1.234"), null);
});

test("foreign currency bills settle in manually converted base currency cents", () => {
  const snapshot = data([bill({ amount: 1080, original: 1000, currency: "EUR", participants: ["a", "b", "c"] })]);
  assert.equal(snapshot.bills[0].originalAmountCents, 1000);
  assert.equal(ledger.calculateStats(snapshot).totalCents, 1080);
  assert.deepEqual(shares(snapshot, snapshot.bills[0]), { a: 360, b: 360, c: 360 });
});

test("manual multi-currency rates preserve original amounts and convert exactly to CNY", () => {
  const snapshot = data([
    bill({ id: "cny", amount: 10000, original: 10000, currency: "CNY", participants: ["a", "b"] }),
    { ...bill({ id: "eur", amount: 0, original: 2000, currency: "EUR", participants: ["a", "b"] }), baseAmountCents: null, exchangeRate: "8.00", rateBaseCurrency: "CNY", splitMode: "equal" },
    { ...bill({ id: "usd", amount: 0, original: 1000, currency: "USD", participants: ["b"], payer: "a" }), baseAmountCents: null, exchangeRate: "7.20", rateBaseCurrency: "CNY", splitMode: "equal" },
    { ...bill({ id: "jpy", amount: 0, original: 1000, currency: "JPY", participants: ["a"] }), currencyExponent: 0, baseAmountCents: null, exchangeRate: "0.05", rateBaseCurrency: "CNY", splitMode: "equal" }
  ]);
  assert.equal(snapshot.bills.find((entry) => entry.id === "eur").originalAmountCents, 2000);
  assert.equal(snapshot.bills.find((entry) => entry.id === "eur").baseAmountCents, 16000);
  assert.equal(snapshot.bills.find((entry) => entry.id === "usd").baseAmountCents, 7200);
  assert.equal(snapshot.bills.find((entry) => entry.id === "jpy").currencyExponent, 0);
  assert.equal(snapshot.bills.find((entry) => entry.id === "jpy").baseAmountCents, 5000);
  assert.equal(ledger.calculateStats(snapshot).totalCents, 10000 + 16000 + 7200 + 5000);
});

test("missing foreign exchange rate stays saved and is excluded from all settlement math", () => {
  const snapshot = data([
    bill({ id: "local", amount: 3000, participants: ["a", "b"], payer: "a" }),
    { ...bill({ id: "unconverted", amount: 0, original: 2500, currency: "EUR", participants: ["b"], payer: "a" }), baseAmountCents: null, exchangeRate: "" }
  ]);
  const missing = snapshot.bills.find((entry) => entry.id === "unconverted");
  assert.ok(missing, "unconverted expense remains in the snapshot");
  assert.equal(missing.baseAmountCents, null);
  assert.equal(ledger.calculateStats(snapshot).totalCents, 3000);
  assert.deepEqual(shares(snapshot, missing), {});
  assert.equal(ledger.calculateStats(snapshot).transfers.length, 1);
});

test("changing a saved manual rate recalculates the settlement without replacing original money", () => {
  const billRecord = { ...bill({ original: 2000, currency: "EUR" }), baseAmountCents: null, exchangeRate: "8", rateBaseCurrency: "CNY" };
  const first = data([billRecord]);
  billRecord.exchangeRate = "9";
  const second = data([billRecord]);
  assert.equal(first.bills[0].baseAmountCents, 16000);
  assert.equal(second.bills[0].baseAmountCents, 18000);
  assert.equal(second.bills[0].originalAmountCents, 2000);
  assert.equal(second.bills[0].currency, "EUR");
});

test("foreign equal, exact, proportional and partial splits are split in source currency then converted", () => {
  const snapshot = data([
    { ...bill({ id: "equal", amount: 0, original: 1001, currency: "EUR", participants: ["a", "b"] }), baseAmountCents: null, exchangeRate: "2" },
    { ...bill({ id: "exact", amount: 0, original: 1000, currency: "EUR", participants: ["a", "c"], splitMode: "amount", splitValues: { a: 250, c: 750 } }), baseAmountCents: null, exchangeRate: "2" },
    { ...bill({ id: "ratio", amount: 0, original: 1000, currency: "EUR", participants: ["a", "b", "c"], splitMode: "ratio", splitValues: { a: 1, b: 2, c: 1 } }), baseAmountCents: null, exchangeRate: "2" }
  ]);
  assert.deepEqual(shares(snapshot, snapshot.bills[0]), { a: 1002, b: 1000 }, "the one-cent source-currency remainder is allocated before conversion");
  assert.deepEqual(shares(snapshot, snapshot.bills[1]), { a: 500, c: 1500 });
  assert.deepEqual(shares(snapshot, snapshot.bills[2]), { a: 500, b: 1000, c: 500 });
});

test("legacy manually converted bills and their exact splits remain readable", () => {
  const snapshot = ledger.normalizeData({ settings: { baseCurrency: "CNY" }, travelers, bills: [
    { id: "legacy", originalAmountCents: 2000, currencyExponent: 2, currency: "EUR", baseAmountCents: 16000, baseExponent: 2, payerId: "a", participantIds: ["a", "b"], splitMode: "amount", splitValues: { a: 6000, b: 10000 } }
  ] });
  assert.equal(snapshot.bills[0].baseAmountCents, 16000);
  assert.deepEqual(shares(snapshot, snapshot.bills[0]), { a: 6000, b: 10000 });
});

test("amount input and legacy bill migration respect currencies with zero and three decimal places", () => {
  assert.equal(ledger.currencyExponent("JPY"), 0);
  assert.equal(ledger.currencyExponent("KWD"), 3);
  assert.equal(ledger.toCents("123", "JPY"), 123);
  assert.equal(ledger.toCents("12.5", "JPY"), null);
  assert.equal(ledger.toCents("1.234", "KWD"), 1234);
  assert.equal(ledger.toCents("1.2345", "KWD"), null);
  assert.equal(ledger.centsToInput(12340, "KWD"), "12.340");
  const migrated = ledger.normalizeData({
    settings: { baseCurrency: "CNY" }, travelers: [{ id: "a", name: "A" }],
    bills: [{ id: "legacy-jpy", originalAmountCents: 1234, baseAmountCents: 2500, currency: "JPY", payerId: "a", participantIds: ["a"] }]
  });
  assert.equal(migrated.bills[0].originalAmountCents, 12, "legacy JPY 12.34 rounds to its 0-decimal minor unit");
  assert.equal(migrated.bills[0].currencyExponent, 0);
  assert.equal(migrated.bills[0].baseAmountCents, 2500);
});

test("editing or deleting an expense recalculates balances; settlement minimizes transfers", () => {
  const snapshot = data([
    bill({ id: "one", amount: 50000, participants: ["b"], payer: "a" }),
    bill({ id: "two", amount: 50000, participants: ["d"], payer: "c" })
  ]);
  assert.equal(ledger.calculateStats(snapshot).transfers.length, 2);
  snapshot.bills[0] = { ...snapshot.bills[0], baseAmountCents: 30000, originalAmountCents: 30000 };
  let stats = ledger.calculateStats(snapshot);
  assert.equal(stats.members.find((member) => member.traveler.id === "a").paidCents, 30000);
  assert.equal(stats.members.find((member) => member.traveler.id === "b").owedCents, 30000);
  snapshot.bills = snapshot.bills.filter((entry) => entry.id !== "one");
  stats = ledger.calculateStats(snapshot);
  assert.equal(stats.members.find((member) => member.traveler.id === "a").paidCents, 0);
  assert.equal(stats.members.find((member) => member.traveler.id === "b").owedCents, 0);
});

test("local ledger saves survive reload and remain isolated by tripId", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) };
  const first = ledger.createLocalStorageAdapter("trip-one", { storage });
  const snapshot = data([bill({ amount: 1234 })]);
  await first.save(snapshot);
  const reloaded = ledger.normalizeData(await ledger.createLocalStorageAdapter("trip-one", { storage }).load());
  assert.equal(reloaded.bills[0].baseAmountCents, 1234);
  assert.equal((await ledger.createLocalStorageAdapter("trip-two", { storage }).load()), null);
});

test("D1 ledger bills and travelers survive cloud snapshot reloads and support add, edit, and delete", async () => {
  const previousFetch = global.fetch;
  let revision = 6;
  let cloud = { version: 1, settings: { baseCurrency: "CNY", commonCurrencies: ["EUR"], lastCurrency: "CNY" }, travelers: [], bills: [], todos: [], tickets: [] };
  global.fetch = async (_url, init = {}) => {
    if (init.method === "POST") {
      const changes = JSON.parse(init.body).changes;
      for (const change of changes) {
        const list = cloud[change.collection];
        const index = list.findIndex((item) => item.id === change.id);
        if (change.op === "delete") { if (index >= 0) list.splice(index, 1); }
        else if (index >= 0) list[index] = change.value;
        else list.push(change.value);
      }
      revision += 1;
    }
    return { ok: true, async json() { return { ...structuredClone(cloud), revision }; } };
  };
  try {
    const adapter = ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" });
    let snapshot = ledger.normalizeData(await adapter.load());
    snapshot.travelers.push({ id: "a", name: "A" }, { id: "b", name: "B" });
    snapshot.bills.push(bill({ id: "new-expense", amount: 2400, participants: ["a"], payer: "a" }));
    await adapter.save(snapshot);

    snapshot = ledger.normalizeData(await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).load());
    assert.equal(snapshot.bills[0].id, "new-expense");
    snapshot.bills[0] = { ...snapshot.bills[0], note: "edited" };
    await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).save(snapshot);

    snapshot = ledger.normalizeData(await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).load());
    assert.equal(snapshot.bills[0].note, "edited");
    snapshot.bills = [];
    await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).save(snapshot);
    snapshot = ledger.normalizeData(await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).load());
    assert.deepEqual(snapshot.bills, []);
    snapshot.travelers.find((person) => person.id === "a").name = "Updated A";
    snapshot.travelers = snapshot.travelers.filter((person) => person.id !== "b");
    await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).save(snapshot);
    const afterDelete = ledger.normalizeData(await ledger.createD1Adapter("cloud-ledger", { apiBase: "/api/trip" }).load());
    assert.deepEqual(afterDelete.travelers.map((person) => [person.id, person.name]), [["a", "Updated A"]]);
  } finally { global.fetch = previousFetch; }
});

test("D1 round trip preserves base currency, original currency amount, and manual exchange rate", async () => {
  const previousFetch = global.fetch;
  let cloud = { version: 1, settings: { baseCurrency: "CNY", commonCurrencies: ["EUR"], lastCurrency: "EUR" }, travelers: [{ id: "a", name: "A" }], bills: [], todos: [], tickets: [] };
  global.fetch = async (_url, init = {}) => {
    if (init.method === "POST") {
      for (const change of JSON.parse(init.body).changes) {
        if (change.collection === "settings") cloud.settings = structuredClone(change.value);
        else {
          const collection = cloud[change.collection];
          const index = collection.findIndex((item) => item.id === change.id);
          if (index >= 0) collection[index] = structuredClone(change.value); else collection.push(structuredClone(change.value));
        }
      }
    }
    return { ok: true, async json() { return structuredClone(cloud); } };
  };
  try {
    const adapter = ledger.createD1Adapter("currency-trip", { apiBase: "/api/trip" });
    const snapshot = ledger.normalizeData(await adapter.load());
    snapshot.settings.baseCurrency = "CNY";
    snapshot.bills.push({ id: "eur-bill", originalAmountCents: 2000, currency: "EUR", currencyExponent: 2, baseExponent: 2, baseAmountCents: 16000, exchangeRate: "8", rateBaseCurrency: "CNY", payerId: "a", participantIds: ["a"], category: "餐饮", splitMode: "equal", splitValues: {} });
    await adapter.save(snapshot);
    const reloaded = ledger.normalizeData(await ledger.createD1Adapter("currency-trip", { apiBase: "/api/trip" }).load());
    assert.equal(reloaded.settings.baseCurrency, "CNY");
    assert.equal(reloaded.bills[0].originalAmountCents, 2000);
    assert.equal(reloaded.bills[0].currency, "EUR");
    assert.equal(reloaded.bills[0].exchangeRate, "8");
    assert.equal(reloaded.bills[0].baseAmountCents, 16000);
  } finally { global.fetch = previousFetch; }
});

test("preserved local AA snapshot stays untouched while D1 reads and saves cloud state", async () => {
  const previousFetch = global.fetch;
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)) };
  const oldLocal = ledger.createLocalStorageAdapter("same-trip", { storage });
  await oldLocal.save(data([bill({ id: "local-bill", amount: 789 })]));
  const localKey = oldLocal.storageKey;
  const before = values.get(localKey);
  let cloud = { version: 1, settings: null, travelers: [], bills: [], todos: [], tickets: [] };
  global.fetch = async (_url, init = {}) => {
    if (init.method === "POST") {
      for (const change of JSON.parse(init.body).changes) {
        const list = cloud[change.collection];
        const index = list.findIndex((item) => item.id === change.id);
        if (change.op === "delete") { if (index >= 0) list.splice(index, 1); }
        else if (index >= 0) list[index] = change.value;
        else list.push(change.value);
      }
    }
    return { ok: true, async json() { return structuredClone(cloud); } };
  };
  try {
    const adapter = ledger.createD1Adapter("same-trip", { apiBase: "/api/trip" });
    const remote = await adapter.load();
    remote.travelers.push({ id: "cloud-person", name: "Cloud person" });
    await adapter.save(remote);
    const legacy = await ledger.createLocalStorageAdapter("same-trip", { storage }).load();
    assert.equal(legacy.bills[0].id, "local-bill");
    assert.equal(values.get(localKey), before, "cloud writes leave preserved local data unchanged");
  } finally { global.fetch = previousFetch; }
});

