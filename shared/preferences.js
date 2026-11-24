// Save independent browsing preferences without requiring browser storage.
const KEY = "patch-bundle-registry:browsing:v1";
function normalize(value, grid, tab) {
    const state = value && typeof value === "object" ? value : {};
    const text = key => typeof state[key] === "string" ? state[key].slice(0, 512) : "";
    return {
        search: text("search"), package: text("package"), source: text("source"),
        version: tab === "apps" ? "" : text("version"), type: text("type").replace(/^ReSeam/, "Reseam"),
        release: normalizeReleaseFilter(state.release, tab),
        grid: typeof state.grid === "boolean" ? state.grid : grid
    };
}
export function defaultReleaseFilter(tab) {
    return tab === "changelogs" ? "all" : "latest";
}
export function normalizeReleaseFilter(filter, tab) {
    return ["all", "latest", "release", "prerelease"].includes(filter) ? filter : defaultReleaseFilter(tab);
}
export function catalogTab(tab) {
    return ["apps", "changelogs"].includes(tab) ? tab : "bundles";
}
export function createBrowsePreferences(getStorage, defaultGrid = true) {
    let saved;
    try { saved = JSON.parse(getStorage()?.getItem(KEY) || "null"); } catch { /* Storage is optional. */ }
    // Older sessions saved Latest automatically. New sessions may choose it explicitly.
    if (!saved?.changelogHistory && saved?.tabs?.changelogs?.release === "latest")
        saved.tabs.changelogs.release = "all";
    const tabs = Object.fromEntries(["bundles", "apps", "changelogs"].map(tab =>
        [tab, normalize(saved?.tabs?.[tab], defaultGrid, tab)]));
    let activeTab = catalogTab(saved?.activeTab);
    let changelogCalendar = saved?.changelogCalendar === true;
    const openChangelogDays = new Set(Array.isArray(saved?.openChangelogDays)
        ? saved.openChangelogDays.filter(day => typeof day === "string" && /^(?:\d{4}-\d{2}-\d{2}|unknown)$/.test(day))
        : []);
    function persist() {
        try {
            getStorage()?.setItem(KEY, JSON.stringify({ activeTab, tabs, changelogHistory: true, changelogCalendar,
                openChangelogDays: [...openChangelogDays] }));
        } catch { /* Keep in-memory state. */ }
    }
    return {
        get activeTab() { return activeTab; },
        get changelogCalendar() { return changelogCalendar; },
        setChangelogCalendar(enabled) { changelogCalendar = enabled; persist(); },
        read(tab) { return { ...tabs[tab] }; },
        save(tab, state) { tabs[tab] = normalize(state, defaultGrid, tab); persist(); },
        activate(tab) { activeTab = catalogTab(tab); persist(); },
        isChangelogDayOpen(day) { return openChangelogDays.has(day); },
        setChangelogDayOpen(day, open) {
            if (open === openChangelogDays.has(day)) return;
            if (open) openChangelogDays.add(day);
            else openChangelogDays.delete(day);
            persist();
        }
    };
}
