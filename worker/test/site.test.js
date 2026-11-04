import test from "node:test";
import { importFormatAction } from "../../shared/actions.js";
import { reseamNativeImportPath } from "../../shared/catalog.js";
import assert from "node:assert/strict";
import {
  latestReleaseIds, catalogStats, historicalCatalogStats, patchMatchesSearch, repositoryNames, matchesReleaseFilter, countLabel
} from "../../shared/site.js";

test("Latest selects one overall release per source without changing category latest", () => {
  const bundles = [
    { id: "stable", source_id: "a", is_latest: true, created_at: "2026-10-08T00:00:00Z" },
    { id: "preview", source_id: "a", is_latest: true, is_prerelease: true, created_at: "2026-10-09T00:00:00Z" },
    { id: "old", source_id: "a", is_latest: false, created_at: "2026-10-01T00:00:00Z" },
    { id: "other", source_id: "b", is_latest: true, created_at: "2026-10-01T00:00:00Z" },
  ];
  assert.deepEqual([...latestReleaseIds(bundles)].sort(), ["other", "preview"]);
  assert.equal(bundles.filter(bundle => bundle.is_latest).length, 3);
  assert.equal(matchesReleaseFilter({ isLatest: true, isPrerelease: true }, "latest"), true);
  assert.equal(matchesReleaseFilter({ isLatest: false, isPrerelease: false }, "latest"), false);
  assert.equal(matchesReleaseFilter({ isLatest: true, isPrerelease: true }, "release"), false);
});

test("Latest uses the latest channel for equal release dates", () => {
  assert.deepEqual([...latestReleaseIds([
    { id: "stable", source_id: "a", is_latest: true, created_at: "2026-10-08", channels: ["stable"] },
    { id: "preview", source_id: "a", is_latest: true, created_at: "2026-10-08", channels: ["latest", "dev"] },
  ])], ["preview"]);
});

test("Statistics count only one newest release per source across history", () => {
  const stats = catalogStats([
    {id:"a1", source_id:"a", is_latest:true, created_at:"2026-01-01", bundle_type:"ReVanced:v21", patch_count:3},
    {id:"a2", source_id:"a", is_latest:true, created_at:"2026-01-02", bundle_type:"Morphe:V1", patch_count:8},
    {id:"a0", source_id:"a", is_latest:false, created_at:"2025-01-01", bundle_type:"ReVanced:v21", patch_count:999},
    {id:"b1", source_id:"b", is_latest:true, created_at:"2026-01-01", bundle_type:"ReVanced:v22", patch_count:5},
    {id:"c1", source_id:"c", is_latest:true, created_at:"2026-01-01", bundle_type:"Reseam", patch_count:4},
  ]);
  assert.deepEqual(stats["All bundles"], {bundles:3, patches:17});
  assert.deepEqual(stats.ReVanced, {bundles:1, patches:5});
  assert.deepEqual(stats.Morphe, {bundles:1, patches:8});
  assert.deepEqual(stats.Reseam, {bundles:1, patches:4});
});

test("Historical statistics count all historical bundle releases and patches across all runtimes", () => {
  const bundles = [
    {id:"a1", source_id:"a", is_latest:true, created_at:"2026-01-01", bundle_type:"ReVanced:v21", patch_count:3},
    {id:"a2", source_id:"a", is_latest:true, created_at:"2026-01-02", bundle_type:"Morphe:V1", patch_count:8},
    {id:"a0", source_id:"a", is_latest:false, created_at:"2025-01-01", bundle_type:"ReVanced:v21", patch_count:999},
    {id:"b1", source_id:"b", is_latest:true, created_at:"2026-01-01", bundle_type:"ReVanced:v22", patch_count:5},
    {id:"c1", source_id:"c", is_latest:true, created_at:"2026-01-01", bundle_type:"Reseam", patch_count:4},
  ];
  assert.deepEqual(historicalCatalogStats(bundles), {bundles: 5, patches: 1019});
  assert.deepEqual(historicalCatalogStats(bundles, { counts: { bundles: 18, patches: 450 } }), {bundles: 18, patches: 450});
  assert.deepEqual(historicalCatalogStats([]), {bundles: 0, patches: 0});
  assert.deepEqual(historicalCatalogStats(null), {bundles: 0, patches: 0});
});

test("Patch search combines names, descriptions, package names, and version fragments", () => {
  const patch = {
    name: "Hide Ads", description: "Remove video advertisements",
    compatiblePackages: [{ name: "com.google.android.youtube", versions: ["19.16.39"] }]
  };
  for (const query of ["hide", "VIDEO", "com.google", "19.16", "youtube 19.16 ads", "  "]) {
    assert.equal(patchMatchesSearch(patch, query), true, query);
  }
  assert.equal(patchMatchesSearch(patch, "youtube 20.0"), false);
  assert.equal(patchMatchesSearch({ name: null, description: null }, "ads"), false);
});

test("Repository labels suppress case-only duplicates and retain actual renames", () => {
  const source = { sourceUrl: "https://github.com/morpheapp/morphe-patches",
    ownerName: "MorpheApp", repoName: "morphe-patches" };
  assert.deepEqual(repositoryNames(source), {
    tracked: "MorpheApp/morphe-patches", renamed: ""
  });
  assert.deepEqual(repositoryNames({ ...source, repoName: "new-patches" }), {tracked:"MorpheApp/new-patches",renamed:""});
  assert.equal(repositoryNames({ sourceUrl: "https://gitlab.com/team/subgroup/patches" }).tracked, "team/subgroup/patches");
});

// Exercise the real card event handlers without a browser or network requests.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { iconAction } from "../../shared/actions.js";

function cardHarness(bundleType = "ReVanced:v21", overrides = {}, fetchChangelog = async () => "Full release notes") {
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const functionSource = source.slice(source.indexOf("function renderBundle("),
    source.indexOf("\nfunction renderPatch"));
  const cards = [], opened = [], reads = [], markdown = [];

  function element() {
    return Object.assign(new EventTarget(), {
      dataset: {}, hidden: false, isConnected: true, scrollTop: 0, value: "",
      innerHTML: "", textContent: "", attrs: {}, setAttribute(key, value) { this.attrs[key] = value; },
      classList: { toggle() {}, remove() {} },
      hasChildNodes() { return Boolean(this.innerHTML || this.textContent); }
    });
  }

  const document = {
    createElement() {
      const card = element();
      const selectors = [".copy-btn", ...(overrides.description ?
        ["[data-toggle-changelog]", ".changelog-preview", "[data-changelog-preview]", "[data-expand-changelog]"] : [])];
      card.elements = Object.fromEntries(selectors.map(selector => [selector, element()]));
      card.elements[".copy-btn"].textContent = "Copy remote bundle URL";
      card.querySelector = selector => card.elements[selector] || null;
      cards.push(card);
      return card;
    }
  };
  const context = {
    iconAction, importFormatAction, reseamNativeImportPath,
    bindActions() {}, URL, siteConfig:{api:"https://api.test"},
    document, detailsBrowser:{activateCard(card,fn){card.openDetails=fn;},openBundle(...args){opened.push(args);}}, escapeHtml: value => String(value || ""), repositoryNames,
    releaseTagUrl: () => "", bundleTypeLabel: type => type,
    formatDate: () => "", bundleImportPath: () => "/v3/bundle",
    currentBundleVersion: "", cachedMarkdown: (id, key, value) => { markdown.push(value); return "Rendered: " + value; },
    changelogViews: new Map(), RENDER_CACHE_LIMIT: 500,
    bundleChangelog: bundle => { reads.push(bundle.id); return fetchChangelog(bundle); },
    installAvatarFallback() {}, countLabel,
    setTimeout, clearTimeout
  };
  runInNewContext(functionSource, context);
  const bundle = {
    id: "bundle", sourceUrl: "https://github.com/team/patches", ownerName: "team",
    repoName: "patches", iconUrl: "https://img.test/custom.png",
    ownerAvatarUrl: "https://img.test/owner.png", repoStars: 20,
    version: "1", bundleType, isLatest: true,
    hasPatches: true, patchCount: 2, metadataStatus: "verified", ...overrides
  };
  return {
    opened, bundle, reads, markdown,
    render: () => {
      cards.forEach(card => Object.values(card.elements).forEach(node => { node.isConnected = false; }));
      context.renderBundle(bundle, { appendChild() {} });
      return cards.at(-1);
    }
  };
}

test("Bundle cards open details without an inline patch button or URV warning banner", () => {
  const card = cardHarness().render();
  assert.match(card.innerHTML, /badge-latest[^]*?Latest/);
  assert.match(card.innerHTML, /owner-avatar-link bundle-icon/);
  assert.doesNotMatch(card.innerHTML, /Requires the ReVanced v21 runtime plugin/);
  assert.doesNotMatch(card.innerHTML, /data-toggle-patches|data-patch-search/);
  assert.equal(typeof card.openDetails, "function");
});

test("Reseam cards do not render URV runtime warning", () => {
  const card = cardHarness("Reseam").render();
  assert.doesNotMatch(card.innerHTML, /Requires the Reseam runtime plugin in order to be used in URV/);
  assert.doesNotMatch(card.innerHTML, /Requires the ReVanced v21/);
});

test("Show changelog toggles a lazy inline preview and Expand opens the popup", async () => {
  const harness = cardHarness("Morphe:V1", {description:"Summary notes"});
  const card = harness.render();
  const button = card.elements["[data-toggle-changelog]"];
  const preview = card.elements[".changelog-preview"];
  const content = card.elements["[data-changelog-preview]"];
  assert.equal(preview.hidden, true);
  assert.equal(button.attrs["aria-expanded"], "false");
  assert.equal(harness.reads.length, 0);
  button.dispatchEvent(new Event("click"));
  await new Promise(done => setImmediate(done));
  assert.equal(preview.hidden, false);
  assert.equal(button.attrs["aria-expanded"], "true");
  assert.equal(button.textContent, "Hide changelog");
  assert.equal(content.innerHTML, "Rendered: Full release notes");
  assert.deepEqual(harness.markdown, ["Full release notes"]);
  assert.equal(harness.opened.length, 0);
  card.elements["[data-expand-changelog]"].dispatchEvent(new Event("click"));
  assert.equal(harness.opened[0][0], harness.bundle);
  assert.equal(harness.opened[0][1].section, "changelog");
  button.dispatchEvent(new Event("click"));
  assert.equal(preview.hidden, true);
  assert.equal(button.textContent, "Show changelog");
  button.dispatchEvent(new Event("click"));
  assert.equal(harness.reads.length, 1);
  card.openDetails();
  assert.equal(harness.opened[1][1], undefined);
});

test("Inline changelog preserves expansion and scroll across virtualized cards", async () => {
  const harness = cardHarness("Morphe:V1", {description:"Release notes"});
  const card = harness.render(), button = card.elements["[data-toggle-changelog]"];
  const content = card.elements["[data-changelog-preview]"];
  button.dispatchEvent(new Event("click"));
  await new Promise(done => setImmediate(done));
  content.scrollTop = 72;
  content.dispatchEvent(new Event("scroll"));
  button.dispatchEvent(new Event("click"));
  content.scrollTop = 0;
  content.dispatchEvent(new Event("scroll"));
  button.dispatchEvent(new Event("click"));
  assert.equal(content.scrollTop, 72);
  const remounted = harness.render();
  const remountedContent = remounted.elements["[data-changelog-preview]"];
  remountedContent.dispatchEvent(new Event("scroll"));
  content.scrollTop = 0;
  content.dispatchEvent(new Event("scroll"));
  await new Promise(done => setImmediate(done));
  assert.equal(remounted.elements[".changelog-preview"].hidden, false);
  assert.equal(remountedContent.scrollTop, 72);
});

test("Inline changelog retries failed loading when reopened", async () => {
  let attempts = 0;
  const harness = cardHarness("Morphe:V1", {description:"Release notes"}, async () => {
    if (++attempts === 1) throw new Error("Temporary failure");
    return "Recovered release notes";
  });
  const card = harness.render(), button = card.elements["[data-toggle-changelog]"];
  const content = card.elements["[data-changelog-preview]"];
  button.dispatchEvent(new Event("click"));
  await new Promise(done => setImmediate(done));
  assert.match(content.textContent, /Unable to load changelog: Temporary failure/);
  button.dispatchEvent(new Event("click"));
  button.dispatchEvent(new Event("click"));
  await new Promise(done => setImmediate(done));
  assert.equal(content.innerHTML, "Rendered: Recovered release notes");
  assert.equal(attempts, 2);
});

test("Bundle cards show app counts and compact labeled actions", () => {
  const card = cardHarness("Morphe:V1",{appCount:1}).render();
  assert.match(card.innerHTML,/2 patches · 1 app/);
  assert.match(card.innerHTML,/class="bundle-actions"/);
  assert.match(card.innerHTML,/aria-label="Download bundle"/);
  assert.match(card.innerHTML,/aria-label="Copy remote bundle URL"/);
  assert.doesNotMatch(card.innerHTML,/Explore apps and patch options/);
});
