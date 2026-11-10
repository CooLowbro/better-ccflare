/**
 * Escopo Artel da busca local (patch nosso; nao existe no upstream).
 *
 * O upstream intercepta todo pedido auxiliar de `web_search`. Aqui so
 * interceptamos quando o modelo pedido e alias de um provedor que nao e a
 * Anthropic. As sessoes Claude seguem com a busca da propria Anthropic, que ja
 * sai na assinatura, e a mudanca alcanca so as sessoes GPT: nelas o tradutor
 * Codex transforma a ferramenta de servidor numa funcao que ninguem executa, e
 * a busca voltava vazia (medido em 10/11/2026).
 */

import { resolveModelAlias } from "@better-ccflare/core";

export function isLocalWebSearchInScope(body: unknown): boolean {
	if (!body || typeof body !== "object") return false;
	const model = (body as { model?: unknown }).model;
	if (typeof model !== "string") return false;
	const alias = resolveModelAlias(model);
	return alias !== null && alias.provider !== "anthropic";
}
