const originalFetch = window.fetch.bind(window);
const fixtureURL = new URL("./demo-fixture.json", window.location.href);
const fixturePromise = originalFetch(fixtureURL).then(async (response) => {
  if (!response.ok) throw new Error(`Unable to load static demo fixture (${response.status})`);
  return response.json();
});

window.fetch = async (input, init = {}) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request?.url ?? String(input), window.location.href);
  if (!url.pathname.includes("/api/")) return originalFetch(input, init);

  const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
  const route = apiRoute(url.pathname);
  if (method !== "GET") {
    if (route === "/api/layout" && method === "PUT") return jsonResponse(200, { saved: false, demo: true });
    return jsonResponse(405, {
      error: "Static demo is read-only. This action is available in a local Boushun installation.",
    });
  }

  const fixture = await fixturePromise;
  if (!(route in fixture.routes)) return jsonResponse(404, { error: "Demo endpoint not available" });
  return jsonResponse(200, fixture.routes[route]);
};

const blockedSelectors = [
  "#passive-scan",
  "#open-scan-dialog",
  "#open-service-dialog",
  "#open-udp-dialog",
  "#ports-run-tcp",
  "#ports-run-udp",
  "#ports-empty-tcp",
  "#ports-empty-udp",
  "#graph-empty-deep",
  "#scan-form",
  "#service-form",
  "#udp-form",
  "#confirm-scan",
  "#confirm-service-scan",
  "#confirm-udp-scan",
  "#cancel-scan",
  "#global-cancel-scan",
  "#drawer-rescan-tcp",
  "#drawer-rescan-udp",
  "#drawer-use-suggested-name",
  "#drawer-apply-recommended-split",
  "#device-editor",
  "#device-editor input",
  "#device-editor button",
  "#merge-device",
  "#split-device",
  "#schedule-form",
  "#schedule-form input",
  "#schedule-form select",
  "#schedule-form button",
  ".schedule-run",
  ".schedule-delete",
  "#mark-notifications-read",
  "#database-export",
  "#database-file",
  "#database-import",
  "#database-reset",
  "#database-collect-facts",
].join(",");

const readOnlyMessage = "Static demo: available in a local Boushun installation.";

document.documentElement.dataset.staticDemo = "true";
configureDemoBanner();
lockMutatingControls();

const observer = new MutationObserver(() => lockMutatingControls());
observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "class"] });

document.addEventListener("click", blockMutation, true);
document.addEventListener("submit", blockMutation, true);

function apiRoute(pathname) {
  const marker = pathname.indexOf("/api/");
  return marker === -1 ? pathname : pathname.slice(marker);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function lockMutatingControls() {
  for (const control of document.querySelectorAll(blockedSelectors)) {
    if ("disabled" in control && !control.disabled) control.disabled = true;
    if (control.getAttribute("aria-disabled") !== "true") control.setAttribute("aria-disabled", "true");
    if (control.title !== readOnlyMessage) control.title = readOnlyMessage;
  }
}

function blockMutation(event) {
  const target = event.target instanceof Element ? event.target.closest(blockedSelectors) : null;
  if (!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function configureDemoBanner() {
  const banner = document.getElementById("demo-banner");
  if (!banner) return;
  const strong = document.createElement("strong");
  const copy = document.createElement("span");
  strong.textContent = "Static demo";
  copy.textContent = "Synthetic read-only data. Scanning and data changes are disabled.";
  banner.replaceChildren(strong, copy);
}
