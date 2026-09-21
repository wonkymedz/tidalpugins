/**
 * In-app toasts.
 *
 * TidaLuna plugins have no access to OS notifications, so TiDLoad renders its own banner stack inside
 * the TIDAL window. Plain DOM (no React root to manage) with classes from page.css.
 */

import { settings } from "./settings";

export type ToastKind = "info" | "success" | "error";

export type ToastOptions = {
	kind?: ToastKind;
	timeout?: number;
	actionLabel?: string;
	onAction?: () => void;
};

let container: HTMLDivElement | undefined;

const ensureContainer = (): HTMLDivElement => {
	if (container !== undefined && container.isConnected) return container;
	container = document.createElement("div");
	container.className = "tidload-toasts";
	document.body.appendChild(container);
	return container;
};

export const toast = (message: string, options: ToastOptions = {}): (() => void) => {
	if (!settings.toasts && options.kind !== "error") return () => {};

	const host = ensureContainer();
	const element = document.createElement("div");
	element.className = `tidload-toast tidload-toast--${options.kind ?? "info"}`;

	const text = document.createElement("span");
	text.className = "tidload-toast__text";
	text.textContent = message;
	element.appendChild(text);

	const dismiss = () => {
		element.remove();
		if (container !== undefined && container.childElementCount === 0) {
			container.remove();
			container = undefined;
		}
	};

	if (options.actionLabel !== undefined && options.onAction !== undefined) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "tidload-toast__action";
		button.textContent = options.actionLabel;
		button.onclick = () => {
			dismiss();
			options.onAction?.();
		};
		element.appendChild(button);
	}

	host.appendChild(element);
	const timeout = options.timeout ?? (options.actionLabel !== undefined ? 9000 : 5000);
	const timer = window.setTimeout(dismiss, timeout);

	return () => {
		window.clearTimeout(timer);
		dismiss();
	};
};

/** Called on plugin unload so a reload does not leave orphaned toasts behind. */
export const removeToasts = (): void => {
	container?.remove();
	container = undefined;
};
