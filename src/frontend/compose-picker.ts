import { filterSnippets, type SnippetRecord as Snippet } from "./snippets";

export interface SnippetPickerState {
  query: string | null;
  results: Snippet[];
  visibleResults: Snippet[];
}

export const deriveSnippetPickerState = (
  composeText: string,
  snippets: Snippet[],
  maxResults = 8
): SnippetPickerState => {
  const query = composeText.startsWith("/") ? composeText.slice(1) : null;
  const results = query === null ? [] : filterSnippets(snippets, query);
  return {
    query,
    results,
    visibleResults: results.slice(0, maxResults)
  };
};
