import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setCustomModelAliases } from "@better-ccflare/core";
import {
	DatabaseFactory,
	type DatabaseOperations,
} from "@better-ccflare/database";
import { interceptAndModifyRequest } from "../agent-interceptor";

const TEST_DB_PATH = path.join(
	os.tmpdir(),
	"bcf-interceptor-alias-passthrough-test.db",
);

const ALIASES = {
	"claude-6.1-sol": { provider: "codex", model: "gpt-6.1-sol" },
};

// Shape the Responses adapter forwards to /v1/messages: the client's model is
// kept twice, once in `model` and once in the Codex side channel.
function responsesBodyFor(model: string, passthroughModel: string): ArrayBuffer {
	const json = JSON.stringify({
		model,
		messages: [{ role: "user", content: "oi" }],
		__better_ccflare_codex_passthrough: { model: passthroughModel },
	});
	return new TextEncoder().encode(json).buffer as ArrayBuffer;
}

function parse(buffer: ArrayBuffer | null): Record<string, any> {
	if (!buffer) throw new Error("no body");
	return JSON.parse(new TextDecoder().decode(buffer));
}

describe("interceptAndModifyRequest - alias in the Codex side channel", () => {
	let dbOps: DatabaseOperations;

	beforeAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.initialize(TEST_DB_PATH);
		dbOps = DatabaseFactory.getInstance();
	});

	afterAll(() => {
		if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
		DatabaseFactory.reset();
		setCustomModelAliases({});
	});

	beforeEach(() => {
		setCustomModelAliases(ALIASES);
	});

	test("the side-channel copy of the alias is resolved too", async () => {
		const result = await interceptAndModifyRequest(
			responsesBodyFor("claude-6.1-sol", "claude-6.1-sol"),
			dbOps,
		);
		const body = parse(result.modifiedBody);
		expect(body.model).toBe("gpt-6.1-sol");
		expect(body.__better_ccflare_codex_passthrough.model).toBe("gpt-6.1-sol");
	});

	test("a side-channel model that is not the alias is left alone", async () => {
		const result = await interceptAndModifyRequest(
			responsesBodyFor("claude-6.1-sol", "gpt-6-luna"),
			dbOps,
		);
		expect(parse(result.modifiedBody).__better_ccflare_codex_passthrough.model).toBe(
			"gpt-6-luna",
		);
	});

	test("without an alias the body is not touched", async () => {
		const buffer = responsesBodyFor("gpt-6.1-sol", "gpt-6.1-sol");
		const result = await interceptAndModifyRequest(buffer, dbOps);
		expect(result.modifiedBody).toBe(buffer);
	});
});
