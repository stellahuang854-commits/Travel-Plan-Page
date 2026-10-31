(() => {
  "use strict";
  const root = () => document.querySelector("#inspiration-root");
  const esc = (value = "") => String(value).replace(/[&<>\'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  const idFor = () => `inspiration-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
  const platforms = ["小红书", "抖音", "TikTok", "Instagram", "YouTube", "Bilibili", "微博", "大众点评", "网页", "Other"];
  let options = null;
  let filterItemId = "";

  function content() { return options?.getContent?.() || window.TravelContentEditor?.getContent?.() || {}; }
  function travelers() { return window.TravelLedger?.getSnapshot?.()?.travelers || []; }
  function selectedTravelerId() {
    const list = travelers();
    let selected = "";
    try { selected = localStorage.getItem(`travel-plan:inspiration-voter:${options?.tripId || ""}`) || ""; } catch {}
    return list.some((person) => String(person.id) === selected) ? selected : String(list[0]?.id || "");
  }
  function platformMarkup(value = "") {
    const custom = value && !platforms.includes(value);
    return `<select name="sourcePlatform">${platforms.map((platform) => `<option value="${esc(platform)}"${value === platform || (custom && platform === "Other") ? " selected" : ""}>${esc(platform)}</option>`).join("")}</select><input name="sourcePlatformOther" value="${custom ? esc(value) : ""}" maxlength="60" placeholder="其他平台名称（可选）">`;
  }
  function providerUrl(record) {
    const provider = record.mapProvider || options?.mapProvider || "google";
    const coordinates = record.coordinates && Number.isFinite(Number(record.coordinates.lat)) && Number.isFinite(Number(record.coordinates.lng)) ? record.coordinates : null;
    const query = [record.locationName, record.city, record.region].filter(Boolean).join(", ");
    return window.TravelPhase3?.placeUrl?.(provider, { label: record.locationName || record.title, query: query || record.title, coordinates }) || "";
  }
  function statusText(record) {
    return ({ below_threshold: "等待更多同行人投票", below_threshold_linked: "当前票数低于通过线 · 已加入的行程保留", approved_pending_day: "已通过 · 待选择日期", approved_added: "已通过 · 已关联行程", manual_added: "已手动加入行程", linked_existing: "已关联现有行程地点" })[record.status] || "等待投票";
  }
  function render() {
    const host = root();
    if (!host || !options) return;
    const data = content();
    const people = travelers();
    const currentId = selectedTravelerId();
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    filterItemId = params.get("item") || "";
    const linkedItem = params.get("item") || "";
    const requestedLocation = params.get("location") || "";
    const records = (data.inspirations || []).filter((item) => !filterItemId || item.linkedItineraryItemId === filterItemId || item.id === filterItemId || item.linkedItineraryItemId === `inspiration-item-${filterItemId}`);
    const days = [...(data.days || [])].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const itineraryItems = (data.days || []).flatMap((day) => (day.schedule || []).map((item) => ({ day, item })));
    host.innerHTML = `<div class="inspiration-app">
      <header class="inspiration-header"><div><p class="ledger-page-eyebrow">TRAVEL INSPIRATION · TRIP ARCHIVE</p><h1>种草</h1><p>保存旅行前发现的地点与原帖链接；不抓取第三方页面。</p></div><button class="inspiration-primary" type="button" data-inspiration-add>＋ 添加种草</button></header>
      <section class="inspiration-voter"><label for="inspiration-voter-select">我是同行人</label><select id="inspiration-voter-select"${people.length ? "" : " disabled"}>${people.length ? people.map((person) => `<option value="${esc(person.id)}"${String(person.id) === currentId ? " selected" : ""}>${esc(person.name || "同行人")}</option>`).join("") : "<option value=\"\">请先在 AA / 账本中添加同行人</option>"}</select><small>每位同行人使用统一 traveler ID，每条记录最多投一票。</small></section>
      ${linkedItem ? `<p class="inspiration-filter-note">正在查看与某个行程安排关联的灵感。<a href="#inspiration">查看全部</a></p>` : ""}
      <div class="inspiration-grid">${records.map((record) => {
        const count = new Set((record.votes || []).filter((vote) => vote.value === "yes" && people.some((person) => String(person.id) === String(vote.travelerId))).map((vote) => String(vote.travelerId))).size;
        const url = window.TravelContentStore.safeInspirationUrl(record.sourceUrl || "");
        const mapUrl = providerUrl(record);
        const hasVoted = (record.votes || []).some((vote) => String(vote.travelerId) === currentId && vote.value === "yes");
        const targetValue = record.targetDay || "";
        const attachmentId = `inspiration:${record.id}`;
        const category = record.category || "旅行灵感";
        return `<article class="inspiration-card" data-inspiration-card="${esc(record.id)}">
          <div class="inspiration-card__top"><span class="inspiration-platform">${esc(record.sourcePlatform || "Other")}</span><span class="inspiration-category">${esc(category)}</span></div>
          <h2>${esc(record.title)}</h2><p class="inspiration-location">${esc([record.locationName, record.city, record.region].filter(Boolean).join(" · ") || "地点待补充")}</p>
          ${record.note ? `<p class="inspiration-note">${esc(record.note)}</p>` : ""}
          <p class="inspiration-status">${esc(statusText(record))}</p>
          <p class="inspiration-votes">♥ ${count} / ${people.length} 想去</p>
          <div class="inspiration-actions">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">打开原帖 ↗</a>` : ""}${mapUrl ? `<a href="${esc(mapUrl)}" target="_blank" rel="noopener noreferrer">打开地图 ↗</a>` : ""}<button type="button" data-inspiration-vote="${esc(record.id)}" aria-pressed="${hasVoted}"${people.length ? "" : " disabled"}>${hasVoted ? "取消想去" : "想去"}</button><button type="button" data-inspiration-attachments="${esc(record.id)}" data-owner="${esc(attachmentId)}">附件</button><button type="button" data-inspiration-add-day="${esc(record.id)}">加入某一天</button><button type="button" data-inspiration-edit="${esc(record.id)}">编辑</button><button type="button" data-inspiration-delete="${esc(record.id)}">删除</button></div>
          ${days.length ? `<label class="inspiration-day-select">选择日期<select data-inspiration-day="${esc(record.id)}"><option value="">选择一天</option>${days.map((day) => `<option value="${esc(day.id)}"${targetValue === day.id ? " selected" : ""}>${esc(day.date || "日期待补充")} · ${esc(day.title || `DAY ${day.day || ""}`)}</option>`).join("")}</select></label>` : `<small>请先添加旅行日期，再加入行程。</small>`}
        </article>`;
      }).join("") || `<div class="inspiration-empty"><strong>还没有旅行灵感</strong><p>添加你自己保存的社交平台或网页链接。</p><button class="inspiration-primary" type="button" data-inspiration-add>＋ 添加第一条</button></div>`}</div>
      <dialog class="inspiration-dialog" data-inspiration-dialog><form data-inspiration-form method="dialog"><header><div><small>TRAVEL INSPIRATION</small><h2 data-inspiration-form-title>添加种草</h2></div><button type="button" data-inspiration-close>关闭</button></header><input type="hidden" name="id"><div class="inspiration-form-grid"><label>标题<input name="title" maxlength="140" required></label><label>地点名称<input name="locationName" maxlength="140"></label><label>类别<input name="category" maxlength="60" placeholder="景点、餐厅、咖啡店…"></label><label>城市<input name="city" maxlength="80"></label><label>地区<input name="region" maxlength="80"></label><label>平台${platformMarkup()}</label><label class="inspiration-url-field">原帖链接<input name="sourceUrl" type="url" inputmode="url" placeholder="https://…"><small>仅保存你粘贴的链接，不抓取内容；仅允许 http / https。</small></label><label>纬度（可选）<input name="latitude" type="number" min="-90" max="90" step="any"></label><label>经度（可选）<input name="longitude" type="number" min="-180" max="180" step="any"></label><label>地图服务<select name="mapProvider"><option value="google">Google Maps</option><option value="apple">Apple Maps</option><option value="openstreetmap">OpenStreetMap</option><option value="amap">高德地图</option></select></label><label class="inspiration-note-field">备注<textarea name="note" rows="3" maxlength="1000"></textarea></label><label>目标日期（可选）<select name="targetDay"><option value="">暂不指定</option>${days.map((day) => `<option value="${esc(day.id)}">${esc(day.date || "日期待补充")} · ${esc(day.title || `DAY ${day.day || ""}`)}</option>`).join("")}</select></label><label class="inspiration-note-field">关联现有行程地点（可选）<select name="linkedItineraryItemId"><option value="">不关联</option>${itineraryItems.map(({ day, item }) => `<option value="${esc(item.id)}">${esc(day.date || "日期待补充")} · ${esc(day.title || `DAY ${day.day || ""}`)} · ${esc(item.location || item.placeName || item.text || item.title || "行程地点")}</option>`).join("")}</select><small>多个种草记录可以关联同一地点；投票通过时不会重复创建地点。</small></label></div><p class="inspiration-form-error" data-inspiration-error role="status"></p><div class="inspiration-form-actions"><button type="button" data-inspiration-close>取消</button><button class="inspiration-primary" type="submit">保存种草</button></div></form></dialog>
    </div>`;
    const selector = host.querySelector("#inspiration-voter-select");
    selector?.addEventListener("change", () => { try { localStorage.setItem(`travel-plan:inspiration-voter:${options.tripId}`, selector.value); } catch {} render(); });
    if (requestedLocation && !records.length) {
      history.replaceState(history.state, "", "#inspiration");
      openForm(null, { locationName: requestedLocation });
    }
  }

  function openForm(recordId = null, prefill = {}) {
    const host = root();
    const form = host?.querySelector("[data-inspiration-form]");
    const record = (content().inspirations || []).find((item) => item.id === recordId) || prefill;
    if (!form) return;
    form.reset();
    form.elements.id.value = record.id || "";
    for (const name of ["title", "locationName", "category", "city", "region", "sourceUrl", "note", "mapProvider"]) if (record[name] !== undefined && form.elements[name]) form.elements[name].value = record[name];
    const knownPlatform = platforms.includes(record.sourcePlatform);
    form.elements.sourcePlatform.value = knownPlatform ? record.sourcePlatform : platforms.at(-1);
    form.elements.sourcePlatformOther.value = knownPlatform ? "" : record.sourcePlatform || "";
    form.elements.latitude.value = record.coordinates?.lat ?? "";
    form.elements.longitude.value = record.coordinates?.lng ?? "";
    form.elements.targetDay.value = record.targetDay || "";
    form.elements.linkedItineraryItemId.value = record.linkedItineraryItemId || "";
    host.querySelector("[data-inspiration-form-title]").textContent = record.id ? "编辑种草" : "添加种草";
    host.querySelector("[data-inspiration-error]").textContent = "";
    const dialog = host.querySelector("[data-inspiration-dialog]");
    if (dialog?.showModal) dialog.showModal(); else dialog?.setAttribute("open", "");
    form.elements.title.focus({ preventScroll: true });
  }

  async function submitForm(form) {
    const values = new FormData(form);
    const latitude = String(values.get("latitude") || "").trim(); const longitude = String(values.get("longitude") || "").trim();
    if (Boolean(latitude) !== Boolean(longitude)) { form.querySelector("[data-inspiration-error]").textContent = "经纬度需同时填写，或同时留空。"; return; }
    let sourceUrl = String(values.get("sourceUrl") || "").trim();
    try { sourceUrl = window.TravelContentStore.safeInspirationUrl(sourceUrl); }
    catch (error) { form.querySelector("[data-inspiration-error]").textContent = error.message; return; }
    const targetDay = String(values.get("targetDay") || "");
    const linkedItineraryItemId = String(values.get("linkedItineraryItemId") || "");
    const day = (content().days || []).find((entry) => entry.id === targetDay);
    const record = {
      ...(content().inspirations || []).find((item) => item.id === values.get("id")) || {},
      id: String(values.get("id") || idFor()), title: String(values.get("title") || "").trim(),
      locationName: String(values.get("locationName") || "").trim(), category: String(values.get("category") || "").trim(),
      city: String(values.get("city") || "").trim(), region: String(values.get("region") || "").trim(),
      sourcePlatform: String(values.get("sourcePlatform") === "Other" && String(values.get("sourcePlatformOther") || "").trim() ? values.get("sourcePlatformOther") : values.get("sourcePlatform") || "Other").trim(), sourceUrl, note: String(values.get("note") || "").trim(),
      mapProvider: String(values.get("mapProvider") || "google"),
      coordinates: latitude && longitude ? { lat: Number(latitude), lng: Number(longitude), system: "WGS84" } : null,
      targetDay, targetDate: targetDay ? day?.date || "" : "",
      linkedItineraryItemId,
      votes: (content().inspirations || []).find((item) => item.id === values.get("id"))?.votes || [],
      status: linkedItineraryItemId ? "linked_existing" : (content().inspirations || []).find((item) => item.id === values.get("id"))?.status || "below_threshold"
    };
    form.closest("dialog")?.close();
    const saved = await options.editor.saveInspiration(record);
    if (!saved) { form.querySelector("[data-inspiration-error]").textContent = "保存失败，请检查网络后重试。"; form.closest("dialog")?.showModal?.(); }
  }

  function setup() {
    const host = root();
    if (!host || host.dataset.bound) return;
    host.dataset.bound = "true";
    host.addEventListener("click", async (event) => {
      if (event.target.closest("[data-inspiration-add]")) { openForm(null, { locationName: new URLSearchParams(location.hash.split("?")[1] || "").get("location") || "" }); return; }
      const close = event.target.closest("[data-inspiration-close]"); if (close) { close.closest("dialog")?.close(); return; }
      const edit = event.target.closest("[data-inspiration-edit]"); if (edit) { openForm(edit.dataset.inspirationEdit); return; }
      const remove = event.target.closest("[data-inspiration-delete]"); if (remove) { await options.editor.deleteInspiration(remove.dataset.inspirationDelete); return; }
      const vote = event.target.closest("[data-inspiration-vote]"); if (vote) { try { await options.editor.voteInspiration(vote.dataset.inspirationVote, selectedTravelerId()); } catch (error) { window.alert(error.message || "投票失败。"); } return; }
      const join = event.target.closest("[data-inspiration-add-day]"); if (join) { const dayId = host.querySelector(`[data-inspiration-day="${CSS.escape(join.dataset.inspirationAddDay)}"]`)?.value; if (!dayId) { window.alert("请先选择要加入的日期。"); return; } await options.editor.addInspirationToDay(join.dataset.inspirationAddDay, dayId); return; }
      const attachment = event.target.closest("[data-inspiration-attachments]"); if (attachment) { window.dispatchEvent(new CustomEvent("travel-transport-detail", { detail: { id: `inspiration:${attachment.dataset.inspirationAttachments}`, transportId: `inspiration:${attachment.dataset.inspirationAttachments}`, type: "other", title: "种草附件", attachmentOnly: true } })); return; }
      if (event.target.closest("[data-inspiration-filter-clear]")) location.hash = "#inspiration";
    });
    host.addEventListener("submit", (event) => { const form = event.target.closest("[data-inspiration-form]"); if (!form) return; event.preventDefault(); void submitForm(form); });
    window.addEventListener("travel-ledger:travelers-changed", (event) => { if (String(event.detail?.tripId || "") === String(options.tripId)) render(); });
    window.addEventListener("hashchange", render);
  }

  window.TravelInspiration = Object.freeze({ init(config) { options = config; setup(); render(); }, render });
})();
