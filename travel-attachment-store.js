(() => {
  "use strict";
  const DB_NAME = "travel-plan-local-attachments";
  const STORE = "attachments";
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  let databasePromise;

  function database() {
    if (!globalThis.indexedDB) return Promise.reject(new Error("此浏览器不支持本地附件存储。"));
    if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("by-transport", ["tripId", "transportId"], { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("无法打开本地附件存储。"));
      request.onblocked = () => reject(new Error("本地附件存储正在被其他页面占用，请关闭其他旅行计划页面后重试。"));
    });
    return databasePromise;
  }

  function transaction(mode, operation) {
    return database().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      let result;
      try { result = operation(store); }
      catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result?.result);
      tx.onerror = tx.onabort = () => reject(tx.error || result?.error || new Error("本地附件操作失败。"));
    }));
  }

  function cloudEnabled() {
    return window.TRAVEL_PLAN_CONFIG?.persistence?.mode === "d1";
  }

  function cloudEndpoint(tripId, attachmentId = "") {
    const base = window.TRAVEL_PLAN_CONFIG?.persistence?.apiBase || "/api/trip";
    return `${base.replace(/\/+$/, "")}/${encodeURIComponent(String(tripId))}/attachments${attachmentId ? `/${encodeURIComponent(attachmentId)}` : ""}`;
  }

  async function cloudJson(response, action) {
    if (response.ok) return response.json();
    if (response.status === 401 || response.status === 403) throw new Error("附件操作未获授权，请确认你仍是该旅行的成员。");
    throw new Error(`${action}失败（${response.status}）。`);
  }

  async function list(tripId, transportId) {
    if (cloudEnabled()) {
      const result = await cloudJson(await fetch(cloudEndpoint(tripId), { cache: "no-store" }), "读取云端附件");
      return (result.attachments || []).filter((item) => String(item.tripId) === String(tripId) && (transportId === undefined || item.transportId === String(transportId)));
    }
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = transportId === undefined ? tx.objectStore(STORE).getAll() : tx.objectStore(STORE).index("by-transport").getAll(IDBKeyRange.only([String(tripId), String(transportId)]));
      request.onsuccess = () => resolve((request.result || []).filter((item) => item.tripId === String(tripId)).map(({ id, tripId: scopedTripId, transportId: scopedTransportId, name, type, size, addedAt }) => ({ id, tripId: scopedTripId, transportId: scopedTransportId, name, type, size, addedAt })));
      request.onerror = () => reject(request.error || new Error("无法读取交通凭证。"));
    });
  }

  async function add(tripId, transportId, file) {
    if (!file || !/^(application\/pdf|image\/(jpeg|png|webp|gif|heic|heif))$/i.test(file.type)) throw new Error("请选择 PDF 或常见图片凭证。");
    if (file.size > MAX_FILE_BYTES) throw new Error("单个附件不能超过 25 MB。");
    const record = { id: `attachment-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`, tripId: String(tripId), transportId: String(transportId), name: file.name || "交通凭证", type: file.type, size: file.size, addedAt: new Date().toISOString(), blob: file.slice(0, file.size, file.type) };
    if (cloudEnabled()) {
      const response = await fetch(cloudEndpoint(tripId), { method: "POST", headers: { "content-type": file.type, "x-attachment-type": file.type, "x-attachment-size": String(file.size), "x-attachment-id": record.id, "x-attachment-name": encodeURIComponent(record.name), "x-transport-id": String(transportId) }, body: record.blob });
      return cloudJson(response, "上传附件");
    }
    await transaction("readwrite", (store) => store.add(record));
    return { id: record.id, name: record.name, type: record.type, size: record.size, addedAt: record.addedAt };
  }

  async function get(tripId, id) {
    if (cloudEnabled()) {
      const response = await fetch(cloudEndpoint(tripId, id), { cache: "no-store" });
      if (!response.ok) { await cloudJson(response, "读取云端附件"); return null; }
      return { id, tripId: String(tripId), blob: await response.blob(), type: response.headers.get("content-type") || "application/octet-stream", name: decodeURIComponent(response.headers.get("x-attachment-name") || "凭证") };
    }
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(String(id));
      request.onsuccess = () => {
        const result = request.result;
        if (!result || result.tripId !== String(tripId)) return resolve(null);
        resolve(result);
      };
      request.onerror = () => reject(request.error || new Error("无法读取附件。"));
    });
  }

  async function remove(tripId, id) {
    if (cloudEnabled()) {
      await cloudJson(await fetch(cloudEndpoint(tripId, id), { method: "DELETE" }), "删除云端附件");
      return;
    }
    const record = await get(tripId, id);
    if (!record) return;
    await transaction("readwrite", (store) => store.delete(String(id)));
  }

  async function removeAll(tripId, transportId) {
    if (cloudEnabled()) {
      const items = await list(tripId, transportId);
      await Promise.all(items.map((item) => remove(tripId, item.id)));
      return items.length;
    }
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      const index = tx.objectStore(STORE).index("by-transport");
      const request = index.openCursor(IDBKeyRange.only([String(tripId), String(transportId)]));
      let removed = 0;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        cursor.delete(); removed += 1; cursor.continue();
      };
      tx.oncomplete = () => resolve(removed);
      tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error("无法清理行程附件。"));
    });
  }

  window.TravelAttachmentStore = Object.freeze({ list, add, get, remove, removeAll, MAX_FILE_BYTES });
})();
