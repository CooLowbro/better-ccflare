import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { getModelFamily, isValidClaudeModel } from "./model-mappings";
import {
	isRegisteredAlias,
	listModelAliases,
	resolveModelAlias,
	setCustomModelAliases,
} from "./model-aliases";

beforeEach(() => {
	setCustomModelAliases({});
});

// The registry is process-global by design (see model-aliases.ts). Leaving it
// populated would reach every test file that runs after this one in the same
// bun process — which is exactly how this cleanup came to be written.
afterAll(() => {
	setCustomModelAliases({});
});

describe("model alias registry", () => {
	test("resolves a registered alias to its provider and model", () => {
		setCustomModelAliases({
			"claude-gpt-5.6-sol": { provider: "codex", model: "gpt-5.6-sol" },
		});
		expect(resolveModelAlias("claude-gpt-5.6-sol")).toEqual({
			provider: "codex",
			model: "gpt-5.6-sol",
		});
		expect(isRegisteredAlias("claude-gpt-5.6-sol")).toBe(true);
	});

	test("matches exactly — no case folding, no prefix stripping", () => {
		setCustomModelAliases({
			"claude-gpt-5.6-sol": { provider: "codex", model: "gpt-5.6-sol" },
		});
		expect(resolveModelAlias("CLAUDE-GPT-5.6-SOL")).toBeNull();
		expect(resolveModelAlias("gpt-5.6-sol")).toBeNull();
		expect(resolveModelAlias("claude-gpt-5.6-sol-1m")).toBeNull();
	});

	test("an unknown id is not an alias", () => {
		expect(resolveModelAlias("claude-opus-5")).toBeNull();
		expect(isRegisteredAlias("claude-opus-5")).toBe(false);
	});

	test("setting replaces the whole map, so an alias can be removed", () => {
		setCustomModelAliases({
			a: { provider: "codex", model: "x" },
			b: { provider: "codex", model: "y" },
		});
		setCustomModelAliases({ a: { provider: "codex", model: "x" } });
		expect(isRegisteredAlias("b")).toBe(false);
	});

	test("the registry copies, so a caller's later mutation cannot reach it", () => {
		const mine = { a: { provider: "codex", model: "x" } };
		setCustomModelAliases(mine);
		// biome-ignore lint/performance/noDelete: exercising caller mutation
		delete (mine as Record<string, unknown>).a;
		expect(isRegisteredAlias("a")).toBe(true);
		const listed = listModelAliases();
		delete (listed as Record<string, unknown>).a;
		expect(isRegisteredAlias("a")).toBe(true);
	});

	test("an alias id reports no model family — this is the point", () => {
		// The family words (fable/opus/sonnet/haiku) drive combo routing and
		// per-family capacity accounting. An alias must not smuggle one in: if
		// `claude-gpt-5.6-sol` reported a family, the request would be counted
		// and routed as that family while actually going to Codex.
		setCustomModelAliases({
			"claude-gpt-5.6-sol": { provider: "codex", model: "gpt-5.6-sol" },
		});
		expect(getModelFamily("claude-gpt-5.6-sol")).toBeNull();
		expect(isValidClaudeModel("claude-gpt-5.6-sol")).toBe(false);
		expect(isRegisteredAlias("claude-gpt-5.6-sol")).toBe(true);
	});
});
