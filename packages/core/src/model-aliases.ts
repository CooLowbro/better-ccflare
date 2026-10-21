/**
 * Registered model aliases: a client-facing model id that stands for a real
 * model on a specific provider.
 *
 * The problem this solves: a client whose model picker only accepts Claude-ish
 * names cannot ask for `gpt-5.6-sol`. Claude Code's gateway model discovery, for
 * one, fetches `/v1/models` and then drops every id that fails
 * `/(claude|anthropic)/i` before the picker ever sees it. An alias named
 * `claude-gpt-5.6-sol` survives that filter and resolves here, at ingress, to
 * `gpt-5.6-sol` on the `codex` provider.
 *
 * Why this is not a row in `model_mappings`: those are per-account and run
 * AFTER an account has been selected. An alias has to resolve BEFORE, because
 * the alias is what decides which accounts are eligible in the first place.
 * Folding the two together would make an alias depend on the very choice it is
 * supposed to constrain.
 *
 * Why the names are not translated into the `fable|opus|sonnet|haiku` family
 * vocabulary: they must not be. `getModelFamily` reads those words out of the
 * id, so an alias called `claude-sonnet-gpt-5.6-sol` would report family
 * "sonnet" and quietly poison combo routing, per-family capacity accounting and
 * the rewrite veto. An alias id says nothing about family on purpose, and every
 * guard that needs to admit one consults `isRegisteredAlias` instead of
 * inventing a family for it.
 *
 * Like the "force account model" switch next door, this is a plain in-memory
 * registry rather than a config read: the code that resolves a model sits in
 * core and proxy, and neither may depend on @better-ccflare/config without
 * inverting the dependency graph. The config file stays the source of truth —
 * apps/server pushes the value in at boot and the config POST handler pushes it
 * again after a write, so a change takes effect without a restart.
 */

import { KNOWN_PATTERNS } from "./model-mappings";

/** What one alias stands for. */
export interface CustomModelAlias {
	/** Provider that serves the real model; narrows account selection. */
	provider: string;
	/** Model id actually sent upstream. */
	model: string;
	/** Shown in a client's model picker; falls back to the alias id. */
	displayName?: string;
	description?: string;
}

/** Alias id -> what it stands for. */
export type CustomModelAliases = Record<string, CustomModelAlias>;

let aliases: CustomModelAliases = {};

/**
 * Mirror the config value here. Called at boot and after a successful write.
 *
 * Copies the map rather than holding the caller's object: the registry is read
 * on every request and must not change shape underneath one because a caller
 * kept mutating what it passed in.
 */
export function setCustomModelAliases(next: CustomModelAliases): void {
	aliases = { ...next };
}

/** The registry as it currently stands. */
export function listModelAliases(): CustomModelAliases {
	return { ...aliases };
}

/**
 * Resolve an alias id, or null when the id is not an alias.
 *
 * Exact match only. No prefix stripping, no case folding, no "close enough":
 * a near-miss must fall through to the ordinary model path and be handled
 * there, because silently resolving an id the operator did not register is how
 * a request reaches a provider nobody chose.
 */
export function resolveModelAlias(modelId: string): CustomModelAlias | null {
	return aliases[modelId] ?? null;
}

/**
 * Whether this id is a registered alias.
 *
 * This is the question the acceptance guards ask — `isRewriteTargetServable`
 * in the proxy and `isAllowedModel` in the HTTP API — before rejecting an id
 * that carries no Claude family word and is absent from the live Anthropic
 * catalog. Both of those are right to be suspicious of such an id by default;
 * a registered alias is the one case where the operator has already answered
 * for it.
 */
export function isRegisteredAlias(modelId: string): boolean {
	return Object.hasOwn(aliases, modelId);
}

/** A problem with a proposed alias id, and how much it matters. */
export interface AliasIdProblem {
	/**
	 * "error" — the alias would corrupt routing; refuse it.
	 * "warning" — the alias works here but a Claude Code client will never show
	 * it. Other clients may be fine, so this is not ours to refuse.
	 */
	level: "error" | "warning";
	message: string;
}

/** The family words that an alias id must not contain. */
const FAMILY_WORDS = KNOWN_PATTERNS;

/**
 * Judge a proposed alias id against the two naming rules, so that the HTTP
 * handler and the dashboard form say the same thing about the same id instead
 * of each carrying its own half-remembered copy of the rules.
 *
 * Returns null when the id is fine, otherwise the single most serious problem.
 */
export function describeAliasIdProblem(id: string): AliasIdProblem | null {
	const trimmed = id.trim();
	if (!trimmed) {
		return { level: "error", message: "An alias id cannot be empty." };
	}

	// Error, not warning: `getModelFamily` reads the family out of the id, so an
	// alias carrying a family word is counted and routed as that family while
	// actually being served by another provider. Nothing downstream can detect
	// that afterwards — the id itself is the lie.
	const offender = FAMILY_WORDS.find((word) =>
		trimmed.toLowerCase().includes(word),
	);
	if (offender) {
		return {
			level: "error",
			message: `An alias id must not contain "${offender}": the word names a Claude family, and combo routing and per-family capacity would treat this alias as that family. Pick a name without ${FAMILY_WORDS.join(", ")}.`,
		};
	}

	// Warning, not error: this is a property of one client, and this proxy
	// serves others. Refusing the id would be asserting more than we know.
	if (!/(claude|anthropic)/i.test(trimmed)) {
		return {
			level: "warning",
			message:
				'A Claude Code client drops every id failing /(claude|anthropic)/i before its model picker sees it, so this alias will work over the API but never appear in that picker. Prefix it with "claude-" if you want it listed there.',
		};
	}

	return null;
}
