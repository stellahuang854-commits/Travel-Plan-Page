(() => {
  "use strict";
  const token = location.hash.slice(1);
  if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  const title = document.querySelector("#invite-trip-title");
  const details = document.querySelector("#invite-details");
  const status = document.querySelector("#invite-status");
  const accept = document.querySelector("#invite-accept");
  const decline = document.querySelector("#invite-decline");
  const openTrip = document.querySelector("#invite-open-trip");
  let valid = false;

  function show(message, error = false) {
    status.textContent = message;
    status.classList.toggle("is-error", error);
  }

  async function initialize() {
    if (!/^[a-f0-9]{64}$/i.test(token)) { title.textContent = "邀请链接无效"; show("请向旅行创建者索取新的邀请。", true); return; }
    try {
      const invitation = await window.TravelCloud.inspectInvitation(token);
      title.textContent = invitation.trip.title;
      details.textContent = `邀请角色：${invitation.role === "editor" ? "可编辑同行者" : "只读同行者"} · 有效期至 ${new Date(invitation.expiresAt).toLocaleString()}`;
      valid = true;
      accept.disabled = false;
      decline.disabled = false;
    } catch (error) { title.textContent = "无法验证邀请"; show(error.message || "邀请无效、已过期或已撤销。", true); }
  }

  accept.addEventListener("click", async () => {
    if (!valid) return;
    accept.disabled = decline.disabled = true;
    try { await window.TravelCloud.acceptInvitation(token); valid = false; show("已接受邀请。你现在可以访问这项旅行。"); openTrip.hidden = false; }
    catch (error) { show(error.message || "接受邀请失败。", true); accept.disabled = decline.disabled = true; }
  });
  decline.addEventListener("click", async () => {
    if (!valid) return;
    accept.disabled = decline.disabled = true;
    try { await window.TravelCloud.declineInvitation(token); valid = false; show("已拒绝邀请。此邀请链接不能再次使用。"); }
    catch (error) { show(error.message || "拒绝邀请失败。", true); }
  });
  void initialize();
})();
