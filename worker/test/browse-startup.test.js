import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createBrowsePreferences } from "../../shared/preferences.js";
const script = readFileSync(new URL("../../web/browse-startup.js", import.meta.url), "utf8");
function startup(saved, { blocked = false, mobile = false, readyState = "loading", search = "" } = {}) {
    function node(id) {
        const classes = new Set(), attrs = new Map();
        return { id, dataset: {}, attrs, classes, value: "", options: [],
            setAttribute: (key, value) => attrs.set(key, value),
            removeAttribute: key => attrs.delete(key),
            appendChild(option) { this.options.push(option); },
            classList: { toggle(key, on) { if (on) classes.add(key); else classes.delete(key); } } };
    }
    const nodes = new Map();
    const get = id => {
        assert.notEqual(document.readyState, "loading", "Controls must exist before restoration");
        if (!nodes.has(id)) nodes.set(id, node(id));
        return nodes.get(id);
    };
    const filters = ["all", "latest", "release", "prerelease"].map(filter =>
        Object.assign(node(filter), { dataset: {filter} }));
    const tabs = ["bundles", "apps"].map(tab => node(tab + "-tab"));
    const root = node("root");
    const document = Object.assign(new EventTarget(), { readyState, documentElement: root,
        getElementById: get, querySelector: get,
        querySelectorAll: selector => selector === ".filter-btn" ? filters : tabs });
    runInNewContext(script, { document, URLSearchParams, location: {search}, localStorage: { getItem() {
        if (blocked) throw Error("Storage blocked"); return saved;
    } }, matchMedia: () => ({matches: mobile}),
    Option: function(label, value) { this.label = label; this.value = value; } });
    return { root, get, filters, tabs, parsed() {
        document.readyState = "interactive";
        document.dispatchEvent(new Event("readystatechange"));
    } };
}
test("Saved app filters are visible before catalog modules load", () => {
    const view = startup(JSON.stringify({activeTab:"apps",tabs:{apps:{
        search:"Video App",package:"19.16",source:"https://github.com/a/b",
        type:"Morphe:V1",release:"latest",grid:false,version:"ignored"
    }}}));
    assert(view.root.attrs.has("data-browse-pending"));
    view.parsed(); // No modules or DOMContentLoaded event have run.
    assert.equal(view.root.attrs.has("data-browse-pending"), false);
    assert.equal(view.filters.find(button => button.classes.has("active")).id, "latest");
    assert.equal(view.tabs.find(button => button.classes.has("active")).id, "apps-tab");
    assert.equal(view.get("search").value, "Video App");
    assert.equal(view.get("package-filter").value, "19.16");
    assert.equal(view.get("source-filter").value, "https://github.com/a/b");
    assert.equal(view.get("bundle-type-filter").value, "Morphe:V1");
    assert.equal(view.get("bundle-type-filter").options[0].label, "Morphe");
    assert.equal(view.get("bundle-version-filter").value, "");
    assert.equal(view.get("bundle-version-field").hidden, true);
    assert.equal(view.get("results").classes.has("grid-view"), false);
});
test("Saved bundle selections restore immediately after parsing", () => {
    const view = startup(JSON.stringify({tabs:{bundles:{release:"all",version:"v2",
        source:"https://github.com/a/b",grid:true}}}), {readyState:"interactive"});
    assert.equal(view.get("bundle-version-filter").value, "v2");
    assert.equal(view.get("bundle-version-filter").disabled, false);
    assert.equal(view.get("results").classes.has("grid-view"), true);
    assert.equal(view.filters.find(button => button.classes.has("active")).id, "all");
    assert.deepEqual(view.filters.map(button => button.attrs.get("aria-pressed")), ["true", "false", "false", "false"]);
});
test("Malformed and blocked preferences show usable defaults without waiting for modules", () => {
    for (const options of [{}, {blocked:true}]) {
        const view = startup("{", {...options,mobile:true});
        view.parsed();
        assert.equal(view.root.attrs.has("data-browse-pending"), false);
        assert.equal(view.filters.find(button => button.classes.has("active")).id, "latest");
        assert.equal(view.get("bundle-version-filter").disabled, true);
        assert.equal(view.get("search").value, "");
        assert.equal(view.get("results").classes.has("grid-view"), false);
    }
});

test("Early restored grid settings do not become defaults for the other tab", () => {
    const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
    const declaration = app.slice(app.indexOf("const browsePreferences ="),
        app.indexOf("\nconst navigation ="));
    for (const mobile of [false, true]) {
        const saved = JSON.stringify({activeTab:"apps",tabs:{apps:{grid:mobile}}});
        const context = {
            createBrowsePreferences,
            localStorage: {getItem: () => saved},
            matchMedia: () => ({matches: mobile}),
            results: {classList: {contains: () => mobile}}
        };
        runInNewContext(declaration, context);
        assert.equal(runInNewContext('browsePreferences.read("apps").grid', context), mobile);
        assert.equal(runInNewContext('browsePreferences.read("bundles").grid', context), !mobile);
    }
});

test("Shared links restore their tab and filters before saved preferences", () => {
    const saved = JSON.stringify({activeTab:"bundles",tabs:{apps:{search:"Old search",release:"all"}}});
    const view = startup(saved, {search:"?tab=apps&app=com.video&q=Video&view=list"});
    view.parsed();
    assert.equal(view.tabs.find(button => button.classes.has("active")).id, "apps-tab");
    assert.equal(view.get("search").value,"Video");
    assert.equal(view.filters.find(button => button.classes.has("active")).id, "latest");
    assert.equal(view.get("results").classes.has("grid-view"),false);
});
