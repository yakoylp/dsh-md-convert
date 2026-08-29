import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import * as entry from "../lib/index.js";

/** Mirror of the real ToolRuntime.register() enforcement subset. */
const SUPPORTED_KEYWORDS = new Set([
	"type", "oneOf", "properties", "required", "additionalProperties",
	"items", "enum", "const", "description", "title", "default", "examples",
]);

function assertSupportedSchema(node, path) {
	assert.equal(typeof node, "object", `${path} must be an object`);
	for (const key of Object.keys(node)) {
		assert.ok(SUPPORTED_KEYWORDS.has(key), `${path}.${key} is not a supported keyword`);
	}
	if (Object.hasOwn(node, "required")) {
		assert.equal(node.type, "object", `${path}.required is only supported on object`);
		assert.ok(Array.isArray(node.required), `${path}.required must be an array`);
	}
	if (node.type === "object") {
		if (Object.hasOwn(node, "additionalProperties")) {
			assert.equal(typeof node.additionalProperties, "boolean", `${path}.additionalProperties must be a boolean`);
		}
		for (const [key, value] of Object.entries(node.properties ?? {})) {
			assertSupportedSchema(value, `${path}.properties.${key}`);
		}
	}
	if (node.type === "array" && node.items) {
		assertSupportedSchema(node.items, `${path}.items`);
	}
}

/**
 * Boot the plugin through real cordis activation, mirroring how the DSH
 * Loader applies a function plugin ({ name, inject, apply } + config).
 * The fake `tools` service enforces the same registration contract as the
 * real ToolRuntime.register(definition), so a malformed definition fails
 * this test instead of the next dsh boot.
 */
function boot(config) {
	const registrations = [];
	const ctx = new Context();
	ctx.provide("tools", {
		register(definition) {
			assert.equal(typeof definition, "object", "register must receive one ToolDefinition object");
			assert.equal(typeof definition.name, "string", "definition.name must be a string");
			assert.equal(typeof definition.description, "string", "definition.description must be a string");
			assert.equal(typeof definition.output, "object", "definition.output is required");
			assert.equal(typeof definition.output.schema, "object", "definition.output.schema is required");
			assert.equal(typeof definition.output.render, "function", "definition.output.render is required");
			assert.equal(typeof definition.execute, "function", "definition.execute is required");
			assertSupportedSchema(definition.parameters, "parameters");
			assertSupportedSchema(definition.output.schema, "schema");
			registrations.push(definition);
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
	assert.deepEqual(regs[0].parameters.required, ["file"]);
	assert.deepEqual(regs[0].output.schema.required, ["ok"]);
	assert.equal(typeof regs[0].execute, "function");
});

test("plugin activates when the loader passes no config", async () => {
	const regs = await boot(undefined);
	assert.equal(regs.length, 1);
	assert.equal(regs[0].name, "md_convert");
});
