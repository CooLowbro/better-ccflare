/**
 * GAMBIARRA LOCAL — NÃO SUBIR PARA tombii/better-ccflare
 * ======================================================
 *
 * Este arquivo NÃO é correção. É um remendo deliberado, válido apenas para o
 * cenário do Eric em 2026-08-22: exatamente UMA conta `openai-compatible`
 * configurada, apontada para a API pública do DeepSeek. Se algum dia existir
 * uma segunda conta `openai-compatible` que não seja DeepSeek, releia
 * `GAMBIARRA-NAO-SUBIR.md` na raiz antes de confiar neste arquivo.
 *
 * ---------------------------------------------------------------------------
 * O problema que ele remenda
 * ---------------------------------------------------------------------------
 *
 * Com "force account model" ligado, quem decide se uma conta pode servir o
 * modelo pedido é `accountServesModel`, em
 * `packages/proxy/src/handlers/account-selector.ts`. A regra de lá tem duas
 * etapas: conhecimento de primeira mão (listagem que a própria conta
 * declarou) e, quando não há listagem, o espaço de nomes:
 *
 *     providerAcceptsClientModel(account.provider) === isClaudeModelId(model)
 *
 * Só o provedor `codex` tem etapa de primeira mão implementada. Para
 * `openai-compatible` sobra a segunda etapa — e ela é um coringa. Para a
 * conta DeepSeek e o modelo `gpt-5.6-sol`:
 *
 *     providerAcceptsClientModel("openai-compatible") === false
 *     isClaudeModelId("gpt-5.6-sol")                  === false
 *     false === false                                 -> "pode servir"
 *
 * Ou seja: a conta DeepSeek se declara capaz de QUALQUER id que não seja
 * Claude. Estando ela em `priority: 0` (menor valor = maior prioridade), ela é
 * a primeira candidata de todo pedido não-Claude, e os `gpt-5.6-*` acabam
 * forçados contra a API do DeepSeek, que responde 400 dizendo quais nomes
 * aceita. O upstream conhece esse furo: o comentário de `accountServesModel`
 * admite que a regra "é grosseira — com vários provedores não-Claude
 * configurados, um pedido ainda pode chegar ao errado".
 *
 * Pior: o texto de recusa do DeepSeek não casa com nenhuma frase de
 * `MODEL_REFUSAL_PHRASES`, então o veredicto registrado é `ignore` e não
 * `rejected` — o gateway nunca aprende, e o erro se repete para sempre.
 *
 * ---------------------------------------------------------------------------
 * O que este arquivo faz
 * ---------------------------------------------------------------------------
 *
 * Embute o mapa fixo de modelos do DeepSeek e usa esse mapa como etapa de
 * primeira mão para a conta DeepSeek — o equivalente ao que `codex` já tem.
 * A conta deixa de ser coringa e passa a responder "não" para tudo que não
 * está na lista. Nenhuma outra conta `openai-compatible` muda de
 * comportamento, porque o desvio é condicionado ao endpoint.
 *
 * ---------------------------------------------------------------------------
 * Por que é gambiarra, e não a correção
 * ---------------------------------------------------------------------------
 *
 * A correção de verdade não hardcoda vendor nenhum. Ela seria alguma
 * combinação de: (a) semear a capacidade real das contas via
 * `POST /api/accounts/:id/test-model`, (b) ler a listagem `/models` do próprio
 * endpoint e derivar a lista como `provider-model-defaults.ts` já faz para
 * outros provedores, e (c) acrescentar a fraseologia de recusa do DeepSeek a
 * `MODEL_REFUSAL_PHRASES`, para o gateway aprender sozinho. Nada disso está
 * aqui. Esta lista é um valor congelado em tempo de build — exatamente o que
 * o comentário de `provider-model-defaults.ts` chama de "um palpite congelado
 * em tempo de build", e falha em silêncio quando o DeepSeek renomear ou
 * lançar um modelo.
 *
 * Consequência prática: quando o DeepSeek mudar o catálogo, o modelo novo será
 * recusado AQUI, não pela API. O sintoma será 503 "No available account can
 * serve" em vez de 400. Se isso acontecer, é esta lista que está velha.
 */

/**
 * Os únicos modelos que a conta DeepSeek aceita.
 *
 * Fonte: a própria mensagem de validação da API do DeepSeek, observada em
 * 2026-08-22 ao forçar `gpt-5.6-sol` contra ela — "The supported API model
 * names are deepseek-v4-pro, deepseek-v4-flash, and
 * deepseek-v4-flash-vision-exp, but you passed gpt-5.6-sol".
 *
 * Não é catálogo oficial documentado; é o que o validador do upstream disse
 * naquele dia. Trate como carimbo de data, não como verdade permanente.
 */
export const GAMBIARRA_DEEPSEEK_MODELS: ReadonlySet<string> = new Set([
	"deepseek-v4-pro",
	"deepseek-v4-flash",
	"deepseek-v4-flash-vision-exp",
]);

/**
 * Marcador de host que identifica a conta DeepSeek.
 *
 * Deliberadamente casado contra `custom_endpoint`, e não contra `account.name`:
 * o nome é rótulo visual, o operador troca sem pensar, e ninguém espera que
 * renomear uma conta mude o roteamento. O endpoint é o que de fato decide para
 * onde o pedido vai, então é o único campo em que ancorar isto é honesto.
 *
 * Casamento por substring de propósito: `custom_endpoint` às vezes guarda um
 * bloco JSON em vez de uma URL nua (ver `packages/types/src/account.ts`, o
 * ramo de compatibilidade que faz `JSON.parse(account.custom_endpoint)`), e a
 * substring cobre as duas formas sem precisar adivinhar qual delas veio.
 */
const DEEPSEEK_ENDPOINT_MARKER = "deepseek.com";

/** Campos que esta gambiarra precisa — subconjunto mínimo de `Account`. */
type ContaComEndpoint = {
	provider: string;
	custom_endpoint: string | null;
};

/**
 * Se esta conta é a conta DeepSeek do cenário atual.
 *
 * Falso para qualquer outra conta `openai-compatible`: um proxy genérico que
 * aceita ids arbitrários continua coringa como antes, porque é justamente para
 * isso que ele existe. É o que mantém o estrago desta gambiarra confinado à
 * única conta que ela precisa consertar.
 */
export function isGambiarraDeepSeekAccount(account: ContaComEndpoint): boolean {
	if (account.provider !== "openai-compatible") return false;
	const endpoint = account.custom_endpoint;
	if (!endpoint) return false;
	return endpoint.toLowerCase().includes(DEEPSEEK_ENDPOINT_MARKER);
}

/**
 * Se a conta DeepSeek serve `model` exatamente como o cliente escreveu.
 *
 * Comparação exata, sem prefixo e sem normalização: sob force model o nome vai
 * para o upstream sem tradução, então "serve" só pode significar "está na
 * lista tal como está escrito". Aceitar por prefixo reabriria em miniatura o
 * mesmo coringa que este arquivo existe para fechar.
 */
export function gambiarraDeepSeekServesModel(model: string): boolean {
	return GAMBIARRA_DEEPSEEK_MODELS.has(model);
}
