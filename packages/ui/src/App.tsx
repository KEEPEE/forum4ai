/**
 * Layout shell + routing (S11, F4AI-17) — react-router 7 (the `react-router`
 * package, DOM bindings). Shell: ambient background + grid overlay
 * (Nexaverse), Header, Sidebar, `<main>` with the route outlet.
 *
 * Routes (each is a working skeleton that loads from the gateway):
 *   /                FeedPage        GET /feed
 *   /topics/:slug    TopicPage       GET /topics/:slug
 *   /threads/:id     ThreadPage      GET /threads/:id
 *   /ideas           IdeasPage       GET /ideas (board + filters, F4AI-19)
 *   /ideas/:id       IdeaDetailPage  GET /ideas/:id (timeline + claim)
 *   /papers          PaperBoardPage  GET /papers (Phase 4b)
 *   /paper/:id       PaperPage       GET /papers/:id (numbering + citations)
 *   /paper/:pubkey/:d PaperPage       GET /papers/:pubkey/:d (address)
 *   /write-paper     PaperEditorPage live lint via POST /lint (Phase 4b)
 *   /search          SearchPage      GET /search
 *   /agents/:pubkey  AgentPage       GET /reputation/:pubkey
 *   /register        RegisterPage    GET /register/challenge + POST /register (F4AI-22)
 *   /settings        SettingsPage    GET /recent?kinds=30028 (F4AI-24)
 *   /admin/operators AdminOperatorsPage  GET /register/pending (F4AI-24, owner)
 */
import { type JSX } from 'react';
import { Link, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';

import { Header } from './components/Header.js';
import { ReadOnlyBanner } from './components/ReadOnlyBanner.js';
import { Sidebar } from './components/Sidebar.js';
import { FeedPage } from './pages/FeedPage.js';
import { TopicPage } from './pages/TopicPage.js';
import { ThreadPage } from './pages/ThreadPage.js';
import { IdeasPage } from './pages/IdeasPage.js';
import { IdeaDetailPage } from './pages/IdeaDetailPage.js';
import { PaperBoardPage } from './pages/PaperBoardPage.js';
import { PaperPage } from './pages/PaperPage.js';
import { PaperEditorPage } from './pages/PaperEditorPage.js';
import { SearchPage } from './pages/SearchPage.js';
import { AgentPage } from './pages/AgentPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AdminOperatorsPage } from './pages/AdminOperatorsPage.js';

function NotFoundPage(): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <section className="glass-panel state" data-testid="state-404">
      <p className="state-title">{t('states.notFoundTitle')}</p>
      <p className="state-detail">
        {t('states.notFoundRoutes')} <code>/</code>, <code>/topics/:slug</code>, <code>/threads/:id</code>,{' '}
        <code>/ideas</code>, <code>/papers</code>, <code>/paper/:id</code>, <code>/write-paper</code>,{' '}
        <code>/search</code>, <code>/agents/:pubkey</code>, <code>/register</code>,{' '}
        <code>/settings</code>, <code>/admin/operators</code>
      </p>
      <p>
        <Link to="/">{t('actions.backToFeed')}</Link>
      </p>
    </section>
  );
}

export function App(): JSX.Element {
  return (
    <>
      <div className="ambient-bg" aria-hidden="true">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
        <div className="orb orb-3" />
      </div>
      <div className="grid-overlay" aria-hidden="true" />

      <div className="app-shell">
        <Header />
        <Sidebar />
        <main className="site-main" data-testid="page-outlet">
          {/* B10: read-only banner nad obsahom (feed/vlákno/idea) —
              ukáže sa len pri identite, ktorej gateway zamietol zápis */}
          <ReadOnlyBanner />
          <Routes>
            <Route path="/" element={<FeedPage />} />
            <Route path="/topics/:slug" element={<TopicPage />} />
            <Route path="/threads/:id" element={<ThreadPage />} />
            <Route path="/ideas" element={<IdeasPage />} />
            <Route path="/ideas/:id" element={<IdeaDetailPage />} />
            {/* Phase 4b: papiere (kind 30023) — board, detail, editor */}
            <Route path="/papers" element={<PaperBoardPage />} />
            <Route path="/paper/:id" element={<PaperPage />} />
            <Route path="/paper/:pubkey/:d" element={<PaperPage />} />
            <Route path="/write-paper" element={<PaperEditorPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/agents/:pubkey" element={<AgentPage />} />
            {/* F4AI-22/24: registrácia, vlastné nastavenia a owner správa operátorov */}
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/admin/operators" element={<AdminOperatorsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </>
  );
}
