export { OpenAICompatibleProvider } from "./provider";
// GAMBIARRA LOCAL - NAO SUBIR PARA tombii/better-ccflare.
// Reexportada so para o seletor de conta do proxy poder consulta-la.
// Ver ./GAMBIARRA-mapa-deepseek.ts e GAMBIARRA-NAO-SUBIR.md na raiz.
export {
	GAMBIARRA_DEEPSEEK_MODELS,
	gambiarraDeepSeekServesModel,
	isGambiarraDeepSeekAccount,
} from "./GAMBIARRA-mapa-deepseek";
