# DocuTalk AI 💬📚

> **Chat with your documents and data with zero hallucinations, exact citations, and real-time 2D semantic exploration.**

DocuTalk AI is a production-grade Retrieval-Augmented Generation (RAG) web application built with React, TypeScript, Tailwind CSS, and Supabase. Connect your PDFs, Word documents, and PostgreSQL databases to have fast, grounded conversations backed by hybrid search and multi-provider AI fallback.

---

## ✨ Features

- **⚡ Real-Time Token Streaming**: Low-latency Server-Sent Events (SSE) streaming with `requestAnimationFrame` token batching for fluid markdown rendering.
- **🔍 Hybrid Retrieval (Vector + BM25 FTS)**: Combines dense 1024-dimensional semantic embeddings (Voyage AI `voyage-3`) with Postgres full-text keyword search using Reciprocal Rank Fusion (RRF).
- **🛡️ Multi-Provider AI Fallback**: Resilient inference routing across **Groq** (`gpt-oss-120b`, `gpt-oss-20b`), **Anthropic** (`claude-sonnet-5-5`), and **OpenAI** (`gpt-4o-mini`). Automatic failover on auth, rate limit, quota (429), or model outage.
- **📍 Interactive Inline Citations**: Every factual claim is referenced with clickable `[1]`, `[2]` chips featuring passage preview popovers and direct jump-to-source navigation.
- **🗺️ 2D Semantic Vector Map**: High-performance HTML5 canvas visualization showing document chunks in 2D space. Clicking any citation smoothly lerps the camera and pulses on the exact cited chunk.
- **📑 Memory-Safe Document Ingestion**: Streaming page-by-page PDF parser maintaining `<45MB` browser RAM usage even on large 30MB+ files, with automatic sidecar offloading for texts exceeding 400KB.
- **🔒 Secure Authentication & Data Isolation**: Supabase Auth (Email + Google OAuth) with strict PostgreSQL Row-Level Security (RLS) ensuring total tenant isolation.

---

## 🛠️ Architecture

```
User Query ──► Conversational Condenser ──► Hybrid Search (pgvector + FTS via RRF)
                                                  │
                                                  ▼
SSE Stream ◄── LLM Fallback (Groq/Anthropic/OpenAI) ◄── Top Ranked Document Chunks
    │
    ├─► Real-Time Markdown Token Stream
    ├─► Inline Interactive Citations [1]
    └─► 2D Semantic Map Camera Focus & Sonar Pulse
```

---

## 💻 Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, Lucide Icons, GSAP & Motion
- **Database & Backend**: Supabase (PostgreSQL 15+, pgvector, Edge Functions via Deno)
- **Embeddings**: Voyage AI (`voyage-3`, native 1024 dimensions)
- **Primary LLM Engine**: Groq LPU (`openai/gpt-oss-120b`)
- **Fallback LLM Engines**: Anthropic Claude & OpenAI
- **Deployment**: Vercel (Frontend SPA) + Supabase (Edge Functions & Database)

---

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later)
- [Supabase CLI](https://supabase.com/docs/guides/cli) (optional for local functions)
- A free account on [Supabase](https://supabase.com), [Groq](https://console.groq.com), and [Voyage AI](https://www.voyageai.com)

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/Ironmanforever-3000/docutalk-ai.git
cd docutalk-ai
npm install
```

### 2. Environment Variables

Create a `.env.local` file in the root directory:

```env
VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<your-supabase-anon-key>
```

### 3. Configure Supabase Server Secrets

Set your provider API keys inside your Supabase project (never expose these in client environment variables):

```bash
supabase secrets set GROQ_API_KEY="gsk_..."
supabase secrets set VOYAGE_API_KEY="pa-..."
# Optional fallbacks:
supabase secrets set ANTHROPIC_API_KEY="sk-ant-..."
supabase secrets set OPENAI_API_KEY="sk-..."
```

### 4. Run Database Migration

Apply the SQL migration file located in `supabase/migrations/20261014220000_rag_stream_hybrid_upgrade.sql` using your Supabase Dashboard SQL Editor.

### 5. Start Development Server

```bash
npm run dev
```

Open `http://localhost:5173` in your browser.

---

## 🧪 Testing & Verification

Run the test suite to verify fallback routing, key validation, and token stripping:

```bash
# Run LLM provider fallback test suite (16 tests)
npm run test:llm

# Run TypeScript typecheck
npm run typecheck

# Run production build
npm run build
```

---

## 🌐 Deploying to Vercel

1. Push your repository to GitHub.
2. In the [Vercel Dashboard](https://vercel.com), import the project.
3. Keep default build settings (**Framework: Vite**, Build: `npm run build`, Output: `dist`).
4. Add Environment Variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
5. In Supabase Dashboard $\rightarrow$ **Authentication** $\rightarrow$ **URL Configuration**, add your Vercel URL to **Site URL** and **Redirect URLs** (`https://<your-app>.vercel.app/**`).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
The live deployed site: https://docutalk-o1ap.onrender.com/
