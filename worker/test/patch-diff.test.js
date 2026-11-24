import assert from "node:assert/strict";
import test from "node:test";
import { comparePatchLists, wordDiff } from "../../shared/patch-diff.js";

const patch = (name, other = {}) => ({ name, ...other });

test("Release comparison classifies visible patch metadata changes in baseline-to-release order", () => {
    const before = [patch("Old"), patch("Ads", {description:"Hide video advertisements",
        compatiblePackages:[{name:"com.video",versions:["1"]}], options:[{key:"ads",default:false}]}),
        patch("Same")];
    const after = [patch("New"), patch("Ads", {description:"Hide all advertisements",
        compatiblePackages:[{name:"com.video",versions:["1","2"]}], options:[{key:"ads",default:true}]}),
        patch("Same")];
    const result = comparePatchLists(before, after);
    assert.deepEqual(result.added.map(item => item.name), ["New"]);
    assert.deepEqual(result.removed.map(item => item.name), ["Old"]);
    assert.deepEqual(result.changed.map(item => [item.before.name, item.fields]),
        [["Ads", ["description", "compatibility", "options"]]]);
    assert.deepEqual(comparePatchLists(after, before).added.map(item => item.name), ["Old"]);
});

test("Reordered patch metadata and app display-name changes leave the diff empty", () => {
    const before = patch("Ads", {
        compatiblePackages:[{name:"com.music",appName:"Music",versions:["2","1"]},{name:"com.video",versions:[]}],
        options:[{key:"color", values:{red:1,blue:2}},{key:"enabled", default:true}]
    });
    const after = patch("Ads", {
        compatiblePackages:[{name:"com.video",versions:[]},{name:"com.music",appName:"New app label",versions:["1","2"]}],
        options:[{default:true,key:"enabled"},{values:{blue:2,red:1},key:"color"}]
    });
    assert.deepEqual(comparePatchLists([before],[after]), { added:[], removed:[], changed:[] });
});

test("Source indentation changes alone do not change a patch description", () => {
    const before = patch("Logo", {description:"\n    Choose a file.\n\n    - logo.png\n- mask.png\n"});
    const after = patch("Logo", {description:"Choose a file.\n\n- logo.png\n- mask.png"});
    assert.deepEqual(comparePatchLists([before],[after]), {added:[], removed:[], changed:[]});
});

test("Option descriptions only change the diff when their displayed text changes", () => {
    const make = description => patch("Logo", {options:[{key:"logo",description}]});
    const before = make("\r\n    Choose a file.\r\n\r\n    - logo.png\r\n- mask.png\r\n");
    const after = make("Choose a file.\n\n- logo.png\n- mask.png");
    assert.deepEqual(comparePatchLists([before],[after]), {added:[], removed:[], changed:[]});
    const edited = make("Choose a folder.");
    assert.deepEqual(comparePatchLists([after],[edited]).changed[0].fields, ["options"]);
});

test("Option comparison ignores invalid entries and blank descriptions", () => {
    const option = {key:"logo",title:"Logo",default:null};
    const before = patch("Logo", {options:[option]});
    const after = patch("Logo", {options:[null, [], {...option, description:" \r\n  "}]});
    assert.deepEqual(comparePatchLists([before],[after]), {added:[], removed:[], changed:[]});
    const empty = patch("Logo");
    assert.deepEqual(comparePatchLists([empty],[patch("Logo", {options:{}})]),
        {added:[], removed:[], changed:[]});
});

test("A display-name change keeps the patch paired by its original identifier", () => {
    const before = patch("internalName", {display_name:"Old label"});
    const after = patch("internalName", {display_name:"New label"});
    assert.deepEqual(comparePatchLists([before],[after]), {
        added:[], removed:[], changed:[{before, after, fields:["name"]}]
    });
});

test("Duplicate patch names are matched by identical metadata before pairing changes", () => {
    const same = patch("Ads", {description:"Identical"});
    const old = patch("Ads", {description:"Previous"});
    const next = patch("Ads", {description:"Current"});
    assert.deepEqual(comparePatchLists([same,old],[next,same]), {
        added:[], removed:[], changed:[{before:old, after:next, fields:["description"]}]
    });
    const result = comparePatchLists([same,old],[next,patch("Ads", {description:"New"})]);
    assert.equal(result.changed.length, 0);
    assert.equal(result.removed.length, 2);
    assert.equal(result.added.length, 2);
});

test("Word differences retain original text and highlight only the words that changed", () => {
    const before = "Hide video ads\n  everywhere";
    const after = "Hide player ads\n  everywhere";
    const diff = wordDiff(before, after);
    assert.equal(diff.filter(item => item.kind !== "added").map(item => item.text).join(""), before);
    assert.equal(diff.filter(item => item.kind !== "removed").map(item => item.text).join(""), after);
    assert.deepEqual(diff.filter(item => item.kind !== "same").map(item => item.text), ["video ", "player "]);
    const long = "a ".repeat(500);
    assert.deepEqual(wordDiff(long, long + "b").map(item => item.kind), ["removed", "added"]);
});
