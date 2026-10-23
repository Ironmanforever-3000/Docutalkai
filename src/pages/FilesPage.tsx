import { useState, useRef, useEffect } from 'react';
import { FileText, Upload, Search, Trash2, Download, FileImage, FileSpreadsheet, FileCode, FileAudio, Video, X, Check, UploadCloud, File, Loader, RefreshCw, Eye, AlertCircle, Brain } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { Document } from '../types';
import { extractTextFromFile, extractDocumentText } from '../lib/extraction';

export default function FilesPage() {
  const { user } = useAuth();
  const [files, setFiles] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewDoc, setPreviewDoc] = useState<{ name: string; text: string } | null>(null);
  const [reprocessing, setReprocessing] = useState<string | null>(null);
  const [vectorizing, setVectorizing] = useState<string | null>(null);
  const [vectorizingAll, setVectorizingAll] = useState(false);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadFiles();
  }, [user]);

  const loadFiles = async () => {
    if (!user) return;

    setLoading(true);
    try {
      const [filesRes, projectsRes] = await Promise.all([
        supabase
          .from('documents')
          .select('id, name, file_type, file_size, char_count, status, error_message, storage_path, project_id, created_at, updated_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('projects')
          .select('id, name')
          .eq('user_id', user.id)
          .order('name', { ascending: true })
      ]);

      if (filesRes.error) throw filesRes.error;
      setFiles(filesRes.data || []);
      
      if (projectsRes.data) {
        setProjects(projectsRes.data);
      }
    } catch (err) {
      console.error('Error loading files:', err);
    } finally {
      setLoading(false);
    }
  };

  const getFileIcon = (type: string) => {
    if (type.includes('image')) return FileImage;
    if (type.includes('audio')) return FileAudio;
    if (type.includes('video')) return Video;
    if (type.includes('spreadsheet') || type.includes('excel')) return FileSpreadsheet;
    if (type.includes('json') || type.includes('javascript') || type.includes('typescript')) return FileCode;
    return FileText;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setSelectedFiles(selected);
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0 || !user) return;

    setUploading(true);
    setError(null);
    const MAX_INLINE_TEXT_CHARS = 400_000;
    const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

    setUploadProgress(0);
    setUploadStatus('Starting upload...');

    const uploadedDocs: Document[] = [];
    const totalFiles = selectedFiles.length;

    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];

        if (file.size > MAX_FILE_SIZE_BYTES) {
          throw new Error(`File "${file.name}" exceeds the 50MB limit (${(file.size / (1024 * 1024)).toFixed(1)}MB).`);
        }

        const docId = crypto.randomUUID();
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const binaryStoragePath = `${user.id}/${docId}/${safeName}`;
        const sidecarTextPath = `${user.id}/${docId}/extracted.md`;

        // Step 1: Streamed client-side extraction with page-by-page RAM cleanup
        setUploadStatus(`Extracting text from ${file.name}...`);
        let extractedText = '';
        let extractionFailed = false;
        let extractionError: string | null = null;
        let charCount = 0;

        try {
          const res = await extractDocumentText(file, (prog) => {
            const detail = prog.totalPages && prog.currentPage
              ? `Extracting ${file.name} (p. ${prog.currentPage}/${prog.totalPages})...`
              : `Extracting ${file.name}...`;
            setUploadStatus(detail);
            setUploadProgress(Math.round(((i + (prog.percent / 100)) / totalFiles) * 100));
          });
          extractedText = res.text;
          charCount = res.charCount;
        } catch (extErr: unknown) {
          extractionFailed = true;
          extractionError = extErr instanceof Error ? extErr.message : 'Extraction failed';
          console.error(`[Extraction] Failed for "${file.name}":`, extErr);
        }

        // Step 2: Upload original binary file to Supabase Storage
        setUploadStatus(`Uploading ${file.name} to storage...`);
        const { error: uploadError } = await supabase.storage
          .from('documents')
          .upload(binaryStoragePath, file, {
            cacheControl: '3600',
            upsert: true,
          });

        if (uploadError) throw uploadError;

        // Step 3: If extracted text > 400KB, offload to Storage sidecar to prevent PostgREST 413
        const isLargeText = extractedText.length > MAX_INLINE_TEXT_CHARS;
        if (isLargeText) {
          setUploadStatus(`Saving text sidecar for ${file.name}...`);
          const textBlob = new Blob([extractedText], { type: 'text/markdown;charset=utf-8' });
          const { error: sidecarErr } = await supabase.storage
            .from('documents')
            .upload(sidecarTextPath, textBlob, {
              contentType: 'text/markdown;charset=utf-8',
              upsert: true,
            });
          if (sidecarErr) {
            console.warn(`[Sidecar] Failed to upload sidecar: ${sidecarErr.message}`);
          }
        }

        const inlineContent = isLargeText
          ? `__STORAGE_SIDECAR__:${sidecarTextPath}`
          : extractedText;

        // Step 4: Register document in Postgres with lightweight payload
        setUploadStatus(`Registering ${file.name}...`);
        const { data: docData, error: docError } = await supabase
          .from('documents')
          .insert({
            id: docId,
            name: file.name,
            file_type: file.type || 'application/octet-stream',
            storage_path: binaryStoragePath,
            user_id: user.id,
            project_id: selectedProjectId || null,
            status: extractionFailed ? 'failed' : 'processing',
            extracted_text: isLargeText ? null : extractedText,
            char_count: charCount,
            error_message: extractionError,
            content_text: inlineContent,
            processed: false,
          })
          .select()
          .single();

        if (docError) throw docError;

        if (docData && !extractionFailed) {
          uploadedDocs.push(docData);
          // Trigger vector embedding in the background
          supabase.functions.invoke('process-document', {
            body: { document_id: docData.id },
          }).catch((err) => {
            console.error(`[Vectorize] Failed to process "${file.name}":`, err);
          });
        }

        setUploadProgress(Math.round(((i + 1) / totalFiles) * 100));
      }

      setFiles((prev) => [...uploadedDocs, ...prev]);
      setShowUploadModal(false);
      setSelectedFiles([]);
      setSuccess(`Successfully uploaded ${uploadedDocs.length} file(s)`);
      setTimeout(() => setSuccess(null), 3000);

      // Create notification
      await supabase.from('notifications').insert({
        user_id: user.id,
        title: 'Files Uploaded',
        message: `${uploadedDocs.length} file(s) have been uploaded and processed for RAG.`,
        type: 'success',
      });
    } catch (err) {
      console.error('Error uploading files:', err);
      setError(err instanceof Error ? err.message : 'Failed to upload files');
    } finally {
      setUploading(false);
      setUploadProgress(0);
      setUploadStatus('');
    }
  };

  const handleDelete = async (file: Document) => {
    if (!user || !confirm('Are you sure you want to delete this file?')) return;

    try {
      // Delete from storage
      if (file.storage_path) {
        await supabase.storage.from('documents').remove([file.storage_path]);
      }

      // Delete from database
      const { error } = await supabase
        .from('documents')
        .delete()
        .eq('id', file.id);

      if (error) throw error;

      setFiles((prev) => prev.filter((f) => f.id !== file.id));
      setSuccess('File deleted successfully');
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Error deleting file:', err);
      setError('Failed to delete file');
    }
  };

  const triggerVectorize = async (fileId: string) => {
    const { error } = await supabase.functions.invoke('process-document', {
      body: { document_id: fileId },
    });
    if (error) throw error;
  };

  const handleVectorize = async (file: Document) => {
    if (!user || vectorizing) return;
    setVectorizing(file.id);
    setError(null);
    try {
      await triggerVectorize(file.id);
      setFiles((prev) =>
        prev.map((f) => (f.id === file.id ? { ...f, status: 'ready' as const } : f))
      );
      setSuccess(`Vectorized "${file.name}"`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Error vectorizing file:', err);
      setError('Failed to vectorize file');
    } finally {
      setVectorizing(null);
    }
  };

  const handleVectorizeAll = async () => {
    if (!user || vectorizingAll) return;
    setVectorizingAll(true);
    setError(null);
    let count = 0;
    for (const file of files) {
      try {
        await triggerVectorize(file.id);
        setFiles((prev) =>
          prev.map((f) => (f.id === file.id ? { ...f, status: 'ready' as const } : f))
        );
        count++;
      } catch (err) {
        console.error(`Error vectorizing "${file.name}":`, err);
      }
    }
    setVectorizingAll(false);
    setSuccess(`Vectorized ${count} of ${files.length} files`);
    setTimeout(() => setSuccess(null), 3000);
  };

  const handleReprocess = async (file: Document) => {
    if (!user || reprocessing) return;
    setReprocessing(file.id);
    setError(null);
    try {
      const { data: fileData } = await supabase.storage
        .from('documents')
        .download(file.storage_path!);
      if (!fileData) throw new Error('File not found in storage');
      const blob = new Blob([fileData], { type: file.file_type });
      const fakeFile: File = Object.assign(blob, { name: file.name, lastModified: Date.now() }) as unknown as File;
      const result = await extractTextFromFile(fakeFile);
      const updateData: Record<string, unknown> = {
        status: result.status,
        extracted_text: result.text,
        char_count: result.charCount,
        error_message: result.errorMessage,
        content_text: result.text,
        processed: result.status === 'ready',
      };
      const { error: updateError } = await supabase
        .from('documents')
        .update(updateData)
        .eq('id', file.id);
      if (updateError) throw updateError;
      setFiles((prev) =>
        prev.map((f) => (f.id === file.id ? { ...f, ...updateData } as Document : f))
      );
      setSuccess(`Re-processed "${file.name}" — ${result.status}`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      console.error('Error reprocessing file:', err);
      setError('Failed to reprocess file');
    } finally {
      setReprocessing(null);
    }
  };

  const handlePreview = async (file: Document) => {
    let text = file.extracted_text || file.content_text;
    if (!text) {
      const { data } = await supabase
        .from('documents')
        .select('content_text, extracted_text')
        .eq('id', file.id)
        .maybeSingle();
      text = data?.extracted_text || data?.content_text;
    }
    if (!text) {
      setError(`No extracted text available for "${file.name}"`);
      return;
    }
    setPreviewDoc({ name: file.name, text: text.slice(0, 2000) });
  };

  const handleDownload = async (file: Document) => {
    if (!file.storage_path) return;

    try {
      const { data, error } = await supabase.storage
        .from('documents')
        .download(file.storage_path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error downloading file:', err);
      setError('Failed to download file');
    }
  };

  const filteredFiles = files.filter((file) =>
    file.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="relative space-y-6">
      <div className="grid-bg grid-bg-fade pointer-events-none absolute inset-0 -z-10" />
      {success && (
        <div className="fixed top-4 right-4 z-50 bg-green-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-slide-in">
          <Check className="w-5 h-5" />
          {success}
        </div>
      )}

      {error && (
        <div className="fixed top-4 right-4 z-50 bg-red-600 text-white px-6 py-3 rounded-lg shadow-lg flex items-center gap-2 animate-slide-in">
          <X className="w-5 h-5" />
          {error}
          <button onClick={() => setError(null)} className="ml-2">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold text-parchment">Files</h1>
          <p className="text-ash mt-1">Manage your uploaded documents</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleVectorizeAll}
            disabled={vectorizingAll || files.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-ember-600 hover:bg-ember-700 text-parchment rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title="Create vector embeddings for all documents"
          >
            <Brain className="w-5 h-5" />
            {vectorizingAll ? 'Vectorizing...' : 'Vectorize All'}
          </button>
          <button
            onClick={() => setShowUploadModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-ember-600 hover:bg-ember-700 text-parchment rounded-lg transition-colors"
          >
            <Upload className="w-5 h-5" />
            Upload Files
          </button>
        </div>
      </div>

      <div className="flex gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-ash" />
          <input
            type="text"
            placeholder="Search files..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-ink-800 border border-ink-700 rounded-lg text-parchment placeholder-ash/60 focus:outline-none focus:border-ember-500 transition-colors"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ember-500" />
        </div>
      ) : filteredFiles.length === 0 ? (
        <div className="bg-ink-800 rounded-xl p-12 border border-ink-700 text-center">
          <FileText className="w-16 h-16 text-ash/50 mx-auto mb-4" />
          <h3 className="text-xl font-semibold text-parchment mb-2">
            {searchTerm ? 'No files found' : 'No files uploaded'}
          </h3>
          <p className="text-ash mb-6">
            {searchTerm
              ? 'Try a different search term'
              : 'Upload your first document to get started'}
          </p>
          {!searchTerm && (
            <button
              onClick={() => setShowUploadModal(true)}
              className="px-6 py-2 bg-ember-600 hover:bg-ember-700 text-parchment rounded-lg transition-colors"
            >
              Upload File
            </button>
          )}
        </div>
      ) : (
        <div className="bg-ink-800 rounded-xl border border-ink-700 overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-ink-700">
                <th className="text-left py-3 px-6 text-ash font-medium text-sm">Name</th>
                <th className="text-left py-3 px-6 text-ash font-medium text-sm">Type</th>
                <th className="text-left py-3 px-6 text-ash font-medium text-sm">Uploaded</th>
                <th className="text-right py-3 px-6 text-ash font-medium text-sm">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.map((file) => {
                const Icon = getFileIcon(file.file_type);
                const status = file.status || 'processing';
                return (
                  <tr
                    key={file.id}
                    className="border-b border-ink-700 hover:bg-ink-800/50 transition-colors group"
                  >
                    <td className="py-4 px-6">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-ember-500/10 rounded-lg flex items-center justify-center">
                          <Icon className="w-5 h-5 text-ember-400" />
                        </div>
                        <div>
                          <span className="text-parchment font-medium">{file.name}</span>
                          <div className="flex items-center gap-2 mt-1">
                            {status === 'ready' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 border border-green-500/30 text-green-400 text-[10px] font-medium rounded-full">
                                <Check className="w-2.5 h-2.5" />
                                Ready
                              </span>
                            )}
                            {status === 'failed' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 border border-red-500/30 text-red-400 text-[10px] font-medium rounded-full">
                                <AlertCircle className="w-2.5 h-2.5" />
                                Failed
                              </span>
                            )}
                            {status === 'processing' && (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-[10px] font-medium rounded-full">
                                <Loader className="w-2.5 h-2.5 animate-spin" />
                                Processing
                              </span>
                            )}
                            {file.char_count != null && file.char_count > 0 && (
                              <span className="text-[10px] text-ash/60">
                                {file.char_count.toLocaleString()} chars
                              </span>
                            )}
                          </div>
                          {status === 'failed' && file.error_message && (
                            <p className="text-[10px] text-red-400 mt-0.5 max-w-md truncate" title={file.error_message}>
                              {file.error_message}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-4 px-6">
                      <span className="px-2 py-1 bg-ink-800 rounded text-xs text-parchment-300">
                        {file.file_type.split('/')[1] || file.file_type}
                      </span>
                    </td>
                    <td className="py-4 px-6">
<span className="text-ash text-sm">
                        {file.created_at
                          ? new Date(file.created_at).toLocaleDateString()
                          : 'Unknown'}
                      </span>
                    </td>
                    <td className="py-4 px-6">
                      <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        {status === 'ready' && (
                          <button
                            onClick={() => handlePreview(file)}
                            className="p-2 text-ash hover:text-ember-400 transition-colors"
                            title="Preview extracted text"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleVectorize(file)}
                          disabled={vectorizing === file.id}
                          className="p-2 text-ash hover:text-ember-400 transition-colors disabled:opacity-50"
                          title="Create vector embedding"
                        >
                          <Brain className={`w-4 h-4 ${vectorizing === file.id ? 'animate-pulse' : ''}`} />
                        </button>
                        <button
                          onClick={() => handleReprocess(file)}
                          disabled={reprocessing === file.id}
                          className="p-2 text-ash hover:text-green-400 transition-colors disabled:opacity-50"
                          title="Re-process"
                        >
                          <RefreshCw className={`w-4 h-4 ${reprocessing === file.id ? 'animate-spin' : ''}`} />
                        </button>
                        <button
                          onClick={() => handleDownload(file)}
                          className="p-2 text-ash hover:text-ember-400 transition-colors"
                          title="Download"
                        >
                          <Download className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(file)}
                          className="p-2 text-ash hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Preview Modal */}
      {previewDoc && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-ink-800 rounded-xl p-6 max-w-2xl w-full border border-ink-700 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-lg font-semibold text-parchment truncate flex items-center gap-2">
                <FileText className="w-5 h-5 text-ember-400" />
                {previewDoc.name}
              </h2>
              <button
                onClick={() => setPreviewDoc(null)}
                className="text-ash hover:text-parchment"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto bg-ink-800 rounded-lg p-4">
              <pre className="text-sm text-parchment-300 whitespace-pre-wrap font-mono">{previewDoc.text}</pre>
              <p className="text-xs text-ash/60 mt-4 border-t border-ink-700 pt-3">
                Showing first {previewDoc.text.length.toLocaleString()} characters
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-ink-800 rounded-xl p-6 max-w-lg w-full border border-ink-700">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-xl font-semibold text-parchment">Upload Files</h2>
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setSelectedFiles([]);
                }}
                className="text-ash hover:text-parchment"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            {projects.length > 0 && (
              <div className="mb-4">
                <label className="block text-sm font-medium text-parchment-300 mb-1">
                  Assign to Project (Optional)
                </label>
                <select
                  value={selectedProjectId}
                  onChange={(e) => setSelectedProjectId(e.target.value)}
                  className="w-full px-4 py-2 bg-ink-900 border border-ink-700 rounded-lg text-parchment focus:outline-none focus:border-ember-500 transition-colors"
                >
                  <option value="">No Project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                selectedFiles.length > 0
                  ? 'border-ember-500 bg-ember-500/5'
                  : 'border-ink-700 hover:border-ember-500'
              }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <UploadCloud className={`w-12 h-12 mx-auto mb-4 ${
                selectedFiles.length > 0 ? 'text-ember-400' : 'text-ash/50'
              }`} />
              <p className="text-ash mb-2">
                Drag and drop files here, or click to browse
              </p>
              <p className="text-ash/60 text-sm mb-4">
                PDF, DOC, DOCX, TXT, XLSX, XLS, PNG, JPG, JSON
              </p>

              {selectedFiles.length > 0 && (
                <div className="mt-4 space-y-2 text-left">
                  {selectedFiles.map((file, i) => (
                    <div key={i} className="flex items-center gap-2 p-2 bg-ink-800 rounded">
                      <File className="w-4 h-4 text-ember-400" />
                      <span className="text-parchment text-sm flex-1 truncate">{file.name}</span>
                      <span className="text-ash/60 text-xs">{formatFileSize(file.size)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept=".pdf,.doc,.docx,.txt,.xlsx,.xls,.png,.jpg,.jpeg,.gif,.json,.csv,.md"
            />

            {uploading && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-ash text-sm flex items-center gap-2">
                    <Loader className="w-4 h-4 animate-spin" />
                    {uploadStatus}
                  </span>
                  <span className="text-ash text-sm">{uploadProgress}%</span>
                </div>
                <div className="w-full bg-ink-700 rounded-full h-2">
                  <div
                    className="bg-ember-500 h-2 rounded-full transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-xs text-ash/60 mt-2">
                  Files are being processed for RAG (Retrieval-Augmented Generation)
                </p>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button
                onClick={() => {
                  setShowUploadModal(false);
                  setSelectedFiles([]);
                }}
                disabled={uploading}
                className="flex-1 py-2 bg-ink-700 hover:bg-ink-600 text-parchment rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleUpload}
                disabled={selectedFiles.length === 0 || uploading}
                className="flex-1 py-2 bg-ember-600 hover:bg-ember-700 text-parchment rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {uploading ? 'Uploading...' : `Upload ${selectedFiles.length} file(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
