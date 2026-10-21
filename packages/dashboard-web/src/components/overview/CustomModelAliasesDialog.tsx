import { describeAliasIdProblem } from "@better-ccflare/core";
import {
	AlertCircle,
	AlertTriangle,
	Info,
	Loader2,
	Plus,
	Save,
	Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "../../hooks/queries";
import {
	useCustomModelAliases,
	useSaveCustomModelAliases,
} from "../../hooks/useCustomModelAliases";
import type { CustomModelAliasRow } from "../../lib/custom-model-aliases-api";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

/**
 * Custom model aliases: a client-facing model id standing for a real model on
 * a named provider, resolved at ingress before account selection.
 *
 * It has a UI because the alias id obeys two rules that are invisible from
 * outside and expensive to get wrong, and a JSON file cannot tell you when you
 * have broken them:
 *
 *   - it must NOT contain fable/opus/sonnet/haiku, because `getModelFamily`
 *     reads the family out of the id — an alias carrying one is routed and
 *     counted as that family while actually going elsewhere;
 *   - it SHOULD contain "claude" or "anthropic", because a Claude Code client
 *     drops every other id before its model picker sees it.
 *
 * The first is an error, the second a warning: the first corrupts this proxy,
 * the second only makes the alias invisible to one client among several. Both
 * judgements come from `describeAliasIdProblem` in core, which the POST handler
 * also calls — the rules are stated once.
 *
 * The model field is a plain input, not the ModelCombobox used on the
 * provider-defaults screen: this modal grows a row per alias and therefore has
 * to scroll, and ModelCombobox renders its popover without a portal precisely
 * so it survives a modal — an `overflow-y-auto` ancestor would clip its list.
 * A free-text field here is the honest trade: the id typed is the id sent.
 */

/** A row the user is editing, with a stable key so React can track deletions. */
interface DraftRow extends CustomModelAliasRow {
	key: string;
}

let rowCounter = 0;
function newKey(): string {
	rowCounter += 1;
	return `alias-${rowCounter}`;
}

function toDrafts(rows: CustomModelAliasRow[]): DraftRow[] {
	return rows.map((row) => ({ ...row, key: newKey() }));
}

function emptyRow(provider: string): DraftRow {
	return {
		key: newKey(),
		id: "",
		provider,
		model: "",
		displayName: "",
		description: "",
	};
}

/** Problems that block Save, keyed by row key. Empty means the form is sound. */
function collectErrors(rows: DraftRow[]): Map<string, string> {
	const errors = new Map<string, string>();
	const seen = new Map<string, string>();
	for (const row of rows) {
		const id = row.id.trim();
		if (!id) {
			errors.set(row.key, "An alias needs an id.");
			continue;
		}
		const previous = seen.get(id);
		if (previous) {
			// Whole-map replacement means a duplicate id does not error server
			// side — the second silently wins. Catch it here, where the user can
			// still see both rows.
			errors.set(row.key, `Duplicate id: "${id}" is already used above.`);
			continue;
		}
		seen.set(id, row.key);
		const problem = describeAliasIdProblem(id);
		if (problem?.level === "error") {
			errors.set(row.key, problem.message);
			continue;
		}
		if (!row.provider.trim()) {
			errors.set(row.key, "Pick the provider that serves this model.");
			continue;
		}
		if (!row.model.trim()) {
			errors.set(row.key, "Name the model actually sent upstream.");
		}
	}
	return errors;
}

/** Non-blocking notes, keyed by row key. */
function collectWarnings(rows: DraftRow[]): Map<string, string> {
	const warnings = new Map<string, string>();
	for (const row of rows) {
		const id = row.id.trim();
		if (!id) continue;
		const problem = describeAliasIdProblem(id);
		if (problem?.level === "warning") warnings.set(row.key, problem.message);
	}
	return warnings;
}

function sameRows(a: DraftRow[], b: CustomModelAliasRow[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((row, index) => {
		const other = b[index];
		return (
			row.id === other.id &&
			row.provider === other.provider &&
			row.model === other.model &&
			row.displayName === other.displayName &&
			row.description === other.description
		);
	});
}

export function CustomModelAliasesDialog() {
	const query = useCustomModelAliases();
	const save = useSaveCustomModelAliases();
	const accounts = useAccounts();
	const [drafts, setDrafts] = useState<DraftRow[]>([]);

	// Resynchronizes the draft whenever the query brings a fresh server
	// snapshot: on initial load and after Save invalidates the query.
	useEffect(() => {
		if (!query.data) return;
		setDrafts(toDrafts(query.data));
	}, [query.data]);

	// Providers that actually have an account configured. Offering the full
	// list of provider names would let someone save an alias nothing can serve,
	// which fails later as a 503 with no hint of why.
	const providers = useMemo(() => {
		const set = new Set<string>();
		for (const account of accounts.data ?? []) {
			if (account.provider) set.add(account.provider);
		}
		for (const row of drafts) {
			// Never drop a provider an existing alias already names, even if its
			// account has since been removed: hiding it would silently rewrite
			// the alias on the next Save.
			if (row.provider) set.add(row.provider);
		}
		return [...set].sort((a, b) => a.localeCompare(b));
	}, [accounts.data, drafts]);

	const errors = collectErrors(drafts);
	const warnings = collectWarnings(drafts);
	const dirty = query.data ? !sameRows(drafts, query.data) : false;
	const disableFields = query.isLoading || save.isPending;

	const update = (key: string, patch: Partial<CustomModelAliasRow>) => {
		setDrafts((prev) =>
			prev.map((row) => (row.key === key ? { ...row, ...patch } : row)),
		);
	};

	const remove = (key: string) => {
		setDrafts((prev) => prev.filter((row) => row.key !== key));
	};

	const add = () => {
		setDrafts((prev) => [...prev, emptyRow(providers[0] ?? "")]);
	};

	const handleSave = () => {
		if (errors.size > 0 || !dirty) return;
		save.mutate(
			drafts.map(({ key: _key, ...row }) => ({
				...row,
				id: row.id.trim(),
				provider: row.provider.trim(),
				model: row.model.trim(),
			})),
		);
	};

	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					Configure
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-3xl">
				<DialogHeader>
					<DialogTitle>Custom Model Aliases</DialogTitle>
					<DialogDescription>
						A model id clients may ask for, standing for a real model on a
						specific provider.
					</DialogDescription>
				</DialogHeader>

				<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
					<Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
					Resolved at ingress, before an account is picked: the alias is what
					decides which accounts are eligible. Aliases are appended to{" "}
					<code>/v1/models</code> after everything the upstream answered, never
					in place of it.
				</p>

				{query.isLoading && (
					<div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Loading aliases...
					</div>
				)}

				{query.isError && (
					<p className="flex items-center gap-2 py-2 text-sm text-destructive">
						<AlertCircle className="h-4 w-4 shrink-0" />
						Could not load aliases.{" "}
						{query.error instanceof Error
							? query.error.message
							: "unknown error"}
					</p>
				)}

				{!query.isLoading && !query.isError && drafts.length === 0 && (
					<p className="py-2 text-sm text-muted-foreground">
						No alias configured. Nothing is added to <code>/v1/models</code>.
					</p>
				)}

				{drafts.length > 0 && (
					<div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
						{drafts.map((row) => {
							const error = errors.get(row.key);
							const warning = warnings.get(row.key);
							return (
								<div
									key={row.key}
									className="space-y-2 rounded-md border p-3 text-sm"
								>
									<div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr_auto]">
										<div className="space-y-1">
											<Label
												htmlFor={`alias-id-${row.key}`}
												className="text-xs"
											>
												Alias id (what the client asks for)
											</Label>
											<Input
												id={`alias-id-${row.key}`}
												value={row.id}
												placeholder="claude-gpt-5.6-terra"
												className="h-8"
												disabled={disableFields}
												onChange={(event) =>
													update(row.key, { id: event.target.value })
												}
											/>
										</div>
										<div className="space-y-1">
											<Label
												htmlFor={`alias-provider-${row.key}`}
												className="text-xs"
											>
												Provider
											</Label>
											<Select
												value={row.provider || undefined}
												disabled={disableFields}
												onValueChange={(value) =>
													update(row.key, { provider: value })
												}
											>
												<SelectTrigger
													id={`alias-provider-${row.key}`}
													className="h-8 w-[10rem]"
												>
													<SelectValue placeholder="pick one" />
												</SelectTrigger>
												<SelectContent>
													{providers.map((provider) => (
														<SelectItem key={provider} value={provider}>
															{provider}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
										</div>
										<div className="space-y-1">
											<Label
												htmlFor={`alias-model-${row.key}`}
												className="text-xs"
											>
												Model sent upstream
											</Label>
											<Input
												id={`alias-model-${row.key}`}
												value={row.model}
												placeholder="gpt-5.6-terra"
												className="h-8"
												disabled={disableFields}
												onChange={(event) =>
													update(row.key, { model: event.target.value })
												}
											/>
										</div>
										<div className="flex items-end">
											<Button
												type="button"
												variant="ghost"
												size="sm"
												title="Remove this alias"
												disabled={disableFields}
												onClick={() => remove(row.key)}
											>
												<Trash2 className="h-3.5 w-3.5" />
											</Button>
										</div>
									</div>

									<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
										<div className="space-y-1">
											<Label
												htmlFor={`alias-display-${row.key}`}
												className="text-xs"
											>
												Display name (optional)
											</Label>
											<Input
												id={`alias-display-${row.key}`}
												value={row.displayName}
												placeholder={row.id.trim() || "falls back to the id"}
												className="h-8"
												disabled={disableFields}
												onChange={(event) =>
													update(row.key, { displayName: event.target.value })
												}
											/>
										</div>
										<div className="space-y-1">
											<Label
												htmlFor={`alias-description-${row.key}`}
												className="text-xs"
											>
												Description (optional)
											</Label>
											<Input
												id={`alias-description-${row.key}`}
												value={row.description}
												placeholder="shown next to the name in a picker"
												className="h-8"
												disabled={disableFields}
												onChange={(event) =>
													update(row.key, { description: event.target.value })
												}
											/>
										</div>
									</div>

									{error && (
										<p className="flex items-start gap-1.5 text-[11px] text-destructive">
											<AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
											{error}
										</p>
									)}
									{!error && warning && (
										<p className="flex items-start gap-1.5 text-[11px] text-yellow-600 dark:text-yellow-500">
											<AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
											{warning}
										</p>
									)}
								</div>
							);
						})}
					</div>
				)}

				<div className="flex items-center gap-2 pt-1">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={add}
						disabled={disableFields}
					>
						<Plus className="h-3.5 w-3.5" />
						Add alias
					</Button>
					<Button
						size="sm"
						onClick={handleSave}
						disabled={
							!dirty || errors.size > 0 || save.isPending || query.isLoading
						}
					>
						{save.isPending ? (
							<>
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
								Saving...
							</>
						) : (
							<>
								<Save className="h-3.5 w-3.5" />
								Save
							</>
						)}
					</Button>
					{errors.size > 0 && (
						<span className="text-xs text-destructive">
							{errors.size} alias{errors.size === 1 ? "" : "es"} to fix
						</span>
					)}
					{errors.size === 0 && dirty && !save.isPending && (
						<span className="text-xs text-muted-foreground">
							Unsaved changes
						</span>
					)}
				</div>

				{save.isError && (
					<p className="flex items-center gap-2 text-xs text-destructive">
						<AlertCircle className="h-3.5 w-3.5 shrink-0" />
						Could not save.{" "}
						{save.error instanceof Error ? save.error.message : "unknown error"}
					</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
