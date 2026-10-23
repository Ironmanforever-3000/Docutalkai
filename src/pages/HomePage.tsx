import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileText, FolderKanban, Database, ArrowRight, Bot, Clock, FileUp } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';

type Page = 'Home' | 'Files' | 'Projects' | 'DataSources' | 'Library' | 'DocuTalk' | 'Settings';

interface HomePageProps {
  onNavigate?: (page: Page) => void;
}

interface Stats {
  documents: number;
  projects: number;
  dataSources: number;
  chatMessages: number;
}

interface Activity {
  id: string;
  type: 'document' | 'project' | 'datasource' | 'chat';
  action: string;
  name: string;
  timestamp: string;
}

export default function HomePage({ onNavigate }: HomePageProps) {
  const { user } = useAuth();
  const navigate = useNavigate();

  const handleNavigate = (page: Page) => {
    if (onNavigate) {
      onNavigate(page);
      return;
    }
    const routeMap: Record<Page, string> = {
      Home: '/app',
      Files: '/app/files',
      Projects: '/app/projects',
      DataSources: '/app/data-sources',
      Library: '/app/files',
      DocuTalk: '/app/chat',
      Settings: '/app/settings',
    };
    navigate(routeMap[page] || '/app');
  };
  const [stats, setStats] = useState<Stats>({
    documents: 0,
    projects: 0,
    dataSources: 0,
    chatMessages: 0,
  });
  const [recentActivity, setRecentActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  const quickActions = [
    { page: 'Files' as Page, icon: FileText, label: 'Upload Files', description: 'Add documents to your library', color: 'blue' },
    { page: 'Projects' as Page, icon: FolderKanban, label: 'Create Project', description: 'Start a new RAG project', color: 'purple' },
    { page: 'DataSources' as Page, icon: Database, label: 'Connect Data', description: 'Link external data sources', color: 'green' },
    { page: 'DocuTalk' as Page, icon: Bot, label: 'Chat with Docs', description: 'Ask questions about your docs', color: 'orange' },
  ];

  useEffect(() => {
    if (user) {
      loadData();
    }
  }, [user]);

  const loadData = async () => {
    if (!user) return;

    setLoading(true);
    try {
      // Load stats
      const [docsRes, projectsRes, dataSourcesRes, chatRes] = await Promise.all([
        supabase.from('documents').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('data_sources').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
        supabase.from('chat_messages').select('id', { count: 'exact', head: true }).eq('user_id', user.id),
      ]);

      const newStats = {
        documents: docsRes.count || 0,
        projects: projectsRes.count || 0,
        dataSources: dataSourcesRes.count || 0,
        chatMessages: chatRes.count || 0,
      };
      setStats(newStats);

      // Load recent documents (metadata only)
      const { data: recentDocs } = await supabase
        .from('documents')
        .select('id, name, file_type, status, created_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(5);

      // Build recent activity from all sources
      const activity: Activity[] = [];

      if (recentDocs && recentDocs.length > 0) {
        const docActivity = recentDocs.slice(0, 3).map(doc => ({
          id: `doc-${doc.id}`,
          type: 'document' as const,
          action: 'uploaded',
          name: doc.name,
          timestamp: doc.created_at || new Date().toISOString(),
        }));
        activity.push(...docActivity);
      }

      const { data: recentProjects } = await supabase
        .from('projects')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(2);

      if (recentProjects && recentProjects.length > 0) {
        const projectActivity = recentProjects.map(proj => ({
          id: `proj-${proj.id}`,
          type: 'project' as const,
          action: 'created',
          name: proj.name,
          timestamp: proj.created_at,
        }));
        activity.push(...projectActivity);
      }

      // Sort by timestamp
      activity.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setRecentActivity(activity.slice(0, 5));

    } catch (err) {
      console.error('Error loading data:', err);
    } finally {
      setLoading(false);
    }
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'document':
        return FileUp;
      case 'project':
        return FolderKanban;
      case 'datasource':
        return Database;
      default:
        return Clock;
    }
  };

  const formatTimeAgo = (timestamp: string) => {
    const now = new Date();
    const past = new Date(timestamp);
    const diffMs = now.getTime() - past.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return past.toLocaleDateString();
  };

  return (
    <div className="relative space-y-8">
      <div className="grid-bg grid-bg-fade pointer-events-none absolute inset-0 -z-10" />
      <div>
        <h1 className="font-display text-3xl font-semibold text-parchment mb-2">Welcome back!</h1>
        <p className="text-ash">Manage your documents and chat with AI about them</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {quickActions.map((action) => {
          const Icon = action.icon;
          const colorClasses = {
            blue: 'bg-ember-500/10 text-ember-400 hover:bg-ember-500/20 border-ember-500/30',
            purple: 'bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 border-purple-500/30',
            green: 'bg-green-500/10 text-green-400 hover:bg-green-500/20 border-green-500/30',
            orange: 'bg-orange-500/10 text-orange-400 hover:bg-orange-500/20 border-orange-500/30',
          }[action.color];

          return (
            <button
              key={action.page}
              onClick={() => handleNavigate(action.page)}
              className={`p-6 rounded-xl border transition-all hover:scale-[1.02] group ${colorClasses}`}
            >
              <Icon className="w-8 h-8 mb-4" />
              <h3 className="text-lg font-semibold text-parchment mb-1">{action.label}</h3>
              <p className="text-sm text-ash mb-4">{action.description}</p>
              <div className="flex items-center text-sm font-medium group-hover:gap-2 transition-all">
                Get started <ArrowRight className="w-4 h-4 ml-1" />
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-ink-800 rounded-xl p-6 border border-ink-700">
          <h2 className="font-display text-xl font-semibold text-parchment mb-4">Quick Stats</h2>
          {loading ? (
            <div className="grid grid-cols-2 gap-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="p-4 bg-ink-800 rounded-lg animate-pulse">
                  <div className="h-8 bg-ink-700 rounded mb-2" />
                  <div className="h-4 bg-ink-700 rounded w-1/2" />
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-ink-800 rounded-lg hover:bg-ink-700 transition-colors cursor-pointer" onClick={() => handleNavigate('Files')}>
                <p className="text-3xl font-bold text-ember-400">{stats.documents}</p>
                <p className="text-sm text-ash">Documents</p>
              </div>
              <div className="p-4 bg-ink-800 rounded-lg hover:bg-ink-700 transition-colors cursor-pointer" onClick={() => handleNavigate('Projects')}>
                <p className="text-3xl font-bold text-purple-400">{stats.projects}</p>
                <p className="text-sm text-ash">Projects</p>
              </div>
              <div className="p-4 bg-ink-800 rounded-lg hover:bg-ink-700 transition-colors cursor-pointer" onClick={() => handleNavigate('DataSources')}>
                <p className="text-3xl font-bold text-green-400">{stats.dataSources}</p>
                <p className="text-sm text-ash">Data Sources</p>
              </div>
              <div className="p-4 bg-ink-800 rounded-lg hover:bg-ink-700 transition-colors cursor-pointer" onClick={() => handleNavigate('DocuTalk')}>
                <p className="text-3xl font-bold text-orange-400">{stats.chatMessages}</p>
                <p className="text-sm text-ash">Chat Messages</p>
              </div>
            </div>
          )}
        </div>

        <div className="bg-ink-800 rounded-xl p-6 border border-ink-700">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display text-xl font-semibold text-parchment">Recent Activity</h2>
            {recentActivity.length > 0 && (
              <span className="text-xs text-ash/60">{recentActivity.length} activities</span>
            )}
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-ink-800 rounded-lg animate-pulse">
                  <div className="w-8 h-8 bg-ink-700 rounded" />
                  <div className="flex-1 h-4 bg-ink-700 rounded" />
                </div>
              ))}
            </div>
          ) : recentActivity.length === 0 ? (
            <div className="text-center py-8">
              <Clock className="w-12 h-12 text-ash/50 mx-auto mb-2" />
              <p className="text-ash">No recent activity</p>
              <p className="text-ash/60 text-sm">Upload a document to get started</p>
            </div>
          ) : (
            <div className="space-y-3">
              {recentActivity.map((activity) => {
                const Icon = getActivityIcon(activity.type);
                return (
                  <div
                    key={activity.id}
                    className="flex items-center gap-3 p-3 bg-ink-800 rounded-lg hover:bg-ink-700 transition-colors"
                  >
                    <div className="w-8 h-8 bg-ember-500/10 rounded-lg flex items-center justify-center">
                      <Icon className="w-4 h-4 text-ember-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-parchment truncate">{activity.name}</p>
                      <p className="text-xs text-ash capitalize">
                        {activity.action} • {formatTimeAgo(activity.timestamp)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
