import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { getProvider } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	clearAnthropicModelCacheForTests,
	getAnthropicModels,
} from "../../anthropic-model-catalog";
import { clearCodexModelCacheForTests } from "../../codex-model-catalog";
import { selectAccountsForRequest } from "../account-selector";
import type { ProxyContext } from "../proxy-types";

/**
 * Routing when two Claude accounts are entitled to different models.
 *
 * Until 2026-10-21 the namespace rule was the whole answer for Anthropic ids:
 * "it is a Claude model, any Claude account will do". Measured that day on a
 * live gateway, that is false — one account lists `claude-mythos-5-1` and the
 * other answers `not_found_error` for it. Under the old rule the strategy
 * picks whichever account it likes and a client sees a 404 roughly half the
 * time, which looks like an outage and is a routing decision.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "anthropic-1",
		name: "has-mythos",
		provider: "anthropic",
		api_key: null,
		refresh_token: "rt",
		access_token: "token-one",
		expires_at: Date.now() + 3_600_000,
		created_at: Date.now(),
		request_count: 0,
		total_requests: 0,
		last_used: null,
		rate_limited_until: null,
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
		custom_endpoint: null,
		model_mappings: null,
		cross_region_mode: null,
		model_fallbacks: null,
		...overrides,
	} as Account;
}

const withMythos = makeAccount();
const withoutMythos = makeAccount({
	id: "anthropic-2",
	name: "no-mythos",
	access_token: "token-two",
});
const codexAccount = makeAccount({
	id: "codex-1",
	name: "codex-account",
	provider: "codex",
	access_token: "token-codex",
});

function makeRequestMeta(): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(),
	};
}

function makeCtx(accounts: Account[]): ProxyContext {
	return {
		strategy: { select: mock(() => accounts) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(
				async (id: string) =>
					accounts.find((account) => account.id === id) ?? null,
			),
			getActiveComboForFamily: mock(async () => null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock((fn: () => unknown) => fn()) },
		// biome-ignore lint/style/noNonNullAssertion: always registered here
		provider: getProvider("anthropic")!,
		config: {
			getForceAccountModel: () => true,
			getCombosEnabled: () => false,
		},
	} as unknown as ProxyContext;
}

let servedByToken: Record<string, string[]>;
let fetchCalls: number;
const originalFetch = globalThis.fetch;

beforeEach(() => {
	fetchCalls = 0;
	servedByToken = {
		"token-one": ["claude-opus-5", "claude-mythos-5-1"],
		"token-two": ["claude-opus-5"],
	};
	globalThis.fetch = (async (_url: string, init?: RequestInit) => {
		fetchCalls++;
		const bearer = (
			new Headers(init?.headers).get("authorization") ?? ""
		).replace(/^Bearer\s+/i, "");
		const ids = servedByToken[bearer];
		if (!ids) return new Response("unauthorized", { status: 401 });
		return new Response(
			JSON.stringify({
				data: ids.map((id) => ({ id, display_name: id })),
				has_more: false,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}) as typeof globalThis.fetch;
	clearAnthropicModelCacheForTests();
	clearCodexModelCacheForTests();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearAnthropicModelCacheForTests();
	clearCodexModelCacheForTests();
});

/** Populate both accounts' listings, the way real traffic would. */
async function primeListings(ctx: ProxyContext, accounts: Account[]) {
	for (const account of accounts) {
		await getAnthropicModels(account.id, ctx);
	}
	fetchCalls = 0;
}

describe("force account model — Claude accounts with different entitlements", () => {
	it("sends a model only one account lists to that account", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);
		await primeListings(ctx, [withMythos, withoutMythos]);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-mythos-5-1",
		);

		expect(result.map((a) => a.id)).toEqual(["anthropic-1"]);
		// The listings answered it; nothing had to be re-read.
		expect(fetchCalls).toBe(0);
	});

	it("prefers the account that lists it over one never read", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);
		// Only the first account has ever answered — the second is simply
		// unknown, not known to lack the model.
		await getAnthropicModels(withMythos.id, ctx);
		fetchCalls = 0;

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-mythos-5-1",
		);

		// Measured failure this guards: treating "unknown" as good as
		// "confirmed" let a 429 on the entitled account fail over to the one
		// that answers not_found_error, so the client was told the model does
		// not exist by an account that never had it.
		expect(result.map((a) => a.id)).toEqual(["anthropic-1"]);
		expect(fetchCalls).toBe(0);
	});

	it("keeps both accounts for a model both of them list", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);
		await primeListings(ctx, [withMythos, withoutMythos]);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-5",
		);

		expect(result.map((a) => a.id)).toEqual(["anthropic-1", "anthropic-2"]);
	});

	it("excludes nobody while no listing has been read", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-opus-5",
		);

		// Absent knowledge is not evidence of absence: the namespace rule still
		// lets both through, and the provider gets to answer.
		expect(result.map((a) => a.id)).toEqual(["anthropic-1", "anthropic-2"]);
	});

	it("re-reads live and routes to the account that has just gained it", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);
		await primeListings(ctx, [withMythos, withoutMythos]);
		// Anthropic ships a model after both listings were taken.
		servedByToken["token-one"] = [
			"claude-opus-5",
			"claude-mythos-5-1",
			"claude-mythos-6",
		];

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-mythos-6",
		);

		expect(fetchCalls).toBe(2);
		expect(result.map((a) => a.id)).toEqual(["anthropic-1"]);
	});

	it("lets the request go when the fresh listings still omit it", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);
		await primeListings(ctx, [withMythos, withoutMythos]);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-unreleased-9",
		);

		// Same promise the Codex path makes: a listing is evidence, not a
		// census, so the verdict comes from the provider rather than from here.
		expect(result.map((a) => a.id)).toEqual(["anthropic-1", "anthropic-2"]);
	});

	it("spends no read on an id that could not be Anthropic's anyway", async () => {
		const ctx = makeCtx([withMythos, withoutMythos]);
		await primeListings(ctx, [withMythos, withoutMythos]);

		await selectAccountsForRequest(makeRequestMeta(), ctx, "gpt-6.1-sol");

		// A Claude account cannot be handed a Codex id, and no listing of theirs
		// could ever say otherwise — so asking costs a round trip and settles
		// nothing.
		expect(fetchCalls).toBe(0);
	});

	it("still refuses to hand a Claude id to a non-Claude account", async () => {
		const ctx = makeCtx([codexAccount]);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"claude-mythos-5-1",
		);

		// The defect that started this: an unknown family read as "not a Claude
		// id" and the request left for a ChatGPT account, which answered about a
		// model it had never heard of.
		expect(result).toEqual([]);
	});
});
