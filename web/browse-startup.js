/* SPDX-License-Identifier: GPL-3.0-only */
// Restore controls before CDN/module loading so the HTML defaults never flash.
(() => {
    const root = document.documentElement;
    root.setAttribute("data-browse-pending", "");
    let saved;
    try { saved = JSON.parse(localStorage.getItem("patch-bundle-registry:browsing:v1") || "null"); }
    catch { /* Storage is optional. */ }
    const params = new URLSearchParams(location.search);
    const shared = ["tab", "q", "package", "source", "version", "type", "release", "view",
        "app", "bundle", "bundle_source", "bundle_version", "section"].some(key => params.has(key));
    const tab = shared ? params.get("tab") === "apps" ||
        (!params.has("tab") && params.has("app")) ? "apps" : "bundles" :
        saved?.activeTab === "apps" ? "apps" : "bundles";
    const state = shared ? {
        search: params.get("q"), package: params.get("package"), source: params.get("source"),
        version: params.get("version"), type: params.get("type"), release: params.get("release"),
        ...(params.has("view") ? { grid: params.get("view") !== "list" } : {})
    } : saved?.tabs?.[tab] || {};
    const text = key => typeof state[key] === "string"
        ? (key === "type" ? state[key].replace(/^ReSeam/, "Reseam") : state[key]).slice(0, 512) : "";
    const release = ["all", "latest", "release", "prerelease"].includes(state.release) ? state.release : "latest";
    const grid = typeof state.grid === "boolean" ? state.grid : !matchMedia("(max-width: 700px)").matches;
    function restore() {
        const byId = id => document.getElementById(id);
        byId("search").value = text("search");
        byId("search").placeholder = tab === "apps" ? "Search by app or package" : "Search bundles or patches";
        byId("search").setAttribute("aria-label", tab === "apps" ? "Search apps" : "Search bundles");
        byId("package-filter").value = text("package");
        for (const [id, value] of [["source-filter", text("source")], ["bundle-type-filter", text("type")],
            ["bundle-version-filter", tab === "bundles" ? text("version") : ""]]) {
            const control = byId(id);
            const label = id === "bundle-type-filter"
                ? value.startsWith("Morphe:") ? "Morphe" : value.startsWith("Reseam") ? "Reseam"
                    : value.replace(/^ReVanced:v/, "ReVanced v")
                : value;
            if (value) control.appendChild(new Option(label, value));
            control.value = value;
        }
        byId("source-picker-value").textContent = text("source") || "All sources";
        byId("bundle-version-filter").disabled = !text("source");
        document.querySelectorAll(".filter-btn").forEach(button => {
            const selected = button.dataset.filter === release;
            button.classList.toggle("active", selected);
            button.setAttribute("aria-pressed", String(selected));
        });
        document.querySelectorAll(".catalog-tab").forEach(button => {
            const selected = button.id === tab + "-tab";
            button.classList.toggle("active", selected);
            button.setAttribute("aria-selected", String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        byId("results").setAttribute("aria-labelledby", tab + "-tab");
        byId("results").classList.toggle("grid-view", grid);
        document.querySelector(".container").classList.toggle("grid-view-enabled", grid);
        byId("view-toggle").setAttribute("aria-pressed", String(grid));
        byId("bundle-version-field").hidden = tab === "apps";
        document.querySelector(".filter-row").classList.toggle("apps-filters", tab === "apps");
        byId("apps-note").hidden = tab !== "apps";
        byId("status").textContent = tab === "apps" ? "Loading apps..." : "Loading bundles...";
        byId("catalog-app").addEventListener?.("error", () => {
            byId("status").textContent = "The catalog interface could not start.";
            byId("catalog-stats").textContent = "Catalog statistics unavailable";
            byId("catalog-retry").hidden = false;
            byId("catalog-retry").addEventListener("click", () => location.reload());
        });
        root.removeAttribute("data-browse-pending");
    }
    if (document.readyState === "loading")
        document.addEventListener("readystatechange", restore, { once: true });
    else restore();
})();
