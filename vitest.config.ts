import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["plugins/*/src/**/*.test.ts"],
		environment: "node",
	},
});
