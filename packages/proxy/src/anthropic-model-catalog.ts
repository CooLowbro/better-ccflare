/**
 * Models each Anthropic account can actually call.
 *
 * The sibling `model-catalog.ts` answers a different question — "which models
 * exist at Anthropic" — with a single list for the whole gateway, read from
 * whichever account happened to be eligible. That is the right shape for a
 * dropdown and the wrong shape for routing, because entitlement is per
 * account.
 *
 * Measured on 2026-10-21 against two live OAuth accounts of one gateway:
 * `/v1/models` returned 15 models for one and 14 for the other, and the model
 * only one of them lists (`claude-mythos-5-1`) answers `not_found_error` on
 * the other. A gateway holding one list for both either hides a model from
 * the account that has it, or routes it to the account that does not.
 *
 * Shaped after `codex-model-catalog.ts`, with two deliberate differences,
 * both of which are the point of this module:
 *
 *  - **No borrowing.** Codex falls back to another account's listing when an
 *    account cannot produce its own, because two ChatGPT logins generally see
 *    the same models. Here the measured fact is the opposite, so a borrowed
 *    list is never offered — not even labelled. Absent knowledge is reported
 *    as absent.
 *  - **Persisted to disk.** Codex deliberately keeps nothing across restarts.
 *    That choice costs one extra read per account per boot, which is fine for
 *    an endpoint built for polling and not fine here: recurring background
 *    traffic against a consumer OAuth account is what `model-catalog.ts`
 *    restricts for fear of an account flag, and a restart loop would turn
 *    every boot into another round of reads. The staleness this introduces is
 *    bounded by the escalation in `refreshAnthropicModelsForMissing`: a model
 *    nobody lists triggers a live re-read before anyone is excluded.
 */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "@better-ccflare/logger";
import type { Account } from "@better-ccflare/types";
import type { ProxyContext } from "./handlers/proxy-types";
import {
	ANTHROPIC_ACCOUNT_PROVIDERS,
	fetchModelsForAccount,
	type ModelCatalogEntry,
} from "./model-catalog";

const log = new Logger("AnthropicModelCatalog");

export interface AnthropicModelListing {
	accountId: string;
	models: ModelCatalogEntry[];
	fetchedAt: number;
	/** "live" straight from Anthropic, "cached" this account's own earlier read. */
	source: "live" | "cached";
}

/** How long a confirmed absence suppresses another live read of that model. */
const ABSENCE_TTL_MS = 10 * 60_000;

/**
 * How long a listing is served without being re-read. Anthropic ships a model
 * every few weeks, so a day is well inside the window where the answer is
 * still right, and it keeps a busy gateway to one read per account per day.
 */
const LISTING_TTL_MS = 24 * 60 * 60 * 1000;

/** Last good listing per account id. */
const lastGood = new Map<string, AnthropicModelListing>();

/** Accounts with a read already in flight, so a burst triggers one read. */
const inFlight = new Set<string>();

/** Models a live read has already shown to be absent from every account. */
const confirmedAbsentAt = new Map<string, number>();

let diskLoadAttempted = false;

function getCachePath(): string {
	const dir =
		process.env.BETTER_CCFLARE_MODELS_CACHE_DIR ||
		join(tmpdir(), "better-ccflare");
	return join(dir, "anthropic-models-by-account.json");
}

/** Whether this account is served by the Anthropic listing endpoint at all. */
export function isAnthropicAccount(account: Account): boolean {
	// A `custom_endpoint` points the adapter at a third party that answers the
	// same routes with its own models. Reading that as this account's Anthropic
	// entitlement would exclude it from every real Claude model it can serve.
	return (
		ANTHROPIC_ACCOUNT_PROVIDERS.has(account.provider) &&
		!account.custom_endpoint
	);
}

interface PersistedListings {
	version: 1;
	listings: AnthropicModelListing[];
}

async function loadFromDisk(): Promise<void> {
	if (diskLoadAttempted) return;
	diskLoadAttempted = true;
	try {
		const parsed = JSON.parse(
			await fs.readFile(getCachePath(), "utf-8"),
		) as PersistedListings;
		for (const listing of parsed.listings ?? []) {
			if (
				typeof listing?.accountId === "string" &&
				Array.isArray(listing.models) &&
				typeof listing.fetchedAt === "number"
			) {
				lastGood.set(listing.accountId, { ...listing, source: "cached" });
			}
		}
	} catch {
		// No cache yet, or an unreadable one: start empty. Callers must have an
		// answer for "we do not know" that is not "refuse".
	}
}

async function saveToDisk(): Promise<void> {
	try {
		const path = getCachePath();
		await fs.mkdir(join(path, ".."), { recursive: true });
		const payload: PersistedListings = {
			version: 1,
			listings: [...lastGood.values()],
		};
		await fs.writeFile(path, JSON.stringify(payload, null, 2));
	} catch (error) {
		log.warn("Could not persist the per-account model listings: %s", error);
	}
}

/**
 * Load the persisted listings into memory. Call once at startup; everything
 * else here loads lazily anyway, so a missed call costs a first-request read
 * rather than correctness.
 */
export async function initAnthropicModelCatalog(): Promise<void> {
	await loadFromDisk();
	if (lastGood.size > 0) {
		log.info(
			`Loaded model listings for ${lastGood.size} Anthropic account(s) from cache`,
		);
	}
}

/**
 * What this account itself already told us it can serve, or null.
 *
 * Never fetches and never borrows: it answers "do we know, for this account,
 * first-hand?" — the only form of knowledge strong enough to exclude an
 * account from routing. Account selection runs per request, so a network call
 * here is out of the question.
 *
 * Synchronous by necessity (the selector is hot), so it reads only what is
 * already in memory; `initAnthropicModelCatalog` is what puts the persisted
 * listings there.
 */
export function getKnownAnthropicModels(
	accountId: string,
): AnthropicModelListing | null {
	const own = lastGood.get(accountId);
	return own ? { ...own, source: "cached" } : null;
}

/** Every listing currently known, for callers assembling a union. */
export function getAllKnownAnthropicListings(): AnthropicModelListing[] {
	return [...lastGood.values()].map((listing) => ({
		...listing,
		source: "cached" as const,
	}));
}

/**
 * Every model at least one account in the pool has listed for itself, each
 * appearing once.
 *
 * The union, not the intersection, because the gateway can serve a model as
 * long as one of its accounts is entitled to it — and the selector is what
 * makes sure the request reaches that account. Publishing the intersection
 * would hide a model that works; publishing a catalog read from some other
 * account could advertise one that does not.
 *
 * Ordering follows first appearance, which keeps Anthropic's own newest-first
 * ordering from whichever account answered first rather than imposing an
 * alphabetical one that opens on `claude-fable-5`.
 */
export function unionOfKnownAnthropicModels(): ModelCatalogEntry[] {
	const byId = new Map<string, ModelCatalogEntry>();
	for (const listing of lastGood.values()) {
		for (const entry of listing.models) {
			if (!byId.has(entry.id)) byId.set(entry.id, entry);
		}
	}
	return [...byId.values()];
}

/** Test seam: both registries are process-wide and leak between cases. */
export function clearAnthropicModelCacheForTests(): void {
	lastGood.clear();
	confirmedAbsentAt.clear();
	diskLoadAttempted = false;
}

/** Drops a removed account's listing so it does not linger forever. */
export function clearAnthropicModelCacheForAccount(accountId: string): void {
	if (lastGood.delete(accountId)) {
		void saveToDisk();
	}
}

function isFresh(listing: AnthropicModelListing | undefined): boolean {
	return (
		listing !== undefined && Date.now() - listing.fetchedAt < LISTING_TTL_MS
	);
}

/**
 * The model list for one Anthropic account: live when Anthropic answers,
 * otherwise the last list this account gave us. Returns null only when both
 * are unavailable.
 *
 * `force` skips the freshness check — used by the escalation path, where the
 * whole question is whether something changed since the cached read.
 */
export async function getAnthropicModels(
	accountId: string,
	ctx: ProxyContext,
	options?: { force?: boolean },
): Promise<AnthropicModelListing | null> {
	await loadFromDisk();

	const cached = lastGood.get(accountId);
	if (!options?.force && isFresh(cached)) {
		return { ...(cached as AnthropicModelListing), source: "cached" };
	}

	const account = await ctx.dbOps.getAccount(accountId);
	if (!account || !isAnthropicAccount(account)) return null;

	try {
		const models = await fetchModelsForAccount(account, ctx);
		// An answer with nothing in it is not an answer. Recording it would mark
		// the account as having no entitlements at all, which excludes it from
		// every request under "force account model".
		if (models.length === 0) {
			throw new Error("the listing came back with no models");
		}
		const listing: AnthropicModelListing = {
			accountId,
			models,
			fetchedAt: Date.now(),
			source: "live",
		};
		lastGood.set(accountId, listing);
		void saveToDisk();
		return listing;
	} catch (error) {
		log.warn(
			`Live model list failed for ${account.name} (${error}); ` +
				(cached
					? `serving the list from ${new Date(cached.fetchedAt).toISOString()}`
					: "and there is no cached list to fall back to"),
		);
		return cached ? { ...cached, source: "cached" } : null;
	}
}

/**
 * Make sure this account's listing exists and is not stale, without making the
 * caller wait for it.
 *
 * Deliberately fire-and-forget, which is where it differs from the Codex
 * equivalent: that one is awaited because the mapping of the request in hand
 * depends on it, while this listing decides the ROUTING of later requests. The
 * account serving this request was already chosen; blocking it to learn
 * something only the next request can use would buy nothing.
 *
 * So the warm-up rides on real traffic rather than a timer: an account that is
 * never used is never probed, and an account in constant use is read once a
 * day. That is what keeps this clear of the concern that restricts background
 * polling of consumer OAuth accounts in `model-catalog.ts` — the read happens
 * because the account was already talking to Anthropic anyway.
 */
export function ensureAnthropicModelListing(
	account: Account | null | undefined,
	ctx: ProxyContext,
): void {
	if (!account || !isAnthropicAccount(account)) return;
	if (process.env.BETTER_CCFLARE_MODELS_OFFLINE === "1") return;
	if (isFresh(lastGood.get(account.id))) return;
	if (inFlight.has(account.id)) return;

	inFlight.add(account.id);
	void getAnthropicModels(account.id, ctx)
		.catch((error) => {
			// Never surfaces: routing has a defined answer for "we do not know".
			log.debug(`Warming the model list for ${account.name} failed: ${error}`);
			return null;
		})
		.finally(() => {
			inFlight.delete(account.id);
		});
}

/**
 * Re-read every Anthropic account's listing because `model` is absent from all
 * of them, and tell the caller whether looking again is worth it.
 *
 * Exists for the one case a cache cannot distinguish on its own: a model
 * published after our last read looks exactly like a model that does not
 * exist. A live read separates them — but only once per model per window, or a
 * client retrying a genuinely unknown model turns every attempt into a fresh
 * read against every account, which is the traffic pattern this module is
 * otherwise careful to avoid.
 *
 * `false` means nothing was re-read, so re-running the same check would reach
 * the same answer. Never throws: an account that cannot answer must not stop
 * the others from being asked, since the one that answers may be the one that
 * lists it.
 */
export async function refreshAnthropicModelsForMissing(
	accounts: Account[],
	model: string,
	ctx: ProxyContext,
): Promise<boolean> {
	const anthropicAccounts = accounts.filter(isAnthropicAccount);
	if (anthropicAccounts.length === 0) return false;

	const confirmedAt = confirmedAbsentAt.get(model);
	if (confirmedAt !== undefined && Date.now() - confirmedAt < ABSENCE_TTL_MS) {
		return false;
	}

	const listings = await Promise.all(
		anthropicAccounts.map((account) =>
			getAnthropicModels(account.id, ctx, { force: true }).catch((error) => {
				log.debug(`Refreshing the list for ${account.name} failed: ${error}`);
				return null;
			}),
		),
	);

	const found = listings.some((listing) =>
		listing?.models.some((entry) => entry.id === model),
	);
	if (found) {
		confirmedAbsentAt.delete(model);
		log.info(
			`A live read found "${model}", which was missing from the cached listings`,
		);
	} else {
		confirmedAbsentAt.set(model, Date.now());
	}
	return true;
}
