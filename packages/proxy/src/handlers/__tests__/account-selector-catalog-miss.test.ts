import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { clearDerivedProviderModelDefaults } from "@better-ccflare/providers";
import type { Account, RequestMeta } from "@better-ccflare/types";
import {
	clearCodexModelCacheForTests,
	getCodexModels,
} from "../../codex-model-catalog";
import { selectAccountsForRequest } from "../account-selector";
import type { ProxyContext } from "../proxy-types";

/**
 * What happens under "force account model" when no listing mentions the model.
 *
 * The listing is evidence, not a census. Measured against a live account on
 * 2026-10-05: `gpt-6.1-sol` is absent from `/backend-api/codex/models` while
 * the same token runs it to completion on `/backend-api/codex/responses` —
 * HTTP 200, `response.completed`. A gateway that reads the listing as a
 * verdict answers 503 for a model the account serves, and words it as if an
 * upstream had refused when no upstream was ever asked. That 503 was returned
 * 203 times in 72 hours before this.
 *
 * So a miss escalates: re-read live first, in case the model is simply newer
 * than our copy, and failing that let the request go and be judged by the
 * provider.
 */

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "codex-1",
		name: "codex-account",
		provider: "codex",
		api_key: null,
		refresh_token: "rt",
		access_token: "at",
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

const codexAccount = makeAccount();
const claudeAccount = makeAccount({
	id: "claude-1",
	name: "claude-account",
	provider: "anthropic",
});

function makeRequestMeta(headers: Record<string, string> = {}): RequestMeta {
	return {
		id: "req-1",
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		headers: new Headers(headers),
	};
}

function makeCtx(accounts: Account[]): ProxyContext {
	return {
		strategy: { select: mock(() => accounts) },
		dbOps: {
			getAllAccounts: mock(async () => accounts),
			getAccount: mock(async (id: string) =>
				accounts.find((account) => account.id === id),
			),
			getActiveComboForFamily: mock(async () => null),
		},
		refreshInFlight: new Map(),
		asyncWriter: { enqueue: mock(() => {}) },
		config: {
			getForceAccountModel: () => true,
			getCombosEnabled: () => false,
		},
	} as unknown as ProxyContext;
}

/** A listing in the shape OpenAI returns, carrying exactly these models. */
function listingOf(...slugs: string[]): Response {
	return new Response(
		JSON.stringify({
			models: slugs.map((slug, index) => ({
				slug,
				display_name: slug,
				visibility: "list",
				priority: index + 1,
			})),
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

let originalFetch: typeof globalThis.fetch;
/** Every listing read that actually went out, so the suppression is testable. */
let fetchCalls: number;
/** What the next listing read returns. Reassigned mid-test on purpose. */
let served: string[];

beforeEach(() => {
	originalFetch = globalThis.fetch;
	fetchCalls = 0;
	served = ["gpt-5.6-sol"];
	globalThis.fetch = (async () => {
		fetchCalls++;
		return listingOf(...served);
	}) as typeof globalThis.fetch;
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	clearCodexModelCacheForTests();
	clearDerivedProviderModelDefaults();
});

/** Populate the account's own listing, the way a first request would. */
async function primeListing(account: Account, ctx: ProxyContext) {
	await getCodexModels(account.id, ctx);
	fetchCalls = 0;
}

describe("force account model — a model the listings do not mention", () => {
	it("still narrows to the accounts that list it, and reads nothing live", async () => {
		const ctx = makeCtx([codexAccount, claudeAccount]);
		await primeListing(codexAccount, ctx);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-5.6-sol",
		);

		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
		// The listing answered the question; nothing had to be re-read.
		expect(fetchCalls).toBe(0);
	});

	it("re-reads live, and serves the model once the fresh listing names it", async () => {
		const ctx = makeCtx([codexAccount]);
		await primeListing(codexAccount, ctx);
		// OpenAI publishes it after our copy was taken — indistinguishable from
		// a model that does not exist, until someone looks again.
		served = ["gpt-5.6-sol", "gpt-6.1-sol"];

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-6.1-sol",
		);

		expect(fetchCalls).toBe(1);
		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
	});

	it("lets the request go to the provider when the fresh listing still omits it", async () => {
		const ctx = makeCtx([codexAccount, claudeAccount]);
		await primeListing(codexAccount, ctx);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-6.1-sol",
		);

		expect(fetchCalls).toBe(1);
		// This is the measured case. The account does serve it; only the listing
		// disagrees, and the provider is the one entitled to answer.
		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
	});

	it("does not re-read the listings again for a model already confirmed absent", async () => {
		const ctx = makeCtx([codexAccount]);
		await primeListing(codexAccount, ctx);

		await selectAccountsForRequest(makeRequestMeta(), ctx, "gpt-6.1-sol");
		expect(fetchCalls).toBe(1);

		// A client retrying a model nobody lists must not turn each attempt into
		// a fresh download of every listing: measured at ~550 KB per account,
		// retried 203 times in 72 hours.
		const again = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-6.1-sol",
		);

		expect(fetchCalls).toBe(1);
		expect(again.map((a) => a.id)).toEqual(["codex-1"]);
	});

	it("never hands the id to a provider it cannot travel to", async () => {
		const ctx = makeCtx([claudeAccount]);

		const result = await selectAccountsForRequest(
			makeRequestMeta(),
			ctx,
			"gpt-6.1-sol",
		);

		// Letting a miss through is about the listing being incomplete, not about
		// abandoning the rule: a Claude account cannot be sent a Codex id, and
		// that is knowable here without asking anyone.
		expect(result).toEqual([]);
	});

	it("lets a pinned account serve a model its own listing omits", async () => {
		const ctx = makeCtx([codexAccount, claudeAccount]);
		await primeListing(codexAccount, ctx);

		const result = await selectAccountsForRequest(
			makeRequestMeta({ "x-better-ccflare-account-id": "codex-1" }),
			ctx,
			"gpt-6.1-sol",
		);

		// The header names the account; the listing not mentioning the model is
		// no more a verdict here than it is in ordinary selection.
		expect(result.map((a) => a.id)).toEqual(["codex-1"]);
	});

	it("still refuses a pinned account the id cannot travel to", async () => {
		const ctx = makeCtx([codexAccount, claudeAccount]);

		const result = await selectAccountsForRequest(
			makeRequestMeta({ "x-better-ccflare-account-id": "claude-1" }),
			ctx,
			"gpt-6.1-sol",
		);

		expect(result).toEqual([]);
	});
});
