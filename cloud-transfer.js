(() => {
  "use strict";
  const button = document.querySelector("#cloud-transfer-action");
  const status = document.querySelector("#cloud-transfer-status");
  const fileInput = document.querySelector("#cloud-transfer-file");
  const mode = document.body.dataset.cloudMode || (fileInput ? "import" : "export");
  let selected = null;

  function report(message, failed = false) {
    status.textContent = message;
    status.classList.toggle("is-error", failed);
  }

  fileInput?.addEventListener("change", async () => {
    selected = null;
    const file = fileInput.files?.[0];
    if (!file) { button.disabled = true; return; }
    try {
      const candidate = JSON.parse(await file.text());
      if (candidate.schemaVersion !== "travel-plan-cloud-backup/v1" || !candidate.tripId) throw new Error("文件不是有效的旅行备份。");
      selected = candidate;
      button.disabled = false;
      report(`已读取“${candidate.package?.metadata?.title || candidate.tripId}”，包含 ${candidate.attachments?.length || 0} 个附件。尚未上传。`);
    } catch (error) {
      button.disabled = true;
      report(error.message || "无法读取备份。", true);
    }
  });

  button?.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (mode === "export") {
        const response = await fetch("trip-data.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`读取本地旅行数据失败（${response.status}）。`);
        window.TRAVEL_PLAN_DATA = await response.json();
        const download = window.TRAVEL_PLAN_DATA.config?.persistence?.mode === "d1"
          ? window.TravelCloudMigration.downloadCloudBackup
          : window.TravelCloudMigration.downloadLocalBackup;
        const result = await download(window.TRAVEL_PLAN_DATA.metadata.tripId);
        report(`已生成本地备份（${result.attachmentCount} 个附件）。请妥善保存下载的文件；此处没有上传资料。`);
      } else {
        if (!selected) throw new Error("请先选择备份文件。");
        const result = await window.TravelCloudMigration.importBackup(selected);
        if (result.cancelled) { report("已取消；没有向云端发送资料。"); return; }
        if (result.failedAttachments.length) report(`旅行数据已导入，${result.importedAttachments} 个附件上传成功，${result.failedAttachments.length} 个失败。请保留备份文件，稍后可重试。`, true);
        else report(`导入完成：旅行数据和 ${result.importedAttachments} 个附件已保存。原本地资料仍保留。`);
      }
    } catch (error) { report(error.message || "操作失败；原始备份和本地数据均保留。", true); }
    finally { button.disabled = mode === "import" && !selected; }
  });
})();
