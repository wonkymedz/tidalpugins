import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const stubs = fileURLToPath(new URL("./plugins/TiDLoad/test/luna-stubs.ts", import.meta.url));

export default defineConfig({
	resolve: {
		// TidaLuna's API only exists inside TIDAL; tests run against stand-ins instead.
		alias: {
			"@luna/core": stubs,
			"@luna/lib": stubs,
			"@luna/lib.native": stubs,
			"@luna/ui": stubs,
		},
	},
	test: {
		include: ["plugins/*/src/**/*.test.ts"],
		environment: "node",
	},
});
