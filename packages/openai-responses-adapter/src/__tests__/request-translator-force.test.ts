import { afterEach, describe, expect, test } from "bun:test";
import { LATEST_SONNET_MODEL, setForceAccountModel } from "@better-ccflare/core";
import { translateRequestToAnthropic } from "../request-translator";
import type { ResponseItem, ResponsesRequest } from "../types";

function requestFor(model: string): ResponsesRequest & { input: ResponseItem[] } {
	return {
		model,
		input: [
			{
				type: "message",
				role: "user",
				content: [{ type: "input_text", text: "oi" }],
			},
		],
	} as ResponsesRequest & { input: ResponseItem[] };
}

describe("translateRequestToAnthropic - force account model", () => {
	afterEach(() => {
		// Process-wide switch: hand it back off for the next test file.
		setForceAccountModel(false);
	});

	test("with force on, a gpt-* model reaches routing exactly as requested", () => {
		setForceAccountModel(true);
		expect(translateRequestToAnthropic(requestFor("gpt-6.1-sol")).model).toBe(
			"gpt-6.1-sol",
		);
	});

	test("with force off, a gpt-* model still maps to a Claude family", () => {
		setForceAccountModel(false);
		expect(translateRequestToAnthropic(requestFor("gpt-6.1-sol")).model).toBe(
			LATEST_SONNET_MODEL,
		);
	});
});
