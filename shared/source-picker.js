// The hidden select remains the state holder; the visible control opens a dialog.
export function matchingSources(options, query) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => !option.value || terms.every(term =>
        (option.label + " " + option.value).toLowerCase().includes(term)));
}
export function createSourcePicker({ button, select, onSelect, escapeHtml: escape }) {
    let dialog, previousFocus, refresh;
    function sync() {
        button.querySelector("[data-source-label]").textContent =
            [...select.options].find(option => option.value === select.value)?.label || "All sources";
        if (dialog?.open) refresh?.();
    }
    function open() {
        previousFocus = document.activeElement;
        if (!dialog) {
            dialog = document.createElement("dialog");
            dialog.className = "catalog-dialog source-dialog";
            dialog.setAttribute("aria-labelledby", "source-picker-title");
            document.body.appendChild(dialog);
            dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
            const dismiss = event => { event.preventDefault(); dialog.close(); };
            dialog.addEventListener("cancel", dismiss);
            dialog.addEventListener("keydown", event => {
                if (event.key === "Escape") dismiss(event);
            });
            dialog.addEventListener("close", () => {
                if (dialog.open) return;
                button.setAttribute("aria-expanded", "false");
                if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
            });
        }
        dialog.innerHTML = '<div class="details-heading"><div><h2 id="source-picker-title">Choose a source</h2></div>' +
            '<button class="dialog-close" type="button" aria-label="Close sources">×</button></div>' +
            '<div class="details-toolbar"><input class="details-search" type="search" aria-label="Search sources" placeholder="Search repositories or hosts...">' +
            '<span class="details-count" aria-live="polite"></span></div><div class="details-body source-options"></div>';
        const search = dialog.querySelector(".details-search"), body = dialog.querySelector(".source-options");
        function render() {
            const options = matchingSources([...select.options], search.value);
            const focused = body.contains?.(document.activeElement) ? document.activeElement.dataset.source : undefined;
            body.innerHTML = options.map(option =>
                `<button type="button" class="source-option" data-source="${escape(option.value)}" aria-pressed="${option.value === select.value}">
                    <strong>${escape(option.label)}</strong>${option.value ? `<span>${escape(option.value)}</span>` : ""}</button>`).join("");
            const count = options.filter(option => option.value).length;
            dialog.querySelector(".details-count").textContent = count + (count === 1 ? " source" : " sources");
            body.querySelectorAll("[data-source]").forEach(option => {
                if (option.dataset.source === focused) option.focus({ preventScroll: true });
                option.addEventListener("click", () => {
                    select.value = option.dataset.source;
                    dialog.close();
                    sync();
                    void onSelect(select.value);
                });
            });
        }
        refresh = render;
        search.addEventListener("input", render);
        dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
        render();
        button.setAttribute("aria-expanded", "true");
        dialog.showModal();
        search.focus();
    }
    button.addEventListener("click", open);
    return {sync, open};
}

