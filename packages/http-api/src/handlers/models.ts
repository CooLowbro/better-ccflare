import {
	listCatalogueModels,
	listModelAliases,
	validateApiKey,
	validateEndpointUrl,
} from "@better-ccflare/core";
import {
	BadRequest,
	errorResponse,
	jsonResponse,
} from "@better-ccflare/http-common";
import { fetchOpenAICompatibleModelsPreview } from "@better-ccflare/proxy";
import type { APIContext } from "../types";

/**
 * Where a listed model id came from — the whole point of the endpoint.
 *
 *  - "builtin"   ccflare itself knows this model for that provider (it is in
 *                the provider adapter's own table). Strongest signal there is.
 *  - "catalog"   the provider's own live listing (Anthropic /v1/models),
 *                fetched with a real account's credentials.
 *  - "reference" the public models.dev catalogue. Says the model EXISTS at
 *                the vendor and says NOTHING about whether a given account's
 *                plan may call it: ChatGPT-subscription accounts reject
 *                gpt-5.3-codex with HTTP 400 while OpenAI lists it happily.
 *                Never collapse this into the other two.
 */
export type ModelListingSource =
	| "builtin"
	| "catalog"
	| "reference"
	/**
	 * The provider's own listing for THIS account. The only source that can
	 * tell an entitled model from one the plan does not reach — which is the
	 * distinction that matters when the choice ends up in a request.
	 */
	| "account"
	/**
	 * A registered custom model alias. Says the operator declared this id and
	 * what it resolves to — and says nothing at all about entitlement, exactly
	 * like "reference": the alias target still has to be serveable by some
	 * account of the provider the alias names. Never collapse it into
	 * "account" or "catalog", which are claims about a provider, not about
	 * local configuration.
	 */
	| "alias";

export interface ProviderModelEntry {
	id: string;
	displayName: string;
	source: ModelListingSource;
}

/**
 * ccflare provider name -> models.dev top-level section. Only names that
 * differ need an entry; anything else falls through to the provider name
 * itself, which models.dev uses verbatim for "anthropic", "zai", "minimax",
 * and friends.
 */
const MODELS_DEV_SECTION_BY_PROVIDER: Record<string, string> = {
	// Intentionally empty for providers that answer with a listing of their
	// own. Add an entry only for a provider whose models ccflare cannot ask
	// for — the catalogue is the fallback of last resort, not a second opinion.
};

/**
 * Model ids ccflare ships knowledge of, per provider.
 *
 * Empty for codex on purpose: the account's own listing supersedes anything
 * compiled in, and the compiled list contained `gpt-5.3-codex`, which a
 * ChatGPT-subscription account refuses. A built-in list is a guess about
 * entitlement, and a guess is exactly what fails silently.
 */
const BUILTIN_MODELS_BY_PROVIDER: Record<string, readonly string[]> = {};

/**
 * Providers served by the live Anthropic catalog. Both auth modes (OAuth and
 * console API key) talk to the same /v1/models listing, so both get it.
 */
function isAnthropicProvider(provider: string): boolean {
	return provider === "anthropic" || provider === "claude-console-api";
}

/**
 * GET /api/models[?provider=<name>] — list the models available for one
 * provider, each entry tagged with where the knowledge came from.
 *
 * Without `provider` (and for the Anthropic providers) the body is what this
 * endpoint has always returned — the cached live catalog, or the bundled
 * static fallback — plus any registered custom model alias, tagged
 * `source: "alias"`. `provider` and the per-entry `source` are additive
 * fields, and an alias never displaces a catalog entry.
 *
 * For every other provider the answer is the union of what ccflare knows
 * built in and what the public models.dev catalogue lists, deduplicated by
 * id with the stronger marking winning, builtin entries first. A failed or
 * unavailable catalogue fetch degrades to the builtin list plus a warning —
 * it never fails the request.
 */
export function createModelsHandler(context: APIContext) {
	return async (url?: URL): Promise<Response> => {
		const requested = url?.searchParams.get("provider")?.trim() || "";
		const accountId = url?.searchParams.get("accountId")?.trim() || "";

		// An account's own listing beats every catalogue: it is the only one
		// that knows what this subscription may call. Providers without such a
		// listing fall through to the generic path below, unchanged.
		if (accountId && context.modelCatalog?.codexModels) {
			const listing = await context.modelCatalog.codexModels(accountId);
			if (listing) {
				return jsonResponse({
					provider: requested,
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
						description: model.description,
						contextWindow: model.contextWindow,
						supersededBy: model.supersededBy,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
					...(listing.source === "shared"
						? {
								warning:
									"This account cannot read its own model list, so this is " +
									"another account of the same provider. Accounts on " +
									"different plans can differ.",
							}
						: {}),
				});
			}
		}

		if (accountId && context.modelCatalog?.openaiCompatibleModels) {
			const listing =
				await context.modelCatalog.openaiCompatibleModels(accountId);
			if (listing) {
				return jsonResponse({
					provider: requested,
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
				});
			}
		}

		// And the same question asked of an Anthropic account. It belongs with
		// the two above rather than with the catalog branch below, because the
		// distinction that matters here is the one they share: what the account
		// may call, not what the vendor publishes.
		if (accountId && context.modelCatalog?.anthropicModels) {
			const listing = await context.modelCatalog.anthropicModels(accountId);
			if (listing) {
				return jsonResponse({
					provider: requested || "anthropic",
					models: listing.models.map((model) => ({
						id: model.id,
						displayName: model.displayName,
						source: "account" as const,
						createdAt: model.createdAt,
						line: model.line ?? null,
					})),
					fetchedAt: listing.fetchedAt,
					source: listing.source,
				});
			}
		}

		// Registered aliases, rendered in this endpoint's vocabulary. Appended
		// to whichever branch answers below rather than replacing anything: an
		// alias is additional knowledge, never a correction of the provider's.
		const aliasEntries: ProviderModelEntry[] = Object.entries(
			listModelAliases(),
		)
			.filter(([, alias]) => !requested || alias.provider === requested)
			.map(([id, alias]) => ({
				id,
				displayName: alias.displayName ?? id,
				source: "alias" as const,
			}));

		if (requested === "" || isAnthropicProvider(requested)) {
			if (!context.modelCatalog) {
				return errorResponse("Model catalog is not available");
			}

			// What the pool's own accounts have listed, when any of them has.
			// Preferred over the gateway-wide catalog for the reason the catalog
			// cannot address: it is read from one eligible account and presented
			// as the gateway's, so it both hides models only another account can
			// call and offers models no account can.
			const union = context.modelCatalog.anthropicUnion?.() ?? [];
			if (union.length > 0) {
				return jsonResponse({
					provider: requested || "anthropic",
					models: [
						...union.map((model) => ({
							...model,
							source: "account" as const,
						})),
						...aliasEntries,
					],
					source: "live",
				});
			}

			const catalog = await context.modelCatalog.get();
			// `fallback` means an on-disk copy or the list bundled into the binary
			// answered — not the provider. After a restart that would make the
			// field look answered when nothing has been read.
			const live = catalog.source === "live";
			return jsonResponse({
				provider: requested || "anthropic",
				models: live
					? [
							...catalog.models.map((model) => ({
								...model,
								source: "catalog" as const,
							})),
							...aliasEntries,
						]
					: aliasEntries,
				fetchedAt: catalog.fetchedAt,
				source: live ? "live" : "unavailable",
				...(live
					? {}
					: {
							warning:
								"No listing read from the provider yet. The field takes any model id meanwhile.",
						}),
			});
		}

		const builtinIds = BUILTIN_MODELS_BY_PROVIDER[requested] ?? [];
		const section = MODELS_DEV_SECTION_BY_PROVIDER[requested] ?? requested;
		const reference = await listCatalogueModels(section);

		const builtinById = new Map<string, ProviderModelEntry>();
		for (const id of builtinIds) {
			builtinById.set(id, { id, displayName: id, source: "builtin" });
		}

		// A reference entry never overwrites a builtin one — the stronger
		// marking wins, and the UI shows the two groups apart on purpose.
		const referenceById = new Map<string, ProviderModelEntry>();
		for (const entry of reference) {
			if (!entry.id) continue;
			if (builtinById.has(entry.id) || referenceById.has(entry.id)) continue;
			referenceById.set(entry.id, {
				id: entry.id,
				displayName: entry.name || entry.id,
				source: "reference",
			});
		}

		const referenceEntries = Array.from(referenceById.values()).sort((a, b) =>
			a.id.localeCompare(b.id),
		);
		// Aliases sit between builtin and reference: the operator declared them
		// explicitly, which outranks a public catalogue's say-so, but they are
		// still not the provider's own word about entitlement.
		const models = [
			...builtinById.values(),
			...aliasEntries,
			...referenceEntries,
		];

		const hasBuiltin = builtinById.size > 0;
		const hasReference = referenceEntries.length > 0;
		const source = hasBuiltin
			? hasReference
				? "mixed"
				: "builtin"
			: hasReference
				? "reference"
				: aliasEntries.length > 0
					? "alias"
					: "unavailable";

		return jsonResponse({
			provider: requested,
			models,
			fetchedAt: Date.now(),
			source,
			referenceSection: section,
			...(hasReference
				? {}
				: {
						warning: `No reference models for "${section}" in the models.dev catalogue (unknown provider, catalogue offline, or fetch failed)`,
					}),
		});
	};
}

/**
 * POST /api/models/preview — live model discovery for the account wizard,
 * before an account row exists to read api_key/custom_endpoint from. Takes
 * the apiKey/endpoint the user just typed instead of an accountId.
 *
 * Same shape as the `accountId` branch above (`source: "account"` there
 * becomes `source: "preview"` here — there is no account row yet to call it
 * "account"). Errors propagate as 4xx/5xx rather than degrading to a cached
 * listing: unlike the account-backed path, a preview has no cache to fall
 * back to.
 */
export function createModelsPreviewHandler() {
	return async (req: Request): Promise<Response> => {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return errorResponse(BadRequest("Request body must be valid JSON"));
		}
		const { apiKey, endpoint } = body as Record<string, unknown>;

		try {
			const validApiKey = validateApiKey(apiKey);
			const validEndpoint = validateEndpointUrl(endpoint);
			const preview = await fetchOpenAICompatibleModelsPreview(
				validApiKey,
				validEndpoint,
			);
			return jsonResponse({
				provider: "openai-compatible",
				models: preview.models.map((model) => ({
					id: model.id,
					displayName: model.displayName,
					source: "preview" as const,
				})),
				fetchedAt: preview.fetchedAt,
				source: preview.source,
			});
		} catch (error) {
			// Never let the raw error surface the apiKey the caller sent — the
			// thrown errors from fetchOpenAICompatibleModelsPreview never include
			// it, but errorResponse's own request-body logging redaction (see
			// http-common/responses.ts) is the backstop if that ever changes.
			return errorResponse(error);
		}
	};
}

/**
 * POST /api/models/refresh — force an immediate live model catalog refresh.
 * Never throws: refreshModelCatalog is fail-open, so this always returns
 * 200 with the outcome (success flag + optional error) plus the resulting
 * catalog.
 */
export function createModelsRefreshHandler(context: APIContext) {
	return async (): Promise<Response> => {
		if (!context.modelCatalog) {
			return errorResponse("Model catalog is not available");
		}
		const result = await context.modelCatalog.refresh();
		const catalog = await context.modelCatalog.get();
		return jsonResponse({ ...result, catalog });
	};
}
