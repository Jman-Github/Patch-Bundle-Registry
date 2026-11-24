import assert from "node:assert/strict";
import test from "node:test";
import { readSiteRoute, siteRouteUrl, createSiteNavigation } from "../../shared/site-navigation.js";

const base = "https://example.test/catalog/?utm_source=shared#top";
const browse = { search: "Hide ads & branding", package: "com.video@1.0",
    source: "https://git.example/team/repo", version: "v1+test", type: "Morphe:V1",
    release: "all", grid: false };
test("Changelogs default to all releases and share explicit channel filters", () => {
    assert.equal(readSiteRoute(base.replace("utm_source=shared", "tab=changelogs")).browse.release, "all");
    const latest = siteRouteUrl(base, { tab: "changelogs", browse: { release: "latest" } });
    assert.equal(latest.searchParams.get("release"), "latest");
    assert.equal(readSiteRoute(latest).browse.release, "latest");
    assert.equal(siteRouteUrl(latest, { tab: "changelogs", browse: { release: "all" } }).searchParams.has("release"), false);
});

test("Comparison share links preserve changelog filters and the selected baseline", () => {
    const route = {
        tab:"changelogs", browse:{ search:"morphe", package:"", source:"https://github.com/a/b",
            version:"v2", type:"Morphe:V1", release:"all", grid:true },
        detail:{ kind:"bundle", id:"ab", source:"https://github.com/a/b", version:"v2", section:"compare", baseline:"a1" }
    };
    assert.deepEqual(readSiteRoute(siteRouteUrl("https://example.test/", route)), route);
    assert.equal(readSiteRoute("https://example.test/?bundle=ab&section=compare&baseline=invalid").detail.baseline, undefined);
});

test("Share URLs round-trip bundle versions, details sections and all browse filters", () => {
    const route = { tab: "bundles", browse, detail: { kind: "bundle", id: "a".repeat(24),
        source: browse.source, version: "v1+test", section: "changelog" } };
    const url = siteRouteUrl(base, route);
    assert.equal(url.pathname, "/catalog/");
    assert.equal(url.searchParams.get("utm_source"), "shared");
    assert.equal(url.hash, "#top");
    assert.deepEqual(readSiteRoute(url), route);
});

test("App links default to Apps and override saved filters with explicit defaults", () => {
    const app = readSiteRoute("https://example.test/?app=com.video");
    assert.equal(app.tab, "apps");
    assert.equal(app.detail.package, "com.video");
    assert.equal(app.browse.search, "");
    assert.equal(app.browse.release, "latest");
    const url = siteRouteUrl(base, { tab: "apps", browse, detail: app.detail });
    assert.equal(url.searchParams.has("version"), false);
    assert.equal(url.searchParams.has("bundle"), false);
    assert.equal(readSiteRoute(url).detail.kind, "app");
});

test("Routes ignore unrelated query strings and bound malformed shared input", () => {
    assert.equal(readSiteRoute(base), null);
    const parsed = readSiteRoute("https://example.test/?tab=invalid&release=invalid&bundle=../../secret&q="+"x".repeat(1000));
    assert.equal(parsed.tab, "bundles");
    assert.equal(parsed.detail, null);
    assert.equal(parsed.browse.release, "latest");
    assert.equal(parsed.browse.search.length, 512);
});

test("Browser navigation pushes details and tabs, replaces filters, and restores Back and Forward", () => {
    const entries = [base], handlers = new Map(), applied = [];
    let index = 0;
    const browser = { location: { href: base },
        addEventListener: (event, handler) => handlers.set(event, handler),
        removeEventListener: event => handlers.delete(event),
        history: {
            pushState(_, __, url) { entries.splice(++index); entries.push(url); browser.location.href=url; },
            replaceState(_, __, url) { entries[index]=url; browser.location.href=url; }
        } };
    const navigation = createSiteNavigation(browser, state => applied.push(state));
    const bundles = { tab:"bundles",browse:{release:"latest",grid:true},detail:null };
    assert.equal(navigation.write(bundles, {replace:true}),true);
    navigation.write({...bundles,tab:"apps"});
    navigation.write({...bundles,tab:"apps",detail:{kind:"app",package:"com.video"}});
    assert.equal(entries.length,3);
    assert.equal(navigation.write({...bundles,tab:"apps",detail:{kind:"app",package:"com.video"}}),false);
    assert.equal(entries.length,3);
    const move = step => { browser.location.href=entries[index+=step]; handlers.get("popstate")(); };
    move(-1);
    assert.equal(applied.at(-1).tab,"apps");
    assert.equal(applied.at(-1).detail,null);
    move(-1);
    assert.equal(applied.at(-1).tab,"bundles");
    move(1); move(1);
    assert.equal(applied.at(-1).detail.package,"com.video");
    navigation.dispose();
    assert.equal(handlers.has("popstate"),false);
});
