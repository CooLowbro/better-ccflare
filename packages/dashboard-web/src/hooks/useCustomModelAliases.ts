import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type CustomModelAliasRow,
	fetchCustomModelAliases,
	saveCustomModelAliases,
} from "../lib/custom-model-aliases-api";
import { queryKeys } from "../lib/query-keys";

/**
 * The custom model alias map. Few records: short staleTime only to avoid
 * duplicate calls between re-renders, with no polling.
 */
export const useCustomModelAliases = () =>
	useQuery({
		queryKey: queryKeys.customModelAliases(),
		queryFn: fetchCustomModelAliases,
		staleTime: 30 * 1000,
	});

/**
 * Saves the whole map edited on screen in one operation.
 *
 * Also invalidates the model queries: an alias is an id clients may now ask
 * for, so the model listing the dashboard shows is stale the moment this
 * succeeds.
 */
export const useSaveCustomModelAliases = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (rows: CustomModelAliasRow[]) => saveCustomModelAliases(rows),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: queryKeys.customModelAliases(),
			});
			queryClient.invalidateQueries({ queryKey: queryKeys.models() });
		},
	});
};
