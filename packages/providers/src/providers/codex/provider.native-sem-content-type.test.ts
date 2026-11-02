import { describe, expect, it } from "bun:test";
import { CodexProvider } from "./provider";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function event(type: string, data: Record<string, unknown>): string {
	return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const CREATED = event("response.created", {
	response: { id: "resp_1", status: "in_progress", output: [] },
});
const COMPLETED = event("response.completed", {
	response: {
		id: "resp_1",
		status: "completed",
		model: "gpt-6.1-terra",
		output: [],
		usage: { input_tokens: 36, output_tokens: 16, total_tokens: 52 },
	},
});

// chatgpt.com answered the Codex endpoint without any content-type (measured
// 2026-11-02); these responses mirror that.
describe("CodexProvider native Responses without content-type", () => {
	it("streams an SSE body live and labels it text/event-stream", async () => {
		const provider = new CodexProvider();
		let upstream!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				upstream = controller;
				controller.enqueue(encoder.encode(CREATED));
			},
		});

		const response = await provider.processResponse(
			new Response(body, {
				status: 200,
				headers: { "x-better-ccflare-native-responses": "true" },
			}),
			null,
		);

		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("x-better-ccflare-codex-response-format")).toBe(
			"responses-api",
		);

		// The first event is readable while upstream is still open: no buffering.
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(decoder.decode(first.value)).toBe(CREATED);

		upstream.enqueue(encoder.encode(COMPLETED));
		upstream.close();
		let rest = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			rest += decoder.decode(value, { stream: true });
		}
		expect(rest).toBe(COMPLETED);
	});

	it("leaves a non-SSE body untouched", async () => {
		const provider = new CodexProvider();
		const json = JSON.stringify({ id: "resp_2", status: "completed", output: [] });

		const response = await provider.processResponse(
			new Response(json, {
				status: 200,
				headers: { "x-better-ccflare-native-responses": "true" },
			}),
			null,
		);

		expect(response.headers.get("content-type")).not.toBe("text/event-stream");
		expect(await response.text()).toBe(json);
	});
});
