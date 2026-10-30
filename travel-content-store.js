(() => {
  "use strict";

  const VERSION = 1;
  const PREFIX = "travel-plan:content:v1";
  const COLLECTIONS = Object.freeze(["accommodations", "transportRecords", "restaurants", "days", "todoCategories", "connections"]);
  const TRANSPORT_TYPES = Object.freeze(["flight", "high-speed-rail", "train", "metro", "bus-coach", "ferry-boat", "taxi-ride-hailing", "rental-car-driving", "walking", "bicycle", "other"]);
  const DEFAULT_CATEGORIES = Object.freeze([
    ["documents", "Documents"], ["transportation", "Transportation"], ["accommodation", "Accommodation"],
    ["tickets", "Tickets"], ["food", "Food"], ["packing", "Packing"], ["shopping", "Shopping"],
    ["money", "Money"], ["communication", "Communication"], ["other", "Other"]
  ]);

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function keyFor(tripId) {
    const id = String(tripId || "").trim();
    if (!id) throw new Error("Travel content requires a tripId.");
    return `${PREFIX}:${encodeURIComponent(id)}`;
  }

  function stableId(prefix, item, index, used) {
    if (item && typeof item.id === "string" && item.id.trim() && !used.has(item.id)) return item.id;
    const source = JSON.stringify(item || {});
    let hash = 2166136261;
    for (let cursor = 0; cursor < source.length; cursor += 1) {
      hash ^= source.charCodeAt(cursor);
      hash = Math.imul(hash, 16777619);
    }
    let candidate = `${prefix}-${(hash >>> 0).toString(36)}-${index + 1}`;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${prefix}-${(hash >>> 0).toString(36)}-${index + 1}-${suffix++}`;
    return candidate;
  }

  function withStableIds(items, prefix) {
    const used = new Set();
    return (Array.isArray(items) ? items : []).map((item, index) => {
      const record = item && typeof item === "object" && !Array.isArray(item) ? clone(item) : {};
      record.id = stableId(prefix, record, index, used);
      used.add(record.id);
      if (prefix === "day" && !Array.isArray(record.schedule)) record.schedule = [];
      if (Array.isArray(record.schedule)) {
        const scheduleIds = new Set();
        record.schedule = record.schedule.map((entry, entryIndex) => {
          const scheduleItem = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
          const id = stableId("item", scheduleItem, entryIndex, scheduleIds);
          scheduleIds.add(id);
          return { ...scheduleItem, id };
        });
      }
      return record;
    });
  }

  function normalizeTransportType(value) {
    const raw = String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
    if (TRANSPORT_TYPES.includes(raw)) return raw;
    if (/flight|air/.test(raw)) return "flight";
    if (/high.?speed|bullet/.test(raw)) return "high-speed-rail";
    if (/metro|subway|underground/.test(raw)) return "metro";
    if (/train|rail/.test(raw)) return "train";
    if (/bus|coach/.test(raw)) return "bus-coach";
    if (/ferry|boat|ship/.test(raw)) return "ferry-boat";
    if (/taxi|ride.?hail|uber|lyft/.test(raw)) return "taxi-ride-hailing";
    if (/rental|driv|car/.test(raw)) return "rental-car-driving";
    if (/walk|foot/.test(raw)) return "walking";
    if (/bicycle|bike|cycle/.test(raw)) return "bicycle";
    return "other";
  }

  function passengerJourneyAttachmentKey(transportId, passengerJourneyId) {
    const parent = String(transportId || "").trim();
    const journey = String(passengerJourneyId || "").trim();
    if (!parent || !journey) throw new Error("交通附件需要稳定的交通记录 ID 和乘客行程 ID。");
    const readable = `transport:${parent}:passenger:${journey}`;
    if (readable.length <= 180) return readable;
    const source = `${parent}\u0000${journey}`;
    const hash = (seed) => {
      let value = seed;
      for (let index = 0; index < source.length; index += 1) { value ^= source.charCodeAt(index); value = Math.imul(value, 16777619); }
      return (value >>> 0).toString(16).padStart(8, "0");
    };
    return `transport:${hash(2166136261)}${hash(2246822519)}:${parent.slice(0, 32)}:${journey.slice(0, 32)}`;
  }

  function normalizePassengerJourneys(record, options = {}) {
    const parent = record && typeof record === "object" ? record : {};
    if (Array.isArray(parent.passengerJourneys)) {
      return parent.passengerJourneys.map((journey, index) => ({
        ...clone(journey || {}),
        id: String(journey?.id || `${parent.id || "transport"}-passenger-${index + 1}`),
        travelerIds: Array.isArray(journey?.travelerIds) ? journey.travelerIds.map(String) : [],
        type: normalizeTransportType(journey?.type || parent.type),
        ticketIds: Array.isArray(journey?.ticketIds) ? journey.ticketIds.map(String) : []
      }));
    }
    const hasLegacyDetails = ["passenger", "serviceNumber", "flightNumber", "date", "arrivalDate", "from", "to", "startTime", "endTime", "seat", "note"]
      .some((key) => parent[key] !== undefined && parent[key] !== null && String(parent[key]).trim());
    if (!hasLegacyDetails && !options.ensureOne) return [];
    return [{
      id: `${parent.id || "transport"}-passenger-1`, travelerIds: [], type: normalizeTransportType(parent.type),
      serviceNumber: parent.serviceNumber || parent.flightNumber || "", from: parent.from || "", to: parent.to || "",
      date: parent.date || "", arrivalDate: parent.arrivalDate || parent.date || "", startTime: parent.startTime || "",
      endTime: parent.endTime || "", seat: parent.seat || "", passenger: parent.passenger || "", note: parent.note || "",
      ticketIds: Array.isArray(parent.ticketIds) ? parent.ticketIds.map(String) : []
    }];
  }

  function createInitialContent(data = {}) {
    const days = withStableIds(data.days, "day");
    const scheduleIds = new Set();
    days.forEach((day) => {
      day.schedule = (day.schedule || []).map((item, index) => {
        const id = stableId("item", item, index, scheduleIds);
        scheduleIds.add(id);
        return { ...item, id };
      });
    });
    const existingTransit = withStableIds(data.groundTransport?.publicTransitAndRail, "transport").map((record) => ({
      ...record,
      type: normalizeTransportType(record.type || record.mode || record.transportType),
      date: record.date || record.departureDate || record.departure?.date || "",
      from: record.from || record.fromPlace || record.departure?.place || record.departure?.station || "",
      to: record.to || record.toPlace || record.arrival?.place || record.arrival?.station || "",
      startTime: record.startTime || record.departureTime || record.departure?.time || "",
      endTime: record.endTime || record.arrivalTime || record.arrival?.time || "",
      note: record.note || record.notes || "",
      dayIds: Array.isArray(record.dayIds) ? record.dayIds : [],
      ticketIds: Array.isArray(record.ticketIds) ? record.ticketIds : []
    })).filter((record) => record.type !== "flight" && record.type !== "rental-car-driving");
    return {
      version: VERSION,
      tripId: String(data.metadata?.tripId || ""),
      accommodations: withStableIds(data.accommodations, "stay"),
      transportRecords: existingTransit,
      restaurants: withStableIds(data.restaurants, "restaurant"),
      days,
      todoCategories: DEFAULT_CATEGORIES.map(([id, name]) => ({ id, name })),
      connections: [],
      updatedAt: new Date().toISOString()
    };
  }

  function normalizeTodos(todos, categories) {
    const validIds = new Set(categories.map((category) => category.id));
    const fallbackId = categories.find((category) => category.id === "other")?.id || categories[0]?.id;
    return (Array.isArray(todos) ? todos : []).map((todo) => ({
      ...clone(todo),
      categoryId: validIds.has(todo.categoryId) ? todo.categoryId : fallbackId
    }));
  }

  function moveTasksBeforeCategoryDelete(todos, categories, categoryId, targetId) {
    if (categoryId === targetId || !categories.some((item) => item.id === targetId) || !categories.some((item) => item.id === categoryId)) {
      throw new Error("请选择有效的目标分类。");
    }
    if (categories.length < 2) throw new Error("至少需要保留一个分类。");
    return (Array.isArray(todos) ? todos : []).map((todo) => todo.categoryId === categoryId ? { ...clone(todo), categoryId: targetId } : clone(todo));
  }

  function validate(content, expectedTripId) {
    if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("旅行资料格式无效。");
    if (content.version !== VERSION || content.tripId !== expectedTripId) throw new Error("旅行资料版本或 tripId 不匹配。");
    for (const collection of COLLECTIONS) {
      if (!Array.isArray(content[collection])) throw new Error(`旅行资料 ${collection} 必须是列表。`);
      const ids = new Set();
      for (const item of content[collection]) {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string" || !item.id.trim()) {
          throw new Error(`旅行资料 ${collection} 中有无效记录。`);
        }
        if (ids.has(item.id)) throw new Error(`旅行资料 ${collection} 中存在重复 ID。`);
        ids.add(item.id);
      }
    }
    const pairKeys = new Set();
    const connectionModes = ["walking", "bicycle", "taxi", "driving", "metro", "bus", "train", "ferry", "other"];
    for (const connection of content.connections) {
      if (!connection.fromItemId || !connection.toItemId || connection.fromItemId === connection.toItemId) throw new Error("交通衔接必须关联两个不同的行程项目。");
      if (!connectionModes.includes(connection.mode)) throw new Error("交通衔接方式无效。");
      const pairKey = `${connection.fromItemId}\u0000${connection.toItemId}`;
      if (pairKeys.has(pairKey)) throw new Error("相同行程项目之间不能保存重复交通衔接。");
      pairKeys.add(pairKey);
      if (connection.estimatedMinutes !== undefined && connection.estimatedMinutes !== null && (!Number.isFinite(Number(connection.estimatedMinutes)) || Number(connection.estimatedMinutes) < 1 || Number(connection.estimatedMinutes) > 1440)) throw new Error("交通耗时必须为 1 到 1440 分钟。");
      if (connection.timeSource !== undefined && !["manual", "route"].includes(connection.timeSource)) throw new Error("交通耗时来源无效。");
    }
    if (content.todoCategories.some((category) => typeof category.name !== "string" || !category.name.trim())) {
      throw new Error("To Do 分类名称不能为空。");
    }
    if (content.transportRecords.some((record) => !TRANSPORT_TYPES.includes(record.type))) throw new Error("交通方式无效。");
    const allScheduleIds = new Set();
    for (const day of content.days) {
      if (!Array.isArray(day.schedule)) throw new Error("每日行程安排必须是列表。");
      const scheduleIds = new Set();
      for (const item of day.schedule) {
        if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id.trim() || scheduleIds.has(item.id) || allScheduleIds.has(item.id)) throw new Error("每日行程中有无效或重复的安排 ID。");
        scheduleIds.add(item.id);
        allScheduleIds.add(item.id);
      }
    }
    const transportSources = new Set();
    for (const record of content.transportRecords) {
      if (record.ticketIds !== undefined && !Array.isArray(record.ticketIds)) throw new Error("交通记录的门票关联必须是列表。");
      if (record.dayIds !== undefined && !Array.isArray(record.dayIds)) throw new Error("交通记录的日期关联必须是列表。");
      if (record.passengerJourneys !== undefined) {
        if (!Array.isArray(record.passengerJourneys)) throw new Error("交通记录的乘客行程必须是列表。");
        const journeyIds = new Set();
        for (const journey of record.passengerJourneys) {
          if (!journey || typeof journey !== "object" || Array.isArray(journey) || typeof journey.id !== "string" || !journey.id.trim() || journeyIds.has(journey.id)) throw new Error("交通记录中有无效或重复的乘客行程 ID。");
          journeyIds.add(journey.id);
          if (journey.travelerIds !== undefined && (!Array.isArray(journey.travelerIds) || journey.travelerIds.some((id) => typeof id !== "string"))) throw new Error("乘客行程的同行者必须是 ID 列表。");
          if (journey.ticketIds !== undefined && !Array.isArray(journey.ticketIds)) throw new Error("乘客行程的票据关联必须是列表。");
          if (!TRANSPORT_TYPES.includes(normalizeTransportType(journey.type || record.type))) throw new Error("乘客行程的交通方式无效。");
        }
      }
      if (record.sourceType && record.sourceId) {
        const sourceKey = `${record.sourceType}:${record.sourceId}`;
        if (transportSources.has(sourceKey)) throw new Error("同一航班或租车资料不能重复关联。");
        transportSources.add(sourceKey);
      }
    }
    if (!content.todoCategories.length) throw new Error("至少需要保留一个 To Do 分类。");
    return true;
  }

  function createStore(tripId, storage = globalThis.localStorage) {
    const storageKey = keyFor(tripId);
    if (!storage) throw new Error("此浏览器无法使用本地存储。");

    function load(data) {
      let serialized;
      try { serialized = storage.getItem(storageKey); }
      catch (error) { throw new Error(`无法读取本地旅行资料：${error.message}`); }
      if (serialized === null) return createInitialContent(data);
      let parsed;
      try { parsed = JSON.parse(serialized); }
      catch { throw new Error("本地旅行资料无法解析；为保护数据，未覆盖原内容。"); }
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.version === VERSION && parsed.connections === undefined) parsed.connections = [];
      validate(parsed, String(tripId));
      return clone(parsed);
    }

    function save(content) {
      validate(content, String(tripId));
      const next = { ...clone(content), updatedAt: new Date().toISOString() };
      let serialized;
      try {
        serialized = JSON.stringify(next);
        storage.setItem(storageKey, serialized);
        if (storage.getItem(storageKey) !== serialized) throw new Error("保存后校验不一致。");
      } catch (error) {
        throw new Error(`旅行资料保存失败：${error.message || "本地存储不可用"}`);
      }
      return clone(next);
    }

    return Object.freeze({ tripId: String(tripId), storageKey, load, save });
  }

  function createCloudStore(tripId, apiBase = "/api/trip") {
    const id = String(tripId || "").trim();
    if (!id) throw new Error("Cloud travel content requires a tripId.");
    if (!/^\/(?!\/)/.test(apiBase) || apiBase.includes("\\") || /[?#]/.test(apiBase)) throw new Error("Cloud API must use a same-origin path.");
    const endpoint = `${apiBase.replace(/\/+$/, "")}/${encodeURIComponent(id)}/content`;
    let revision = null;

    async function load(data) {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "请通过已授权的私人访问入口登录后重试。" : `云端旅行资料读取失败（${response.status}）。`);
      const result = await response.json();
      revision = result.revision;
      const content = result.content || createInitialContent(data);
      if (!content.tripId) content.tripId = id;
      validate(content, id);
      return clone(content);
    }

    async function save(content) {
      validate(content, id);
      if (!Number.isSafeInteger(revision)) throw new Error("云端版本尚未载入，请刷新页面后重试。");
      const next = { ...clone(content), updatedAt: new Date().toISOString() };
      const response = await fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": `\"${revision}\"` },
        body: JSON.stringify({ content: next })
      });
      if (response.status === 409) throw new Error("云端旅行资料已在其他设备更新。请刷新以载入最新版本，再重新提交修改。");
      if (!response.ok) throw new Error(`云端旅行资料保存失败（${response.status}），本次修改未确认保存。`);
      revision = (await response.json()).revision;
      return clone(next);
    }

    return Object.freeze({ tripId: id, mode: "d1", load, save, getRevision: () => revision });
  }

  const api = Object.freeze({ VERSION, COLLECTIONS, TRANSPORT_TYPES, DEFAULT_CATEGORIES, createStore, createCloudStore, createInitialContent, normalizeTransportType, normalizePassengerJourneys, passengerJourneyAttachmentKey, normalizeTodos, moveTasksBeforeCategoryDelete, validate, keyFor });
  if (typeof window !== "undefined") window.TravelContentStore = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})();
