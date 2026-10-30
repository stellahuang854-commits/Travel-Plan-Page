(() => {
  "use strict";
  const tripSelect = document.querySelector("#cloud-access-trip");
  const status = document.querySelector("#cloud-access-status");
  const invitationResult = document.querySelector("#cloud-invite-result");
  const memberList = document.querySelector("#cloud-member-list");
  const invitationList = document.querySelector("#cloud-invitation-list");
  const revisionList = document.querySelector("#cloud-revision-list");
  let currentUser = null;

  const esc = (value = "") => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const selectedTrip = () => tripSelect.value;
  const displayDate = (value) => value ? new Date(value).toLocaleString() : "";

  function report(message, error = false) {
    status.textContent = message;
    status.classList.toggle("is-error", error);
  }

  async function loadTrips() {
    currentUser = await window.TravelCloud.session();
    document.querySelector("#cloud-access-user").textContent = currentUser.email || "已验证身份";
    const { trips } = await window.TravelCloud.listTrips();
    tripSelect.innerHTML = trips.map((trip) => `<option value="${esc(trip.id)}">${esc(trip.title)} · ${esc(trip.role)}</option>`).join("");
    if (!trips.length) { report("当前账号尚未创建或加入旅行。", true); return; }
    await loadTripData();
  }

  async function loadTripData() {
    const tripId = selectedTrip();
    const option = tripSelect.selectedOptions[0];
    const isOwner = option?.textContent.endsWith("owner");
    if (!tripId) return;
    if (!isOwner) {
      memberList.textContent = "只有旅行创建者可以管理同行者。";
      invitationList.replaceChildren();
      report("此旅行的访问权限由 Owner 管理。", true);
      return;
    }
    report("正在读取成员和邀请…");
    try {
      const [{ members }, { invitations }, { revisions }] = await Promise.all([window.TravelCloud.listMembers(tripId), window.TravelCloud.listInvitations(tripId), window.TravelCloud.listRevisions(tripId)]);
      memberList.innerHTML = members.map((member) => `<article class="travel-content-row" data-member-id="${esc(member.id)}"><div><strong>${esc(member.email || member.id)}</strong><p>${esc(member.role)} · 加入于 ${esc(displayDate(member.addedAt))}</p></div>${member.role === "owner" ? "" : `<div class="travel-content-row__actions"><select aria-label="${esc(member.email || member.id)} 的角色" data-member-role><option value="editor" ${member.role === "editor" ? "selected" : ""}>Editor</option><option value="viewer" ${member.role === "viewer" ? "selected" : ""}>Viewer</option></select><button type="button" data-member-save>保存角色</button><button type="button" data-member-remove>移除</button></div>`}</article>`).join("") || "尚无同行者。";
      invitationList.innerHTML = invitations.map((invite) => `<article class="travel-content-row" data-invitation-id="${esc(invite.id)}"><div><strong>${esc(invite.email || "未绑定邮箱")} · ${esc(invite.role)}</strong><p>${esc(invite.status)} · 截止 ${esc(displayDate(invite.expiresAt))}</p></div>${invite.status === "pending" ? `<div class="travel-content-row__actions"><button type="button" data-invitation-revoke>撤销邀请</button></div>` : ""}</article>`).join("") || "暂无邀请记录。";
      revisionList.innerHTML = revisions.slice(0, 30).map((revision) => `<article class="travel-content-row" data-revision="${Number(revision.revision)}"><div><strong>版本 ${Number(revision.revision)}</strong><p>${esc(displayDate(revision.updatedAt))} · ${esc(revision.updatedBy === currentUser.id ? "本人保存" : "同行者保存")}</p></div><div class="travel-content-row__actions"><button type="button" data-revision-restore>恢复为新版本</button></div></article>`).join("") || "暂无历史版本。";
      report("");
    } catch (error) { report(error.message || "无法读取访问管理信息。", true); }
  }

  document.querySelector("#cloud-invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    invitationResult.textContent = "";
    const values = new FormData(event.currentTarget);
    try {
      const invite = await window.TravelCloud.invite(selectedTrip(), { email: values.get("email"), role: values.get("role"), expiresInDays: Number(values.get("expiresInDays")) });
      invitationResult.textContent = `邀请已创建（${invite.role}，${displayDate(invite.expiresAt)} 前有效）。链接只显示这一次，请立即复制并发送给同行者。`;
      const link = document.querySelector("#cloud-invite-link");
      link.value = invite.invitationUrl;
      document.querySelector("#cloud-invite-link-wrap").hidden = false;
      document.querySelector("#cloud-invite-copy").hidden = false;
      await loadTripData();
    } catch (error) { invitationResult.textContent = error.message || "邀请创建失败。"; invitationResult.classList.add("is-error"); }
  });

  tripSelect.addEventListener("change", () => { void loadTripData(); });
  document.querySelector("#cloud-invite-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(document.querySelector("#cloud-invite-link").value); invitationResult.textContent = "邀请链接已复制。请通过你选择的私人渠道发送。"; }
    catch { document.querySelector("#cloud-invite-link").select(); invitationResult.textContent = "浏览器未允许复制；请手动复制上方邀请链接。"; }
  });
  document.querySelector("#cloud-backup-download").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await window.TravelCloudMigration.downloadCloudBackup(selectedTrip());
      report(`云端备份已下载，包含 ${result.attachmentCount} 个附件。请将文件保存在安全位置。`);
    } catch (error) { report(error.message || "云端备份下载失败。", true); }
    finally { button.disabled = false; }
  });
  document.addEventListener("click", async (event) => {
    const row = event.target.closest("[data-member-id], [data-invitation-id], [data-revision]");
    if (!row) return;
    try {
      if (event.target.closest("[data-member-save]")) await window.TravelCloud.setMemberRole(selectedTrip(), row.dataset.memberId, row.querySelector("[data-member-role]").value);
      else if (event.target.closest("[data-member-remove]")) {
        if (!window.confirm("移除后，该同行者将立即失去访问此旅行及附件的权限。继续？")) return;
        await window.TravelCloud.removeMember(selectedTrip(), row.dataset.memberId);
      } else if (event.target.closest("[data-invitation-revoke]")) {
        if (!window.confirm("撤销后，未接受的邀请链接将立即失效。继续？")) return;
        await window.TravelCloud.revokeInvitation(selectedTrip(), row.dataset.invitationId);
      } else if (event.target.closest("[data-revision-restore]")) {
        if (!window.confirm(`将版本 ${row.dataset.revision} 恢复为当前旅行状态？此操作会保留现状为历史版本，并创建一个新版本。`)) return;
        const current = await window.TravelCloud.getPackage(selectedTrip());
        await window.TravelCloud.restoreRevision(selectedTrip(), row.dataset.revision, current.revision);
      } else return;
      await loadTripData();
    } catch (error) { report(error.message || "访问权限更新失败。", true); }
  });

  void loadTrips().catch((error) => report(error.message || "无法验证私人访问身份。", true));
})();
