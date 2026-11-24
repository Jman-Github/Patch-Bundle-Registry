export function formatPatchDescription(value) {
    const lines = String(value ?? "").split(/\r\n?|\n/).map(line => line.trimEnd());
    let start = 0, end = lines.length;
    while (start < end && !lines[start]) start++;
    while (end > start && !lines[end - 1]) end--;
    if (start === end) return "";
    const indent = lines[start].match(/^[ \t]*/)[0];
    // Interpolated list lines can already be flush left while the template is indented.
    return lines.slice(start, end).map(line =>
        line.startsWith(indent) ? line.slice(indent.length) : line
    ).join("\n");
}

export function renderablePatchOptions(options) {
    return Array.isArray(options)
        ? options.filter(option => option && typeof option === "object" && !Array.isArray(option))
        : [];
}

// Group normalized patch compatibility without turning empty restrictions into universal patches.
export function groupBundlePatches(patches, apps = []) {
    const metadata = new Map(apps.map(app => [app.package_name, app]));
    const groups = new Map();
    for (const patch of patches) {
        const packages = new Map((patch.compatiblePackages || []).map(pkg => [pkg.name, pkg]));
        if (patch.universal) packages.set("", { name: "" });
        for (const [name, pkg] of packages) {
            if (!groups.has(name)) groups.set(name, {
                package_name: name, app_name: name ? (metadata.get(name)?.app_name || pkg.appName || name) : "Universal patches",
                icon_url: metadata.get(name)?.icon_url || null, patches: []
            });
            groups.get(name).patches.push(patch);
        }
    }
    return [...groups.values()].sort((a, b) =>
        Number(!a.package_name) - Number(!b.package_name) || a.app_name.localeCompare(b.app_name));
}

export function filterPatchGroups(groups, query, matches) {
    return groups.flatMap(group => {
        const label = (group.app_name + " " + group.package_name).toLowerCase();
        const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
        const patches = terms.every(term => label.includes(term)) ? group.patches :
            group.patches.filter(patch => matches(patch, query));
        return patches.length ? [{ ...group, patches }] : [];
    });
}
