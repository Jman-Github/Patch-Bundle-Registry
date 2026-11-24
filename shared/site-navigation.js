import { catalogTab, defaultReleaseFilter, normalizeReleaseFilter } from "./preferences.js";

// Query parameters work on static hosting without server-side route rewrites.
const keys = ["tab", "q", "package", "source", "version", "type", "release", "view",
    "app", "bundle", "bundle_source", "bundle_version", "section", "baseline"];

export function readSiteRoute(href) {
    const params = new URL(href).searchParams;
    if (!keys.some(key => params.has(key))) return null;
    const text = key => (params.get(key) || "").slice(0, 512);
    const app = text("app");
    const bundle = text("bundle");
    const detail = app ? { kind: "app", package: app } :
        /^[a-f0-9]{1,64}$/.test(bundle) ? { kind: "bundle", id: bundle,
            source: text("bundle_source"), version: text("bundle_version"),
            section: ["changelog", "compare"].includes(text("section")) ? text("section") : "patches",
            ...(text("section") === "compare" && /^[a-f0-9]{1,64}$/.test(text("baseline"))
                ? { baseline: text("baseline") } : {}) } : null;
    const tab = catalogTab(params.has("tab") ? params.get("tab") : app ? "apps" : "bundles");
    return {
        tab,
        browse: { search: text("q"), package: text("package"), source: text("source"),
            version: text("version"), type: text("type"),
            release: normalizeReleaseFilter(text("release"), tab),
            ...(params.has("view") ? { grid: params.get("view") !== "list" } : {}) },
        detail
    };
}

export function siteRouteUrl(href, route) {
    const url = new URL(href);
    keys.forEach(key => url.searchParams.delete(key));
    url.searchParams.set("tab", catalogTab(route.tab));
    const state = route.browse || {};
    for (const [key, value] of Object.entries({ q: state.search, package: state.package,
        source: state.source, version: route.tab === "apps" ? "" : state.version, type: state.type,
        release: state.release === defaultReleaseFilter(route.tab) ? "" : state.release })) {
        if (value) url.searchParams.set(key, value);
    }
    if (typeof state.grid === "boolean") url.searchParams.set("view", state.grid ? "grid" : "list");
    const detail = route.detail;
    if (detail?.kind === "app") url.searchParams.set("app", detail.package);
    if (detail?.kind === "bundle") {
        url.searchParams.set("bundle", detail.id);
        if (detail.source) url.searchParams.set("bundle_source", detail.source);
        if (detail.version) url.searchParams.set("bundle_version", detail.version);
        if (["changelog", "compare"].includes(detail.section)) url.searchParams.set("section", detail.section);
        if (detail.section === "compare" && detail.baseline) url.searchParams.set("baseline", detail.baseline);
    }
    return url;
}

export function createSiteNavigation(browser, onNavigate) {
    const read = () => readSiteRoute(browser.location.href);
    const pop = () => { void onNavigate(read()); };
    browser.addEventListener("popstate", pop);
    return {
        read,
        write(route, { replace = false } = {}) {
            const url = siteRouteUrl(browser.location.href, route);
            if (url.href === browser.location.href) return false;
            browser.history[replace ? "replaceState" : "pushState"](null, "", url.href);
            return true;
        },
        dispose() { browser.removeEventListener("popstate", pop); }
    };
}
