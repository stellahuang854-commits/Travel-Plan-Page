(() => {
  const TRAVEL_HASHES = new Set(["", "#top", "#flights", "#route", "#itinerary", "#drive", "#prep"]);
  const isLedgerHash = (hash) => hash === "#ledger" || hash.startsWith("#ledger-");
  const isInspirationHash = (hash) => hash === "#inspiration" || hash.startsWith("#inspiration?");
  const ledgerEnabled = () => !document.querySelector("#ledger-navigation-link")?.hidden;
  const viewForHash = (hash) => isInspirationHash(hash) ? "inspiration" : isLedgerHash(hash) && ledgerEnabled() ? "ledger" : "travel";

  let activeView = "travel";
  const scrollPositions = { travel: 0, ledger: 0, inspiration: 0 };
  let scrollFrame = 0;
  let browserRouteFrame = 0;
  let pendingBrowserRestore = false;

  function elements() {
    return {
      travelView: document.querySelector('[data-site-view="travel"]'),
      ledgerView: document.querySelector('[data-site-view="ledger"]'),
      inspirationView: document.querySelector('[data-site-view="inspiration"]'),
      travelMenu: document.querySelector("#travel-navigation"),
      travelTrigger: document.querySelector("#travel-navigation-trigger"),
      ledgerLink: document.querySelector("#ledger-navigation-link"),
      inspirationLink: document.querySelector("#inspiration-navigation-link"),
      skipLink: document.querySelector("#skip-link")
    };
  }

  function setVisibleView(nextView, options = {}) {
    const { travelView, ledgerView, inspirationView, travelTrigger, ledgerLink, inspirationLink, skipLink } = elements();
    if (!travelView || !ledgerView || !inspirationView) return;

    const viewChanged = activeView !== nextView;
    if (viewChanged) scrollPositions[activeView] = window.scrollY;
    activeView = nextView;
    const ledgerActive = nextView === "ledger";
    const inspirationActive = nextView === "inspiration";

    travelView.hidden = ledgerActive || inspirationActive;
    ledgerView.hidden = !ledgerActive;
    inspirationView.hidden = !inspirationActive;
    travelView.toggleAttribute("inert", ledgerActive || inspirationActive);
    ledgerView.toggleAttribute("inert", !ledgerActive);
    inspirationView.toggleAttribute("inert", !inspirationActive);
    document.body.dataset.activeView = nextView;
    if (travelTrigger) {
      if (nextView !== "travel") travelTrigger.removeAttribute("aria-current");
      else travelTrigger.setAttribute("aria-current", "page");
    }
    if (ledgerLink) {
      if (ledgerActive) ledgerLink.setAttribute("aria-current", "page");
      else ledgerLink.removeAttribute("aria-current");
    }
    if (inspirationLink) {
      if (inspirationActive) inspirationLink.setAttribute("aria-current", "page");
      else inspirationLink.removeAttribute("aria-current");
    }
    if (skipLink) skipLink.href = ledgerActive ? "#ledger-root" : inspirationActive ? "#inspiration-root" : "#main";

    if (ledgerActive) {
      const tab = location.hash === "#ledger-stats" ? "stats" : location.hash === "#ledger" ? "entry" : "";
      if (tab) window.TravelLedger?.setActiveTab?.(tab, { updateHash: false });
    }

    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (nextView === "travel" && viewChanged) window.dispatchEvent(new Event("travel-view:shown"));
      if (options.targetId && nextView === "travel") {
        document.getElementById(options.targetId)?.scrollIntoView({ block: "start" });
      } else if ((viewChanged || options.forceScroll) && options.restore) {
        window.scrollTo({ top: scrollPositions[nextView] || 0 });
      } else if (viewChanged || options.forceScroll) {
        window.scrollTo({ top: 0 });
      }
    });
  }

  function routeFromLocation(options = {}) {
    const hash = location.hash;
    const nextView = viewForHash(hash);
    const targetId = nextView === "travel" && TRAVEL_HASHES.has(hash) ? hash.slice(1) : "";
    setVisibleView(nextView, { ...options, targetId });
  }

  function navigate(hash) {
    const nextView = viewForHash(hash);
    scrollPositions[activeView] = window.scrollY;
    if (location.hash === hash) {
      setVisibleView(nextView, { targetId: nextView === "travel" ? hash.slice(1) : "" });
      return;
    }
    history.pushState({ view: nextView }, "", hash);
    setVisibleView(nextView, { targetId: nextView === "travel" ? hash.slice(1) : "" });
  }

  function scheduleBrowserRoute({ restore = false } = {}) {
    pendingBrowserRestore ||= restore;
    if (browserRouteFrame) return;
    browserRouteFrame = requestAnimationFrame(() => {
      browserRouteFrame = 0;
      const shouldRestore = pendingBrowserRestore;
      pendingBrowserRestore = false;
      routeFromLocation({ restore: shouldRestore });
    });
  }

  function setup() {
    const { travelMenu } = elements();
    history.scrollRestoration = "manual";
    activeView = viewForHash(location.hash);
    routeFromLocation({ restore: false, forceScroll: true });

    document.addEventListener("click", (event) => {
      const inspirationLink = event.target.closest("#inspiration-navigation-link");
      if (inspirationLink) {
        event.preventDefault();
        navigate("#inspiration");
        return;
      }

      const ledgerLink = event.target.closest("#ledger-navigation-link");
      if (ledgerLink) {
        event.preventDefault();
        travelMenu?.removeAttribute("open");
        navigate("#ledger");
        return;
      }

      const travelLink = event.target.closest(".travel-navigation-menu a, #wordmark");
      if (travelLink) {
        event.preventDefault();
        travelMenu?.removeAttribute("open");
        navigate(travelLink.getAttribute("href") || "#top");
        return;
      }

      if (travelMenu?.open && !event.target.closest("#travel-navigation")) travelMenu.removeAttribute("open");
    });

    window.addEventListener("popstate", () => scheduleBrowserRoute({ restore: true }));
    window.addEventListener("hashchange", () => scheduleBrowserRoute());
    window.addEventListener("travel-config:ready", () => {
      activeView = viewForHash(location.hash);
      routeFromLocation({ forceScroll: false });
    });
    window.addEventListener("travel-ledger:navigate", (event) => {
      const hash = event.detail?.tab === "stats" ? "#ledger-stats" : "#ledger";
      if (location.hash !== hash) history.pushState({ view: "ledger" }, "", hash);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", setup);
  else setup();
})();
