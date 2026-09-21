/**
 * Shared inline icons.
 *
 * TIDAL ships its icons as inline SVGs, so TiDLoad injects its own the same way rather than pulling in an
 * icon font or an image. The download icon is used by the sidebar entry and the play queue button.
 */

/** Download arrow into a tray, drawn on a 24x24 grid. */
export const DOWNLOAD_ICON_PATH = "M11 3h2v8h3.5L12 16.5 7.5 11H11V3zM5 18h14v2H5z";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Replaces an existing icon's contents in place, keeping the size/class TIDAL gave it. */
export const applyDownloadIcon = (svg: Element): void => {
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "currentColor");
	svg.setAttribute("stroke", "none");
	svg.innerHTML = `<path d="${DOWNLOAD_ICON_PATH}"/>`;
};

/** A standalone icon for places where there is nothing to clone. */
export const createDownloadIcon = (size = 20): SVGSVGElement => {
	const svg = document.createElementNS(SVG_NAMESPACE, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("fill", "currentColor");
	svg.setAttribute("stroke", "none");
	svg.setAttribute("aria-hidden", "true");
	svg.innerHTML = `<path d="${DOWNLOAD_ICON_PATH}"/>`;
	return svg;
};

/** True for an element that is (or is inside) an SVG — never strip those when removing a label. */
export const isIconElement = (element: Element): boolean => element.closest("svg") !== null;

export type IconButtonOptions = {
	/** Marker attribute that identifies our button in the DOM. */
	attribute: string;
	/** Tooltip + accessible name. */
	label: string;
};

/**
 * Builds one of TiDLoad's injected toolbar buttons.
 *
 * TIDAL's own markup is cloned when available so padding, hover state and theming match, then the icon is
 * swapped for a download icon and the visible label is removed (the text becomes the tooltip). TIDAL's
 * test ids and element ids are scrubbed so nothing collides, and any inherited disabled state is cleared —
 * TIDAL renders some slots disabled, which would otherwise swallow our clicks.
 */
export const makeIconButton = (template: HTMLElement | undefined, options: IconButtonOptions): HTMLElement => {
	const button = template !== undefined ? (template.cloneNode(true) as HTMLElement) : document.createElement("button");
	if (template === undefined) button.className = "tidload-btn";

	for (const element of [button, ...button.querySelectorAll("[data-test]")]) element.removeAttribute("data-test");
	for (const element of [button, ...button.querySelectorAll("[id]")]) element.removeAttribute("id");
	button.removeAttribute("disabled");
	button.removeAttribute("aria-disabled");
	button.setAttribute(options.attribute, "true");
	button.setAttribute("type", "button");
	button.style.opacity = "1";
	button.style.pointerEvents = "auto";

	const svg = button.querySelector("svg");
	if (svg !== null) applyDownloadIcon(svg);
	else button.prepend(createDownloadIcon());

	// Drop any label text (and its wrapper text) but keep the elements TIDAL uses for padding/layout.
	for (const node of [...button.childNodes]) {
		if (node.nodeType === Node.TEXT_NODE) node.textContent = "";
	}
	for (const element of [...button.querySelectorAll<HTMLElement>("*")]) {
		if (isIconElement(element)) continue;
		if (element.children.length === 0 && (element.textContent ?? "").trim() !== "") element.textContent = "";
	}

	button.setAttribute("aria-label", options.label);
	button.setAttribute("title", options.label);

	return button;
};

/** Keeps a button's tooltip in sync without rebuilding it. */
export const setIconButtonLabel = (button: HTMLElement, label: string): void => {
	if (button.getAttribute("aria-label") === label) return;
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
};
