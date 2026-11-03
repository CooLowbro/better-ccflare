/*
 * Copyright (c) 2026 Gili Tzabari. All rights reserved.
 *
 * Licensed under the CAT Commercial License.
 * See LICENSE.md in the project root for license terms.
 */
import { describe, expect, it } from "bun:test";
import {
	getSupportedReasoningEfforts,
	resolveReasoningEffort,
	validateReasoningEffort,
} from "./reasoning";

describe("reasoning effort support", () => {
	it("exposes supported Claude and Codex effort matrices", () => {
		expect(getSupportedReasoningEfforts("claude-sonnet-4-6")).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		expect(getSupportedReasoningEfforts("claude-haiku-4-5")).toEqual([
			"low",
			"medium",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.3-codex")).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
		]);
		expect(getSupportedReasoningEfforts("gpt-5.4-mini")).toEqual([
			"low",
			"medium",
		]);
	});

	it("accepts valid reasoning effort for supported Claude and Codex models", () => {
		expect(
			validateReasoningEffort("xhigh", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toBe("xhigh");
	});

	it("downgrades unsupported effort to nearest lower supported level", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "gpt-5.4-mini",
		});
		expect(resolved.effort).toBe("medium");
		expect(resolved.downgrades).toEqual([
			{
				model: "gpt-5.4-mini",
				from: "xhigh",
				to: "medium",
			},
		]);
	});

	it("rejects unsupported reasoning effort values", () => {
		expect(() =>
			validateReasoningEffort("extreme", {
				sourceModel: "claude-sonnet-4-6",
				targetModel: "gpt-5.3-codex",
			}),
		).toThrow(
			"reasoning.effort must be one of: none, minimal, low, medium, high, xhigh, max",
		);
	});

	it("accepts none and passes it through to a model that supports it", () => {
		const gpt6 = resolveReasoningEffort("none", {
			sourceModel: "gpt-6.1-terra",
			targetModel: "gpt-6.1-terra",
		});
		expect(gpt6).toEqual({ effort: "none", downgrades: [] });
		const gpt56 = resolveReasoningEffort("none", {
			sourceModel: "gpt-5.6-terra",
			targetModel: "gpt-5.6-terra",
		});
		expect(gpt56).toEqual({ effort: "none", downgrades: [] });
	});

	it("clamps none up to the minimum on a model without it", () => {
		expect(
			validateReasoningEffort("none", {
				sourceModel: "gpt-5.4-mini",
				targetModel: "gpt-5.4-mini",
			}),
		).toBe("low");
	});

	it("passes through effort unchanged when target model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-sonnet-4-6",
			targetModel: "unknown-model-xyz",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});

	it("passes through effort unchanged when source model is unknown", () => {
		const resolved = resolveReasoningEffort("xhigh", {
			sourceModel: "claude-future-model-99",
			targetModel: "gpt-5.3-codex",
		});
		expect(resolved.effort).toBe("xhigh");
		expect(resolved.downgrades).toEqual([]);
	});
});
