(() => {
  "use strict";
  const base = "/api";
  const tripPath = (tripId, suffix = "") => `${base}/trip/${encodeURIComponent(String(tripId))}${suffix ? `/${suffix.replace(/^\/+/, "")}` : ""}`;

  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options });
    if (!response.ok) {
      if (response.status === 409) throw new Error("云端资料已在另一台设备上变化。请先刷新并确认最新版本。");
      if (response.status === 401 || response.status === 403) throw new Error("当前账号没有访问此项旅行的权限。");
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.message || `请求失败（${response.status}）。`);
    }
    return response.status === 204 ? null : response.json();
  }

  const json = (method, data, revision) => ({
    method,
    headers: { "content-type": "application/json", ...(revision === undefined ? {} : { "if-match": `\"${revision}\"` }) },
    body: JSON.stringify(data)
  });

  const api = Object.freeze({
    getPackage: (tripId) => request(tripPath(tripId, "package")),
    savePackage: (tripId, value, revision) => request(tripPath(tripId, "package"), json("PUT", { package: value }, revision)),
    getContent: (tripId) => request(tripPath(tripId, "content")),
    saveContent: (tripId, value, revision) => request(tripPath(tripId, "content"), json("PUT", { content: value }, revision)),
    getBackup: (tripId) => request(tripPath(tripId, "backup")),
    listRevisions: (tripId) => request(tripPath(tripId, "revisions")),
    restoreRevision: (tripId, sourceRevision, expectedRevision) => request(tripPath(tripId, `revisions/${encodeURIComponent(sourceRevision)}/restore`), json("POST", { expectedRevision }, expectedRevision)),
    listAttachments: (tripId) => request(tripPath(tripId, "attachments")),
    async uploadAttachment(tripId, attachment, file) {
      const response = await fetch(tripPath(tripId, "attachments"), {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": file.type, "x-attachment-type": file.type, "x-attachment-size": String(file.size), "x-attachment-id": attachment.id, "x-attachment-name": encodeURIComponent(attachment.name), "x-transport-id": attachment.transportId },
        body: file
      });
      if (!response.ok) throw new Error(`附件上传失败（${response.status}）。`);
      return response.json();
    },
    downloadAttachment: (tripId, id) => fetch(tripPath(tripId, `attachments/${encodeURIComponent(id)}`), { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`附件读取失败（${response.status}）。`);
      return { blob: await response.blob(), name: decodeURIComponent(response.headers.get("x-attachment-name") || "凭证"), type: response.headers.get("content-type") || "application/octet-stream" };
    }),
    deleteAttachment: (tripId, id) => request(tripPath(tripId, `attachments/${encodeURIComponent(id)}`), { method: "DELETE" }),
    restoreAttachment: (tripId, id) => request(tripPath(tripId, `attachments/${encodeURIComponent(id)}/restore`), json("POST", {}))
  });
  window.TravelCloud = api;
})();
