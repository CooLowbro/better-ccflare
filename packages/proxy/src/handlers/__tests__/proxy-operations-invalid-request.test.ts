import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ValidationError } from "@better-ccflare/core";
import type { Account, RequestMeta } from "@better-ccflare/types";
import { proxyWithAccount } from "../proxy-operations";
import type { ProxyContext } from "../proxy-types";

/**
 * A request the provider rejects as invalid is the client's error. Every other
 * account would reject it the same way, so failing over only ended in "all
 * accounts failed" and a 503 that hid the real message (measured 2026-11-02
 * with reasoning.effort "none").
 */

function makeAccount(): Account {
	return {
		id: "acc-invalid",
		name: "invalid-test",
		provider: "teste-pedido-invalido",
		api_key: "test-key",
		refresh_token: "",
		access_token: null,
		expires_at: null,
		request_count: 0,
		total_requests: 0,
		last_used: null,
		created_at: Date.now(),
		rate_limited_until: null,
		rate_limited_reason: null,
		rate_limited_at: null,
		session_start: null,
		session_request_count: 0,
		paused: false,
		rate_limit_reset: null,
		rate_limit_status: null,
		rate_limit_remaining: null,
		priority: 0,
		auto_fallback_enabled: false,
		auto_refresh_enabled: false,
		auto_pause_on_overage_enabled: false,
		peak_hours_pause_enabled: false,
		custom_endpoint: "https://openrouter.ai/api/v1",
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
	} as Account;
}

function makeContext(): ProxyContext {
	return {
		strategy: { getNextAccount: () => null } as never,
		dbOps: {
			markAccountRateLimited: mock(() =>
				Promise.resolve({ consecutiveRateLimits: 1, applied: true }),
			),
			saveRequest: mock(() => Promise.resolve()),
			updateAccountUsage: mock(() => Promise.resolve()),
			getAdapter: mock(() => ({
				run: mock(() => Promise.resolve()),
				get: mock(() => Promise.resolve(null)),
			})),
		} as never,
		runtime: { port: 8080, clientId: "test" } as never,
		provider: {
			name: "teste-pedido-invalido",
			canHandle: () => true,
			buildUrl: () => "https://openrouter.ai/api/v1/messages",
			prepareHeaders: () => new Headers(),
			transformRequestBody: async () => {
				throw new ValidationError(
					"reasoning.effort must be one of: minimal, low",
					"reasoning.effort",
					"bogus",
				);
			},
			processResponse: async (r: Response) => r,
			parseRateLimit: () => ({
				isRateLimited: false,
				resetTime: undefined,
				statusHeader: "allowed",
				remaining: undefined,
			}),
			isStreamingResponse: () => false,
		} as never,
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) } as never,
		config: { getStorePayloads: () => false } as never,
		internalProbeSecret: "test-secret",
	};
}

describe("proxyWithAccount: invalid request", () => {
	let originalFetch: typeof globalThis.fetch;
	let fetchCalls = 0;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		fetchCalls = 0;
		globalThis.fetch = mock(async () => {
			fetchCalls++;
			return new Response("{}", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("answers 400 with the validation message instead of failing over", async () => {
		const body = new TextEncoder().encode(
			JSON.stringify({ model: "gpt-6.1-terra", messages: [], max_tokens: 10 }),
		).buffer as ArrayBuffer;
		const requestMeta: RequestMeta = {
			id: "req-invalid",
			method: "POST",
			path: "/v1/messages",
			timestamp: Date.now(),
			headers: new Headers(),
		};
		const response = await proxyWithAccount(
			new Request("https://proxy.local/v1/messages", {
				method: "POST",
				body,
				headers: { "Content-Type": "application/json" },
			}),
			new URL("https://proxy.local/v1/messages"),
			makeAccount(),
			requestMeta,
			body,
			() => undefined,
			0,
			makeContext(),
		);

		expect(response).not.toBeNull();
		expect(response?.status).toBe(400);
		const json = (await response?.json()) as {
			error: { type: string; message: string };
		};
		expect(json.error.type).toBe("invalid_request_error");
		expect(json.error.message).toContain("reasoning.effort");
		expect(fetchCalls).toBe(0);
	});
});
