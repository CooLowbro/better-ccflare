import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvider } from "@better-ccflare/providers";
import type { Account } from "@better-ccflare/types";
import {
	clearAnthropicModelCacheForAccount,
	clearAnthropicModelCacheForTests,
	getAnthropicModels,
	getKnownAnthropicModels,
	initAnthropicModelCatalog,
	isAnthropicAccount,
	refreshAnthropicModelsForMissing,
	unionOfKnownAnthropicModels,
} from "../anthropic-model-catalog";
import type { ProxyContext } from "../handlers/proxy-types";

/**
 * Per-account entitlement, which is the thing a single gateway-wide catalog
 * cannot express.
 *
 * Measured on 2026-10-21 against the two Anthropic accounts of one live
 * gateway: `/v1/models` answered with 15 models for one and 14 for the other,
 * and the odd one out (`claude-mythos-5-1`) answers `not_found_error` on the
 * account that does not list it. Every case below is that shape.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "anthropic-1",
		name: "account-one",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "token-one",
		expires_at: Date.now() + 60 * 60 * 1000,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		billing_type: null,
		pause_reason: null,
		refresh_token_issued_at: null,
		consecutive_rate_limits: 0,
		...overrides,
	};
}

function makeCtx(accounts: Account[]): ProxyContext {
	return {
		strategy: {} as never,
		dbOps: {
			getAllAccounts: async () => accounts,
			getAccount: async (id: string) =>
				accounts.find((account) => account.id === id) ?? null,
			// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		} as any,
		runtime: { port: 8080, clientId: "test-client" } as never,
		config: {} as never,
		// biome-ignore lint/style/noNonNullAssertion: always registered here
		provider: getProvider("anthropic")!,
		refreshInFlight: new Map(),
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		asyncWriter: { enqueue: (fn: () => unknown) => fn() } as any,
	};
}

const TEST_CACHE_DIR = join(tmpdir(), "better-ccflare-test-anthropic-catalog");

const accountOne = makeAccount();
const accountTwo = makeAccount({
	id: "anthropic-2",
	name: "account-two",
	access_token: "token-two",
});

/** What each account's token is served, keyed by bearer token. */
let servedByToken: Record<string, string[]>;
/** Reads that actually went out, so suppression and freshness are testable. */
let fetchCalls: number;

function listingBody(ids: string[]): Response {
	return new Response(
		JSON.stringify({
			data: ids.map((id) => ({
				id,
				display_name: id,
				created_at: "2026-09-01T00:00:00Z",
				line: id.split("-")[1] ?? null,
			})),
			has_more: false,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

const originalFetch = globalThis.fetch;

beforeEach(async () => {
	process.env.BETTER_CCFLARE_MODELS_CACHE_DIR = TEST_CACHE_DIR;
	delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
	await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true });
	clearAnthropicModelCacheForTests();
	fetchCalls = 0;
	servedByToken = {
		"token-one": ["claude-opus-5", "claude-sonnet-5-5", "claude-mythos-5-1"],
		"token-two": ["claude-opus-5", "claude-sonnet-5-5"],
	};
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		fetchCalls++;
		const headers = new Headers(init?.headers);
		const bearer = (headers.get("authorization") ?? "").replace(
			/^Bearer\s+/i,
			"",
		);
		const ids = servedByToken[bearer];
		if (!ids) return new Response("unauthorized", { status: 401 });
		return listingBody(ids);
	}) as typeof globalThis.fetch;
});

afterEach(async () => {
	globalThis.fetch = originalFetch;
	clearAnthropicModelCacheForTests();
	await fs.rm(TEST_CACHE_DIR, { recursive: true, force: true });
	delete process.env.BETTER_CCFLARE_MODELS_CACHE_DIR;
	delete process.env.BETTER_CCFLARE_MODELS_OFFLINE;
});

describe("anthropic model catalog — per account", () => {
	it("reads one account's own listing and reports it as live", async () => {
		const ctx = makeCtx([accountOne]);

		const listing = await getAnthropicModels(accountOne.id, ctx);

		expect(listing?.source).toBe("live");
		expect(listing?.models.map((m) => m.id)).toEqual([
			"claude-opus-5",
			"claude-sonnet-5-5",
			"claude-mythos-5-1",
		]);
		// The family comes from the listing's own `line`, not from the id.
		expect(
			listing?.models.find((m) => m.id === "claude-mythos-5-1")?.line,
		).toBe("mythos");
	});

	it("never offers one account's listing as another's", async () => {
		const ctx = makeCtx([accountOne, accountTwo]);
		await getAnthropicModels(accountOne.id, ctx);

		// Nothing has been read for the second account, and the first account's
		// list is not an answer about it: these two are entitled to different
		// models, which is the whole reason this cache is per account.
		expect(getKnownAnthropicModels(accountTwo.id)).toBeNull();
	});

	it("keeps the two accounts' listings apart", async () => {
		const ctx = makeCtx([accountOne, accountTwo]);

		await getAnthropicModels(accountOne.id, ctx);
		await getAnthropicModels(accountTwo.id, ctx);

		expect(
			getKnownAnthropicModels(accountOne.id)?.models.map((m) => m.id),
		).toContain("claude-mythos-5-1");
		expect(
			getKnownAnthropicModels(accountTwo.id)?.models.map((m) => m.id),
		).not.toContain("claude-mythos-5-1");
	});

	it("serves a fresh listing from memory instead of reading again", async () => {
		const ctx = makeCtx([accountOne]);
		await getAnthropicModels(accountOne.id, ctx);
		expect(fetchCalls).toBe(1);

		const again = await getAnthropicModels(accountOne.id, ctx);

		expect(fetchCalls).toBe(1);
		expect(again?.source).toBe("cached");
	});

	it("keeps the last good listing when a later read fails", async () => {
		const ctx = makeCtx([accountOne]);
		await getAnthropicModels(accountOne.id, ctx);
		// The token stops being accepted; the account's entitlement did not
		// change, only our ability to ask about it.
		servedByToken = {};

		const listing = await getAnthropicModels(accountOne.id, ctx, {
			force: true,
		});

		expect(listing?.source).toBe("cached");
		expect(listing?.models.map((m) => m.id)).toContain("claude-mythos-5-1");
	});

	it("refuses to record an empty listing as the answer", async () => {
		const ctx = makeCtx([accountOne]);
		servedByToken = { "token-one": [] };

		const listing = await getAnthropicModels(accountOne.id, ctx);

		// Recording it would say this account is entitled to nothing, which
		// excludes it from every request under "force account model".
		expect(listing).toBeNull();
		expect(getKnownAnthropicModels(accountOne.id)).toBeNull();
	});

	it("does not treat a third-party endpoint as Anthropic entitlement", () => {
		const proxied = makeAccount({
			id: "anthropic-3",
			custom_endpoint: "https://example.invalid/v1",
		});

		expect(isAnthropicAccount(proxied)).toBe(false);
		expect(isAnthropicAccount(accountOne)).toBe(true);
	});
});

describe("anthropic model catalog — the union", () => {
	it("is every model at least one account lists, each once", async () => {
		const ctx = makeCtx([accountOne, accountTwo]);
		await getAnthropicModels(accountOne.id, ctx);
		await getAnthropicModels(accountTwo.id, ctx);

		expect(unionOfKnownAnthropicModels().map((m) => m.id)).toEqual([
			"claude-opus-5",
			"claude-sonnet-5-5",
			"claude-mythos-5-1",
		]);
	});

	it("is empty before any account has answered", () => {
		expect(unionOfKnownAnthropicModels()).toEqual([]);
	});

	it("drops an account's models once that account is gone", async () => {
		const ctx = makeCtx([accountOne, accountTwo]);
		await getAnthropicModels(accountOne.id, ctx);
		await getAnthropicModels(accountTwo.id, ctx);

		clearAnthropicModelCacheForAccount(accountOne.id);

		expect(unionOfKnownAnthropicModels().map((m) => m.id)).not.toContain(
			"claude-mythos-5-1",
		);
	});
});

describe("anthropic model catalog — across a restart", () => {
	it("serves what the previous run read, without going out again", async () => {
		const ctx = makeCtx([accountOne]);
		await getAnthropicModels(accountOne.id, ctx);
		// Give the fire-and-forget disk write a turn to land.
		await new Promise((resolve) => setTimeout(resolve, 20));

		// A restart: memory is empty, the file is not.
		clearAnthropicModelCacheForTests();
		expect(getKnownAnthropicModels(accountOne.id)).toBeNull();

		await initAnthropicModelCatalog();

		const restored = getKnownAnthropicModels(accountOne.id);
		expect(restored?.models.map((m) => m.id)).toContain("claude-mythos-5-1");
		// Routing consults this synchronously on the very first request, which
		// is why it has to survive the restart rather than be fetched later.
		expect(restored?.source).toBe("cached");
	});
});

describe("anthropic model catalog — a model nobody lists", () => {
	it("re-reads live and finds a model published since the last read", async () => {
		const ctx = makeCtx([accountOne]);
		await getAnthropicModels(accountOne.id, ctx);
		fetchCalls = 0;
		servedByToken["token-one"] = [
			"claude-opus-5",
			"claude-sonnet-5-5",
			"claude-mythos-5-1",
			"claude-mythos-6",
		];

		const looked = await refreshAnthropicModelsForMissing(
			[accountOne],
			"claude-mythos-6",
			ctx,
		);

		expect(looked).toBe(true);
		expect(fetchCalls).toBe(1);
		expect(
			getKnownAnthropicModels(accountOne.id)?.models.map((m) => m.id),
		).toContain("claude-mythos-6");
	});

	it("does not look again for a model already confirmed absent", async () => {
		const ctx = makeCtx([accountOne]);
		await getAnthropicModels(accountOne.id, ctx);
		fetchCalls = 0;

		expect(
			await refreshAnthropicModelsForMissing([accountOne], "claude-nope", ctx),
		).toBe(true);
		expect(fetchCalls).toBe(1);

		// A client retrying a model that does not exist must not turn every
		// attempt into a fresh read against every account.
		expect(
			await refreshAnthropicModelsForMissing([accountOne], "claude-nope", ctx),
		).toBe(false);
		expect(fetchCalls).toBe(1);
	});

	it("reports nothing to look at when no account is Anthropic's", async () => {
		const codex = makeAccount({ id: "codex-1", provider: "codex" });
		const ctx = makeCtx([codex]);

		expect(
			await refreshAnthropicModelsForMissing([codex], "claude-mythos-5-1", ctx),
		).toBe(false);
		expect(fetchCalls).toBe(0);
	});
});
