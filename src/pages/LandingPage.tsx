import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Menu, X } from 'lucide-react';
import Logo from '../components/Logo';
import HeroSection from '../landing/HeroSection';
import ProblemSolutionSection from '../landing/ProblemSolutionSection';
import FeaturesSection from '../landing/FeaturesSection';
import DemoSection from '../landing/DemoSection';
import PricingSection from '../landing/PricingSection';

const NAV_LINKS = [
  { label: 'Problem', href: '#problem-solution' },
  { label: 'Features', href: '#features' },
  { label: 'Demo', href: '#demo' },
  { label: 'Pricing', href: '#pricing' },
];

interface LandingPageProps {
  onGetStarted?: () => void;
}

export default function LandingPage({ onGetStarted }: LandingPageProps) {
  const navigate = useNavigate();
  const handleGetStarted = onGetStarted || (() => navigate('/login'));
  const [scrolled, setScrolled] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('');
  const navRef = useRef<HTMLElement>(null);

  // Nav scroll shadow
  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20);
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Active section tracking via IntersectionObserver
  useEffect(() => {
    const sections = document.querySelectorAll('section[id]');
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        });
      },
      { rootMargin: '-40% 0px -55% 0px' }
    );
    sections.forEach((s) => observer.observe(s));
    return () => observer.disconnect();
  }, []);

  const handleNavClick = (href: string) => {
    setMobileMenuOpen(false);
    const target = document.querySelector(href);
    target?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="relative min-h-screen bg-ink-950 text-parchment font-sans overflow-x-hidden">
      <div className="grid-bg grid-bg-fade pointer-events-none absolute inset-0 -z-10" />

      {/* ── Sticky navigation ──────────────────────────────────────── */}
      <nav
        ref={navRef}
        className={`fixed top-0 inset-x-0 z-50 transition-all duration-300 ${
          scrolled
            ? 'bg-ink-950/90 backdrop-blur-md border-b border-ink-700/60 shadow-lg shadow-ink-950/40'
            : 'bg-transparent'
        }`}
        aria-label="Main navigation"
      >
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 h-16">
          {/* Logo + wordmark */}
          <a
            href="#hero"
            onClick={(e) => { e.preventDefault(); handleNavClick('#hero'); }}
            className="flex items-center gap-2.5 focus-ember rounded-md"
            aria-label="DocuTalk AI home"
          >
            <Logo size={28} animated={false} />
            <span className="font-display text-lg font-semibold text-parchment">
              DocuTalk
              <span className="text-ember-500 ml-1">AI</span>
            </span>
          </a>

          {/* Desktop nav links */}
          <div className="hidden md:flex items-center gap-1 relative" role="tablist">
            {NAV_LINKS.map((link) => {
              const sectionId = link.href.replace('#', '');
              const isActive  = activeSection === sectionId;
              return (
                <a
                  key={link.href}
                  href={link.href}
                  id={`nav-${sectionId}`}
                  role="tab"
                  aria-selected={isActive}
                  onClick={(e) => { e.preventDefault(); handleNavClick(link.href); }}
                  className={`relative px-4 py-2 font-sans text-sm rounded-lg transition-colors duration-200 focus-ember ${
                    isActive ? 'text-parchment' : 'text-ash hover:text-parchment-300'
                  }`}
                >
                  {/* Active underline pill */}
                  {isActive && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-3 -bottom-px h-px bg-ember-500 rounded-full"
                      transition={{ type: 'spring', stiffness: 400, damping: 35 }}
                    />
                  )}
                  {link.label}
                </a>
              );
            })}
          </div>

          {/* Desktop CTAs */}
          <div className="hidden md:flex items-center gap-3">
            <button
              id="nav-signin"
              onClick={handleGetStarted}
              className="font-sans text-sm text-ash hover:text-parchment transition-colors focus-ember px-3 py-2 rounded-lg"
            >
              Sign in
            </button>
            <button
              id="nav-cta"
              onClick={handleGetStarted}
              className="font-sans text-sm font-medium bg-ember-500 hover:bg-ember-600 text-ink-950 px-4 py-2 rounded-lg transition-colors focus-ember"
            >
              Get started
            </button>
          </div>

          {/* Mobile menu toggle */}
          <button
            id="nav-mobile-toggle"
            className="md:hidden p-2 rounded-lg text-ash hover:text-parchment transition-colors focus-ember"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-expanded={mobileMenuOpen}
            aria-label="Toggle navigation menu"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>

        {/* Mobile menu */}
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: 'easeInOut' }}
              className="md:hidden overflow-hidden bg-ink-900 border-t border-ink-700"
            >
              <div className="px-6 py-4 flex flex-col gap-2">
                {NAV_LINKS.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={(e) => { e.preventDefault(); handleNavClick(link.href); }}
                    className="font-sans text-sm text-ash hover:text-parchment py-2.5 border-b border-ink-700 last:border-0 transition-colors focus-ember rounded"
                  >
                    {link.label}
                  </a>
                ))}
                <button
                  id="nav-mobile-cta"
                  onClick={() => { setMobileMenuOpen(false); handleGetStarted(); }}
                  className="mt-2 w-full bg-ember-500 hover:bg-ember-600 text-ink-950 font-sans font-medium text-sm py-3 rounded-xl transition-colors focus-ember"
                >
                  Get started free
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      {/* ── Page sections ─────────────────────────────────────────── */}
      <main id="main-content">
        <HeroSection onGetStarted={handleGetStarted} />
        <ProblemSolutionSection />
        <FeaturesSection />
        <DemoSection />
        <PricingSection onGetStarted={handleGetStarted} />
      </main>

      {/* ── Footer ────────────────────────────────────────────────── */}
      <footer className="relative z-0 bg-ink-900 border-t border-ink-700 px-6 py-12">
        {/* Graph-paper grid backdrop */}
        <div className="grid-bg pointer-events-none absolute inset-0 -z-10" />
        <div className="relative max-w-6xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-8">
          <div className="flex items-center gap-3">
            <Logo size={28} animated={false} />
            <div>
              <p className="font-display text-base font-semibold text-parchment">
                DocuTalk<span className="text-ember-500 ml-1">AI</span>
              </p>
              <p className="font-mono text-[11px] text-ash">RAG • Postgres • Documents</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-x-8 gap-y-3">
            {NAV_LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={(e) => { e.preventDefault(); handleNavClick(l.href); }}
                className="font-sans text-sm text-ash hover:text-parchment-300 transition-colors focus-ember rounded"
              >
                {l.label}
              </a>
            ))}
          </div>

          <p className="font-mono text-[11px] text-ash/60">
            © {new Date().getFullYear()} DocuTalk AI
          </p>
        </div>
      </footer>
    </div>
  );
}
