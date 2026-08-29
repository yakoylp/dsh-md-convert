import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import * as entry from "../lib/index.js";

/**
 * Boot the plugin through real cordis activation, mirroring how the DSH
 * Loader applies a function plugin ({ name, inject, apply } + config).
 * Catches boot-time-only failures (missing injected services, config
 * accessed through ctx instead of the apply() second argument).
 */
function boot(config) {
	const registrations = [];
	const ctx = new Context();
	ctx.provide("tools", {
		register(name, def) {
			registrations.push({ name, def });
			return () => {};
		},
	});
	const fiber = ctx.plugin(
		{ name: entry.name, inject: entry.inject, apply: entry.apply },
		config,
	);
	return fiber.then(() => registrations);
}

test("plugin activates with tools injected and registers md_convert", async () => {
	const regs = await boot({ outDir: "C:/tmp/out" });
	assert.equal(regs.length, 1);
	assert.equal(regs[0].name, "md_convert");
	assert.equal(typeof regs[0].def.run, "function");
});

test("plugin activates when the loader passes no config", async () => {
	const regs = await boot(undefined);
	assert.equal(regs.length, 1);
	assert.equal(regs[0].name, "md_convert");
});
