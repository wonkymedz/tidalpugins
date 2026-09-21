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
