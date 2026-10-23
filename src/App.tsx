import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { UserProfileProvider } from './contexts/UserProfileContext';
import ErrorBoundary from './components/ErrorBoundary';
import Preloader from './components/Preloader';
import AuthPage from './components/AuthPage';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import LandingPage from './pages/LandingPage';
import HomePage from './pages/HomePage';
import ProjectsPage from './pages/ProjectsPage';
import ProjectPage from './pages/ProjectPage';
import DataSourcesPage from './pages/DataSourcesPage';
import FilesPage from './pages/FilesPage';
import DocuTalkPage from './pages/DocuTalkPage';
import SettingsPage from './pages/SettingsPage';

function Shell() {
  const { user } = useAuth();
  return (
    <UserProfileProvider>
      <div className="min-h-screen bg-ink-950 flex text-parchment font-sans">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          <Header user={user} />
          <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
            <Outlet />
          </main>
        </div>
      </div>
    </UserProfileProvider>
  );
}

function AppContent() {
  const { user, loading: authLoading } = useAuth();
  const [preloaderDone, setPreloaderDone] = useState(() => {
    if (typeof window !== 'undefined') {
      // Skip 3.7s preloader on /login so login is instant
      if (window.location.pathname === '/login') return true;
      // Skip if already seen in current browser session
      if (sessionStorage.getItem('docutalk_preloader_seen') === '1') return true;
    }
    return false;
  });

  const handlePreloaderComplete = () => {
    if (typeof window !== 'undefined') {
      sessionStorage.setItem('docutalk_preloader_seen', '1');
    }
    setPreloaderDone(true);
  };

  if (!preloaderDone) {
    return <Preloader onComplete={handlePreloaderComplete} />;
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-ink-950 flex items-center justify-center">
        <div className="w-6 h-6 rounded-full border-2 border-ember-500/30 border-t-ember-500 animate-spin" />
      </div>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={user ? <Navigate to="/app" replace /> : <Navigate to="/login" replace />} />
        <Route path="/landing" element={<LandingPage />} />
        <Route path="/login" element={user ? <Navigate to="/app" replace /> : <AuthPage />} />
        <Route path="/app" element={user ? <Shell /> : <Navigate to="/login" replace />}>
          <Route index element={<HomePage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="chat" element={<DocuTalkPage />} />
          <Route path="chat/:sessionId" element={<DocuTalkPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="data-sources" element={<DataSourcesPage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </ErrorBoundary>
  );
}
