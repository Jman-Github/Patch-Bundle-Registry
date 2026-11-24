import assert from "node:assert/strict";
import test from "node:test";
import { groupBundlePatches, filterPatchGroups, formatPatchDescription } from "../../shared/details.js";
import { patchMatchesSearch } from "../../shared/site.js";
import { createDetailsBrowser, renderPatchOptions, readableOptionType, readableOptionValue } from "../../shared/detail-browser.js";
import worker from "../src/index.js";
import { fixture } from "./fixture.js";

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const video = {name:"Hide ads", description:"Remove video ads", options:[],
    compatiblePackages:[{name:"com.video",appName:"Video",versions:["19.16"]}]};

test("Detail grouping keeps duplicate package associations once and separates universal patches", () => {
    const groups = groupBundlePatches([
        {...video, compatiblePackages:[...video.compatiblePackages,...video.compatiblePackages]},
        {name:"Universal",universal:true,compatiblePackages:[]},
        {name:"No supported versions",universal:false,compatiblePackages:[]}
    ],[{package_name:"com.video",app_name:"Video App",icon_url:"https://img.test/video.png"}]);
    assert.equal(groups.length,2);
    assert.equal(groups[0].app_name,"Video App");
    assert.equal(groups[0].icon_url,"https://img.test/video.png");
    assert.equal(groups[0].patches.length,1);
    assert.equal(groups[1].app_name,"Universal patches");
    assert.equal(filterPatchGroups(groups,"video 19.16",patchMatchesSearch).length,1);
    assert.equal(filterPatchGroups(groups,"99.0",patchMatchesSearch).length,0);
});

test("Options display false, zero, null, required status and escaped choices", () => {
    const html = renderPatchOptions([
        {key:"enabled",title:"Enable <script>",description:"<img>",required:true,type:"Boolean",default:false,values:{"Off":false}},
        {key:"count",default:0},{key:"unset",default:null}
    ],escape);
    assert.match(html,/Enable &lt;script>/);
    assert.match(html,/&lt;img>/);
    assert.match(html,/>No</);
    assert.match(html,/>0</);
    assert.match(html,/>Not set</);
    assert.match(html,/Required<\/dt><dd>Yes/);
    assert.equal(renderPatchOptions([],escape),"");
});

test("Description formatting preserves long internal spacing and trims blank edges", () => {
    const blankLines = "\n".repeat(32768);
    assert.equal(formatPatchDescription("\t\r\n  First" + blankLines + "  Last\r\n "), "First" + blankLines + "Last");
    assert.equal(formatPatchDescription(" \t\r\n \n  "), "");
});

test("Option descriptions retain paragraphs and align interpolated bullets", () => {
    const value = "\r\n    Choose a file.\r\n\r\n    Supported names:\r\n    - logo.png\r\n- mask.png\r\n      with transparency\r\n    ";
    const html = renderPatchOptions([{title:"Logo",description:value}],escape);
    assert.match(html,/<p class="patch-option-description">Choose a file\.\n\nSupported names:\n- logo\.png\n- mask\.png\n  with transparency<\/p>/);
});

test("Blank option descriptions do not render an empty paragraph", () => {
    const html = renderPatchOptions([{title:"Logo",description:" \r\n "}],escape);
    assert.match(html,/Logo/);
    assert.doesNotMatch(html,/patch-option-description/);
});

test("REST and GraphQL preserve extracted option metadata", async () => {
    const base = fixture();
    const rows = JSON.parse(base.bodies["patches/00000.json"]);
    const options = [{key:"enabled",required:true,type:"Boolean",default:false,values:{"Off":false}}];
    rows[0].options = options;
    const state = fixture({"patches/00000.json":rows});
    const response = await worker.fetch(new Request("https://api.test/patches?package=com.video"),state.env);
    const body = await response.json();
    assert.equal(response.status,200);
    assert.deepEqual(body.data[0].options,options);
    const graph = await worker.fetch(new Request("https://api.test/graphql",{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({query:"{ patch(limit:1) { options } }"})
    }),state.env);
    const result = await graph.json();
    assert.equal(result.errors,undefined);
    assert.deepEqual(result.data.patch[0].options,options);
});

function element() {
    const handlers = {}, classes = new Set(), selectors = new Map();
    return {handlers,classes,selectors,open:false,isConnected:true,value:"",dataset:{},attrs:{},
        classList:{add:key=>classes.add(key),remove:key=>classes.delete(key)},
        setAttribute(key,value){this.attrs[key]=value;},
        getAttribute(key){return this.attrs[key];},
        addEventListener(event,fn){handlers[event]=fn;},
        focus(){this.focused=true;},insertAdjacentHTML(position,html){this.innerHTML=html+this.innerHTML;},showModal(){this.open=true;},
        close(){this.open=false;handlers.close?.();},
        closest(){return null;},
        querySelector(selector){
            if (!selectors.has(selector)) selectors.set(selector,element());
            return selectors.get(selector);
        },querySelectorAll(){return [];}
    };
}

function browser(t, patches, extra = {}) {
    const original = {document:globalThis.document,window:globalThis.window};
    const root=element(),dialog=element(),focus=element();
    globalThis.document={createElement:()=>dialog,activeElement:focus,body:{appendChild(){}},
        documentElement:root,querySelectorAll:()=>[],querySelector:()=>null};
    globalThis.window={getSelection:()=>({toString:()=>""})};
    t.after(()=>Object.assign(globalThis,original));
    const api=createDetailsBrowser({
        getApplications:()=>[{package_name:"com.video",app_name:"Video App",icon_url:"https://img.test/v.png"}],
        getSummaries:()=>[{id:"a",version:"v1",sourceUrl:"https://github.com/o/a",bundleType:"Morphe:V1",metadataStatus:"verified"}],
        transformBundle:bundle=>bundle, bundlePatches:patches,
        renderPatch:patch=>"<p>"+escape(patch.name)+"</p>"+renderPatchOptions(patch.options,escape),
        escapeHtml:escape, installAvatarFallback(){},formatDate:()=>"",getApi:()=>"https://api.test",
        bundleChangelog:async bundle=>bundle.description, renderMarkdown:escape, ...extra
    });
    const sections = dialog.querySelector(".details-sections");
    const buttons = ["patches", "changelog", "compare"].map(section => {
        const button = sections.querySelector(`[data-details-section="${section}"]`);
        button.dataset.detailsSection = section;
        return button;
    });
    sections.querySelectorAll = selector => selector === "[data-details-section]" ? buttons : [];
    const body = dialog.querySelector(".details-body"), nodes = new Map();
    let rendered;
    function bodyGroups() {
        if (rendered !== body.innerHTML) {
            rendered = body.innerHTML;
            nodes.clear();
            for (const match of rendered.matchAll(/data-bundle="([^"]+)"/g)) {
                const group = element();
                group.dataset.bundle = match[1];
                group.closest = () => ({ remove() { group.isConnected = false; } });
                nodes.set(match[1], group);
            }
        }
        return [...nodes.values()].filter(group => group.isConnected);
    }
    body.querySelectorAll = selector =>
        ["[data-bundle]", ".details-group"].includes(selector) ? bodyGroups() : [];
    body.querySelector = selector => {
        bodyGroups();
        return nodes.get(selector.match(/data-bundle="([^"]+)"/)?.[1]) ?? null;
    };
    return {api,dialog,root,focus};
}

test("Card activation uses the details button and leaves other controls alone", t => {
    const { api } = browser(t, async () => []);
    const card = element(), button = card.querySelector(".card-details");
    button.click = () => button.handlers.click();
    let opened = 0;
    api.activateCard(card, () => opened++);
    assert.equal(card.attrs.role, undefined);
    button.click();
    assert.equal(opened, 1);
    assert(button.focused);
    assert(card.classes.has("card-selected"));
    for (const control of ["a", "button", "input", "summary", ".changelog-preview"]) {
        card.handlers.click({ target: { closest: selector => selector.split(", ").includes(control) } });
    }
    assert.equal(opened, 1);
    card.handlers.click({ target: { closest: () => null } });
    assert.equal(opened, 2);
});

test("Bundle windows show app metadata, search patches, and restore focus on close", async t => {
    const {api,dialog,root,focus}=browser(t,async()=>[video,{name:"Universal",universal:true}]);
    await api.openBundle({version:"v1",bundleType:"Morphe:V1",sourceUrl:"https://github.com/o/a"});
    const body=dialog.querySelector(".details-body"),search=dialog.querySelector(".details-search");
    assert.match(body.innerHTML,/Video App/);
    assert.match(body.innerHTML,/com.video/);
    assert.match(body.innerHTML,/img.test\/v.png/);
    assert.match(body.innerHTML,/Universal patches/);
    search.value="19.16";search.handlers.input();
    assert.match(body.innerHTML,/Hide ads/);
    assert.doesNotMatch(body.innerHTML,/Universal patches/);
    api.close();
    assert.equal(root.classes.has("details-open"),false);
    assert.equal(focus.focused,true);
});

test("An old async response cannot overwrite a newer window", async t => {
    let resolve;
    const waiting=new Promise(done=>resolve=done);
    const {api,dialog}=browser(t,bundle=>bundle.version==="old"?waiting:Promise.resolve([video]));
    const old=api.openBundle({version:"old",sourceUrl:"https://github.com/o/a"});
    await api.openBundle({version:"new",sourceUrl:"https://github.com/o/a"});
    resolve([{name:"Old patches",universal:true}]);
    await old;
    assert.match(dialog.querySelector(".details-body").innerHTML,/Hide ads/);
    assert.doesNotMatch(dialog.querySelector(".details-body").innerHTML,/Old patches/);
});

test("App windows keep the current filter relationships and search loads cached patches", async t => {
    let calls=0;
    const {api,dialog}=browser(t,async()=>{calls++;return [video];});
    api.openApp({app_name:"Video App",package_name:"com.video",bundles:[{bundle_id:"a",patch_count:1}]});
    assert.equal(calls,0);
    const search=dialog.querySelector(".details-search");
    search.value="Hide ads";search.handlers.input();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);
    assert.match(dialog.querySelector(".details-body").querySelector('[data-bundle="a"]').querySelector(".details-patches").innerHTML,/Hide ads/);
    search.value="missing";search.handlers.input();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);
    assert.match(dialog.querySelector(".details-body").innerHTML,/No bundles or patches match/);
});


test("Loading an app bundle updates its patches without rebuilding other controls", async t => {
    let resolve;
    const waiting = new Promise(done => { resolve = done; });
    const {api,dialog} = browser(t, () => waiting);
    const body = dialog.querySelector(".details-body");
    const group = element(), patches = element();
    group.dataset.bundle = "a";
    group.querySelector = () => patches;
    body.querySelectorAll = selector => selector === "[data-bundle]" ? [group] : [];
    body.querySelector = () => group;
    api.openApp({app_name:"Video App",package_name:"com.video",
        bundles:[{bundle_id:"a",patch_count:1}]});
    const original = body.innerHTML;
    group.open = true;
    group.handlers.toggle();
    resolve([video]);
    await new Promise(done => setImmediate(done));
    assert.equal(body.innerHTML, original);
    assert.match(patches.innerHTML, /Hide ads/);
});


test("Active searches update matching bundle patches without rebuilding existing controls", async t => {
    let resolve;
    const {api,dialog} = browser(t, () => new Promise(done => { resolve = done; }));
    api.openApp({app_name:"Video App",package_name:"com.video",
        bundles:[{bundle_id:"a",patch_count:1}]});
    const search = dialog.querySelector(".details-search"), body = dialog.querySelector(".details-body");
    search.value = "Hide ads";
    search.handlers.input();
    const original = body.innerHTML;
    const group = body.querySelector('[data-bundle="a"]');
    resolve([video]);
    await new Promise(done => setImmediate(done));
    assert.equal(body.innerHTML, original);
    assert.equal(body.querySelector('[data-bundle="a"]'), group);
    assert.match(group.querySelector(".details-patches").innerHTML, /Hide ads/);
    assert.equal(dialog.querySelector(".details-count").textContent, "1 bundle");
});


test("Completed searches remove nonmatching bundles and update the result count", async t => {
    let resolve;
    const {api,dialog} = browser(t, () => new Promise(done => { resolve = done; }));
    api.openApp({app_name:"Video App",package_name:"com.video",
        bundles:[{bundle_id:"a",patch_count:1}]});
    const search = dialog.querySelector(".details-search");
    search.value = "unmatched";
    search.handlers.input();
    assert.equal(dialog.querySelector(".details-count").textContent, "Searching patches...");
    resolve([video]);
    await new Promise(done => setImmediate(done));
    assert.equal(dialog.querySelector(".details-count").textContent, "0 bundles");
    assert.match(dialog.querySelector(".details-body").innerHTML, /No bundles or patches match/);
});


test("Typing during an app search shares at most three concurrent patch requests", async t => {
    const summaries = Array.from({ length: 7 }, (_, index) => ({
        id: String(index), version: "v1", sourceUrl: "https://github.com/o/a",
        bundleType: "Morphe:V1", metadataStatus: "verified"
    }));
    const pending = [];
    const { api, dialog } = browser(t, () =>
        new Promise(resolve => pending.push(resolve)), { getSummaries: () => summaries });
    api.openApp({ app_name: "Video App", package_name: "com.video",
        bundles: summaries.map(bundle => ({ bundle_id: bundle.id, patch_count: 1 })) });
    const search = dialog.querySelector(".details-search");
    for (const query of ["H", "Hide", "Hide ads"]) {
        search.value = query;
        search.handlers.input();
        assert.equal(pending.length, 3);
    }
    let completed = 0;
    while (pending.length) {
        assert(pending.length <= 3);
        completed++;
        pending.shift()([video]);
        await new Promise(done => setImmediate(done));
    }
    assert.equal(completed, 7);
    assert.equal(dialog.querySelector(".details-count").textContent, "7 bundles");
});

test("Failed background searches show an escaped error without rebuilding controls", async t => {
    let reject;
    const {api,dialog} = browser(t, () => new Promise((_, fail) => { reject = fail; }));
    api.openApp({app_name:"Video App",package_name:"com.video",
        bundles:[{bundle_id:"a",patch_count:1}]});
    const search = dialog.querySelector(".details-search"), body = dialog.querySelector(".details-body");
    search.value = "Hide ads";
    search.handlers.input();
    const original = body.innerHTML;
    reject(new Error("<unavailable>"));
    await new Promise(done => setImmediate(done));
    assert.equal(body.innerHTML, original);
    assert.match(body.querySelector('[data-bundle="a"]').querySelector(".details-patches").innerHTML,
        /Unable to load patches: &lt;unavailable>/);
    assert.equal(dialog.querySelector(".details-count").textContent, "1 bundle");
});

test("Single app groups and patch options use singular labels and aligned disclosure controls", async t => {
    const {api,dialog} = browser(t, async () => [video]);
    await api.openBundle({version:"v1",bundleType:"Morphe:V1",sourceUrl:"https://github.com/o/a"});
    assert.equal(dialog.querySelector(".details-count").textContent, "1 app group");
    assert.match(dialog.querySelector(".details-body").innerHTML, />1 patch<\/span>/);
    assert.match(dialog.querySelector(".details-body").innerHTML, /disclosure-arrow[^]*?aria-hidden="true"/);
    const options = renderPatchOptions([null, [], {key:"enabled",default:false}], escape);
    assert.match(options, /aria-label="1 patch option"/);
    assert.match(options, /option-count">1<\/span>/);
    assert.match(options, /patch-options-list/);
    assert.equal(renderPatchOptions([null, []], escape), "");
});

test("Changelog shortcuts load full notes lazily and preserve patch searches between sections", async t => {
    let patchReads = 0, noteReads = 0, markdown;
    const {api,dialog} = browser(t, async () => { patchReads++; return [video]; }, {
        bundleChangelog: async () => { noteReads++; return "Full release notes <script>"; },
        renderMarkdown: text => { markdown = text; return escape(text); }
    });
    const bundle = {version:"v1",sourceUrl:"https://github.com/o/a",description:"Truncated notes"};
    await api.openBundle(bundle, {section:"changelog"});
    const sections = dialog.querySelector(".details-sections");
    const notes = dialog.querySelector(".details-changelog");
    const body = dialog.querySelector(".details-body");
    const toolbar = dialog.querySelector(".details-toolbar");
    const patchesButton = sections.querySelector('[data-details-section="patches"]');
    const changelogButton = sections.querySelector('[data-details-section="changelog"]');
    assert.equal(patchReads, 0);
    assert.equal(noteReads, 1);
    assert.equal(markdown, "Full release notes <script>");
    assert.match(notes.innerHTML, /Full release notes &lt;script>/);
    assert.equal(notes.hidden, false);
    assert.equal(body.hidden, true);
    assert.equal(toolbar.hidden, true);
    assert.equal(changelogButton.attrs["aria-pressed"], "true");
    assert.equal(changelogButton.focused, true);
    patchesButton.handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(patchReads, 1);
    assert.equal(toolbar.hidden, false);
    assert.equal(body.hidden, false);
    const search = dialog.querySelector(".details-search");
    search.value = "19.16"; search.handlers.input();
    const patchHtml = body.innerHTML;
    changelogButton.handlers.click();
    patchesButton.handlers.click();
    assert.equal(noteReads, 1);
    assert.equal(patchReads, 1);
    assert.equal(search.value, "19.16");
    assert.equal(body.innerHTML, patchHtml);
    assert.equal(patchesButton.attrs["aria-pressed"], "true");
});

test("Comparison loads history only when opened and explains when no verified baseline exists", async t => {
    let comparisons = 0;
    const {api,dialog} = browser(t, async () => [video], {
        comparisonReleases: async () => { comparisons++; return { candidates: [] }; }
    });
    const bundle = {version:"v1",sourceUrl:"https://github.com/o/a",hasPatches:true,metadataStatus:"verified"};
    await api.openBundle(bundle, {section:"changelog"});
    assert.equal(comparisons, 0);
    const sections = dialog.querySelector(".details-sections");
    sections.querySelector('[data-details-section="compare"]').handlers.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(comparisons, 1);
    assert.equal(dialog.querySelector(".details-changelog").hidden, true);
    assert.match(dialog.querySelector(".release-comparison").innerHTML, /No other releases with verified patch metadata/);
});

test("Closing a comparison during its history request prevents follow-up work", async t => {
    let resolveHistory;
    const history = new Promise(resolve => { resolveHistory = resolve; });
    let patchReads = 0;
    const {api,dialog} = browser(t, async () => [video], {
        comparisonReleases: () => history,
        comparisonPatches: async () => { patchReads++; return [[video], [video]]; }
    });
    const bundle = {version:"v2",sourceUrl:"https://github.com/o/a",hasPatches:true,metadataStatus:"verified"};
    const loading = api.openBundle(bundle, {section:"compare"});
    const panel = dialog.querySelector(".release-comparison");
    const before = panel.innerHTML;
    assert.match(before, /Loading release history/);
    api.close();
    resolveHistory({candidates:[{id:"a",version:"v1"}], defaultId:"a"});
    await loading;
    assert.equal(patchReads, 0);
    assert.equal(panel.innerHTML, before);
});

test("Loading patches in the background cannot replace the visible changelog", async t => {
    let resolve, noteReads = 0;
    const waiting = new Promise(done => { resolve = done; });
    const {api,dialog} = browser(t, () => waiting, {
        bundleChangelog: async () => { noteReads++; return "Current changelog"; }
    });
    const pending = api.openBundle({version:"v1",sourceUrl:"https://github.com/o/a"});
    assert.equal(noteReads, 0);
    dialog.querySelector(".details-sections").querySelector('[data-details-section="changelog"]').handlers.click();
    await new Promise(done => setImmediate(done));
    resolve([video]);
    await pending;
    assert.equal(dialog.querySelector(".details-body").hidden, true);
    assert.equal(dialog.querySelector(".details-changelog").hidden, false);
    assert.match(dialog.querySelector(".details-changelog").innerHTML, /Current changelog/);
});

test("Old changelog responses cannot replace a newer bundle window", async t => {
    let resolve;
    const waiting = new Promise(done => { resolve = done; });
    const {api,dialog} = browser(t, async () => [video], {
        bundleChangelog: bundle => bundle.version === "old" ? waiting : Promise.resolve("New notes")
    });
    const pending = api.openBundle({version:"old",sourceUrl:"https://github.com/o/a"}, {section:"changelog"});
    await api.openBundle({version:"new",sourceUrl:"https://github.com/o/a"}, {section:"changelog"});
    resolve("Outdated notes");
    await pending;
    assert.equal(dialog.querySelector(".details-changelog").innerHTML, "New notes");
});

test("A failed changelog can be retried without leaving the bundle", async t => {
    let attempts = 0;
    const {api,dialog} = browser(t, async () => [video], {
        bundleChangelog: async bundle => {
            if (bundle.version === "empty") return "";
            if (++attempts === 1) throw new Error("Notes unavailable");
            return "Recovered notes";
        }
    });
    await api.openBundle({version:"empty",sourceUrl:"https://github.com/o/a"}, {section:"changelog"});
    assert.match(dialog.querySelector(".details-changelog").innerHTML, /No changelog was provided/);
    await api.openBundle({version:"failed",sourceUrl:"https://github.com/o/a"}, {section:"changelog"});
    const changelog = dialog.querySelector(".details-changelog");
    assert.match(changelog.innerHTML, /Unable to load changelog: Notes unavailable/);
    changelog.querySelector("[data-retry-detail]").handlers.click();
    await new Promise(done => setImmediate(done));
    assert.equal(changelog.innerHTML, "Recovered notes");
    dialog.querySelector(".details-sections").querySelector('[data-details-section="patches"]').handlers.click();
    await new Promise(done => setImmediate(done));
    assert.match(dialog.querySelector(".details-body").innerHTML, /Hide ads/);
    assert.equal(dialog.querySelector(".details-body").hidden, false);
});


test("Options use compact patch headings and readable types and structured values", () => {
    assert.equal(readableOptionType("kotlin.Long"), "Whole number");
    assert.equal(readableOptionType("kotlin.collections.List<kotlin.String>"), "List of text");
    assert.equal(readableOptionType("List<String>"), "List of text");
    assert.equal(readableOptionValue({Low:96, High:240}), "Low: 96\nHigh: 240");
    assert.equal(readableOptionValue(["one","two"]), "• one\n• two");
    const html = renderPatchOptions([{title:"Custom DPI",type:"kotlin.Long",default:240}], escape, "Set DPI");
    assert.match(html, /patch-name">Set DPI</);
    assert.match(html, /Whole number/);
    assert.doesNotMatch(html, /kotlin.Long|<code>/);
});

test("App windows provide copy controls and bundle actions outside the disclosure", t => {
    const {api,dialog} = browser(t,async()=>[],{getSummaries:()=>[{
        id:"a",version:"v1",sourceUrl:"https://github.com/o/a",bundleType:"Morphe:V1",
        downloadUrl:"https://example.test/bundle.mpp",metadataStatus:"verified"
    }]});
    api.openApp({app_name:"Video App",package_name:"com.video",bundles:[{bundle_id:"a",patch_count:1}]});
    assert.match(dialog.innerHTML,/aria-label="Copy app name"/);
    assert.match(dialog.innerHTML,/data-copy-text="com.video"/);
    const body = dialog.querySelector(".details-body").innerHTML;
    assert.doesNotMatch(body.match(/<summary>([^]*?)<\/summary>/)[1], /<(a|button)\b/);
    assert.match(body, /<div class="details-group-actions"[^]*?aria-label="Download bundle"/);
    assert.match(body, /aria-label="Open repository"/);
    assert.match(body, /data-copy-text="https:\/\/api.test\//);
});

test("Closing release notes focuses the replacement button after the feed is rebuilt", async t => {
    const {api,focus} = browser(t, async () => []);
    const replacement = element();
    focus.id = replacement.id = "read-changelog-a";
    document.getElementById = id => id === replacement.id ? replacement : null;
    await api.openBundle({id:"a",version:"v1",sourceUrl:"https://github.com/o/a"}, {section:"changelog"});
    focus.isConnected = false;
    api.close();
    assert.equal(replacement.focused, true);
});

test("Detail navigation records bundle sections and apps, with silent history restoration", async t => {
    const routes = [];
    let closed = 0;
    const {api,dialog} = browser(t, async()=>[video], {
        onNavigate: route=>routes.push(route), onClose:()=>closed++
    });
    const bundle = {id:"a".repeat(24),version:"v1",bundleType:"Morphe:V1",sourceUrl:"https://github.com/o/a"};
    await api.openBundle(bundle);
    assert.deepEqual(routes.at(-1), {kind:"bundle",id:bundle.id,
        source:bundle.sourceUrl,version:"v1",section:"patches"});
    const sections = dialog.querySelector(".details-sections");
    sections.querySelector('[data-details-section="changelog"]').handlers.click();
    assert.equal(routes.at(-1).section,"changelog");
    api.close({notify:false});
    assert.equal(closed,0);
    await api.openBundle(bundle,{notify:false,section:"changelog"});
    assert.equal(routes.length,2);
    let prevented=false;
    dialog.handlers.cancel({preventDefault(){prevented=true;}});
    assert(prevented);
    assert.equal(closed,1);
    api.openApp({app_name:"Video App",package_name:"com.video",bundles:[]});
    assert.deepEqual(routes.at(-1),{kind:"app",package:"com.video"});
    api.close();
    assert.equal(closed,2);
    api.openApp({app_name:"Video App",package_name:"com.video",bundles:[]},{notify:false});
    assert.equal(routes.length,3);
});
