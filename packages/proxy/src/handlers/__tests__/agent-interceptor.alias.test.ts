import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setCustomModelAliases } from "@better-ccflare/core";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import type { ModelCatalog } from "../../model-catalog";
import {
	interceptAndModifyRequest,
	isRewriteTargetServable,
} from "../agent-interceptor";

const TEST_DB_PATH = path.join(os.tmpdir(), "bcf-interceptor-alias-test.db");

const ALIASES = {
	"claude-gpt-5.6-sol": { provider: "codex", model: "gpt-5.6-sol" },
};

function bodyFor(model: string): ArrayBuffer {
	const json = JSON.stringify({
		model,
		messages: [{ role: "user", content: "oi" }],
	});
	return new TextEncoder().encode(json).buffer as ArrayBuffer;
}

function modelOf(buffer: ArrayBuffer | null): string | null {
	if (!buffer) return null;
	return JSON.parse(new TextDecoder().decode(buffer)).model;
}

describe("interceptAndModifyRequest - registered model aliases", () => {
	let dbOps: DatabaseOperations;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.reset();
		// Process-global registry: hand it back empty or every later test file
		// in this bun process inherits these aliases.
		setCustomModelAliases({});
	});

	beforeEach(() => {
		setCustomModelAliases(ALIASES);
	});

	test("the alias id is replaced in the outgoing body by the real model", async () => {
		const result = await interceptAndModifyRequest(
			bodyFor("claude-gpt-5.6-sol"),
			dbOps,
		);
		expect(modelOf(result.modifiedBody)).toBe("gpt-5.6-sol");
	});

	test("routing sees the real model while the log keeps what the client sent", async () => {
		const result = await interceptAndModifyRequest(
			bodyFor("claude-gpt-5.6-sol"),
			dbOps,
		);
		// appliedModel is what account selection routes on; originalModel is the
		// only record that the client ever said "claude-gpt-5.6-sol".
		expect(result.appliedModel).toBe("gpt-5.6-sol");
		expect(result.originalModel).toBe("claude-gpt-5.6-sol");
	});

	test("the alias names the provider that must serve the request", async () => {
		const result = await interceptAndModifyRequest(
			bodyFor("claude-gpt-5.6-sol"),
			dbOps,
		);
		expect(result.aliasProvider).toBe("codex");
	});

	test("an unregistered id is left completely alone", async () => {
		const buffer = bodyFor("claude-opus-5");
		const result = await interceptAndModifyRequest(buffer, dbOps);
		expect(result.appliedModel).toBe("claude-opus-5");
		expect(result.aliasProvider).toBeNull();
		expect(result.modifiedBody).toBe(buffer);
	});

	test("an empty registry restores today's behaviour exactly", async () => {
		setCustomModelAliases({});
		const buffer = bodyFor("claude-gpt-5.6-sol");
		const result = await interceptAndModifyRequest(buffer, dbOps);
		expect(result.appliedModel).toBe("claude-gpt-5.6-sol");
		expect(result.modifiedBody).toBe(buffer);
	});

	test("a live catalog does not veto a registered alias", () => {
		// Without the alias exemption this is a veto: the id carries no family
		// word and the live catalog has never heard of it.
		const catalog: ModelCatalog = {
			models: [{ id: "claude-opus-5", displayName: "Opus 5", createdAt: null }],
			fetchedAt: Date.now(),
			source: "live",
		};
		expect(isRewriteTargetServable(catalog, "claude-gpt-5.6-sol")).toBe(true);
		expect(isRewriteTargetServable(catalog, "gpt-5.6-sol")).toBe(false);
	});
});
