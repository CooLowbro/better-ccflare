# GAMBIARRA — NÃO SUBIR PARA O TOMBII

**Branch:** `artel/gambiarra-NAO-SUBIR-mapa-deepseek`
**Base:** `pr/force-account-model` (`693ea10d`), tag `v3.5.61`
**Data:** 2026-08-22
**Destino permitido:** este clone, e no máximo um remote próprio.
**Destino proibido:** `origin` = `https://github.com/tombii/better-ccflare.git`.

Este arquivo existe para que ninguém — inclusive eu, inclusive uma IA lendo o
repositório em outro dia — confunda esta branch com uma correção pronta para
pull request.

## O que foi mudado

| Arquivo | O quê |
|---|---|
| `packages/providers/src/providers/openai/GAMBIARRA-mapa-deepseek.ts` | Novo. O mapa fixo de modelos do DeepSeek e a detecção da conta pelo endpoint. |
| `packages/providers/src/providers/openai/index.ts` | Reexporta o mapa. |
| `packages/providers/src/providers/index.ts` | Reexporta o mapa. |
| `packages/proxy/src/handlers/account-selector.ts` | `accountServesModel` passa a consultar o mapa antes das regras normais. |

Reverter é `git checkout pr/force-account-model` e apagar a branch. Não há
migração, não há estado persistido, não há mudança de configuração.

## O problema real

Com *force account model* ligado, `accountServesModel`
(`packages/proxy/src/handlers/account-selector.ts`) decide quais contas podem
servir o modelo pedido. Só o provedor `codex` tem consulta de primeira mão
implementada. Todo o resto cai na regra do espaço de nomes:

```
providerAcceptsClientModel(account.provider) === isClaudeModelId(model)
```

Para a conta DeepSeek pedindo `gpt-5.6-sol`, os dois lados são `false`, logo
`false === false` e a conta se declara **capaz**. Como ela está em
`priority: 0` (menor valor = maior prioridade, ordenação ascendente em
`packages/load-balancer/src/strategies/index.ts`), ela é a primeira candidata
de todo pedido não-Claude. Resultado: os `gpt-5.6-*` são forçados contra a API
do DeepSeek e voltam 400.

`modelMappings` não participa desse predicado. Preencher o mapa da conta pelo
dashboard não resolveria — foi por isso que a mudança teve de ser no código.

Agravante: o texto de recusa do DeepSeek não casa com nenhuma frase de
`MODEL_REFUSAL_PHRASES`, então o resultado é registrado como `ignore` e não
como `rejected`. O gateway nunca aprende, e a falha é permanente em vez de
autocorretiva.

## Por que isto não é a correção

- **Hardcoda um vendor** dentro de um provedor cuja razão de existir é ser
  genérico.
- **A lista é congelada em tempo de build.** Quando o DeepSeek renomear ou
  lançar um modelo, ele será recusado *aqui*, não pela API — o sintoma será
  503 `No available account can serve` em vez de 400.
- **Cobre uma conta, não o mecanismo.** Uma segunda conta `openai-compatible`
  não-DeepSeek continua coringa exatamente como antes.
- **Não conserta o não-aprendizado.** `MODEL_REFUSAL_PHRASES` segue sem a
  fraseologia do DeepSeek.

## O que a correção de verdade seria

1. Semear capacidade real por conta via `POST /api/accounts/:id/test-model`, ou
2. ler o `/models` do próprio endpoint e derivar a lista, como
   `packages/providers/src/provider-model-defaults.ts` já faz para provedores
   com fonte dinâmica, e
3. acrescentar a fraseologia de recusa do DeepSeek a `MODEL_REFUSAL_PHRASES`,
   para o gateway aprender sozinho e a mesma classe de erro nunca mais ser
   permanente.

Só (2) + (3) seria material de pull request. Nada disso está nesta branch.

## Trava mecânica instalada

Há um hook `pre-push` em `.git/hooks/pre-push` neste clone que:

- **bloqueia sem exceção** qualquer push cujo remote contenha `tombii`;
- bloqueia o push desta branch para qualquer remote, a menos que se exporte
  `PERMITIR_PUSH_GAMBIARRA=1`.

O hook **não é versionado** — ele protege este clone, não viaja com a branch.
Se você clonar de novo, reinstale.

## Ainda pendente

Esta árvore **não é** o binário em produção. A imagem que está rodando é
`local/better-ccflare:3.5.55-artel.4-forca`, e não foi possível provar que ela
foi construída deste commit. Editar esta árvore **não muda o gateway em
execução**: é preciso rebuild da imagem e redeploy, e antes disso confirmar de
qual branch a imagem em uso saiu.
