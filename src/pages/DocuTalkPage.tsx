import { useState, useRef, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Send, Bot, User, Trash2, Copy, Check, FileText, Settings, AlertCircle, Paperclip, X, Loader2, Download, Zap, Database, MessageSquarePlus, Square, Compass } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase, functionErrorMessage } from '../lib/supabase';
import { Document, ChatMessage, DataSource, Provider, SourceCitation } from '../types';
import { extractTextFromFile } from '../lib/extraction';


import { CitedMessage } from '../components/CitedMessage';
import { SemanticMapCanvas, type MapChunkNode } from '../components/SemanticMapCanvas';

const SETTINGS_KEY_V2 = 'docutalk_settings.v2';

interface ServerStatus {
  default: Provider;
  order: Provider[];
  providers: Record<Provider, { serverKey: 'ok' | 'missing' | 'malformed'; model: string }>;
}

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

function validateKeyPrefix(p: Provider, raw: string): string | null {
  const k = raw.trim();
  if (!k) return null;
  if (p === 'anthropic') {
    if (k.startsWith('gsk_')) return 'This looks like a Groq key (gsk_...), not an Anthropic key.';
    if (k.startsWith('sk-') && !k.startsWith('sk-ant-')) return 'This looks like an OpenAI key (sk-...), not an Anthropic key.';
    if (!k.startsWith('sk-ant-')) return 'Anthropic keys start with sk-ant-...';
  }
  if (p === 'groq') {
    if (k.startsWith('sk-ant-')) return 'This looks like an Anthropic key (sk-ant-...), not a Groq key.';
    if (k.startsWith('sk-')) return 'This looks like an OpenAI key (sk-...), not a Groq key.';
    if (!k.startsWith('gsk_')) return 'Groq keys start with gsk_...';
  }
  if (p === 'openai') {
    if (k.startsWith('gsk_')) return 'This looks like a Groq key (gsk_...), not an OpenAI key.';
    if (k.startsWith('sk-ant-')) return 'This looks like an Anthropic key (sk-ant-...), not an OpenAI key.';
    if (!k.startsWith('sk-')) return 'OpenAI keys start with sk-...';
  }
  return null;
}

export default function DocuTalkPage() {
  const { user } = useAuth();
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const docsParam = searchParams.get('docs');
  const isGuestUser = user?.app_metadata?.provider === 'guest';

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  
  const [sessions, setSessions] = useState<Array<{ id: string; title: string; created_at: string }>>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
  const [isSyncingSources, setIsSyncingSources] = useState(false);
  const [isLoadingDocs, setIsLoadingDocs] = useState(false);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());

  const [apiKeys, setApiKeys] = useState<Record<Provider, string>>({
    groq: '',
    anthropic: '',
    openai: '',
  });
  const [provider, setProvider] = useState<Provider>('groq');
  const [draftKey, setDraftKey] = useState<string>('');
  const [isEditingKey, setIsEditingKey] = useState(false);
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null);
  const [chatNotice, setChatNotice] = useState<string | null>(null);
  const [migrationToast, setMigrationToast] = useState<string | null>(null);
  const [providerHint, setProviderHint] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  // Custom Paste feature states
  const [showPasteArea, setShowPasteArea] = useState(false);
  const [pastedText, setPastedText] = useState('');
  const [pasteTitle, setPasteTitle] = useState('');
  const [isSavingPaste, setIsSavingPaste] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);

  // File-attach states
  const fileAttachRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isParsingFile, setIsParsingFile] = useState(false);
  const [attachedFileName, setAttachedFileName] = useState<string | null>(null);
  const [attachError, setAttachError] = useState<string | null>(null);

  // Streaming & RAG visualizer states
  const [isStreaming, setIsStreaming] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [focusedChunkId, setFocusedChunkId] = useState<string | null>(null);
  const [activeTurnSources, setActiveTurnSources] = useState<SourceCitation[]>([]);
  const [allDocumentChunks, setAllDocumentChunks] = useState<MapChunkNode[]>([]);
  const [showMap, setShowMap] = useState(false);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (user) {
      loadSessions();
      initializeRagContext();
      loadSettingsV2();
    }
    // Functions are stable — they only read `user` from closure,
    // so they are intentionally omitted from deps to avoid re-triggering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    abortControllerRef.current?.abort();
    setIsStreaming(false);
    setFocusedChunkId(null);
    setActiveTurnSources([]);
    if (sessionId) {
      loadMessages(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Abort ongoing stream on component unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Load 2D chunk coordinates for map visualization
  useEffect(() => {
    const loadChunksForMap = async () => {
      if (!user || isGuestUser) {
        setAllDocumentChunks([]);
        return;
      }
      try {
        let query = supabase
          .from('document_chunks')
          .select('id, document_id, chunk_index, content, x_coordinate, y_coordinate')
          .order('chunk_index', { ascending: true })
          .limit(600);

        if (selectedDocIds.size > 0) {
          query = query.in('document_id', Array.from(selectedDocIds));
        } else if (documents.length > 0) {
          query = query.in('document_id', documents.slice(0, 5).map((d) => d.id));
        } else {
          setAllDocumentChunks([]);
          return;
        }

        const { data, error } = await query;
        if (!error && data) {
          setAllDocumentChunks(data as MapChunkNode[]);
        }
      } catch (err) {
        console.warn('Failed to load chunks for map:', err);
      }
    };

    loadChunksForMap();
  }, [user, selectedDocIds, documents]);

  const loadSettingsV2 = () => {
    try {
      const rawV2 = localStorage.getItem(SETTINGS_KEY_V2);
      if (rawV2) {
        const parsed = JSON.parse(rawV2);
        if (parsed && typeof parsed === 'object') {
          const prov: Provider = (['groq', 'anthropic', 'openai'] as string[]).includes(parsed.provider)
            ? (parsed.provider as Provider)
            : 'groq';
          const keys = {
            groq: typeof parsed.keys?.groq === 'string' ? parsed.keys.groq.trim() : '',
            anthropic: typeof parsed.keys?.anthropic === 'string' ? parsed.keys.anthropic.trim() : '',
            openai: typeof parsed.keys?.openai === 'string' ? parsed.keys.openai.trim() : '',
          };
          setProvider(prov);
          setApiKeys(keys);
          return;
        }
      }

      // One-time legacy migration
      const legacyKey = (localStorage.getItem('docutalk_api_key') || '').trim();
      const legacyProv = (localStorage.getItem('docutalk_provider') || 'groq') as Provider;
      const initialKeys: Record<Provider, string> = { groq: '', anthropic: '', openai: '' };

      if (legacyKey) {
        if (legacyKey.startsWith('gsk_')) {
          initialKeys.groq = legacyKey;
        } else if (legacyKey.startsWith('sk-ant-')) {
          initialKeys.anthropic = legacyKey;
        } else if (legacyKey.startsWith('sk-')) {
          initialKeys.openai = legacyKey;
        } else {
          setMigrationToast("Your saved API key didn't match any provider and was removed.");
        }
      }

      const initialProvider: Provider = (['groq', 'anthropic', 'openai'] as string[]).includes(legacyProv)
        ? legacyProv
        : 'groq';

      const v2Data = { provider: initialProvider, keys: initialKeys };
      localStorage.setItem(SETTINGS_KEY_V2, JSON.stringify(v2Data));
      localStorage.removeItem('docutalk_api_key');
      localStorage.removeItem('docutalk_provider');

      setProvider(initialProvider);
      setApiKeys(initialKeys);
    } catch (err) {
      console.error('Error loading/migrating settings:', err);
      setProvider('groq');
      setApiKeys({ groq: '', anthropic: '', openai: '' });
    }
  };

  const loadServerStatus = async () => {
    try {
      const { data, error } = await supabase.functions.invoke('test-provider', {
        body: { action: 'status' },
      });
      if (!error && data?.providers) {
        const status = data as ServerStatus;
        setServerStatus(status);
        const currentKey = apiKeys[provider]?.trim();
        const sKey = status.providers[provider]?.serverKey;
        if (!currentKey && sKey !== 'ok') {
          const fallbackProv = status.default || 'groq';
          if (fallbackProv !== provider) {
            setProviderHint(`${provider} has no API key configured. Preselected ${fallbackProv}.`);
            setProvider(fallbackProv);
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load server provider status:', e);
    }
  };

  useEffect(() => {
    if (showSettings) {
      loadServerStatus();
      setDraftKey(apiKeys[provider] || '');
      setIsEditingKey(false);
      setTestResult(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

  const handleProviderChange = (newProv: Provider) => {
    setProvider(newProv);
    setDraftKey(apiKeys[newProv] || '');
    setIsEditingKey(false);
    setTestResult(null);
    setProviderHint(null);
  };

  const handleKeyChange = (val: string) => {
    setDraftKey(val.trim());
    setIsEditingKey(true);
  };

  const currentKeyError = isEditingKey
    ? validateKeyPrefix(provider, draftKey)
    : (apiKeys[provider] ? validateKeyPrefix(provider, apiKeys[provider]) : null);

  const handleSaveSettings = () => {
    if (currentKeyError) return;
    const nextKeys = { ...apiKeys };
    if (isEditingKey) {
      nextKeys[provider] = draftKey.trim();
    }
    try {
      localStorage.setItem(
        SETTINGS_KEY_V2,
        JSON.stringify({ provider, keys: nextKeys })
      );
      setApiKeys(nextKeys);
      setIsEditingKey(false);
      setTestResult(null);
      setShowSettings(false);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
  };

  const handleResetDefaults = () => {
    try {
      const defaultProv = serverStatus?.default || 'groq';
      const emptyKeys = { groq: '', anthropic: '', openai: '' };
      localStorage.setItem(
        SETTINGS_KEY_V2,
        JSON.stringify({ provider: defaultProv, keys: emptyKeys })
      );
      setProvider(defaultProv);
      setApiKeys(emptyKeys);
      setDraftKey('');
      setIsEditingKey(false);
      setTestResult(null);
      setProviderHint(null);
    } catch (err) {
      console.error('Failed to reset settings:', err);
    }
  };

  const [chatError, setChatError] = useState<string | null>(null);

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);

    try {
      const effectiveKeys = { ...apiKeys };
      if (isEditingKey) {
        effectiveKeys[provider] = draftKey.trim();
      }
      const activeKeysPayload: Partial<Record<Provider, string>> = {};
      for (const [p, k] of Object.entries(effectiveKeys) as [Provider, string][]) {
        if (k && k.trim()) activeKeysPayload[p] = k.trim();
      }

      const { data, error } = await supabase.functions.invoke('test-provider', {
        body: {
          provider,
          apiKeys: Object.keys(activeKeysPayload).length ? activeKeysPayload : undefined,
        },
      });

      if (error) {
        const errorMsg = await functionErrorMessage(error);
        setTestResult({ ok: false, message: errorMsg });
      } else if (data?.success) {
        const modelNote = data?.model ? ` (${data.model})` : '';
        const sourceNote = data?.keySource ? `, ${data.keySource} key` : '';
        setTestResult({
          ok: true,
          message: `Connected! ${provider} responded successfully${modelNote}${sourceNote}.`,
        });
      } else {
        setTestResult({ ok: false, message: data?.error || 'Connection failed' });
      }
    } catch (err) {
      const errorMsg = await functionErrorMessage(err);
      setTestResult({ ok: false, message: errorMsg });
    } finally {
      setTesting(false);
    }
  };

  const loadSessions = async () => {
    if (!user) return;

    // Instant local handling for guest mode
    if (isGuestUser) {
      let guestSessions: Array<{ id: string; title: string; created_at: string }> = [];
      try {
        const raw = localStorage.getItem('docutalk_guest_sessions');
        if (raw) guestSessions = JSON.parse(raw);
      } catch {}

      if (guestSessions.length === 0) {
        const defaultSession = {
          id: 'guest-session-1',
          title: 'New Chat',
          created_at: new Date().toISOString(),
        };
        guestSessions = [defaultSession];
        try {
          localStorage.setItem('docutalk_guest_sessions', JSON.stringify(guestSessions));
        } catch {}
      }

      setSessions(guestSessions);
      if (!sessionId) {
        navigate(`/app/chat/${guestSessions[0].id}`, { replace: true });
      }
      return;
    }

    try {
      const queryPromise = supabase
        .from('chat_sessions')
        .select('*')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(10);

      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('Session query timeout') }), 2500)
      );

      const { data, error } = await Promise.race([queryPromise, timeoutPromise]);

      if (error) throw error;

      if (data && data.length > 0) {
        setSessions(data);
        if (!sessionId) navigate(`/app/chat/${data[0].id}`, { replace: true });
      } else {
        const insertPromise = supabase
          .from('chat_sessions')
          .insert({ user_id: user.id, title: 'New Chat' })
          .select()
          .single();

        const insertTimeout = new Promise<{ data: null; error: Error }>((resolve) =>
          setTimeout(() => resolve({ data: null, error: new Error('Insert timeout') }), 2500)
        );

        const { data: newSession, error: createError } = await Promise.race([insertPromise, insertTimeout]);

        if (createError) throw createError;
        if (newSession) {
          setSessions([newSession]);
          if (!sessionId) navigate(`/app/chat/${newSession.id}`, { replace: true });
        }
      }
    } catch (err) {
      console.warn('Notice loading sessions from cloud (offline/timeout fallback):', err);
      const fallbackSession = {
        id: `local-${Date.now()}`,
        title: 'New Chat',
        created_at: new Date().toISOString(),
      };
      setSessions([fallbackSession]);
      if (!sessionId) navigate(`/app/chat/${fallbackSession.id}`, { replace: true });
    } finally {
    }
  };

  const loadMessages = async (currentSessionId: string) => {
    if (!user) return;

    if (isGuestUser || currentSessionId.startsWith('guest-') || currentSessionId.startsWith('local-')) {
      try {
        const raw = localStorage.getItem(`docutalk_guest_msgs_${currentSessionId}`);
        if (raw) {
          setMessages(JSON.parse(raw));
        } else {
          setMessages([]);
        }
      } catch {
        setMessages([]);
      }
      return;
    }

    try {
      const queryPromise = supabase
        .from('chat_messages')
        .select('*')
        .eq('user_id', user.id)
        .eq('session_id', currentSessionId)
        .order('created_at', { ascending: true });

      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('Messages query timeout') }), 2500)
      );

      const { data, error } = await Promise.race([queryPromise, timeoutPromise]);
      if (error) throw error;
      const cleanMessages = (data || []).filter(
        (m: ChatMessage) => !m.content.startsWith('AI connection failed')
      );
      setMessages(cleanMessages);
    } catch (err) {
      console.warn('Notice loading messages from cloud:', err);
      setMessages([]);
    } finally {
    }
  };

  const loadDocuments = async (): Promise<Document[]> => {
    if (!user) return [];

    if (isGuestUser) {
      try {
        const raw = localStorage.getItem('docutalk_guest_docs');
        const docs = raw ? (JSON.parse(raw) as Document[]) : [];
        setSelectedDocIds(new Set(docs.map((d) => d.id)));
        return docs;
      } catch {
        return [];
      }
    }

    try {
      const queryPromise = supabase
        .from('documents')
        .select('id, name, file_type, status, char_count, created_at, error_message')
        .eq('user_id', user.id)
        .eq('status', 'ready')
        .order('created_at', { ascending: false })
        .limit(50);

      const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: new Error('Documents timeout') }), 2500)
      );

      const { data, error } = await Promise.race([queryPromise, timeoutPromise]);
      
      if (error) {
        console.warn('Documents query note:', error.message);
      }

      const docs = (data as Document[]) || [];
      if (docsParam) {
        const allowedIds = new Set(docsParam.split(','));
        setSelectedDocIds(new Set(docs.filter(d => allowedIds.has(d.id)).map(d => d.id)));
      } else {
        setSelectedDocIds(new Set(docs.map(d => d.id)));
      }
      return docs;
    } catch (err) {
      console.warn('Error loading documents:', err);
      return [];
    }
  };

  const loadDataSources = async (): Promise<DataSource[]> => {
    if (!user || isGuestUser) return [];
    try {
      const queryPromise = supabase
        .from('data_sources')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      const timeoutPromise = new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), 2500)
      );

      const { data } = await Promise.race([queryPromise, timeoutPromise]);
      return (data as DataSource[]) || [];
    } catch (err) {
      console.warn('Error loading data sources:', err);
      return [];
    }
  };

  const initializeRagContext = async () => {
    if (!user) return;

    setIsLoadingDocs(true);
    setSyncNotice(null);

    if (isGuestUser) {
      const docs = await loadDocuments();
      setDocuments(docs);
      setDataSources([]);
      setIsLoadingDocs(false);
      setIsSyncingSources(false);
      return;
    }

    try {
      const [sources, loadedDocs] = await Promise.all([
        loadDataSources(),
        loadDocuments(),
      ]);
      setDataSources(sources);
      setDocuments(loadedDocs);
    } catch (err) {
      console.warn('Error initializing RAG context:', err);
    } finally {
      setIsSyncingSources(false);
      setIsLoadingDocs(false);
    }
  };

  const handleFileAttach = useCallback(
    async (file: File) => {
      if (!user) return;
      setAttachError(null);
      setAttachedFileName(null);

      const ALLOWED = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'text/markdown',
        'text/csv',
        'application/json',
        'application/xml',
        'text/xml',
      ];
      const isAllowed =
        ALLOWED.includes(file.type) ||
        file.name.endsWith('.md') ||
        file.name.endsWith('.txt') ||
        file.name.endsWith('.docx') ||
        file.name.endsWith('.csv') ||
        file.name.endsWith('.json') ||
        file.name.endsWith('.xml');

      if (!isAllowed) {
        const isImage = file.type.startsWith('image/');
        setAttachError(
          isImage
            ? `Image files are not supported (${file.name}). OCR is not available — paste or upload a text-based document instead.`
            : `Unsupported file type: ${file.name}`
        );
        return;
      }

      const MAX_FILE_SIZE = 50 * 1024 * 1024;
      if (file.size > MAX_FILE_SIZE) {
        setAttachError(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 50MB.`);
        return;
      }

      setIsParsingFile(true);
      try {
        const result = await extractTextFromFile(file);
        if (result.status === 'failed' || !result.text) {
          setAttachError(result.errorMessage || `Could not extract text from "${file.name}". The file may be image-only or corrupted.`);
          return;
        }
        const text = result.text;

        if (isGuestUser) {
          const guestDoc: Document = {
            id: `guest-doc-${Date.now()}`,
            user_id: user.id,
            name: file.name,
            file_type: file.name.split('.').pop() || 'txt',
            status: 'ready',
            extracted_text: text,
            char_count: text.length,
            content_text: text,
            created_at: new Date().toISOString(),
          };
          const updated = [guestDoc, ...documents];
          setDocuments(updated);
          setSelectedDocIds((prev) => new Set([...prev, guestDoc.id]));
          setAttachedFileName(file.name);
          try {
            localStorage.setItem('docutalk_guest_docs', JSON.stringify(updated));
          } catch {}
          setIsParsingFile(false);
          return;
        }

        const { data, error } = await supabase
          .from('documents')
          .insert({
            user_id: user.id,
            name: file.name,
            file_type: file.name.split('.').pop() || 'txt',
            status: 'ready',
            extracted_text: text,
            char_count: text.length,
            content_text: text,
            processed: true,
          })
          .select('id, name, file_type, content_text, extracted_text, status, char_count, error_message')
          .single();

        if (error) throw error;
        if (data) {
          setDocuments((prev) => [data as Document, ...prev]);
          setSelectedDocIds((prev) => new Set([...prev, data.id]));
          setAttachedFileName(file.name);
          // Trigger chunking + embedding so vector search finds this document
          const { error: vecError } = await supabase.functions.invoke('process-document', {
            body: { document_id: data.id },
          });
          if (vecError) {
            console.warn(`[Vectorize] Failed for attached doc "${file.name}":`, vecError);
          }
        }
      } catch (err) {
        console.error('handleFileAttach error:', err);
        setAttachError(err instanceof Error ? err.message : 'Failed to load file.');
      } finally {
        setIsParsingFile(false);
      }
    },
    [user]
  );

  const handleTextareaPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      const file = files[0];
      // Only intercept if it's an actual file paste (not text with embedded images
      // from clipboard — e.g. copying from a webpage often includes image MIME types).
      // We check that the user intended a file paste by ensuring the clipboard
      // does NOT also contain plain text.
      const hasText = e.clipboardData.types?.includes('text/plain') ||
                      e.clipboardData.types?.includes('text/html');
      const isLikelyFilePaste = !hasText ||
                                file.size > 1024 * 1024 ||
                                file.type === 'application/pdf' ||
                                file.type.startsWith('text/');
      if (isLikelyFilePaste) {
        e.preventDefault();
        await handleFileAttach(files[0]);
      }
      // Otherwise let the normal text paste proceed
    }
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) await handleFileAttach(files[0]);
  };

  // ─────────────────────────────────────────────────────────────────────────────

  const handlePasteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !pastedText.trim()) return;

    setIsSavingPaste(true);
    setPasteError(null);
    const documentTitle = pasteTitle.trim() || `Pasted Doc - ${new Date().toLocaleDateString()}`;

    if (isGuestUser) {
      const trimmed = pastedText.trim();
      const guestDoc: Document = {
        id: `guest-doc-${Date.now()}`,
        user_id: user.id,
        name: documentTitle,
        file_type: 'txt',
        status: 'ready',
        extracted_text: trimmed,
        content_text: trimmed,
        char_count: trimmed.length,
        created_at: new Date().toISOString(),
      };
      const updated = [guestDoc, ...documents];
      setDocuments(updated);
      setSelectedDocIds((prev) => new Set([...prev, guestDoc.id]));
      try {
        localStorage.setItem('docutalk_guest_docs', JSON.stringify(updated));
      } catch {}
      setPastedText('');
      setPasteTitle('');
      setShowPasteArea(false);
      setIsSavingPaste(false);
      return;
    }

    try {
      const trimmed = pastedText.trim();
      const { data, error } = await supabase
          .from('documents')
          .insert({
            user_id: user.id,
            name: documentTitle,
            file_type: 'txt',
            status: 'ready',
            extracted_text: trimmed,
            char_count: trimmed.length,
            content_text: trimmed,
            processed: true,
          })
          .select('id, name, file_type, content_text, extracted_text, status, char_count, error_message')
          .single();

      if (error) throw error;
      if (data) {
        setDocuments((prev) => [data as Document, ...prev]);
        setSelectedDocIds((prev) => new Set([...prev, data.id]));
        setPastedText('');
        setPasteTitle('');
        setShowPasteArea(false);
        // Wait for chunking + embedding to finish before closing
        setIsSavingPaste(true);
        const { error: vecError } = await supabase.functions.invoke('process-document', {
          body: { document_id: data.id },
        });
        if (vecError) {
          console.warn(`[Vectorize] Failed for pasted doc "${documentTitle}":`, vecError);
        }
      }
    } catch (err) {
      console.error('Error saving pasted document:', err);
      setPasteError(err instanceof Error ? err.message : 'Failed to save document.');
    } finally {
      setIsSavingPaste(false);
    }
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const downloadSolutionFile = (filename: string, content: string) => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };



  const handleStopGenerating = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
    setLoading(false);
  };

  const handleFocusChunkOnMap = (chunkId: string, messageSources?: SourceCitation[]) => {
    setFocusedChunkId(chunkId);
    if (messageSources && messageSources.length > 0) {
      setActiveTurnSources(messageSources);
    }
    setShowMap(true);
    setTimeout(() => {
      mapContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
  };

  const handleSend = async () => {
    if (!input.trim() || loading || isStreaming || !user) return;

    let activeSessionId = sessionId;
    if (!activeSessionId) {
      if (sessions.length > 0) {
        activeSessionId = sessions[0].id;
      } else {
        activeSessionId = isGuestUser ? `guest-session-${Date.now()}` : `session-${Date.now()}`;
        setSessions([{ id: activeSessionId, title: 'New Chat', created_at: new Date().toISOString() }]);
      }
      navigate(`/app/chat/${activeSessionId}`, { replace: true });
    }

    const userMessage = input.trim();
    setInput('');
    setLoading(true);
    setChatError(null);

    const userMsgId = crypto.randomUUID();
    const assistantMsgId = crypto.randomUUID();

    const userChatMessage: ChatMessage = {
      id: userMsgId,
      user_id: user.id,
      session_id: activeSessionId,
      role: 'user',
      content: userMessage,
      created_at: new Date().toISOString(),
    };

    const assistantPlaceholder: ChatMessage = {
      id: assistantMsgId,
      user_id: user.id,
      session_id: activeSessionId,
      role: 'assistant',
      content: '',
      created_at: new Date().toISOString(),
      status: 'thinking',
      isStreaming: true,
      sources: [],
    };

    const priorHistory = messages
      .filter((m) => !m.isError && !(m.content || '').startsWith('AI connection failed'))
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userChatMessage, assistantPlaceholder]);
    setIsStreaming(true);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    let accumulatedText = '';
    let tokenQueue = '';
    let rafId: number | null = null;
    let streamedSources: SourceCitation[] = [];
    let usedProvider: Provider = provider;
    let usedModel: string | undefined;
    const supabaseBaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://dristvsoinnvufgndymj.supabase.co';
    const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_YZYBRQQL5OyDWfm_am7UwA_QJMrkTN2';
    const functionUrl = `${supabaseBaseUrl}/functions/v1/rag-chat`;

    try {
      // Record user message to DB if not guest, or to localStorage if guest
      if (!isGuestUser) {
        try {
          await supabase.from('chat_messages').insert({
            id: userMsgId,
            user_id: user.id,
            session_id: activeSessionId,
            role: 'user',
            content: userMessage,
          });
        } catch (err) {
          console.warn('Message cloud save note:', err);
        }
      } else {
        try {
          const current = JSON.parse(localStorage.getItem(`docutalk_guest_msgs_${activeSessionId}`) || '[]');
          localStorage.setItem(
            `docutalk_guest_msgs_${activeSessionId}`,
            JSON.stringify([...current, userChatMessage])
          );
        } catch {}
      }

      let authToken = supabaseAnonKey;
      if (!isGuestUser) {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          if (session?.access_token) {
            authToken = session.access_token;
          }
        } catch {}
      }


      const activeDocIds = documents
        .filter((d) => selectedDocIds.has(d.id))
        .map((d) => d.id);

      const response = await fetch(functionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
          apikey: supabaseAnonKey,
        },
        body: JSON.stringify({
          message: userMessage,
          history: priorHistory,
          document_ids: activeDocIds,
          provider,
          apiKey: apiKeys[provider] || undefined,
          apiKeys,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        let detailedMsg = errJson.error || `Server error (${response.status})`;
        if (response.status === 401) {
          detailedMsg = 'Authentication failed (401 Unauthorized): Your session token or anon key was not accepted by the Edge Function.';
        } else if (response.status === 502) {
          detailedMsg = `AI Provider unavailable (502 Bad Gateway): ${errJson.error || 'All configured LLM providers failed.'}`;
        }
        const httpError = Object.assign(new Error(detailedMsg), { status: response.status });
        throw httpError;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Browser failed to initialize stream reader.');
      }

      const decoder = new TextDecoder('utf-8');
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        const frames = sseBuffer.split('\n\n');
        sseBuffer = frames.pop() ?? '';

        for (const frame of frames) {
          const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;

          try {
            const event = JSON.parse(jsonStr);

            if (event.type === 'meta') {
              streamedSources = (event.sources || []) as SourceCitation[];
              usedProvider = (event.provider as Provider) || provider;
              usedModel = event.model;
              if (event.fallbackNotice) {
                setChatNotice(event.fallbackNotice);
              }
              setActiveTurnSources(streamedSources);

              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        sources: streamedSources,
                        provider_used: usedProvider,
                        model_used: usedModel,
                        status: 'streaming',
                      }
                    : m
                )
              );
            } else if (event.type === 'token') {
              const tokenStr = typeof event.content === 'string' ? event.content : '';
              accumulatedText += tokenStr;
              tokenQueue += tokenStr;

              // Batch token appends once per animation frame
              if (!rafId) {
                rafId = requestAnimationFrame(() => {
                  const chunk = tokenQueue;
                  tokenQueue = '';
                  rafId = null;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, content: m.content + chunk, status: 'streaming' }
                        : m
                    )
                  );
                });
              }
            } else if (event.type === 'error') {
              throw new Error(event.message || 'Stream generation failed');
            } else if (event.type === 'done') {
              if (rafId) {
                cancelAnimationFrame(rafId);
                rafId = null;
              }
              const finalText = accumulatedText;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        content: finalText,
                        status: 'done',
                        isStreaming: false,
                      }
                    : m
                )
              );
            }
          } catch (parseErr) {
            // Ignore partial frame parse errors
          }
        }
      }

      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      const finalText = accumulatedText;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: finalText,
                status: 'done',
                isStreaming: false,
                sources: streamedSources,
                provider_used: usedProvider,
                model_used: usedModel,
              }
            : m
        )
      );

      if (finalText.trim()) {
        if (!isGuestUser) {
          try {
            await supabase.from('chat_messages').insert({
              id: assistantMsgId,
              user_id: user.id,
              session_id: activeSessionId,
              role: 'assistant',
              content: finalText,
            });
          } catch (cloudErr) {
            console.warn('Assistant message cloud save note:', cloudErr);
          }
        } else {
          try {
            const current = JSON.parse(localStorage.getItem(`docutalk_guest_msgs_${activeSessionId}`) || '[]');
            localStorage.setItem(
              `docutalk_guest_msgs_${activeSessionId}`,
              JSON.stringify([
                ...current,
                {
                  id: assistantMsgId,
                  role: 'assistant',
                  content: finalText,
                  sources: streamedSources,
                  provider_used: usedProvider,
                  model_used: usedModel,
                  status: 'done',
                  isStreaming: false,
                },
              ])
            );
          } catch {}
        }
      }
    } catch (err: unknown) {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }

      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' || err.message.includes('aborted'));

      if (isAbort) {
        const partialText = accumulatedText;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? {
                  ...m,
                  content: partialText,
                  status: 'done',
                  isStreaming: false,
                }
              : m
          )
        );

        if (partialText.trim()) {
          await supabase.from('chat_messages').insert({
            id: assistantMsgId,
            user_id: user.id,
            session_id: sessionId,
            role: 'assistant',
            content: partialText,
          });
        }
        return;
      }

      let errorMessage = 'AI connection failed';
      let guidance = 'If this keeps happening, check your AI settings or the Edge Function logs.';

      if (err instanceof TypeError && (err.message.includes('fetch') || err.message.includes('network') || err.message.includes('Failed'))) {
        errorMessage = `Network / DNS failure: Unable to reach ${functionUrl}.`;
        guidance = 'The request never reached Supabase. Check your internet connection, verify VITE_SUPABASE_URL points to an active project, and ensure CORS is enabled for this origin.';
      } else if (err instanceof Error) {
        errorMessage = err.message;
        const errStatus = typeof err === 'object' && err !== null && 'status' in err ? (err as { status?: number }).status : undefined;
        if (errStatus === 401) {
          guidance = 'Please sign in or check your Supabase anon key.';
        } else if (errStatus === 502) {
          guidance = 'Check your AI API keys (Groq, OpenAI, or Anthropic) in AI Settings.';
        }
      }
      console.error('Streaming error:', err);

      setChatError(errorMessage);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? {
                ...m,
                content: `${errorMessage} ${guidance}`,
                status: 'error',
                isStreaming: false,
                isError: true,
              }
            : m
        )
      );
    } finally {
      setIsStreaming(false);
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const clearChat = async () => {
    if (!user || !sessionId || !confirm('Clear this chat session?')) return;

    if (isGuestUser || sessionId.startsWith('guest-') || sessionId.startsWith('local-')) {
      try {
        localStorage.removeItem(`docutalk_guest_msgs_${sessionId}`);
      } catch {}
      setMessages([]);
      return;
    }

    try {
      await supabase.from('chat_messages').delete().eq('session_id', sessionId);
      setMessages([]);
    } catch (err) {
      console.error('Error clearing chat:', err);
    }
  };

  const createNewSession = async () => {
    if (!user) return;

    if (isGuestUser) {
      const newSession = {
        id: `guest-session-${Date.now()}`,
        title: 'New Chat',
        created_at: new Date().toISOString(),
      };
      const updated = [newSession, ...sessions];
      setSessions(updated);
      try {
        localStorage.setItem('docutalk_guest_sessions', JSON.stringify(updated));
      } catch {}
      navigate(`/app/chat/${newSession.id}`);
      return;
    }

    try {
      const { data: newSession, error: createError } = await supabase
        .from('chat_sessions')
        .insert({ user_id: user.id, title: 'New Chat' })
        .select()
        .single();

      if (createError) throw createError;
      if (newSession) {
        setSessions([newSession, ...sessions]);
        navigate(`/app/chat/${newSession.id}`);
      }
    } catch (err) {
      console.warn('Error creating new session in cloud, using local fallback:', err);
      const fallbackSession = {
        id: `local-${Date.now()}`,
        title: 'New Chat',
        created_at: new Date().toISOString(),
      };
      setSessions([fallbackSession, ...sessions]);
      navigate(`/app/chat/${fallbackSession.id}`);
    }
  };

  return (
    <div className="relative h-[calc(100vh-8rem)] flex bg-ink-900 overflow-hidden">
      {/* Sessions Rail */}
      <div className="w-64 border-r border-ink-700 bg-ink-800 flex flex-col z-10 shrink-0">
        <div className="p-4 border-b border-ink-700">
          <button
            onClick={createNewSession}
            className="w-full flex items-center justify-center gap-2 py-2 bg-ember-600 hover:bg-ember-700 text-parchment rounded-lg transition-colors"
          >
            <MessageSquarePlus className="w-4 h-4" />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => navigate(`/app/chat/${s.id}`)}
              className={`block w-full text-left px-3 py-2 rounded-lg text-sm truncate transition-colors ${
                s.id === sessionId ? 'bg-ink-700 text-parchment' : 'text-ash hover:bg-ink-700/50 hover:text-parchment'
              }`}
            >
              {s.title}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 flex flex-col relative overflow-hidden">
      <div className="grid-bg grid-bg-fade pointer-events-none absolute inset-0 -z-10" />
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-ink-700 bg-ink-800">
        <div>
          <h1 className="font-display text-2xl font-semibold text-parchment">DocuTalk AI</h1>
          <div className="flex items-center gap-2 mt-1">
            <p className="text-xs text-ash">
              {isLoadingDocs ? (
                <span className="inline-flex items-center gap-1.5 text-ash">
                  <Loader2 className="w-3 h-3 animate-spin text-ember-400" />
                  Updating documents...
                </span>
              ) : selectedDocIds.size > 0 ? (
                `${selectedDocIds.size} of ${documents.length} document${documents.length !== 1 ? 's' : ''} active for RAG`
              ) : documents.length > 0 ? (
                `${documents.length} document${documents.length !== 1 ? 's' : ''} available · Select to query`
              ) : (
                'Ready to chat · Ask any question or attach files for document context'
              )}
            </p>
            {dataSources.filter((s) => s.sync_status === 'synced').length > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-500/15 border border-purple-500/30 text-purple-400 text-[10px] font-semibold rounded-full">
                <Database className="w-2.5 h-2.5" />
                {dataSources.filter((s) => s.sync_status === 'synced').length} DB source{dataSources.filter((s) => s.sync_status === 'synced').length > 1 ? 's' : ''}
              </span>
            )}
            {isSyncingSources && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 text-[10px] font-semibold rounded-full">
                <Loader2 className="w-2.5 h-2.5 animate-spin" />
                Syncing DB
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(true)}
            className="p-2 text-ash hover:text-parchment hover:bg-ink-700 rounded-lg transition-colors"
            title="API Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
          {messages.length > 0 && (
            <button
              onClick={clearChat}
              className="p-2 text-ash hover:text-red-400 hover:bg-ink-700 rounded-lg transition-colors"
              title="Clear Chat"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {migrationToast && (
        <div className="px-6 py-2 bg-amber-500/10 border-b border-amber-500/20 text-amber-300 text-xs flex justify-between items-center">
          <span>⚠️ {migrationToast}</span>
          <button
            onClick={() => setMigrationToast(null)}
            className="text-amber-400 hover:text-amber-200 ml-2 text-xs"
          >
            ✕
          </button>
        </div>
      )}

      {syncNotice && (
        <div className="px-6 py-2 bg-ember-500/10 border-b border-ember-500/20 text-ember-400 text-xs">
          {syncNotice}
        </div>
      )}

      {/* Active Documents bar */}
      {documents.length > 0 && (
        <div className="px-6 py-2 bg-ink-800 border-b border-ink-700">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] text-ash/60 font-medium uppercase tracking-wider mr-1">Active Docs:</span>
            {documents.map((doc) => {
              const isSelected = selectedDocIds.has(doc.id);
              const displayName = doc.name.length > 30 ? doc.name.slice(0, 27) + '...' : doc.name;
              return (
                <button
                  key={doc.id}
                  onClick={() => {
                    const next = new Set(selectedDocIds);
                    if (isSelected) next.delete(doc.id); else next.add(doc.id);
                    setSelectedDocIds(next);
                  }}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                    isSelected
                      ? 'bg-ember-500/15 border-ember-500/40 text-ember-400'
                      : 'bg-ink-800 border-ink-700 text-ash/60 hover:text-parchment-300'
                  }`}
                >
                  {isSelected ? <Check className="w-2.5 h-2.5" /> : <div className="w-2.5 h-2.5" />}
                  {displayName}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Main Layout: Chat Column + Collapsible 2D Map Side Panel */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden min-h-0">
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Chat messages area */}
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
          <div className="text-center max-w-xl w-full space-y-6">
            <div className="bg-ink-800 border border-ink-700 rounded-2xl p-6 text-left">
              <h2 className="font-display text-base font-semibold text-parchment mb-3 flex items-center gap-2">
                <Bot className="w-5 h-5 text-ember-400" /> Intelligent Document Assistant
              </h2>
              <ul className="space-y-2 text-sm text-ash">
                <li>• Upload or paste knowledge resources to build your RAG context.</li>
                <li>• Ask context-aware questions grounded in your private documents.</li>
                <li>• For general questions, DocuTalk AI answers from its own knowledge.</li>
              </ul>
            </div>

            {/* Paste Segment UI */}
            <div>
              {!showPasteArea ? (
                <button
                  onClick={() => setShowPasteArea(true)}
                  className="px-5 py-2.5 bg-ink-800 hover:bg-ink-700 border border-ink-700 text-ember-400 rounded-xl text-sm font-medium transition-colors inline-flex items-center gap-2"
                >
                  <FileText className="w-4 h-4" />
                  Or paste raw document text
                </button>
              ) : (
                <form
                  onSubmit={handlePasteSubmit}
                  className="text-left bg-ink-800 border border-ink-700 rounded-xl p-5 space-y-4 mx-auto"
                >
                  <div className="flex justify-between items-center">
                    <h3 className="text-xs font-semibold text-parchment-300">Insert Text Node</h3>
                    <button
                      type="button"
                      onClick={() => {
                        setShowPasteArea(false);
                        setPasteError(null);
                      }}
                      className="text-xs text-ash/60 hover:text-parchment-300"
                    >
                      Cancel
                    </button>
                  </div>

                  {pasteError && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded-lg flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>{pasteError}</span>
                    </div>
                  )}

                  <input
                    type="text"
                    placeholder="Document Title (e.g., Target System Blueprint)"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                    className="w-full px-3 py-2 bg-ink-700 border border-ink-700 rounded-lg text-sm text-parchment placeholder-ash/60 focus:outline-none focus:border-ember-500"
                  />

                  <textarea
                    rows={4}
                    required
                    placeholder="Paste your source text data context here..."
                    value={pastedText}
                    onChange={(e) => setPastedText(e.target.value)}
                    className="w-full px-3 py-2 bg-ink-700 border border-ink-700 rounded-lg text-sm text-parchment placeholder-ash/60 focus:outline-none focus:border-ember-500 resize-none font-mono"
                  />

                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={isSavingPaste || !pastedText.trim()}
                      className="px-4 py-2 bg-ember-600 hover:bg-ember-700 disabled:opacity-50 text-parchment text-xs font-semibold rounded-lg transition-colors"
                    >
                      {isSavingPaste ? 'Synchronizing...' : 'Load into Core Memory'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {messages.map((message) => (
            <div
              key={message.id}
              className={`flex gap-4 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              {message.role === 'assistant' && (
                <div className="w-9 h-9 bg-gradient-to-br from-ember-500 to-ember-700 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Bot className="w-5 h-5 text-parchment" />
                </div>
              )}
              <div
                className={`max-w-[75%] rounded-2xl p-4 ${
                  message.role === 'user'
                    ? 'bg-ember-600 text-parchment'
                    : 'bg-ink-800 border border-ink-700 text-parchment'
                }`}
              >
                {message.role === 'assistant' ? (
                  <CitedMessage
                    content={message.content}
                    sources={message.sources}
                    isStreaming={message.isStreaming}
                    status={message.status}
                    onLocate={(chunkId) => handleFocusChunkOnMap(chunkId, message.sources)}
                    onInspectSource={(source) => handleFocusChunkOnMap(source.id, message.sources)}
                  />
                ) : (
                  <div className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</div>
                )}
                <div className="flex items-center gap-3 mt-2 text-[10px] text-ash/60">
                  {message.role === 'assistant' && (
                    <>
                      {message.provider_used && (
                        <span className="text-[10px] text-ash/50 mr-1">
                          via {message.provider_used}
                          {message.model_used ? ` (${message.model_used})` : ''}
                        </span>
                      )}
                      <button
                        onClick={() => copyToClipboard(message.id, message.content)}
                        className="hover:text-ember-400 transition-colors"
                      >
                        {copiedId === message.id ? (
                          <Check className="w-3 h-3" />
                        ) : (
                          <Copy className="w-3 h-3" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          const userMsg = messages
                            .slice(0, messages.indexOf(message))
                            .reverse()
                            .find((m) => m.role === 'user');
                          const title = userMsg ? userMsg.content.slice(0, 30).replace(/[^a-zA-Z0-9]/g, '_') : 'solution';
                          downloadSolutionFile(`${title}.md`, message.content);
                        }}
                        className="hover:text-ember-400 transition-colors inline-flex items-center gap-1"
                        title="Download as Markdown"
                      >
                        <Download className="w-3 h-3" />
                        Download .md
                      </button>
                    </>
                  )}
                </div>
              </div>
              {message.role === 'user' && (
                <div className="w-9 h-9 bg-ink-700 rounded-lg flex items-center justify-center flex-shrink-0">
                  <User className="w-5 h-5 text-parchment" />
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex gap-4">
              <div className="w-9 h-9 bg-gradient-to-br from-ember-500 to-ember-700 rounded-lg flex items-center justify-center flex-shrink-0">
                <Bot className="w-5 h-5 text-parchment" />
              </div>
              <div className="bg-ink-800 border border-ink-700 rounded-2xl p-4">
                <div className="flex gap-1.5 items-center h-5">
                  <div
                    className="w-1.5 h-1.5 bg-ink-700 rounded-full animate-bounce"
                    style={{ animationDelay: '0ms' }}
                  />
                  <div
                    className="w-1.5 h-1.5 bg-ink-700 rounded-full animate-bounce"
                    style={{ animationDelay: '150ms' }}
                  />
                  <div
                    className="w-1.5 h-1.5 bg-ink-700 rounded-full animate-bounce"
                    style={{ animationDelay: '300ms' }}
                  />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input area */}
      <div className="p-4 border-t border-ink-700 bg-ink-800">
        <div
          className={`max-w-5xl mx-auto transition-all duration-200 rounded-xl ${
            isDraggingOver ? 'ring-2 ring-ember-500 bg-ember-500/5' : ''
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDraggingOver(true); }}
          onDragLeave={() => setIsDraggingOver(false)}
          onDrop={handleDrop}
        >
          {/* Attach status chips */}
          {(attachedFileName || attachError || isParsingFile) && (
            <div className="flex items-center gap-2 mb-2 px-1">
              {isParsingFile && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-ember-500/15 border border-ember-500/30 text-ember-400 text-xs rounded-full">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Parsing file…
                </span>
              )}
              {attachedFileName && !isParsingFile && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-green-500/15 border border-green-500/30 text-green-400 text-xs rounded-full">
                  <Check className="w-3 h-3" />
                  {attachedFileName} loaded into RAG context
                  <button
                    onClick={() => setAttachedFileName(null)}
                    className="ml-1 hover:text-green-200"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              {attachError && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-red-500/15 border border-red-500/30 text-red-400 text-xs rounded-full">
                  <AlertCircle className="w-3 h-3" />
                  {attachError}
                  <button onClick={() => setAttachError(null)} className="ml-1 hover:text-red-200">
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
            </div>
          )}

          {/* Fallback Notice Banner */}
          {chatNotice && (
            <div className="mb-3 p-3 bg-ember-500/10 border border-ember-500/20 rounded-xl text-xs text-ember-300 flex items-start gap-2 justify-between">
              <div className="flex items-start gap-2 flex-1">
                <AlertCircle className="w-4 h-4 text-ember-400 shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="font-semibold text-ember-200">Notice</p>
                  <p className="mt-0.5 text-ember-300/90 whitespace-pre-wrap">{chatNotice}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setShowSettings(true)}
                  className="px-2 py-1 bg-ember-600/30 hover:bg-ember-600/50 text-ember-200 rounded text-xs transition-colors"
                >
                  Open AI Settings
                </button>
                <button
                  onClick={() => setChatNotice(null)}
                  className="text-ember-400 hover:text-ember-200 text-xs px-1"
                  aria-label="Dismiss notice"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* Chat error notification */}
          {chatError && (
            <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-semibold text-red-200">AI connection failed</p>
                <p className="mt-0.5 text-red-300/90 whitespace-pre-wrap">{chatError}</p>
              </div>
              <button
                onClick={() => setChatError(null)}
                className="text-red-400 hover:text-red-200 text-xs px-1"
                aria-label="Dismiss error"
              >
                ✕
              </button>
            </div>
          )}

          <div className="flex gap-3 items-center">
            {/* Hidden file input */}
            <input
              ref={fileAttachRef}
              type="file"
              className="hidden"
              accept=".pdf,.docx,.doc,.txt,.md,.csv,.json,.xml"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileAttach(f);
                e.target.value = '';
              }}
            />

            {/* Attach button */}
            <button
              onClick={() => fileAttachRef.current?.click()}
              disabled={isParsingFile}
              title="Attach a document file (PDF, DOCX, TXT, MD, CSV…)"
              className="p-3 bg-ink-700 hover:bg-ink-700 border border-ink-700 text-ash hover:text-ember-400 rounded-xl transition-colors disabled:opacity-40 flex items-center justify-center flex-shrink-0"
            >
              {isParsingFile ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Paperclip className="w-4 h-4" />
              )}
            </button>

            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyPress}
              onPaste={handleTextareaPaste}
              placeholder={
                isDraggingOver
                  ? '📎 Drop your document here to attach…'
                  : 'Ask anything, chat with your data, or drop/paste a document…'
              }
              rows={1}
              className="flex-1 px-4 py-3 bg-ink-700 border border-ink-700 rounded-xl text-sm text-parchment placeholder-ash/60 focus:outline-none focus:border-ember-500 transition-colors resize-none"
              disabled={loading}
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStopGenerating}
                className="px-4 py-3 bg-red-600/90 hover:bg-red-600 text-parchment rounded-xl transition-colors flex items-center gap-1.5 text-xs font-semibold shrink-0 shadow-lg"
                title="Stop generating response"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() || loading}
                className="p-3 bg-ember-600 hover:bg-ember-700 text-parchment rounded-xl transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </div>

          <p className="text-[10px] text-ash/50 mt-1.5 px-1">
            📎 Click the clip icon, drag & drop, or paste (Ctrl+V) a file — PDF, DOCX, TXT, MD, CSV, JSON supported
          </p>
        </div>
      </div>

        </div>

        {/* 2D Semantic Chunk Map Panel */}
        {showMap && (
          <div
            ref={mapContainerRef}
            className="w-full lg:w-[420px] xl:w-[460px] h-[360px] lg:h-full border-t lg:border-t-0 lg:border-l border-ink-700 bg-ink-950 flex flex-col flex-shrink-0 animate-in fade-in duration-200"
          >
            <div className="flex items-center justify-between px-3 py-2 bg-ink-900 border-b border-ink-700 text-xs">
              <span className="font-semibold text-parchment flex items-center gap-1.5">
                <Compass className="w-3.5 h-3.5 text-amber-400" />
                2D Semantic Visualizer
              </span>
              <button
                type="button"
                onClick={() => setShowMap(false)}
                className="p-1 rounded hover:bg-ink-800 text-ash hover:text-parchment transition-colors"
                title="Close Map"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-2">
              <SemanticMapCanvas
                chunks={allDocumentChunks}
                activeSources={
                  activeTurnSources.length > 0
                    ? activeTurnSources
                    : messages
                        .slice()
                        .reverse()
                        .find((m) => m.role === 'assistant' && m.sources?.length)?.sources ?? []
                }
                highlightedChunkId={focusedChunkId}
                onSelectChunk={(chunkId) => setFocusedChunkId(chunkId)}
              />
            </div>
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
          <div className="bg-ink-800 rounded-xl p-6 max-w-md w-full border border-ink-700 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-semibold text-parchment">AI Engine Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-ash hover:text-parchment text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              {/* RAG Architecture Info */}
              <div className="p-3 bg-gradient-to-r from-emerald-500/10 to-ember-500/10 border border-emerald-500/20 rounded-lg text-xs">
                <p className="font-semibold text-parchment mb-2 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-emerald-400" />
                  Hybrid RAG Architecture
                </p>
                <div className="space-y-1 text-ash">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0" />
                    <span><span className="text-emerald-300 font-medium">Embeddings:</span> Voyage AI voyage-3 (1024d)</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-ember-400 flex-shrink-0" />
                    <span><span className="text-ember-400 font-medium">Generation:</span> Provider selected below</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-ash mb-2">
                  LLM GENERATION PROVIDER
                </label>
                <select
                  value={provider}
                  onChange={(e) => handleProviderChange(e.target.value as Provider)}
                  className="w-full px-3 py-2 bg-ink-800 border border-ink-700 rounded-lg text-sm text-parchment focus:outline-none focus:border-ember-500"
                >
                  <option value="groq">
                    ⚡ Groq {serverStatus ? (serverStatus.providers.groq?.serverKey === 'ok' ? '(server key ready)' : '(add your key)') : '(Recommended — Fast)'}
                  </option>
                  <option value="anthropic">
                    Anthropic {serverStatus ? (serverStatus.providers.anthropic?.serverKey === 'ok' ? '(server key ready)' : '(add your key)') : '— Claude Sonnet'}
                  </option>
                  <option value="openai">
                    OpenAI {serverStatus ? (serverStatus.providers.openai?.serverKey === 'ok' ? '(server key ready)' : '(add your key)') : '— GPT-4o-mini'}
                  </option>
                </select>
                {providerHint && (
                  <p className="text-[11px] text-ember-400 mt-1.5 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {providerHint}
                  </p>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-xs font-semibold text-ash">
                    {provider.toUpperCase()} API KEY{' '}
                    <span className="text-ash/50 font-normal">
                      (optional; overrides server secret)
                    </span>
                  </label>
                  {!isEditingKey && apiKeys[provider] && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsEditingKey(true);
                        setDraftKey('');
                      }}
                      className="text-[11px] text-ember-400 hover:text-ember-300 transition-colors"
                    >
                      Change key
                    </button>
                  )}
                </div>

                {!isEditingKey && apiKeys[provider] ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      readOnly
                      value={maskKey(apiKeys[provider])}
                      className="flex-1 px-3 py-2 bg-ink-900 border border-ink-700 rounded-lg text-sm text-parchment-300 font-mono select-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = { ...apiKeys, [provider]: '' };
                        setApiKeys(next);
                        setDraftKey('');
                        setIsEditingKey(false);
                      }}
                      className="px-2.5 py-2 bg-ink-700 hover:bg-ink-600 text-ash hover:text-parchment rounded-lg text-xs transition-colors"
                      title="Clear key"
                    >
                      Clear
                    </button>
                  </div>
                ) : (
                  <input
                    type="password"
                    value={draftKey}
                    onChange={(e) => handleKeyChange(e.target.value)}
                    placeholder={
                      provider === 'openai'
                        ? 'sk-...'
                        : provider === 'groq'
                        ? 'gsk_...'
                        : 'sk-ant-...'
                    }
                    className={`w-full px-3 py-2 bg-ink-800 border rounded-lg text-sm text-parchment placeholder-ash/50 focus:outline-none font-mono ${
                      currentKeyError
                        ? 'border-red-500 focus:border-red-500'
                        : 'border-ink-700 focus:border-ember-500'
                    }`}
                  />
                )}

                {currentKeyError && (
                  <p className="mt-1.5 text-xs text-red-400 flex items-center gap-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    {currentKeyError}
                  </p>
                )}
              </div>

              {testResult && (
                <div
                  className={`p-3 rounded-lg text-xs flex items-center gap-2 ${
                    testResult.ok
                      ? 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-300'
                      : 'bg-red-500/10 border border-red-500/20 text-red-300'
                  }`}
                >
                  {testResult.ok ? <Check className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
                  {testResult.message}
                </div>
              )}

              <div className="p-3 bg-ember-500/10 border border-ember-500/20 rounded-lg text-xs text-ember-400">
                💡 Document vectors are embedded via Voyage AI (<code>voyage-3</code>). Edge functions securely read <code>VOYAGE_API_KEY</code> and <code>GROQ_API_KEY</code> from Supabase secrets.
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={testConnection}
                disabled={testing || !!currentKeyError}
                className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-parchment text-xs font-medium rounded-lg transition-colors inline-flex items-center justify-center gap-1.5"
              >
                {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button
                onClick={handleResetDefaults}
                className="flex-1 py-2 bg-ink-800 hover:bg-ink-700 text-parchment-300 text-xs font-medium rounded-lg transition-colors"
              >
                Reset to Defaults
              </button>
            </div>
            <div className="flex gap-3 mt-2">
              <button
                onClick={() => setShowSettings(false)}
                className="flex-1 py-2 bg-ink-800 hover:bg-ink-700 text-parchment-300 text-xs font-medium rounded-lg transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleSaveSettings}
                disabled={!!currentKeyError}
                className="flex-1 py-2 bg-ember-600 hover:bg-ember-700 disabled:opacity-50 text-parchment text-xs font-medium rounded-lg transition-colors"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
