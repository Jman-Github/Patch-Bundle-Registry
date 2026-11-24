import { ApiCatalog } from "./shared/api-catalog.js";
/* SPDX-License-Identifier: GPL-3.0-only
 * Adapted from brosssh/revanced-external-bundles, copyright its contributors.
 * Source: https://github.com/brosssh/revanced-external-bundles/blob/3a59398d667c83cd7033f859f3cb59237da92b3f/src/main/resources/static/app.js
 * Changes: static snapshot loading, indexed search, lazy metadata, freshness labels,
 * catalog API import URLs, source management, catalog totals, Latest filtering,
 * cached app labels, application browsing, and searchable app/bundle detail dialogs. See COPYING.
 */
import { bundleTypeLabel, bundleImages, Catalog, catalogOrigins, bundleImportPath, reseamNativeImportPath, compareReleaseDates, packageFilterMatches, releaseTimestamp } from "./shared/catalog.js";
import { filterApps } from "./shared/apps.js";
import { createBrowsePreferences } from "./shared/preferences.js";
import { createSiteNavigation } from "./shared/site-navigation.js";
import { createDetailsBrowser, renderPatchOptions } from "./shared/detail-browser.js";
import { formatPatchDescription } from "./shared/details.js";
import { iconAction, importFormatAction, bindActions } from "./shared/actions.js";
import { createFilterPicker } from "./shared/source-picker.js";
import { renderChangelogCalendar } from "./shared/changelog-calendar.js";
import { gitHosts } from "./shared/hosts.js";
import { latestReleaseIds, catalogStats, historicalCatalogStats, repositoryNames, matchesReleaseFilter, countLabel, patchDisplayName, reseamInternalSearchAlias } from "./shared/site.js";
import {
    Virtualizer,
    measureElement,
    observeWindowOffset,
    observeWindowRect,
    windowScroll
} from "https://esm.sh/@tanstack/virtual-core@3.17.8?bundle";

const input = document.getElementById("search");
const packageFilter = document.getElementById("package-filter");
const sourceFilter = document.getElementById("source-filter");
const bundleVersionFilter = document.getElementById("bundle-version-filter");
const bundleTypeFilter = document.getElementById("bundle-type-filter");
const results = document.getElementById("results");
const releaseFeed = document.getElementById("release-feed");
const CHANGELOG_DAYS_PER_PAGE = 14;
let releaseFeedLimit = CHANGELOG_DAYS_PER_PAGE;
let displayedChangelogFilters, repaintChangelogs;
const changelogCalendarState = { month: "", day: "" };
const status = document.getElementById("status");
const retry = document.getElementById("catalog-retry");
const resetFilters = document.getElementById("reset-filters");
const statsPanel = document.getElementById("catalog-stats");
const viewToggle = document.getElementById("view-toggle");
const calendarToggle = document.getElementById("calendar-toggle");
const container = document.querySelector(".container");
const filterButtons = document.querySelectorAll(".filter-btn");
const adminAccess = document.getElementById("admin-access");

// Virtualized list: TanStack Virtual renders only the visible rows of cards. Row
// heights are measured from the DOM and a single spacer keeps the document scroll
// height correct, so card positions are stable and no scroll compensation is needed.
const ROW_GAP = 16;
const MIN_COLUMN_WIDTH = 380;

// Reuse parsed repository descriptions when virtualized cards are recreated.
const renderCache = new Map();
// Preserve open previews and their scroll position as virtualized cards reappear.
const changelogViews = new Map();
const RENDER_CACHE_LIMIT = 500;

function cachedMarkdown(bundleId, key, markdown) {
    const cacheKey = `${bundleId}:${key}`;
    let html = renderCache.get(cacheKey);
    if (html === undefined) {
        html = renderMarkdown(markdown);
        if (renderCache.size >= RENDER_CACHE_LIMIT) renderCache.clear();
        renderCache.set(cacheKey, html);
    }
    return html;
}

const track = document.getElementById("v-track");
const browseControls = document.querySelector(".browse-controls");
let filteredBundles = [];
let virtualizer = null;
let rowData = [];
let lastColumns = 1;
const renderedRows = new Map();

function layoutColumns() {
    if (!results.classList.contains("grid-view")) return 1;
    const width = results.clientWidth;
    return Math.max(1, Math.floor((width + ROW_GAP) / (MIN_COLUMN_WIDTH + ROW_GAP)));
}

function buildRows() {
    const columns = layoutColumns();
    const rows = [];
    for (let i = 0; i < filteredBundles.length; i += columns) {
        rows.push(filteredBundles.slice(i, i + columns));
    }
    return rows;
}

function estimateRowHeight() {
    // Guess only: measured row heights replace this as rows render.
    return results.classList.contains("grid-view") ? 320 : 280;
}

function renderVisible() {
    if (!virtualizer || rowData.length === 0) return;

    const items = virtualizer.getVirtualItems();
    const visible = new Set(items.map(item => item.index));
    track.style.height = `${virtualizer.getTotalSize()}px`;
    for (const [index, row] of renderedRows) {
        if (visible.has(index) || row.contains(document.activeElement) || row.querySelector(".card-selected"))
            continue;
        row.remove();
        renderedRows.delete(index);
    }

    // Keep mounted rows in document order so measuring a neighbor preserves
    // keyboard focus, open controls and scroll position inside a card.
    let next = track.firstElementChild;
    const added = [];
    for (const { index, start } of items) {
        while (next && Number(next.dataset.index) < index) next = next.nextElementSibling;
        let row = renderedRows.get(index);
        if (!row) {
            row = document.createElement("div");
            row.className = "virtual-row";
            row.dataset.index = String(index);
            row.style.gridTemplateColumns = `repeat(${lastColumns}, minmax(0, 1fr))`;
            for (const card of rowData[index]) {
                if (currentTab === "apps") renderApp(card, row);
                else renderBundle(card, row);
            }
            renderedRows.set(index, row);
            track.insertBefore(row, next);
            added.push(row);
        }
        row.style.transform = `translateY(${start - virtualizer.options.scrollMargin}px)`;
        next = row.nextElementSibling;
    }
    virtualizer.measureElement(null);
    for (const row of added) {
        if (row.isConnected) virtualizer.measureElement(row);
    }
}

function clearVirtualizer() {
    if (virtualizer) virtualizer.cleanup();
    virtualizer = null;
    rowData = [];
    renderedRows.clear();
    track.replaceChildren();
    track.style.height = "0px";
}


function currentAnchorBundleIndex() {
    if (!virtualizer) return null;
    const trackTop = track.getBoundingClientRect().top + window.scrollY;
    if (window.scrollY < trackTop) return null;
    const visibleRow = virtualizer.getVirtualItems()
        .find(item => item.end >= window.scrollY);
    return (visibleRow?.index ?? 0) * lastColumns;
}

function setupVirtualizer(anchorBundleIndex = null) {
    rowData = buildRows();
    lastColumns = layoutColumns();
    if (virtualizer) virtualizer.cleanup();
    renderedRows.clear();
    track.replaceChildren();
    virtualizer = new Virtualizer({
        count: rowData.length,
        getScrollElement: () => window,
        estimateSize: () => estimateRowHeight(),
        initialOffset: () => window.scrollY,
        scrollMargin: track.getBoundingClientRect().top + window.scrollY,
        overscan: 2,
        gap: ROW_GAP,
        observeElementRect: observeWindowRect,
        observeElementOffset: observeWindowOffset,
        scrollToFn: windowScroll,
        measureElement,
        onChange: () => renderVisible()
    });
    // The vanilla core does not attach its scroll/resize observers until
    // _willUpdate is invoked; without it no viewport rows ever render.
    virtualizer._willUpdate();
    renderVisible();
    if (anchorBundleIndex !== null && rowData.length > 0) {
        virtualizer.scrollToIndex(
            Math.min(Math.floor(anchorBundleIndex / lastColumns), rowData.length - 1),
            { align: "start" }
        );
    }
}

const browsePreferences = createBrowsePreferences(() => localStorage, !matchMedia("(max-width: 700px)").matches);
const navigation = createSiteNavigation(window, route => restoreNavigation(route));
const initialRoute = navigation.read();
if (initialRoute) {
    browsePreferences.save(initialRoute.tab, initialRoute.browse);
    browsePreferences.activate(initialRoute.tab);
}
let navigationReady = false, navigationRevision = 0;
let currentTab = browsePreferences.activeTab;
let applications = [];
let currentFilter = "latest";
let currentSearchQuery = "";
let currentPackageFilter = "";
let currentSourceUrl = "";
let currentBundleVersion = "";
let sourceSelection = 0;
let currentBundleType = "";
let latestBundles = [];
let currentLatestIds = new Set();
let allBundles = [];
let sourceVersions = [];
let catalog, siteConfig, summaries = [], searchSequence = 0;
let refreshingCatalog = false;
const detailsBrowser = createDetailsBrowser({
    getApplications: () => applications,
    getSummaries: () => summaries, transformBundle, bundlePatches, bundleChangelog, renderMarkdown, renderPatch,
    comparisonReleases, comparisonPatches,
    escapeHtml, installAvatarFallback, formatDate,
    getApi: () => siteConfig.api,
    onNavigate: (detail, { replace = false } = {}) =>
        writeNavigation({ detail }, { replace, userAction: !replace }),
    onClose: () => writeNavigation({ detail: null }, { userAction: true })
});
const sourcePicker = createFilterPicker({
    button: document.getElementById("source-picker"), select: sourceFilter,
    label: "Choose a source", searchLabel: "Search repositories or hosts", showValue: true, reselect: true
});
const versionPicker = createFilterPicker({
    button: document.getElementById("bundle-version-picker"), select: bundleVersionFilter,
    label: "Choose a bundle version", searchLabel: "Search versions"
});
const typePicker = createFilterPicker({
    button: document.getElementById("bundle-type-picker"), select: bundleTypeFilter, label: "Choose a bundle type"
});
const renderAfterInput = debounce(() => { void renderFilteredBundles(); }, 150);
adminAccess.textContent = "Manage sources";
adminAccess.addEventListener("click", () => {
    window.open("https://github.com/" + (siteConfig?.repository || "Jman-Github/Patch-Bundle-Registry") +
        "/blob/" + (siteConfig?.data_branch || "bundles") + "/config/sources.json",
        "_blank", "noopener,noreferrer");
});
function saveBrowsePreferences({ updateUrl = true, userAction = false } = {}) {
    browsePreferences.save(currentTab, {
        search: input.value, package: packageFilter.value, source: currentSourceUrl,
        version: currentBundleVersion, type: currentBundleType, release: currentFilter,
        grid: results.classList.contains("grid-view")
    });
    if (updateUrl) writeNavigation(userAction ? { detail: null } : {}, { replace: true, userAction });
}
function writeNavigation(changes = {}, { replace = false, userAction = false } = {}) {
    if (!navigationReady && !userAction) return;
    const changed = navigation.write({ tab: currentTab, browse: browsePreferences.read(currentTab),
        detail: navigation.read()?.detail ?? null, ...changes }, { replace });
    // Only user navigation cancels a pending link. Background renders may
    // normalize default filters/layout while recovering a new catalog.
    if (changed && userAction) navigationRevision++;
}
async function recoverRoute(error, sequence, route) {
    if (sequence !== navigationRevision) return true;
    const recovered = await recoverGeneration(error);
    if (sequence !== navigationRevision) return true;
    if (recovered) await restoreNavigation(navigation.read() ?? route);
    return recovered;
}

function mergeBundles(current, additional) {
    return [...new Map([...current, ...additional].map(bundle => [bundle.id, bundle])).values()];
}

function showHistoryWarning(retry) {
    status.textContent += " · Older versions could not be loaded. " + retry;
}

async function restoreNavigation(route) {
    const sequence = ++navigationRevision;
    detailsBrowser.close({ notify: false });
    // Back to the original URL means the default browse view, not another
    // person's saved filters from this browser.
    route ??= { tab: "bundles", browse: { release: "latest" }, detail: null };
    browsePreferences.save(route.tab, route.browse);
    const historyPending = Boolean(route.browse.source && catalog?.historyBundles);
    selectTab(route.tab, { render: false, initial: true, updateUrl: false, historyPending });
    if (!catalog) return;
    const detail = route.detail;
    const openBeforeHistory = route.tab === "changelogs" && detail?.kind === "bundle";
    const selection = sourceSelection;
    const restoreBrowse = async () => {
        // A changelog link carries the bundle ID. Its source history is only needed
        // for an explicit browse filter or if the linked ID is no longer available.
        const sources = new Set([route.browse.source, openBeforeHistory ? "" : detail?.source].filter(Boolean));
        if (route.browse.source && catalog.historyBundles) status.textContent = "Loading source versions...";
        let historyUnavailable = false;
        for (const source of sources) {
            if (!catalog.historyBundles) continue;
            try {
                const history = await catalog.historyBundles(source);
                if (selection !== sourceSelection) return;
                summaries = mergeBundles(summaries, history);
            } catch (error) {
                if (selection !== sourceSelection) return;
                if (sequence === navigationRevision && await recoverRoute(error, sequence, route)) return;
                historyUnavailable = true;
            }
        }
        if (selection !== sourceSelection) return;
        restoreBrowsePreferences();
        const restoredSelection = sourceSelection;
        await renderFilteredBundles({ updateUrl: false });
        if (historyUnavailable && restoredSelection === sourceSelection)
            showHistoryWarning("Reload this link to retry.");
    };
    const openDetail = async () => {
        if (sequence !== navigationRevision) return;
        if (detail?.kind === "app") {
            const app = applications.find(app => app.package_name === detail.package);
            if (!app) throw new Error("This app is no longer in the catalog");
            const eligible = summaries.filter(bundle =>
                (!currentSourceUrl || bundle.source.url === currentSourceUrl) &&
                (!currentBundleType || bundle.bundle_type === currentBundleType) &&
                matchesReleaseFilter(transformBundle(bundle), currentFilter));
            const selected = filterApps([app], eligible)[0] || app;
            detailsBrowser.openApp(selected, { notify: false });
        } else if (detail?.kind === "bundle") {
            const replacement = rows => detail.source && detail.version && rows.find(bundle =>
                bundle.source.url === detail.source && bundle.version === detail.version);
            let bundle = summaries.find(bundle => bundle.id === detail.id);
            if (!openBeforeHistory || !catalog.historyBundles) bundle ||= replacement(summaries);
            if (!bundle) {
                // Static indexes already contain every visible bundle. Do not
                // bypass disabled-source filtering through a raw catalog file.
                if (!catalog.historyBundles) throw new Error("This bundle is no longer in the catalog");
                try {
                    bundle = await catalog.file("bundles/" + detail.id + ".json");
                } catch (error) {
                    if (!openBeforeHistory || error.status !== 404 || error.generationUnavailable ||
                        !detail.source || !detail.version || sequence !== navigationRevision) throw error;
                    bundle = replacement(summaries) || replacement(await catalog.historyBundles(detail.source));
                    if (!bundle) throw error;
                }
                if (sequence !== navigationRevision) return;
            }
            await detailsBrowser.openBundle(transformBundle(bundle),
                { section: detail.section, baseline: detail.baseline, notify: false });
        }
    };
    const browse = restoreBrowse();
    try {
        if (openBeforeHistory) await Promise.all([browse, openDetail()]);
        else {
            await browse;
            await openDetail();
        }
    } catch (error) {
        if (await recoverRoute(error, sequence, route)) return;
        if (openBeforeHistory) await Promise.allSettled([browse]);
        if (sequence !== navigationRevision) return;
        status.textContent = "Unable to open shared link: " + error.message;
    }
}
function updateReleaseControls() {
    for (const button of filterButtons) {
        const selected = button.dataset.filter === currentFilter;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-pressed", String(selected));
    }
}

function restoreBrowsePreferences(historyPending = false) {
    sourceSelection++;
    const saved = browsePreferences.read(currentTab);
    input.value = saved.search;
    packageFilter.value = saved.package;
    currentSearchQuery = saved.search.trim().toLowerCase();
    currentPackageFilter = saved.package.trim().toLowerCase();
    currentSourceUrl = saved.source;
    currentBundleVersion = saved.version;
    currentBundleType = saved.type;
    currentFilter = saved.release;
    updateReleaseControls();
    results.classList.toggle("grid-view", saved.grid);
    container.classList.toggle("grid-view-enabled", saved.grid);
    viewToggle.setAttribute("aria-pressed", String(saved.grid));
    sourceVersions = summaries.filter(bundle => bundle.source.url === currentSourceUrl).sort(compareReleaseDates);
    if (catalog) {
        reconcileSourceSelection();
        historyPending &&= Boolean(currentSourceUrl);
        populateBundleTypeOptions(historyPending);
        populateVersionOptions(historyPending);
        // Removed releases or changed filters must not restore an invisible selection.
        if (![...bundleVersionFilter.options].some(option => option.value === currentBundleVersion))
            currentBundleVersion = "";
        bundleVersionFilter.value = currentBundleVersion;
    }
    sourceFilter.value = currentSourceUrl;
    sourcePicker.sync();
    setVersionControlsEnabled(Boolean(currentSourceUrl) && !historyPending);
    allBundles = currentBundleVersion
        ? sourceVersions.filter(bundle => bundle.version === currentBundleVersion).map(transformBundle) : latestBundles;
}
const catalogTabs = [...document.querySelectorAll(".catalog-tab")];
function selectTab(tab, { render = true, initial = false, updateUrl = true, historyPending = false } = {}) {
    if (!initial) {
        saveBrowsePreferences({ updateUrl: false });
        detailsBrowser.close({ notify: false });
    }
    const previousSource = currentSourceUrl;
    currentTab = tab;
    browsePreferences.activate(tab);
    restoreBrowsePreferences(historyPending);
    catalogTabs.forEach(button => {
        const selected = button.id === tab + "-tab";
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
    });
    results.setAttribute("aria-labelledby", tab + "-tab");
    document.getElementById("bundle-version-field").hidden = tab === "apps";
    document.querySelector(".filter-row").classList.toggle("apps-filters", tab === "apps");
    document.getElementById("apps-note").hidden = tab !== "apps";
    const changelogs = tab === "changelogs";
    viewToggle.hidden = changelogs;
    calendarToggle.hidden = !changelogs;
    calendarToggle.setAttribute("aria-pressed", String(browsePreferences.changelogCalendar));
    packageFilter.hidden = changelogs;
    input.placeholder = changelogs ? "Search changelogs by source or version" :
        tab === "apps" ? "Search by app or package" : "Search bundles or patches";
    input.setAttribute("aria-label", changelogs ? "Search changelogs" : tab === "apps" ? "Search apps" : "Search bundles");
    track.hidden = changelogs;
    releaseFeed.hidden = !changelogs;
    if (!changelogs || currentSourceUrl !== previousSource) {
        releaseFeed.replaceChildren();
        repaintChangelogs = undefined;
    }
    clearVirtualizer();
    if (updateUrl && !initial) writeNavigation({ detail: null }, { userAction: true });
    if (render) {
        const browse = browsePreferences.read(tab);
        if (browse.source && catalog?.historyBundles)
            void restoreNavigation({ tab, browse, detail: null });
        else void renderFilteredBundles();
    }
}
catalogTabs.forEach((button, index) => {
    button.addEventListener("click", () => {
        const tab = button.id.replace(/-tab$/, "");
        if (tab !== currentTab) selectTab(tab);
    });
    button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const last = catalogTabs.length - 1;
        const next = event.key === "Home" ? 0 : event.key === "End" ? last :
            (index + (event.key === "ArrowLeft" ? -1 : 1) + catalogTabs.length) % catalogTabs.length;
        catalogTabs[next].click();
        catalogTabs[next].focus();
    });
});
selectTab(currentTab, { render: false, initial: true });
void loadBundles();

input.addEventListener("input", () => {
    currentSearchQuery = input.value.trim().toLowerCase();
    saveBrowsePreferences({ userAction: true });
    renderAfterInput();
});

packageFilter.addEventListener("input", () => {
    currentPackageFilter = packageFilter.value.trim().toLowerCase();
    saveBrowsePreferences({ userAction: true });
    renderAfterInput();
});

sourceFilter.addEventListener("change", () => selectSource(sourceFilter.value));

bundleVersionFilter.addEventListener("change", () => selectBundleVersion(bundleVersionFilter.value));

bundleTypeFilter.addEventListener("change", () => {
    currentBundleType = bundleTypeFilter.value;
    resetBundleSelection();
    populateVersionOptions();
    renderFilteredBundles({ userAction: true });
});

filterButtons.forEach(btn => {
    btn.addEventListener("click", () => {
        currentFilter = btn.dataset.filter;
        updateReleaseControls();
        resetBundleSelection();
        populateVersionOptions();
        renderFilteredBundles({ userAction: true });
    });
});

viewToggle.addEventListener("click", () => {
    const anchorBundleIndex = currentAnchorBundleIndex();
    const gridEnabled = results.classList.toggle("grid-view");
    container.classList.toggle("grid-view-enabled", gridEnabled);
    viewToggle.setAttribute("aria-pressed", String(gridEnabled));
    saveBrowsePreferences({ userAction: true });
    // Rebuild the row grouping while keeping the first visible bundle anchored.
    setupVirtualizer(anchorBundleIndex);
    updateStatus();
});

calendarToggle.addEventListener("click", () => {
    const enabled = !browsePreferences.changelogCalendar;
    browsePreferences.setChangelogCalendar(enabled);
    calendarToggle.setAttribute("aria-pressed", String(enabled));
    repaintChangelogs?.({ preserveRetry: true });
});

addEventListener("resize", () => {
    const columns = layoutColumns();
    if (virtualizer && columns !== lastColumns) setupVirtualizer(currentAnchorBundleIndex());
});

new ResizeObserver(() => {
    if (!virtualizer) return;
    const scrollMargin = track.getBoundingClientRect().top + window.scrollY;
    if (scrollMargin === virtualizer.options.scrollMargin) return;
    virtualizer.setOptions({ ...virtualizer.options, scrollMargin });
    renderVisible();
}).observe(browseControls);

async function openCatalog() {
    if (siteConfig.catalog_backend === "d1") return new ApiCatalog(siteConfig.catalog_api || siteConfig.api).initialize();
    let failure;
    for (const origin of catalogOrigins(siteConfig,new URL("./database/",location.href).href)) {
        try { return await new Catalog(origin,fetch,false).initialize(); }
        catch(error) { failure = error; }
    }
    throw failure;
}

retry.addEventListener("click", async () => {
    const loaded = await loadBundles();
    if (document.activeElement === document.body) (loaded ? input : retry).focus();
});

resetFilters.addEventListener("click", () => {
    browsePreferences.save(currentTab, { grid: results.classList.contains("grid-view") });
    restoreBrowsePreferences();
    input.focus();
    void renderFilteredBundles({ userAction: true });
});

async function loadBundles(refreshedCatalog = null) {
    if (!refreshedCatalog) {
        retry.hidden = true;
        status.textContent = currentTab === "changelogs" ? "Loading changelogs..." :
            currentTab === "apps" ? "Loading apps..." : "Loading bundles...";
        if (!catalog) statsPanel.textContent = "Loading catalog statistics...";
    }
    try {
        const configuration = await fetch("./config.json");
        if (!configuration.ok) throw new Error("Site configuration unavailable");
        siteConfig = await configuration.json();
        const nextCatalog = refreshedCatalog ||
            await openCatalog();
        const sources = [...new Set(["bundles", "apps", currentTab].map(tab => browsePreferences.read(tab).source).filter(Boolean))];
        const [latest, nextApplications] = await Promise.all([
            nextCatalog.bundles(), nextCatalog.apps()
        ]);
        const initialRoute = !navigationReady && navigation.read();
        const openChangelog = initialRoute?.tab === "changelogs" && initialRoute.detail?.kind === "bundle";
        let nextSummaries = latest;
        const missingHistory = new Set();
        if (nextCatalog.historyBundles && !openChangelog) {
            const histories = await Promise.allSettled(sources.map(source => nextCatalog.historyBundles(source)));
            histories.forEach((history, index) => {
                if (history.status === "fulfilled") nextSummaries = mergeBundles(nextSummaries, history.value);
                else missingHistory.add(sources[index]);
            });
        }
        applications = nextApplications;
        catalog = nextCatalog;
        scheduleCatalogRefresh();
        summaries = nextSummaries;
        currentLatestIds = latestReleaseIds(summaries);
        renderStats();
        renderCache.clear();
        bundlePatches.cache?.clear();
        latestBundles = summaries.filter(bundle => bundle.is_latest).map(transformBundle)
            .sort((a, b) => (b.repoStars ?? -1) - (a.repoStars ?? -1) ||
                a.sourceUrl.localeCompare(b.sourceUrl));
        populateSourceOptions();
        restoreBrowsePreferences();
        if (openChangelog) {
            // Restore the selected source behind the shared detail. Other tabs
            // restore their source history when they are selected.
            navigationReady = true;
            await restoreNavigation(initialRoute);
            return true;
        }
        await renderFilteredBundles({ resetScroll: !refreshedCatalog });
        if (missingHistory.has(currentSourceUrl)) showHistoryWarning("Select the source again to retry.");
        if (!navigationReady) {
            navigationReady = true;
            const route = navigation.read();
            if (route) await restoreNavigation(route);
            else writeNavigation({}, { replace: true });
        }
        return true;
    } catch (error) {
        console.error(error);
        if (!refreshedCatalog) {
            if (!catalog) statsPanel.textContent = "Catalog statistics unavailable";
            status.textContent = "Unable to load the catalog. Please try again.";
            retry.hidden = false;
        }
        return false;
    }
}

let catalogRefreshTimer;
let activeCatalogRefresh = null;
function scheduleCatalogRefresh() {
    clearTimeout(catalogRefreshTimer);
    catalogRefreshTimer = setTimeout(async () => {
        if (document.hidden || refreshingCatalog) { scheduleCatalogRefresh(); return; }
        refreshingCatalog = true;
        activeCatalogRefresh = (async () => {
            const next = await openCatalog();
            return next.manifest.generation !== catalog.manifest.generation ? loadBundles(next) : false;
        })();
        try { await activeCatalogRefresh; }
        catch { /* Preserve the current view during a transient origin failure. */ }
        finally { refreshingCatalog = false; activeCatalogRefresh = null; scheduleCatalogRefresh(); }
    },15000);
}

async function recoverGeneration(error, waitActive = false) {
    if (!error.generationUnavailable) return false;
    if (refreshingCatalog)
        return waitActive && activeCatalogRefresh ? activeCatalogRefresh.catch(() => false) : false;
    refreshingCatalog = true;
    activeCatalogRefresh = (async () => {
        const nextCatalog = await openCatalog();
        if (nextCatalog.manifest.generation === catalog.manifest.generation) return false;
        return loadBundles(nextCatalog);
    })();
    try { return await activeCatalogRefresh; }
    catch { return false; }
    finally { refreshingCatalog = false; activeCatalogRefresh = null; }
}

async function selectSource(sourceUrl) {
    const selection = ++sourceSelection;
    resetBundleSelection();
    sourceFilter.value = sourceUrl;
    sourcePicker.sync();
    if (sourceUrl !== currentSourceUrl) {
        sourceVersions = [];
        if (currentTab === "changelogs") {
            releaseFeed.replaceChildren();
            repaintChangelogs = undefined;
        }
    }
    currentSourceUrl = sourceUrl;
    setVersionControlsEnabled(false);

    saveBrowsePreferences({ userAction: true });
    let historyUnavailable = false;
    if (sourceUrl && catalog?.historyBundles) {
        status.textContent = "Loading source versions...";
        try {
            const history = await catalog.historyBundles(sourceUrl);
            if (selection !== sourceSelection) return;
            summaries = mergeBundles(summaries, history);
        } catch (error) {
            if (selection !== sourceSelection) return;
            if (await recoverGeneration(error)) return;
            if (selection !== sourceSelection) return;
            historyUnavailable = true;
        }
    }
    sourceVersions = summaries.filter(bundle => bundle.source.url === sourceUrl)
        .sort(compareReleaseDates);
    resetBundleSelection();
    setVersionControlsEnabled(Boolean(sourceUrl));
    populateBundleTypeOptions();
    populateVersionOptions();
    await renderFilteredBundles();
    if (historyUnavailable && selection === sourceSelection) {
        showHistoryWarning("Select the source again to retry.");
    }
}

async function selectBundleVersion(version) {
    currentBundleVersion = version;
    allBundles = version
        ? sourceVersions.filter(bundle => bundle.version === version).map(transformBundle) : latestBundles;
    await renderFilteredBundles({ userAction: true });
}

function transformPatch(patch) {
    return { name: patch.name, display_name: patch.display_name, description: patch.description,
        hidden: patch.hidden === true, options: patch.options || [],
        universal: patch.packages.length === 0 && (patch.compatiblePackages == null || Object.keys(patch.compatiblePackages).length === 0),
        compatiblePackages: patch.packages.map(pkg => ({ name: pkg.name, appName: pkg.app_name || pkg.name, versions: pkg.versions })) };
}

async function bundlePatches(bundle) {
    const cache = bundlePatches.cache = bundlePatches.cache || new Map();
    const key = `${bundle.id}:${bundle.appPackage || ""}`;
    if (bundle.loadedPatches) return bundle.loadedPatches;
    if (cache.has(key)) return cache.get(key);
    const loadPromise = (async () => {
        const load = () => catalog.patchRows({ bundle_id: bundle.id, package: bundle.appPackage,
            all: true, include_unverified: true, compact: true });
        let result;
        try { result = await load(); }
        catch (error) {
            if (!await recoverGeneration(error, true)) throw error;
            result = await load();
        }
        return result.rows.filter(patch => !patch.hidden && !patch.loader_excluded).map(transformPatch);
    })();
    cache.set(key, loadPromise);
    try {
        const patches = await loadPromise;
        bundle.loadedPatches = patches;
        return patches;
    } catch (error) {
        if (cache.get(key) === loadPromise) cache.delete(key);
        throw error;
    }
}

async function comparisonReleases(bundle) {
    const activeCatalog = catalog;
    const history = activeCatalog.historyBundles
        ? await activeCatalog.historyBundles(bundle.sourceUrl)
        : summaries;
    const releases = history.filter(item => item.source?.url === bundle.sourceUrl &&
        item.bundle_type === bundle.bundleType).sort(compareReleaseDates);
    const currentIndex = releases.findIndex(item => item.id === bundle.id);
    const baseline = releases.slice(currentIndex + 1).find(item =>
        item.patch_list_available && item.metadata_status === "verified");
    if (catalog !== activeCatalog) throw new Error("The catalog changed. Retry to load the current releases.");
    if (currentIndex < 0 || !releases[currentIndex].patch_list_available || releases[currentIndex].metadata_status !== "verified")
        throw new Error("Verified patch metadata is unavailable for this release in the current catalog.");
    return {
        generation: activeCatalog.manifest.generation,
        candidates: releases.filter(item => item.id !== bundle.id &&
            item.patch_list_available && item.metadata_status === "verified").map(transformBundle),
        defaultId: baseline?.id
    };
}

async function comparisonPatches(bundle, baseline, generation) {
    const original = catalog;
    if (original.manifest.generation !== generation)
        throw new Error("The catalog changed. Retry to compare the current metadata.");
    const results = await Promise.all([bundle, baseline].map(item =>
        bundlePatches({ id: item.id })));
    if (catalog !== original) throw new Error("The catalog changed. Retry to compare the current metadata.");
    return results;
}

async function bundleChangelog(bundle) {
    const path = "bundles/" + bundle.id + ".json";
    try { return (await catalog.file(path)).description; }
    catch (error) {
        if (!await recoverGeneration(error)) throw error;
        return (await catalog.file(path)).description;
    }
}

function sourceOptionLabel(bundle) {
    const parts = sourceName(bundle.sourceUrl, bundle.ownerName, bundle.repoName).split('/');
    if (parts.length >= 2) {
        return `${parts.slice(0, -1).join('/')} / ${parts[parts.length - 1]}`;
    }
    return parts[0];
}

function populateSourceOptions() {
    const sources = new Map();
    for (const summary of summaries) {
        const bundle = transformBundle(summary);
        if (!sources.has(bundle.sourceUrl)) {
            let host = '';
            try { host = new URL(bundle.sourceUrl).hostname; } catch { /* keep empty */ }
            sources.set(bundle.sourceUrl, { base: sourceOptionLabel(bundle), host });
        }
    }

    // A namespace/repo shared across hosts is ambiguous, so tag every option with that
    // base with its host.
    const baseHosts = new Map();
    for (const { base, host } of sources.values()) {
        const hosts = baseHosts.get(base) || new Set();
        if (host) hosts.add(host);
        baseHosts.set(base, hosts);
    }

    const options = [new Option("All sources", "")];
    [...sources.entries()]
        .sort((left, right) => left[1].base.localeCompare(right[1].base))
        .forEach(([url, { base, host }]) => {
            const label = baseHosts.get(base).size > 1 ? `${base} (${host})` : base;
            options.push(new Option(label, url));
        });
    sourceFilter.replaceChildren(...options);
    sourcePicker.sync();
}

function reconcileSourceSelection() {
    if (currentSourceUrl && !summaries.some(bundle => bundle.source.url === currentSourceUrl)) {
        currentSourceUrl = "";
        sourceVersions = [];
        resetBundleSelection();
        setVersionControlsEnabled(false);
        populateVersionOptions();
    }
    sourceFilter.value = currentSourceUrl;
    sourcePicker.sync();
}

function populateBundleTypeOptions(preserveSelection = false) {
    const selectedType = currentBundleType;
    const types = new Set(latestBundles.map(bundle => bundle.bundleType).filter(Boolean));
    sourceVersions.forEach(bundle => {
        if (bundle.bundle_type) types.add(bundle.bundle_type);
    });

    if (preserveSelection && selectedType) types.add(selectedType);
    const options = [new Option("All types", "")];
    [...types].sort().forEach(type => options.push(new Option(bundleTypeLabel(type), type)));
    bundleTypeFilter.replaceChildren(...options);
    currentBundleType = types.has(selectedType) ? selectedType : "";
    bundleTypeFilter.value = currentBundleType;
    typePicker.sync();
}

function populateVersionOptions(preserveSelection = false) {
    const options = [new Option("All versions", "")];
    const versions = new Map();
    sourceVersions
        .filter(bundle => matchesReleaseFilter(transformBundle(bundle), currentFilter))
        .filter(bundle => !currentBundleType || bundle.bundle_type === currentBundleType)
        .forEach(bundle => {
            if (!versions.has(bundle.version)) versions.set(bundle.version, bundle.is_prerelease);
        });
    versions.forEach((isPrerelease, version) => {
        options.push(new Option(`${version} · ${isPrerelease ? "Prerelease" : "Release"}`, version));
    });

    if (preserveSelection && currentBundleVersion && !versions.has(currentBundleVersion))
        options.push(new Option(currentBundleVersion, currentBundleVersion));
    bundleVersionFilter.replaceChildren(...options);
    bundleVersionFilter.value = currentBundleVersion;
    versionPicker.sync();
}

function setVersionControlsEnabled(enabled) {
    bundleVersionFilter.disabled = !enabled;
    versionPicker.sync();
}

function resetBundleSelection() {
    currentBundleVersion = "";
    bundleVersionFilter.value = "";
    versionPicker.sync();
    allBundles = latestBundles;
}

function installAvatarFallback(card, label) {
    const image = card.querySelector(".owner-avatar");
    if (!image) return;
    const initial = escapeHtml(label.trim()[0] || "?").toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#eee" width="100" height="100"/><text x="50" y="50" font-size="40" text-anchor="middle" dy=".3em" fill="#999">${initial}</text></svg>`;
    if (!image.getAttribute("src")) image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    const fallback = () => {
        image.closest(".owner-avatar-link, .release-entry-icon")?.classList.remove("bundle-icon");
        const owner = card.dataset.ownerAvatar;
        if (owner && image.src !== owner) {
            delete card.dataset.ownerAvatar;
            image.src = owner;
        } else {
            delete card.dataset.ownerAvatar;
            image.removeEventListener("error", fallback);
            image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        }
    };
    image.addEventListener("error", fallback);
}

function transformBundle(bundle) {
    const metadata = bundle.source?.source_metadatum || {};
    return {
        id: bundle.id, bundleType: bundle.bundle_type, createdAt: bundle.created_at,
        description: bundle.description, downloadUrl: bundle.download_url,
        signatureDownloadUrl: bundle.signature_download_url === "N/A" ? null : bundle.signature_download_url,
        isPrerelease: bundle.is_prerelease, isLatest: currentLatestIds.has(bundle.id), version: bundle.version,
        sourceUrl: bundle.source?.url || "",
        ownerName: metadata.owner_name || "", ownerAvatarUrl: bundleImages(bundle).owner_avatar_url || "",
        iconUrl: bundleImages(bundle).icon_url || "", unavailableReason: bundle.source?.unavailable_reason,
        repoName: metadata.repo_name || "", repoDescription: metadata.repo_description || "",
        repoStars: metadata.repo_stars,
        isRepoArchived: metadata.is_repo_archived, patches: [],
        patchCount: bundle.patch_count,
        appCount: new Set((bundle.packages || []).filter(Boolean)).size,
        hasPatches: bundle.patch_list_available, metadataStatus: bundle.metadata_status,
        metadataVersion: bundle.patch_metadata_version
    };
}

async function renderReleaseFeed(sequence) {
    const active = catalog, source = currentSourceUrl;
    const filters = JSON.stringify([source, currentBundleVersion, currentBundleType, currentFilter, currentSearchQuery]);
    const staleStatus = "Unable to refresh changelog history. Showing previous results.";
    const current = () => sequence === searchSequence && currentTab === "changelogs" &&
        catalog === active && currentSourceUrl === source;
    let rows;
    try {
        rows = await active.changelogBundles();
    } catch (error) {
        if (!current()) return;
        if (await recoverGeneration(error) || !current()) return;
        const keepResults = filters === displayedChangelogFilters && Boolean(releaseFeed.querySelector(".release-day, .changelog-calendar"));
        const previousRetry = releaseFeed.querySelector(".release-feed-retry");
        const retryFocused = previousRetry === document.activeElement;
        if (keepResults) previousRetry?.remove();
        else {
            displayedChangelogFilters = undefined;
            repaintChangelogs = undefined;
            releaseFeed.replaceChildren();
        }
        status.textContent = keepResults ? staleStatus : "Unable to load changelog history. Please try again.";
        const reload = document.createElement("button");
        reload.className = "admin-access release-more release-feed-retry";
        reload.id = "release-feed-retry";
        reload.type = "button";
        reload.textContent = "Retry loading changelogs";
        reload.addEventListener("click", () => { void renderFilteredBundles({ resetScroll: false }); });
        if (keepResults) releaseFeed.prepend(reload);
        else releaseFeed.append(reload);
        if (retryFocused) reload.focus({ preventScroll: true });
        return;
    }
    if (!current()) return;
    const matching = rows.filter(row =>
        (!source || row.source.url === source) &&
        (!currentBundleVersion || row.version === currentBundleVersion) &&
        (!currentBundleType || row.bundle_type === currentBundleType) &&
        matchesReleaseFilter({ isLatest: currentLatestIds.has(row.id), isPrerelease: row.is_prerelease }, currentFilter) &&
        (!currentSearchQuery || [sourceOptionLabel({
            sourceUrl: row.source.url,
            ownerName: row.source.source_metadatum?.owner_name,
            repoName: row.source.source_metadatum?.repo_name
        }), row.source.url, row.version, bundleTypeLabel(row.bundle_type)]
            .join(" ").toLowerCase().includes(currentSearchQuery))
    ).map(row => ({ row, timestamp: releaseTimestamp(row.created_at) }))
        .sort((a, b) => b.timestamp - a.timestamp ||
            a.row.source.url.localeCompare(b.row.source.url) || a.row.id.localeCompare(b.row.id));
    const dayFormat = new Intl.DateTimeFormat(undefined,
        { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
    const byDay = new Map();
    for (const release of matching) {
        const day = Number.isFinite(release.timestamp) ? localDayKey(new Date(release.timestamp)) : "unknown";
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(release);
    }
    const renderEntry = ({ row, timestamp }) => renderReleaseEntry(transformBundle(row),
        Number.isFinite(timestamp) ? { iso: new Date(timestamp).toISOString(), label: timeFormat.format(timestamp) } : null);

    const paint = ({ preserveRetry = false } = {}) => {
        displayedChangelogFilters = filters;
        const focus = document.activeElement;
        const focusedId = releaseFeed.contains(focus) ? focus.id : "";
        const focusedDayId = focusedId && focus.closest(".release-day")?.firstElementChild.id;
        const retry = preserveRetry && releaseFeed.querySelector(".release-feed-retry");
        if (retry) releaseFeed.replaceChildren(retry);
        else releaseFeed.replaceChildren();

        const total = countLabel(matching.length, "changelog");
        const updateStatus = count => {
            status.textContent = !byDay.size ? "No changelogs match the selected filters." :
                releaseFeed.querySelector(".release-feed-retry") ? `${staleStatus} ${count}` : count;
            resetFilters.hidden = byDay.size > 0;
        };
        const calendar = browsePreferences.changelogCalendar &&
            renderChangelogCalendar(releaseFeed, byDay, { state: changelogCalendarState, dayFormat, renderEntry });
        if (calendar) {
            if (byDay.has("unknown")) releaseFeed.append(renderReleaseDay("unknown", byDay.get("unknown"), dayFormat, renderEntry));
            updateStatus(total);
        } else {
            const days = [...byDay];
            const more = document.createElement("button");
            more.className = "admin-access release-more";
            more.id = "release-feed-more";
            more.type = "button";
            more.textContent = "Show older days";
            let shown = 0;
            function appendDays(limit) {
                let firstNew;
                more.remove();
                while (shown < Math.min(limit, days.length)) {
                    const [day, releases] = days[shown++];
                    const group = renderReleaseDay(day, releases, dayFormat, renderEntry);
                    releaseFeed.append(group);
                    firstNew ??= group.firstElementChild;
                }
                updateStatus(`${total} · Showing ${shown.toLocaleString()} of ${countLabel(days.length, "day")}`);
                if (shown < days.length) releaseFeed.append(more);
                return firstNew;
            }
            more.addEventListener("click", () => {
                releaseFeedLimit += CHANGELOG_DAYS_PER_PAGE;
                const firstNew = appendDays(releaseFeedLimit);
                firstNew?.focus({ preventScroll: true });
                firstNew?.scrollIntoView({ block: "nearest" });
            });
            appendDays(releaseFeedLimit);
        }
        if (focusedId) {
            const target = document.getElementById(focusedId) || (focusedDayId && document.getElementById(focusedDayId)) ||
                releaseFeed.querySelector(".release-day > summary, .changelog-calendar-cell[aria-pressed='true']") ||
                (calendar ? calendarToggle : document.getElementById("changelogs-tab"));
            target.focus({ preventScroll: true });
        }
    };
    repaintChangelogs = paint;
    const monthPicker = releaseFeed.querySelector(".changelog-calendar .filter-popover");
    if (!monthPicker?.matches(":popover-open")) {
        paint();
        return;
    }
    // Let a viewer finish using the month picker before rebuilding its controls.
    function paintAfterMonthPickerCloses(event) {
        if (event.newState !== "closed") return;
        monthPicker.removeEventListener("toggle", paintAfterMonthPickerCloses);
        if (monthPicker.isConnected && current() && repaintChangelogs === paint) paint();
    }
    monthPicker.addEventListener("toggle", paintAfterMonthPickerCloses);
}

function localDayKey(date) {
    return [String(date.getFullYear()).padStart(4, "0"), String(date.getMonth() + 1).padStart(2, "0"),
        String(date.getDate()).padStart(2, "0")].join("-");
}

function relativeDayLabel(day) {
    const today = new Date();
    if (day === localDayKey(today)) return "Today";
    today.setDate(today.getDate() - 1);
    return day === localDayKey(today) ? "Yesterday" : "";
}

function renderReleaseDay(day, releases, dayFormat, renderEntry) {
    const group = document.createElement("details");
    group.className = "release-day";
    group.open = browsePreferences.isChangelogDayOpen(day);
    const summary = document.createElement("summary");
    summary.id = "changelog-day-" + day;
    const title = document.createElement("h2");
    if (day === "unknown") title.textContent = "Date unavailable";
    else {
        const date = document.createElement("time");
        date.dateTime = day;
        date.textContent = dayFormat.format(releases[0].timestamp);
        title.append(date);
        const relative = relativeDayLabel(day);
        if (relative) {
            const tag = document.createElement("span");
            tag.className = "release-day-relative";
            tag.textContent = relative;
            title.append(" ", tag);
        }
    }
    const count = document.createElement("span");
    count.className = "release-day-count";
    count.textContent = countLabel(releases.length, "changelog");
    summary.append(title, count);
    const entries = document.createElement("div");
    entries.className = "release-day-entries";
    function renderEntries() {
        if (group.open && !entries.hasChildNodes()) entries.append(...releases.map(renderEntry));
    }
    group.addEventListener("toggle", () => {
        if (!group.isConnected) return;
        browsePreferences.setChangelogDayOpen(day, group.open);
        renderEntries();
    });
    group.append(summary, entries);
    renderEntries();
    return group;
}

function renderReleaseEntry(bundle, time) {
    const entry = document.createElement("article");
    entry.className = "release-entry";
    const name = sourceOptionLabel(bundle);
    const icon = bundle.iconUrl || bundle.ownerAvatarUrl;
    if (bundle.ownerAvatarUrl && icon !== bundle.ownerAvatarUrl) entry.dataset.ownerAvatar = bundle.ownerAvatarUrl;
    entry.innerHTML = `<span class="release-entry-icon${icon !== bundle.ownerAvatarUrl ? " bundle-icon" : ""}">
            <img class="owner-avatar" src="${escapeHtml(icon)}" alt="" loading="lazy" decoding="async"></span>
        <div class="release-entry-title">
            <h3>${escapeHtml(name)}</h3>
            <div class="release-entry-meta">
                <strong>${escapeHtml(bundle.version)}</strong>
                <span class="bundle-badge ${bundle.isPrerelease ? "badge-prerelease" : "badge-release"}">${bundle.isPrerelease ? "Prerelease" : "Release"}</span>
                <span class="bundle-badge badge-type">${escapeHtml(bundleTypeLabel(bundle.bundleType))}</span>
                ${time ? `<time datetime="${time.iso}">${escapeHtml(time.label)}</time>` : ""}
            </div>
        </div>
        <button class="card-toggle" type="button" aria-haspopup="dialog"
            aria-label="Read changelog for ${escapeHtml(name + " " + bundle.version)}">Read changelog</button>`;
    installAvatarFallback(entry, name);
    const button = entry.querySelector("button");
    button.id = "read-changelog-" + bundle.id;
    button.addEventListener("click", () => {
        void detailsBrowser.openBundle(bundle, { section: "changelog" });
    });
    return entry;
}

function resetResultsScroll() {
    const top = status.getBoundingClientRect().top;
    if (top < 0) window.scrollBy(0, top);
}

async function renderFilteredBundles({ resetScroll = true, updateUrl = true, userAction = false } = {}) {
    saveBrowsePreferences({ updateUrl, userAction });
    if (!catalog) return;
    resetFilters.hidden = true;
    const sequence = ++searchSequence;
    if (currentTab === "changelogs") {
        if (resetScroll) releaseFeedLimit = CHANGELOG_DAYS_PER_PAGE;
        if (currentSourceUrl && bundleVersionFilter.disabled) return;
        if (!releaseFeed.hasChildNodes()) status.textContent = "Loading changelog history...";
        await renderReleaseFeed(sequence);
        if (resetScroll && sequence === searchSequence) resetResultsScroll();
        return;
    }
    if (currentTab === "apps") {
        try { renderFilteredApps(resetScroll); }
        catch (error) {
            filteredBundles = [];
            clearVirtualizer();
            status.textContent = "Search failed: " + error.message;
        }
        return;
    }
    const search = currentSearchQuery, packageQuery = currentPackageFilter;
    let patchMatches = new Map();
    if (search || packageQuery) {
        status.textContent = "Searching bundles and patches...";
        try {
            const candidates = allBundles.filter(bundle =>
                (!currentSourceUrl || bundle.sourceUrl === currentSourceUrl) &&
                (!currentBundleType || bundle.bundleType === currentBundleType) &&
                matchesReleaseFilter(bundle, currentFilter));
            const reseamBundles = candidates.filter(bundle => bundle.bundleType === "Reseam");
            const alias = !packageQuery && reseamBundles.length ? reseamInternalSearchAlias(search) : null;
            const queries = [{ q: packageQuery ? "" : search, ids: candidates.map(b => b.id), alias: false }];
            if (alias && alias !== search.toLowerCase())
                queries.push({ q: alias, ids: reseamBundles.map(b => b.id), alias: true });
            const seen = new Set();
            for (const request of queries) {
                // A different matching patch must not hide an internal Reseam
                // result whose readable name is absent from the search index.
                if (!request.ids.length) continue;
                let cursor = 0;
                do {
                    const page = await catalog.patchRows({ q: request.q, bundle_ids: request.ids,
                        page_cursor: cursor, include_unverified: true });
                    if (sequence !== searchSequence) return;
                    for (const patch of page.rows) {
                        if (packageQuery && !packageFilterMatches(patch.packages, packageQuery)) continue;
                        const transformed = transformPatch(patch);
                        if (request.alias && !patchDisplayName(transformed).toLowerCase()
                            .replace(/\s+/g, " ").includes(search.replace(/\s+/g, " "))) continue;
                        const key = `${patch.bundle_id}:${patch.id ?? patch.legacy_id ?? patch.name}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        if (!patchMatches.has(patch.bundle_id)) patchMatches.set(patch.bundle_id, []);
                        patchMatches.get(patch.bundle_id).push(transformed);
                    }
                    cursor = page.next_cursor;
                } while (cursor !== null);
            }
        } catch (error) {
            if (sequence === searchSequence && await recoverGeneration(error)) return;
            if (sequence === searchSequence) status.textContent = "Search failed: " + error.message;
            return;
        }
    }
    if (sequence !== searchSequence) return;
    const previousBundles = filteredBundles;
    filteredBundles = allBundles.filter(bundle => {
        if (!matchesReleaseFilter(bundle, currentFilter)) return false;
        if (currentSourceUrl && bundle.sourceUrl !== currentSourceUrl) return false;
        if (currentBundleVersion && bundle.version !== currentBundleVersion) return false;
        if (currentBundleType && bundle.bundleType !== currentBundleType) return false;
        const text = [bundle.sourceUrl, bundle.ownerName, bundle.repoName, bundle.repoDescription,
            bundle.version, bundle.description].filter(Boolean).join(" ").toLowerCase();
        const patchTextMatches = (patchMatches.get(bundle.id) || []).some(patch =>
            ((patch.name || "") + " " + (patch.description || "") + " " + patchDisplayName(patch))
                .toLowerCase().replace(/\s+/g, " ").includes(search.replace(/\s+/g, " ")));
        return (!search || text.includes(search) || patchTextMatches) &&
            (!packageQuery || patchMatches.has(bundle.id));
    }).map(bundle => patchMatches.has(bundle.id) ?
        { ...bundle, patches: patchMatches.get(bundle.id), filteredPatches: true } : bundle);
    if (!filteredBundles.length) {
        clearVirtualizer();
        status.textContent = "No bundles match the selected filters.";
        resetFilters.hidden = false;
        return;
    }
    if (resetScroll) resetResultsScroll();
    if (!resetScroll && virtualizer && lastColumns === layoutColumns() &&
        previousBundles.length === filteredBundles.length &&
        previousBundles.every((bundle, index) => bundle.id === filteredBundles[index].id)) {
        // Progress-only snapshots keep the same rows. Retain their measurements
        // so refreshing card contents does not move the reader to another row.
        rowData = buildRows();
        for (const [index, row] of renderedRows) {
            if (row.contains(document.activeElement) || row.querySelector(".card-selected")) continue;
            row.remove();
            renderedRows.delete(index);
        }
        renderVisible();
    } else setupVirtualizer();
    updateStatus();
}

function renderFilteredApps(resetScroll) {
    const bundles = summaries.filter(bundle =>
        (!currentSourceUrl || bundle.source.url === currentSourceUrl) &&
        (!currentBundleType || bundle.bundle_type === currentBundleType) &&
        matchesReleaseFilter(transformBundle(bundle), currentFilter));
    filteredBundles = filterApps(applications, bundles, {
        q: currentSearchQuery, packageQuery: currentPackageFilter
    });
    if (!filteredBundles.length) {
        clearVirtualizer();
        status.textContent = "No apps match the selected filters.";
        resetFilters.hidden = false;
        return;
    }
    if (resetScroll) resetResultsScroll();
    setupVirtualizer();
    updateStatus();
}

function renderApp(app, target) {
    const card = document.createElement("article");
    card.className = "bundle-item app-item";
    card.innerHTML = `<div class="bundle-header">
        <span class="owner-avatar-link app-icon"><img class="owner-avatar" src="${escapeHtml(app.icon_url || "")}"
            alt="" loading="lazy" decoding="async"></span>
        <div class="bundle-header-content">
            <h2 class="app-name">${escapeHtml(app.app_name)}</h2>
            <div class="app-package">${escapeHtml(app.package_name)}</div>
        </div></div>
        <p class="app-counts">${app.patch_count == null ? "Patch count unavailable" : countLabel(app.patch_count, "patch", "patches")} · ${countLabel(app.bundle_count, "bundle")}</p>
        <p class="app-versions">${app.unrestricted ? "Includes patches for all versions" : app.versions.length ?
            (app.versions.length === 1 ? "Version: " : "Versions: ") + escapeHtml(app.versions.join(", ")) : "Version information unavailable"}</p>
        ${app.bundles.some(reference => reference.compatibility_unknown) ?
            '<p class="metadata-note">Compatibility details are not available in this catalog yet.</p>' :
            app.bundles.some(reference => reference.metadata_status !== "verified") ?
            '<div class="v3-warning">Some bundle compatibility metadata is unverified.</div>' : ""}
        <button class="card-toggle card-details" type="button" aria-haspopup="dialog" aria-label="View bundles for ${escapeHtml(app.app_name)}">View bundles</button>
`;
    target.appendChild(card);
    installAvatarFallback(card, app.app_name);
    detailsBrowser.activateCard(card, () => detailsBrowser.openApp(app));
}

function renderStats() {
    const target = statsPanel;
    const historical = historicalCatalogStats(summaries, catalog?.manifest);
    const stats = catalogStats(summaries);

    if (!target.querySelector(".stat-banner")) {
        const banner = `<div class="stat-card stat-banner">
            <div class="stat-banner-content">
                <h2>All releases</h2>
                <p class="stat-banner-subtitle">Across all versions and runtimes</p>
            </div>
            <dl class="stat-banner-metrics">
                <div class="stat-metric">
                    <dt>Bundle releases</dt>
                    <dd data-stat="historical-bundles">0</dd>
                </div>
                <div class="stat-metric">
                    <dt>Total patches</dt>
                    <dd data-stat="historical-patches">0</dd>
                </div>
            </dl>
        </div>`;
        const cards = Object.entries(stats).map(([name]) => {
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
            return `<div class="stat-card">
                <h2>${escapeHtml(name)}</h2>
                <dl>
                    <div class="stat-metric">
                        <dt>Bundles</dt>
                        <dd data-stat="${slug}-bundles">0</dd>
                    </div>
                    <div class="stat-metric">
                        <dt>Patches</dt>
                        <dd data-stat="${slug}-patches">0</dd>
                    </div>
                </dl>
            </div>`;
        }).join("");
        target.innerHTML = banner + `<details class="runtime-statistics" ${matchMedia("(min-width: 701px)").matches ? "open" : ""}>
            <summary>Latest release totals</summary>
            <div class="runtime-stats-grid">${cards}</div>
            <p class="stats-note">Newest release per source, including prereleases. Patch totals use available metadata.</p>
        </details>`;
    }

    animateStatNumber(target.querySelector('[data-stat="historical-bundles"]'), historical.bundles);
    animateStatNumber(target.querySelector('[data-stat="historical-patches"]'), historical.patches);
    for (const [name, values] of Object.entries(stats)) {
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        animateStatNumber(target.querySelector(`[data-stat="${slug}-bundles"]`), values.bundles);
        animateStatNumber(target.querySelector(`[data-stat="${slug}-patches"]`), values.patches);
    }
}

function animateStatNumber(element, targetValue, duration = 1200) {
    if (!element) return;
    const target = Math.max(0, Number(targetValue) || 0);
    const start = element._currentValue !== undefined ? element._currentValue : 0;

    if (element._animationFrame) {
        cancelAnimationFrame(element._animationFrame);
        element._animationFrame = null;
    }
    if (element._popTimeout) {
        clearTimeout(element._popTimeout);
        element._popTimeout = null;
    }
    element.classList.remove("turning", "turn-complete");

    if (start === target) {
        element._currentValue = target;
        element.textContent = target.toLocaleString();
        return;
    }

    if (typeof requestAnimationFrame === "undefined" ||
        (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches)) {
        element._currentValue = target;
        element.textContent = target.toLocaleString();
        return;
    }

    element.classList.add("turning");
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const ease = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + (target - start) * ease);
        element._currentValue = current;
        element.textContent = current.toLocaleString();

        if (progress < 1) {
            element._animationFrame = requestAnimationFrame(step);
        } else {
            element._currentValue = target;
            element.textContent = target.toLocaleString();
            element._animationFrame = null;
            element.classList.remove("turning");
            element.classList.add("turn-complete");
            element._popTimeout = setTimeout(() => {
                element.classList.remove("turn-complete");
                element._popTimeout = null;
            }, 500);
        }
    }

    element._animationFrame = requestAnimationFrame(step);
}

function updateStatus() {
    const count = filteredBundles.length;
    if (count > 0) {
        status.textContent = `Showing ${count} ${currentTab === "apps" ? "app" : "bundle"}${count === 1 ? "" : "s"}`;
    }
}

function renderBundle(bundle, target) {
    const card = document.createElement("article");
    card.className = "bundle-item";

    if (bundle.ownerAvatarUrl && bundle.iconUrl !== bundle.ownerAvatarUrl)
        card.dataset.ownerAvatar = bundle.ownerAvatarUrl;
    const availabilityWarning = bundle.unavailableReason
        ? `<div class="v3-warning">Repository unavailable: ${escapeHtml(bundle.unavailableReason)}. Showing retained release information.</div>` : "";
    const metadataWarning = bundle.metadataStatus !== "verified"
        ? `<div class="v3-warning">Patch metadata: ${escapeHtml(bundle.metadataStatus)}${bundle.metadataVersion ? " · " + escapeHtml(bundle.metadataVersion) : ""}. Compatibility is unverified for this artifact.</div>` : "";
    const tagUrl = releaseTagUrl(bundle);
    const versionHtml = tagUrl
        ? `<a class="version-text" href="${escapeHtml(tagUrl)}" target="_blank" rel="noopener">${escapeHtml(bundle.version)}</a>`
        : `<span class="version-text">${escapeHtml(bundle.version)}</span>`;

    const { tracked: trackedName } = repositoryNames(bundle);
    const repoLinkText = escapeHtml(trackedName);
    const stars = bundle.repoStars == null ? null : bundle.repoStars.toLocaleString();

    const copyLabel = currentBundleVersion || bundle.pinVersion ? "Copy this version URL" : "Copy remote bundle URL";
    const pinImport = Boolean(currentBundleVersion) || bundle.pinVersion;
    const registryUrl = new URL(bundleImportPath(bundle, pinImport), siteConfig.api).href;
    const showChangelog = Boolean(bundle.description || currentBundleVersion);
    card.innerHTML = `
        <div class="bundle-actions" aria-label="Bundle actions">
            ${bundle.downloadUrl ? iconAction("download", "Download bundle", escapeHtml, {href: bundle.downloadUrl}) : ""}
            ${bundle.signatureDownloadUrl ? iconAction("signature", "Download signature", escapeHtml, {href: bundle.signatureDownloadUrl}) : ""}
            ${bundle.bundleType === "Reseam"
                ? importFormatAction(escapeHtml, registryUrl,
                    new URL(reseamNativeImportPath(bundle, pinImport), siteConfig.api).href,
                    bundle.metadataStatus !== "verified")
                : iconAction("link", copyLabel, escapeHtml, {copy: registryUrl})}
        </div>
        ${metadataWarning}
        ${availabilityWarning}

        <div class="bundle-header">
            <a href="${escapeHtml(bundle.sourceUrl)}" target="_blank" rel="noopener" class="owner-avatar-link${bundle.iconUrl && bundle.iconUrl !== bundle.ownerAvatarUrl ? " bundle-icon" : ""}" aria-label="Open ${escapeHtml(bundle.ownerName || 'source')} repository">
                <img src="${escapeHtml(bundle.iconUrl)}"
                     alt="${escapeHtml(bundle.ownerName)}"
                     class="owner-avatar"
                     loading="lazy"
                     decoding="async">
            </a>
            <div class="bundle-header-content">
                <div class="repo-info">
                    <a href="${escapeHtml(bundle.sourceUrl)}" target="_blank" rel="noopener" class="repo-name">
                        ${repoLinkText}
                    </a>
                    ${stars == null ? "" : `<span class="repo-popularity" title="${stars} stars">
                        <span aria-hidden="true">★</span>${stars}<span class="visually-hidden"> stars</span></span>`}
                </div>
                ${bundle.repoDescription ? `<div class="bundle-description">${cachedMarkdown(bundle.id, 'desc', bundle.repoDescription)}</div>` : ''}
                <div class="bundle-version">
                    ${versionHtml}
                    ${bundle.isLatest ? '<span class="bundle-badge badge-latest">Latest</span>' : ''}
                    <span class="bundle-badge ${bundle.isPrerelease ? 'badge-prerelease' : 'badge-release'}">
                        ${bundle.isPrerelease ? 'Prerelease' : 'Release'}
                    </span>
                    <span class="bundle-badge badge-type">${escapeHtml(bundleTypeLabel(bundle.bundleType))}</span>
                    ${bundle.isRepoArchived ? `<span class="bundle-badge badge-archived">Archived</span>` : ''}
                    <span class="created-date">${formatDate(bundle.createdAt)}</span>
                </div>
            </div>
        </div>

        <p class="card-hint">${bundle.hasPatches ? countLabel(bundle.patchCount ?? 0, "patch", "patches") : "Patch metadata unavailable"} · ${countLabel(bundle.appCount ?? 0, "app")}</p>
        <div class="card-toggles">
            <button class="card-toggle card-details" type="button" aria-haspopup="dialog" aria-label="View patches for ${repoLinkText} ${escapeHtml(bundle.version)}">View patches</button>
            ${showChangelog ? `<button class="card-toggle" type="button" data-toggle-changelog aria-expanded="false"
                    aria-controls="changelog-${escapeHtml(bundle.id)}">Show changelog</button>` : ""}
        </div>
        ${showChangelog ? `<div class="changelog-preview" id="changelog-${escapeHtml(bundle.id)}" hidden>
                <div class="changelog-content" data-changelog-preview tabindex="0"
                    role="region" aria-label="Changelog preview for ${repoLinkText}"></div>
                <div class="changelog-preview-actions">
                    <button class="card-toggle changelog-expand" type="button" data-expand-changelog
                        aria-haspopup="dialog" aria-label="Expand changelog for ${repoLinkText}">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7"/></svg>
                        Expand
                    </button>
                </div>
            </div>
        ` : ''}
    `;

    installAvatarFallback(card, bundle.ownerName || trackedName);
    target.appendChild(card);

    bindActions(card);

    const changelogButton = card.querySelector("[data-toggle-changelog]");
    const preview = card.querySelector(".changelog-preview");
    const changelogContent = card.querySelector("[data-changelog-preview]");
    if (changelogButton && preview && changelogContent) {
        let state = changelogViews.get(bundle.id);
        if (!state) {
            if (changelogViews.size >= RENDER_CACHE_LIMIT)
                changelogViews.delete(changelogViews.keys().next().value);
            state = { expanded: false, scrollTop: 0 };
            changelogViews.set(bundle.id, state);
        }
        let pending, ready = false;
        const setExpanded = expanded => {
            if (!expanded && state.expanded && ready)
                state.scrollTop = changelogContent.scrollTop;
            state.expanded = expanded;
            preview.hidden = !expanded;
            changelogButton.setAttribute("aria-expanded", String(expanded));
            changelogButton.textContent = expanded ? "Hide changelog" : "Show changelog";
            if (!expanded) return;
            if (ready) { changelogContent.scrollTop = state.scrollTop; return; }
            if (pending) return;
            changelogContent.innerHTML = '<p role="status">Loading changelog...</p>';
            pending = bundleChangelog(bundle).then(description => {
                if (!changelogContent.isConnected) return;
                changelogContent.innerHTML = description
                    ? cachedMarkdown(bundle.id, "full-changelog", description)
                    : '<p role="status">No changelog was provided for this release.</p>';
                ready = true;
                if (state.expanded) changelogContent.scrollTop = state.scrollTop;
            }).catch(error => {
                pending = null;
                if (changelogContent.isConnected)
                    changelogContent.textContent = "Unable to load changelog: " + error.message;
            });
        };
        changelogButton.addEventListener("click", () => setExpanded(!state.expanded));
        changelogContent.addEventListener("scroll", () => {
            if (ready && state.expanded && changelogContent.isConnected)
                state.scrollTop = changelogContent.scrollTop;
        }, { passive: true });
        card.querySelector("[data-expand-changelog]").addEventListener("click", () => {
            void detailsBrowser.openBundle(bundle, { section: "changelog" });
        });
        setExpanded(state.expanded);
    }

    detailsBrowser.activateCard(card, () => detailsBrowser.openBundle(bundle));
}

function renderPatch(patch) {
    const packages = (patch.compatiblePackages || []).map(pkg => {
        const versions = pkg.versions?.filter(Boolean) || [];
        const packageId = escapeHtml(pkg.name).replaceAll(".", ".<wbr>");
        const distinctName = pkg.appName && pkg.appName !== pkg.name;
        return `<span class="package-tag">
            <span class="package-identity">
                <span class="package-name">${distinctName ? escapeHtml(pkg.appName) : packageId}</span>
                ${distinctName ? `<span class="package-id">${packageId}</span>` : ""}
            </span>
            ${versions.length ? `<span class="package-versions" role="list" aria-label="Compatible versions">
                ${versions.map(version => `<span class="package-version" role="listitem">${escapeHtml(version)}</span>`).join(" ")}
            </span>` : '<span class="package-version">All versions</span>'}
        </span>`;
    }).join('');

    const heading = escapeHtml(patchDisplayName(patch)) +
        (patch.hidden ? ' <span class="badge">Internal patch</span>' : "");
    const description = formatPatchDescription(patch.description);
    const overview = `${description ? `<span class="patch-description">${escapeHtml(description)}</span>` : ""}
        ${packages ? `<span class="patch-packages">${packages}</span>` : ""}`;
    const options = renderPatchOptions(patch.options, escapeHtml, heading, overview);
    return `<div class="patch-item">${options || `<div class="patch-name">${heading}</div>${overview}`}</div>`;
}

function sourceName(sourceUrl, ownerName, repoName) {
    try {
        const path = new URL(sourceUrl).pathname.replace(/^\/+|\/+$/g, '');
        return path || [ownerName, repoName].filter(Boolean).join('/');
    } catch {
        return [ownerName, repoName].filter(Boolean).join('/') || sourceUrl;
    }
}

function releaseTagUrl(bundle) {
    try {
        const source = new URL(bundle.sourceUrl);
        const repositoryUrl = `${source.origin}${source.pathname.replace(/\/+$/, '')}`;
        const tag = encodeURIComponent(bundle.version);

        if (gitHosts[source.host] === 'gitlab') {
            return `${repositoryUrl}/-/releases/${tag}`;
        }
        if (['github', 'gitea'].includes(gitHosts[source.host])) {
            return `${repositoryUrl}/releases/tag/${tag}`;
        }

        const download = new URL(bundle.downloadUrl);
        const downloadPrefix = `${source.pathname.replace(/\/+$/, '')}/releases/download/`;
        if (download.origin === source.origin && download.pathname.startsWith(downloadPrefix)) {
            const downloadedTag = download.pathname.slice(downloadPrefix.length).split('/')[0];
            if (downloadedTag) return `${repositoryUrl}/releases/tag/${downloadedTag}`;
        }
    } catch {
        // Keep the version as plain text when the API URLs cannot identify a release page.
    }

    return null;
}

function debounce(callback, delay) {
    let timeout;
    return () => {
        clearTimeout(timeout);
        timeout = setTimeout(callback, delay);
    };
}

function escapeHtml(text) {
    return String(text ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function renderMarkdown(text) {
    if (!text) return "";
    if (!globalThis.marked?.parse || !globalThis.DOMPurify?.sanitize)
        return escapeHtml(text).replace(/\r?\n/g, "<br>");
    return DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
}

function formatDate(dateString) {
    try {
        if (!dateString) return "";
        const date = new Date(releaseTimestamp(dateString));
        if (Number.isNaN(date.getTime())) return "";
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 60) {
            return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        } else if (diffHours < 24) {
            return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        } else if (diffDays < 7) {
            return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        } else {
            return date.toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        }
    } catch (e) {
        return dateString;
    }
}
