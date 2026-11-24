import { countLabel, patchDisplayName } from "./site.js";
import { comparePatchLists, wordDiff } from "./patch-diff.js";
import { createFilterPicker } from "./source-picker.js";
import { formatPatchDescription } from "./details.js";

const groups = { changed: "Changed", added: "Added", removed: "Removed" };

function descriptionDiff(before, after, escape) {
    const segments = wordDiff(before, after);
    const render = (excluded, tag) => segments.filter(item => item.kind !== excluded).map(item => {
        const text = escape(item.text);
        return item.kind === "same" ? text : `<${tag}>${text}</${tag}>`;
    }).join("");
    return [render("added", "del"), render("removed", "ins")];
}

function compatibility(patch, escape) {
    if (patch.universal) return "Applies across apps";
    const packages = patch.compatiblePackages || [];
    return packages.length ? `<ul>${packages.map(pkg => `<li><strong>${escape(pkg.name)}</strong>
        <span>${pkg.versions?.length ? escape(pkg.versions.join(", ")) : "Any version"}</span></li>`).join("")}</ul>`
        : "Compatibility unavailable";
}

function changedFields(item, escape, renderOptions) {
    const { before, after } = item;
    const values = {
        name: () => [before, after].map(patch => escape(patch.display_name?.trim() || patchDisplayName(patch))),
        description: () => descriptionDiff(formatPatchDescription(before.description), formatPatchDescription(after.description), escape),
        compatibility: () => [compatibility(before, escape), compatibility(after, escape)],
        options: () => [before, after].map(patch => renderOptions(patch.options || [], escape) || "No patch options")
    };
    const labels = { name: "Display name", description: "Description", compatibility: "Compatibility", options: "Patch options" };
    return item.fields.map(field => {
        const [oldValue, newValue] = values[field]();
        return `<div class="diff-field"><h5>${labels[field]}</h5><div class="diff-sides">
            <div><span>Baseline</span><div${field === "description" ? ' class="diff-text"' : ""}>${oldValue || "No description"}</div></div>
            <div><span>Selected release</span><div${field === "description" ? ' class="diff-text"' : ""}>${newValue || "No description"}</div></div></div></div>`;
    }).join("");
}

function renderDiff(result, escape) {
    if (!Object.values(result).some(items => items.length))
        return '<p class="diff-message" role="status">No patch metadata changes between these releases.</p>';
    const totals = Object.entries(groups).map(([key, label]) =>
        `<button type="button" class="diff-count diff-${key}" ${result[key].length
            ? `data-diff-jump aria-controls="patch-changes-${key}"`
            : "disabled"}><strong>${result[key].length}</strong> ${label.toLowerCase()}</button>`).join("");
    const sections = Object.entries(groups).filter(([key]) => result[key].length).map(([key, label]) => {
        const rows = result[key].map(item => {
            if (key === "changed") return `<li><details class="diff-patch"><summary>${escape(patchDisplayName(item.after))}
                <span>${countLabel(item.fields.length, "field")}</span></summary></details></li>`;
            const description = formatPatchDescription(item.description);
            return `<li><strong>${escape(patchDisplayName(item))}</strong>
                ${description ? `<p>${escape(description)}</p>` : ""}</li>`;
        }).join("");
        return `<section class="diff-group diff-${key}" id="patch-changes-${key}"><h4 tabindex="-1">${label} patches</h4><ul>${rows}</ul></section>`;
    }).join("");
    return `<div class="diff-totals" role="group" aria-label="Jump to patch changes">${totals}</div>${sections}`;
}

export function createReleaseComparison(panel, { bundle, getReleases, loadPatches, escape, formatDate,
    renderOptions, onBaselineChange, baselineId, isCurrent }) {
    let initialized, selectionRevision = 0;
    const message = text => `<p class="diff-message" role="status">${escape(text)}</p>`;
    function showError(element, error, retry) {
        element.innerHTML = message(error.message) +
            '<button class="card-toggle" type="button">Retry comparison</button>';
        element.querySelector("button").addEventListener("click", () => {
            panel.focus({ preventScroll: true });
            retry();
        });
    }
    async function initialize() {
        if (!bundle.hasPatches || bundle.metadataStatus !== "verified") {
            panel.innerHTML = message("Verified patch metadata is unavailable for this release.");
            return;
        }
        panel.innerHTML = message("Loading release history...");
        try {
            const { candidates, defaultId, generation } = await getReleases(bundle);
            if (!isCurrent()) return;
            if (!candidates.length) {
                panel.innerHTML = message("No other releases with verified patch metadata are available for this source and bundle type.");
                return;
            }
            panel.innerHTML = `<div class="diff-toolbar"><div class="filter-field">
                <label id="baseline-label" for="baseline-release">Baseline release</label>
                <select id="baseline-release"></select>
                <button id="baseline-picker" class="filter-picker" type="button" aria-labelledby="baseline-label baseline-value"
                    aria-haspopup="dialog" aria-expanded="false" hidden>
                    <span id="baseline-value" data-picker-value></span>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                </button></div>
                <div class="diff-target"><span>Selected release</span><strong>${escape(bundle.version)}</strong></div>
                </div><div data-diff-results></div>`;
            const select = panel.querySelector("select"), output = panel.querySelector("[data-diff-results]");
            output.addEventListener("click", event => {
                const jump = event.target.closest("[data-diff-jump]");
                if (!jump) return;
                const section = output.querySelector("#" + jump.getAttribute("aria-controls"));
                section.querySelector("h4").focus({ preventScroll: true });
                section.scrollIntoView({ block: "start" });
            });
            const byId = new Map(candidates.map(item => [item.id, item]));
            const placeholder = new Option("Choose a release", "");
            placeholder.disabled = true;
            select.replaceChildren(placeholder, ...candidates.map(item =>
                new Option(`${item.version} · ${item.isPrerelease ? "Prerelease" : "Release"} · ${formatDate(item.createdAt)}`, item.id)));
            const preferredId = baselineId || defaultId;
            select.value = byId.has(preferredId) ? preferredId : "";
            if (!baselineId && select.value) {
                baselineId = select.value;
                onBaselineChange(baselineId, { replace: true });
            }
            createFilterPicker({ button: panel.querySelector("#baseline-picker"), select,
                label: "Choose a baseline release", searchLabel: "Search releases" });
            const render = async () => {
                const revision = ++selectionRevision;
                const baseline = byId.get(select.value);
                const emptyMessage = baselineId
                    ? "The linked baseline release is unavailable. Choose another release."
                    : "Choose a baseline release to see patch changes.";
                output.innerHTML = message(baseline ? "Comparing patch metadata..." : emptyMessage);
                if (!baseline) return;
                try {
                    const [current, previous] = await loadPatches(bundle, baseline, generation);
                    if (!isCurrent() || revision !== selectionRevision) return;
                    const result = comparePatchLists(previous, current);
                    output.innerHTML = renderDiff(result, escape);
                    output.querySelectorAll(".diff-patch").forEach((row, index) => {
                        row.addEventListener("toggle", () => {
                            if (row.open && row.children.length === 1)
                                row.insertAdjacentHTML("beforeend", changedFields(result.changed[index], escape, renderOptions));
                        });
                    });
                } catch (error) {
                    if (isCurrent() && revision === selectionRevision)
                        showError(output, error, () => { initialized = initialize(); });
                }
            };
            select.addEventListener("change", () => {
                baselineId = select.value;
                onBaselineChange(baselineId);
                void render();
            });
            await render();
        } catch (error) {
            if (isCurrent()) showError(panel, error, () => { initialized = initialize(); });
        }
    }
    return () => initialized ??= initialize();
}
