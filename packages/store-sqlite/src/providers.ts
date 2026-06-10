import type { EmbeddingProvider } from '@ekg/core';

/**
 * Embedding adapters — fetch-based, zero dependencies. Selected via env:
 *   EKG_EMBEDDINGS_PROVIDER = voyage | openai | ollama
 *   EKG_EMBEDDINGS_MODEL    = optional model override
 *   VOYAGE_API_KEY / OPENAI_API_KEY for the API providers
 *   OLLAMA_HOST for local (defaults to http://localhost:11434)
 * Unset → undefined → stores run lexical-only.
 */

class HttpEmbedding implements EmbeddingProvider {
  constructor(
    readonly id: string,
    private readonly request: (texts: string[]) => Promise<number[][]>,
  ) {}

  embed(texts: string[]): Promise<number[][]> {
    return this.request(texts);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${url} -> ${res.status} ${await res.text().then((t) => t.slice(0, 200))}`);
  }
  return res.json();
}

export function voyageProvider(apiKey: string, model = 'voyage-3-large'): EmbeddingProvider {
  return new HttpEmbedding(`voyage:${model}`, async (texts) => {
    const data = (await postJson(
      'https://api.voyageai.com/v1/embeddings',
      { model, input: texts },
      { authorization: `Bearer ${apiKey}` },
    )) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  });
}

export function openaiProvider(apiKey: string, model = 'text-embedding-3-small'): EmbeddingProvider {
  return new HttpEmbedding(`openai:${model}`, async (texts) => {
    const data = (await postJson(
      'https://api.openai.com/v1/embeddings',
      { model, input: texts },
      { authorization: `Bearer ${apiKey}` },
    )) as { data: { embedding: number[] }[] };
    return data.data.map((d) => d.embedding);
  });
}

export function ollamaProvider(
  model = 'nomic-embed-text',
  host = 'http://localhost:11434',
): EmbeddingProvider {
  return new HttpEmbedding(`ollama:${model}`, async (texts) => {
    const data = (await postJson(`${host}/api/embed`, { model, input: texts }, {})) as {
      embeddings: number[][];
    };
    return data.embeddings;
  });
}

export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | undefined {
  const model = env.EKG_EMBEDDINGS_MODEL;
  switch (env.EKG_EMBEDDINGS_PROVIDER) {
    case 'voyage': {
      const key = env.VOYAGE_API_KEY ?? env.EKG_EMBEDDINGS_API_KEY;
      return key ? voyageProvider(key, model ?? 'voyage-3-large') : undefined;
    }
    case 'openai': {
      const key = env.OPENAI_API_KEY ?? env.EKG_EMBEDDINGS_API_KEY;
      return key ? openaiProvider(key, model ?? 'text-embedding-3-small') : undefined;
    }
    case 'ollama':
      return ollamaProvider(model ?? 'nomic-embed-text', env.OLLAMA_HOST);
    default:
      return undefined;
  }
}
