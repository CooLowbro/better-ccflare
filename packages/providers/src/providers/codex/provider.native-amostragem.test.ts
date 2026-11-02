import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

function nativeRequest(): Request {
	return new Request("https://example.com/v1/messages", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-better-ccflare-native-responses": "true",
		},
		body: JSON.stringify({
			model: "gpt-6.1-terra",
			max_tokens: 10,
			messages: [{ role: "user", content: "oi" }],
			__better_ccflare_codex_passthrough: {
				model: "gpt-6.1-terra",
				temperature: 0,
				top_p: 1,
			},
		}),
	});
}

// The subscription endpoint answers HTTP 400 "Unsupported parameter:
// temperature" on every model (measured 2026-11-02).
describe("CodexProvider native sampling controls", () => {
	it("drops temperature and top_p for the subscription endpoint", async () => {
		const provider = new CodexProvider();
		const account = { id: "acc-sub" } as Parameters<
			typeof provider.transformRequestBody
		>[1];
		const body = await (
			await provider.transformRequestBody(nativeRequest(), account)
		).json();
		expect(body.model).toBe("gpt-6.1-terra");
		expect(body.temperature).toBeUndefined();
		expect(body.top_p).toBeUndefined();
	});

	it("keeps them for a custom endpoint", async () => {
		const provider = new CodexProvider();
		const account = {
			id: "acc-custom",
			custom_endpoint: "https://proxy.example.com/v1/responses",
		} as Parameters<typeof provider.transformRequestBody>[1];
		const body = await (
			await provider.transformRequestBody(nativeRequest(), account)
		).json();
		expect(body.temperature).toBe(0);
		expect(body.top_p).toBe(1);
	});
});
