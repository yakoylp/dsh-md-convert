import { test } from "node:test";
import assert from "node:assert/strict";
import { join as pathJoin, parse as pathParse, resolve as pathResolve } from "node:path";
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

test("execute resolves relative file against session cwd, not process.cwd()", async () => {
	const regs = await boot({});
	const def = regs[0];
	// 会话工作区与进程 cwd 不同:修复前会用 process.cwd() 解析相对路径导致 E_FILE_NOT_FOUND 指向错误目录。
	const sessionCwd = pathResolve(process.cwd(), "fake-workspace");
	const exec = { agent: { session: { header: { cwd: sessionCwd } } } };
	const r = await def.execute({ file: "测试.doc" }, exec);
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_FILE_NOT_FOUND");
	assert.equal(r.file, pathJoin(sessionCwd, "测试.doc"));
});

test("execute preserves an absolute file path regardless of session cwd", async () => {
	const regs = await boot({});
	const def = regs[0];
	// 带盘符/根的绝对路径应原样保留,不被拼接到 cwd 之后(回归: path.join 会把盘符拼坏)。
	const absFile = pathJoin(pathParse(process.cwd()).root, "办公室工作", "测试.doc");
	const exec = { agent: { session: { header: { cwd: pathResolve(process.cwd(), "elsewhere") } } } };
	const r = await def.execute({ file: absFile }, exec);
	assert.equal(r.ok, false);
	assert.equal(r.code, "E_FILE_NOT_FOUND");
	assert.equal(r.file, absFile);
});

/**
 * Validate a tool-returned value against the declared output schema, the way
 * the DSH runtime does after execute() — a schema/value mismatch here is
 * exactly the kind of bug that blocks the tool result from reaching the
 * conversation ("value.chain must be an array").
 */
function validateValue(value, schema, path = "$") {
	if (schema === undefined || schema === null) return [];
	if (schema.oneOf) {
		return schema.oneOf.some(branch => validateValue(value, branch, path).length === 0)
			? []
			: [`${path} must match one of oneOf`];
	}
	switch (schema.type) {
		case "object": {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				return [`${path} must be object`];
			}
			const violations = [];
			for (const key of schema.required ?? []) {
				if (!Object.hasOwn(value, key)) violations.push(`${path}.${key} is required`);
			}
			if (schema.additionalProperties === false) {
				for (const key of Object.keys(value)) {
					if (!(key in (schema.properties ?? {}))) violations.push(`${path}.${key} is not allowed`);
				}
			}
			for (const [key, sub] of Object.entries(schema.properties ?? {})) {
				if (Object.hasOwn(value, key)) violations.push(...validateValue(value[key], sub, `${path}.${key}`));
			}
			return violations;
		}
		case "array": {
			if (!Array.isArray(value)) return [`${path} must be array`];
			const violations = [];
			for (let index = 0; index < value.length; index++) {
				violations.push(...validateValue(value[index], schema.items, `${path}[${index}]`));
			}
			return violations;
		}
		case "string": return typeof value === "string" ? [] : [`${path} must be string`];
		case "boolean": return typeof value === "boolean" ? [] : [`${path} must be boolean`];
		case "number":
		case "integer": return typeof value === "number" ? [] : [`${path} must be ${schema.type}`];
		default: return [];
	}
}

test("execute() return values satisfy the declared output schema", async () => {
	const regs = await boot({});
	const schema = regs[0].output.schema;
	// chain 是字符串(如 "legacy(wps) → markitdown"),schema 必须与之匹配,
	// 否则 DSH 会以 "value.chain must be an array" 拦下工具结果。
	const success = { ok: true, output: "./md/report.md", chain: "legacy(wps) → markitdown", warnings: [] };
	const failure = { ok: false, code: "E_FILE_NOT_FOUND", file: "x.doc", error: "missing" };
	assert.deepEqual(validateValue(success, schema), []);
	assert.deepEqual(validateValue(failure, schema), []);
});
