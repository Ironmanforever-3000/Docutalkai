-- ==============================================================================
-- RAG Pipeline Upgrade: 1024d Vector Migration, Full-Text Search, and Hybrid RPC
-- ==============================================================================

-- 1. User Creation Trigger Fix (search_path, conflict handling, and error fallback)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1),
      'User'
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (user_id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    avatar_url = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url),
    updated_at = NOW();

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'handle_new_user trigger error: %', SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 2. Migrate existing 1536-dim vectors down to 1024-dim in-place using subvector
DROP INDEX IF EXISTS document_chunks_embedding_idx;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = 'document_chunks' 
      AND column_name = 'embedding'
  ) THEN
    -- Alter column type down to 1024 in-place
    ALTER TABLE public.document_chunks 
      ALTER COLUMN embedding TYPE vector(1024) 
      USING subvector(embedding, 1, 1024)::vector(1024);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx 
  ON public.document_chunks 
  USING hnsw (embedding vector_cosine_ops);

-- 3. Stored tsvector column and GIN index for BM25/FTS lookup
ALTER TABLE public.document_chunks
  ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED;

CREATE INDEX IF NOT EXISTS document_chunks_fts_idx 
  ON public.document_chunks USING gin (fts);

-- 4. Hybrid Search RPC (Vector + Full-Text Search with RRF and Document Scoping)
CREATE OR REPLACE FUNCTION public.hybrid_match_chunks(
  query_text text,
  query_embedding vector(1024),
  match_user_id uuid,
  match_count int DEFAULT 8,
  match_document_ids uuid[] DEFAULT NULL,
  rrf_k int DEFAULT 60
) RETURNS TABLE (
  id uuid,
  document_id uuid,
  chunk_index int,
  content text,
  similarity float,
  rrf_score float,
  x_coordinate float,
  y_coordinate float
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
WITH filtered_chunks AS (
  SELECT 
    c.id, 
    c.document_id, 
    c.chunk_index, 
    c.content, 
    c.embedding, 
    c.fts,
    c.x_coordinate,
    c.y_coordinate
  FROM public.document_chunks c
  WHERE c.user_id = match_user_id
    AND (match_document_ids IS NULL OR c.document_id = ANY(match_document_ids))
),
vector_search AS (
  SELECT 
    id,
    1 - (embedding <=> query_embedding) AS sim,
    ROW_NUMBER() OVER (ORDER BY embedding <=> query_embedding) AS rank
  FROM filtered_chunks
  WHERE 1 - (embedding <=> query_embedding) >= 0.25
  ORDER BY embedding <=> query_embedding
  LIMIT 30
),
keyword_search AS (
  SELECT 
    id,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank_cd(fts, websearch_to_tsquery('english', query_text)) DESC
    ) AS rank
  FROM filtered_chunks
  WHERE fts @@ websearch_to_tsquery('english', query_text)
  LIMIT 30
)
SELECT 
  c.id,
  c.document_id,
  c.chunk_index,
  c.content,
  COALESCE(v.sim, 0.0)::float AS similarity,
  (COALESCE(1.0 / (rrf_k + v.rank), 0.0) + COALESCE(1.0 / (rrf_k + k.rank), 0.0))::float AS rrf_score,
  c.x_coordinate,
  c.y_coordinate
FROM filtered_chunks c
LEFT JOIN vector_search v ON c.id = v.id
LEFT JOIN keyword_search k ON c.id = k.id
WHERE v.id IS NOT NULL OR k.id IS NOT NULL
ORDER BY rrf_score DESC
LIMIT match_count;
$$;

-- 5. Update Storage Bucket size to 50MB and ensure folder-scoped RLS policies
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'documents',
  'documents',
  false,
  52428800,
  ARRAY[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown',
    'text/csv'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = 52428800,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Users can upload own documents" ON storage.objects;
CREATE POLICY "Users can upload own documents"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can read own documents" ON storage.objects;
CREATE POLICY "Users can read own documents"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Users can delete own documents" ON storage.objects;
CREATE POLICY "Users can delete own documents"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );
