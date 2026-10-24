import { createClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://dristvsoinnvufgndymj.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'sb_publishable_YZYBRQQL5OyDWfm_am7UwA_QJMrkTN2';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

// ─── Data Source Helpers ──────────────────────────────────────────────────────

export interface DataSourceActionResult {
  success?: boolean;
  error?: string;
  tableCount?: number;
  tables?: string[];
  syncedTables?: number;
  documents?: Array<{ id: string; name: string }>;
}

async function invokeDataSourceFunction(
  action: 'test' | 'sync',
  dataSourceId: string
): Promise<DataSourceActionResult> {
  const { data, error } = await supabase.functions.invoke('data-source', {
    body: { action, dataSourceId },
  });

  if (error) {
    throw new Error(
      error.message ||
        'Data source function unavailable. Deploy the data-source edge function to Supabase.'
    );
  }

  if (data?.error) {
    throw new Error(data.error as string);
  }

  return data as DataSourceActionResult;
}

/** Tests whether a saved PostgreSQL data source is reachable. */
export async function testDataSource(dataSourceId: string): Promise<DataSourceActionResult> {
  return invokeDataSourceFunction('test', dataSourceId);
}

/** Syncs PostgreSQL tables into documents so DocuTalk RAG can use them. */
export async function syncDataSource(dataSourceId: string): Promise<DataSourceActionResult> {
  return invokeDataSourceFunction('sync', dataSourceId);
}

// ─── Edge Function Error Helper ──────────────────────────────────────────────

export async function functionErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.clone === "function") {
    try {
      const body = await ctx.clone().json();
      return body.error ?? body.message ?? JSON.stringify(body);
    } catch {
      /* body was not JSON */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

// ─── General Chat (via Edge Function) ────────────────────────────────────────

export interface GeneralChatResult {
  response: string;
  provider_used?: string;
  model_used?: string;
  notice?: string | null;
  timestamp?: string;
}

/**
 * Calls the chat Edge Function for general Q&A without RAG context.
 */
export async function generalChat(
  message: string,
  history: Array<{ role: string; content: string }>,
  apiKeys?: Partial<Record<string, string>>,
  provider?: string
): Promise<GeneralChatResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('No active session');
  }

  const filteredKeys: Record<string, string> = {};
  if (apiKeys) {
    for (const [k, v] of Object.entries(apiKeys)) {
      if (v && v.trim()) filteredKeys[k] = v.trim();
    }
  }

  const { data, error } = await supabase.functions.invoke('chat', {
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: {
      message,
      history,
      documents: [],
      apiKeys: Object.keys(filteredKeys).length ? filteredKeys : undefined,
      provider: provider || 'groq',
    },
  });

  if (error) {
    const msg = await functionErrorMessage(error);
    throw new Error(msg || 'Chat function unavailable');
  }

  if (data?.error) {
    throw new Error(data.error as string);
  }

  return {
    response: (data as { response: string }).response || 'No response generated.',
    provider_used: data?.provider_used,
    model_used: data?.model_used,
    notice: data?.notice ?? null,
    timestamp: data?.timestamp,
  };
}

// ─── RAG Chat (via Edge Function) ────────────────────────────────────────────

export interface RagChatSource {
  id: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  content_snippet: string;
  similarity: number;
  x_coordinate: number | null;
  y_coordinate: number | null;
}

export interface RagChatResult {
  response: string;
  sources: RagChatSource[];
  vectorSearch: boolean;
  query_coordinate?: { x: number; y: number; document_id: string } | null;
  provider_used?: string;
  model_used?: string;
  notice?: string | null;
}

/**
 * Calls the rag-chat Edge Function for vector-powered retrieval.
 */
export async function ragChat(
  message: string,
  history: Array<{ role: string; content: string }>,
  documentIds: string[],
  apiKeys?: Partial<Record<string, string>>,
  provider?: string
): Promise<RagChatResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.access_token) {
    throw new Error('No active session');
  }

  const filteredKeys: Record<string, string> = {};
  if (apiKeys) {
    for (const [k, v] of Object.entries(apiKeys)) {
      if (v && v.trim()) filteredKeys[k] = v.trim();
    }
  }

  const { data, error } = await supabase.functions.invoke('rag-chat', {
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: {
      message,
      history,
      document_ids: documentIds,
      apiKeys: Object.keys(filteredKeys).length ? filteredKeys : undefined,
      provider: provider || 'groq',
    },
  });

  if (error) {
    const msg = await functionErrorMessage(error);
    throw new Error(msg || 'RAG chat function unavailable');
  }

  if (data?.error) {
    throw new Error(data.error as string);
  }

  return {
    response: (data as { response: string }).response || 'No response generated.',
    sources: (data as { sources: RagChatSource[] }).sources || [],
    vectorSearch: !!(data as { vectorSearch: boolean }).vectorSearch,
    query_coordinate: (data as { query_coordinate?: { x: number; y: number; document_id: string } | null }).query_coordinate,
    provider_used: data?.provider_used,
    model_used: data?.model_used,
    notice: data?.notice ?? null,
  };
}
