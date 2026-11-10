import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { setCustomModelAliases } from "@better-ccflare/core";
import { isLocalWebSearchInScope } from "../artel-scope";

describe("isLocalWebSearchInScope", () => {
	beforeAll(() => {
		setCustomModelAliases({
			"claude-6.1-sol": { provider: "codex", model: "gpt-6.1-sol" },
			"claude-alias-anthropic": {
				provider: "anthropic",
				model: "claude-sonnet-5-5",
			},
		});
	});
	// O registro de aliases e global de processo: devolver vazio para nao vazar
	// para os arquivos de teste seguintes.
	afterAll(() => setCustomModelAliases({}));

	it("intercepts an alias served by a non-Anthropic provider", () => {
		expect(isLocalWebSearchInScope({ model: "claude-6.1-sol" })).toBe(true);
	});

	it("leaves real Claude models to Anthropic's own search", () => {
		expect(isLocalWebSearchInScope({ model: "claude-opus-5-5" })).toBe(false);
	});

	it("leaves an alias that points back to Anthropic alone", () => {
		expect(isLocalWebSearchInScope({ model: "claude-alias-anthropic" })).toBe(
			false,
		);
	});

	it("rejects bodies without a string model", () => {
		expect(isLocalWebSearchInScope(null)).toBe(false);
		expect(isLocalWebSearchInScope({})).toBe(false);
		expect(isLocalWebSearchInScope({ model: 7 })).toBe(false);
	});
});
