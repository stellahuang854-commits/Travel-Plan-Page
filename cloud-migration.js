(() => {
  "use strict";
  const ATTACHMENT_DB = "travel-plan-local-attachments";
  const ATTACHMENT_STORE = "attachments";

  function localJson(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch { throw new Error(`本地备份数据损坏，未继续：${key}`); }
  }

  function getAttachments(tripId) {
    return new Promise((resolve, reject) => {
      if (!indexedDB) return resolve([]);
      const open = indexedDB.open(ATTACHMENT_DB);
      open.onerror = () => reject(open.error || new Error("无法读取 IndexedDB 附件。"));
      open.onsuccess = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) { db.close(); resolve([]); return; }
        const request = db.transaction(ATTACHMENT_STORE, "readonly").objectStore(ATTACHMENT_STORE).getAll();
        request.onerror = () => { db.close(); reject(request.error || new Error("无法读取 IndexedDB 附件。")); };
        request.onsuccess = () => { db.close(); resolve((request.result || []).filter((item) => item.tripId === String(tripId))); };
      };
    });
  }

  function toBase64(blob) {
    return blob.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const stride = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += stride) binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
      return btoa(binary);
    });
  }

  async function createLocalBackup(tripId = window.TRAVEL_PLAN_DATA?.metadata?.tripId) {
    const id = String(tripId || "").trim();
    const data = window.TRAVEL_PLAN_DATA;
    if (!id || !data || data.metadata?.tripId !== id) throw new Error("当前页面没有匹配的旅行数据；未创建备份。");
    const encodedId = encodeURIComponent(id);
    const content = window.TRAVEL_CONTENT || localJson(`travel-plan:content:v1:${encodedId}`);
    const localRuntime = localJson(`travel-plan:runtime:v1:${encodedId}`) || {};
    const runtime = {
      version: 1, settings: localRuntime.settings && typeof localRuntime.settings === "object" ? localRuntime.settings : null,
      bills: Array.isArray(localRuntime.bills) ? localRuntime.bills : [],
      travelers: Array.isArray(localRuntime.travelers) ? localRuntime.travelers : [],
      todos: Array.isArray(localRuntime.todos) ? localRuntime.todos : [],
      tickets: Array.isArray(localRuntime.tickets) ? localRuntime.tickets : [],
      updatedAt: typeof localRuntime.updatedAt === "string" ? localRuntime.updatedAt : new Date().toISOString()
    };
    const attachments = await getAttachments(id);
    const attachmentBackup = await Promise.all(attachments.map(async (item) => ({
      id: item.id, transportId: item.transportId, name: item.name, type: item.type, size: item.size, addedAt: item.addedAt,
      base64: await toBase64(item.blob)
    })));
    return {
      schemaVersion: "travel-plan-cloud-backup/v1",
      tripId: id,
      createdAt: new Date().toISOString(),
      package: JSON.parse(JSON.stringify(data)),
      content: content ? JSON.parse(JSON.stringify(content)) : null,
      runtime: JSON.parse(JSON.stringify(runtime)),
      attachmentManifest: attachmentBackup.map(({ base64, ...item }) => item),
      attachments: attachmentBackup
    };
  }

  async function downloadLocalBackup(tripId) {
    const backup = await createLocalBackup(tripId);
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `travel-plan-${backup.tripId}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { tripId: backup.tripId, attachmentCount: backup.attachments.length, backup };
  }

  async function downloadCloudBackup(tripId) {
    const backup = await window.TravelCloud.getBackup(tripId);
    const attachments = await Promise.all((backup.attachments || []).map(async (item) => ({
      ...item,
      base64: await toBase64((await window.TravelCloud.downloadAttachment(tripId, item.id)).blob)
    })));
    const bundle = {
      schemaVersion: "travel-plan-cloud-backup/v1", tripId: backup.tripId, createdAt: new Date().toISOString(),
      package: backup.package, content: backup.content, runtime: backup.runtime,
      attachmentManifest: attachments.map(({ base64, ...item }) => item), attachments
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `travel-plan-${tripId}-cloud-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { tripId, attachmentCount: attachments.length, backup: bundle };
  }

  async function importBackup(backup) {
    if (!backup || backup.schemaVersion !== "travel-plan-cloud-backup/v1" || !backup.tripId || backup.package?.metadata?.tripId !== backup.tripId) throw new Error("备份格式或 tripId 无效；没有上传数据。");
    const saved = window.confirm(`即将把“${backup.package.metadata.title || backup.tripId}”及其旅行资料、AA 账单和 ${backup.attachments?.length || 0} 个附件发送到当前网站的 Cloudflare 私人旅行 API。原浏览器数据不会删除。请先确认已将导出的备份文件保存到安全位置。继续？`);
    if (!saved) return { cancelled: true };
    let trip;
    try {
      trip = await window.TravelCloud.createTrip(backup.tripId, backup.package.metadata.title || "旅行计划");
    } catch (error) {
      const existing = (await window.TravelCloud.listTrips()).trips.find((item) => item.id === backup.tripId && item.role === "owner");
      if (!existing) throw error;
      trip = existing;
    }
    const state = {
      schemaVersion: backup.schemaVersion, tripId: backup.tripId, package: backup.package,
      content: backup.content, runtime: backup.runtime, attachmentManifest: backup.attachmentManifest || []
    };
    const current = await window.TravelCloud.getBackup(backup.tripId).catch(() => null);
    if (!current?.package) {
      await fetch(`/api/trip/${encodeURIComponent(backup.tripId)}/migrations`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(state)
      }).then(async (response) => { if (!response.ok) throw new Error(`云端资料迁移未完成（${response.status}）。本地资料仍保留。`); return response.json(); });
    } else {
      const expectedPackage = JSON.parse(JSON.stringify(backup.package));
      expectedPackage.config ||= {};
      expectedPackage.config.persistence = { mode: "d1", apiBase: "/api/trip", sharedCollections: ["todos", "tickets", "ledger"] };
      if (JSON.stringify(current.package) !== JSON.stringify(expectedPackage)
          || JSON.stringify(current.content) !== JSON.stringify(backup.content || null)
          || JSON.stringify(current.runtime) !== JSON.stringify(backup.runtime)) {
        throw new Error("云端已存在不同或后续更新的旅行内容；为避免覆盖，已停止迁移。");
      }
    }
    const uploaded = new Set((await window.TravelCloud.listAttachments(backup.tripId)).attachments.map((item) => item.id));
    const failures = [];
    for (const item of backup.attachments || []) {
      try {
        if (uploaded.has(item.id)) continue;
        const binary = atob(item.base64);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        await window.TravelCloud.uploadAttachment(backup.tripId, item, new Blob([bytes], { type: item.type }));
      } catch (error) { failures.push({ id: item.id, message: error.message }); }
    }
    return { trip, importedAttachments: (backup.attachments || []).length - failures.length, failedAttachments: failures, localDataRetained: true };
  }

  function chooseAndImportBackup() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.addEventListener("change", async () => {
        const file = input.files?.[0];
        if (!file) { resolve({ cancelled: true }); return; }
        try { resolve(await importBackup(JSON.parse(await file.text()))); }
        catch (error) { reject(error); }
      }, { once: true });
      input.click();
    });
  }

  window.TravelCloudMigration = Object.freeze({ createLocalBackup, downloadLocalBackup, downloadCloudBackup, importBackup, chooseAndImportBackup });
})();
