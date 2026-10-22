export interface Source {
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

export interface DocumentChunk {
  id: string;
  document_id: string;
  user_id: string;
  chunk_index: number;
  content: string;
  embedding?: number[];
  token_count?: number;
  created_at: string;
}

export interface Document {
  id: string;
  name: string;
  file_type: string;
  storage_path?: string;
  /** Phase 2 — canonical status. One of 'processing' | 'ready' | 'failed' */
  status?: 'processing' | 'ready' | 'failed';
  /** Phase 2 — human-readable reason when status === 'failed' */
  error_message?: string;
  /** Phase 2 — full extracted text used for RAG (replaces content_text) */
  extracted_text?: string;
  /** Phase 2 — length of extracted_text in characters */
  char_count?: number;
  /** Legacy — kept for backward compat with existing rows & edge functions */
  content_text?: string;
  /** Legacy — kept for backward compat */
  processed?: boolean;
  data_source_id?: string;
  created_at?: string;
  user_id?: string;
}

export interface User {
  id: string;
  email: string;
}

export interface UserProfile {
  id: string;
  user_id: string;
  display_name: string;
  avatar_url?: string;
  language: string;
  theme: string;
  email_notifications: boolean;
  push_notifications: boolean;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  user_id: string;
  documents?: { count: number }[];
}

export interface DataSource {
  id: string;
  name: string;
  type: string;
  connection_string?: string;
  last_synced_at?: string;
  sync_status?: string;
  sync_error?: string;
  created_at: string;
  user_id: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface SourceCitation {
  citationIndex: number;
  id: string;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
  x_coordinate?: number | null;
  y_coordinate?: number | null;
}

export type Provider = 'groq' | 'anthropic' | 'openai';

export interface ChatMessage {
  id: string;
  user_id: string;
  session_id?: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
  isError?: boolean;
  provider_used?: string;
  model_used?: string;
  notice?: string | null;
  sources?: SourceCitation[];
  isStreaming?: boolean;
  status?: 'thinking' | 'streaming' | 'done' | 'error';
}

export interface ChatSession {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  type: 'info' | 'success' | 'warning' | 'error';
  read: boolean;
  created_at: string;
}
