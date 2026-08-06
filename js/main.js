/* ==========================================================================
   Apex Construction — Main JS
   Vanilla, dependency-free. Defer-loaded.
   ========================================================================== */

(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // === Mobile menu toggle ===
  const menuBtn = document.querySelector('.menu-toggle');
  const nav = document.getElementById('primary-nav');
  if (menuBtn && nav) {
    menuBtn.addEventListener('click', () => {
      const open = nav.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      menuBtn.textContent = open ? '✕' : '☰';
      document.body.style.overflow = open ? 'hidden' : '';
    });

    // Close menu when a link is clicked
    nav.querySelectorAll('a:not(.has-menu)').forEach((a) => {
      a.addEventListener('click', () => {
        if (nav.classList.contains('open')) {
          nav.classList.remove('open');
          menuBtn.setAttribute('aria-expanded', 'false');
          menuBtn.textContent = '☰';
          document.body.style.overflow = '';
        }
      });
    });

    // On mobile the parent of a dropdown expands it rather than navigating
    nav.querySelectorAll('.has-menu').forEach((trigger) => {
      trigger.addEventListener('click', (e) => {
        if (window.matchMedia('(max-width: 1080px)').matches) {
          e.preventDefault();
          trigger.closest('.nav-item').classList.toggle('open');
        }
      });
    });
  }

  // === Datum rail — the signature. Decorative scroll position indicator. ===
  if (!document.querySelector('.datum-rail')) {
    const rail = document.createElement('div');
    rail.className = 'datum-rail';
    rail.setAttribute('aria-hidden', 'true');

    const mark = document.createElement('span');
    mark.className = 'datum-mark';
    mark.dataset.pos = '000';

    const label = document.createElement('span');
    label.className = 'datum-label';
    label.textContent = 'Apex Construction';

    rail.append(mark, label);
    document.body.prepend(rail);

    let ticking = false;
    const place = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      const progress = scrollable > 0 ? Math.min(1, Math.max(0, window.scrollY / scrollable)) : 0;
      mark.style.top = `calc(${(progress * 100).toFixed(2)}% - ${progress * 2}px)`;
      mark.dataset.pos = String(Math.round(progress * 100)).padStart(3, '0');
      ticking = false;
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(place); }
    }, { passive: true });
    window.addEventListener('resize', place, { passive: true });
    place();
  }

  // === Year auto-fill in footer ===
  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = new Date().getFullYear();
  });

  // === Reveal-on-scroll ===
  const reveals = document.querySelectorAll('.reveal');
  if (reveals.length) {
    if (reduceMotion || !('IntersectionObserver' in window)) {
      reveals.forEach((el) => el.classList.add('in'));
    } else {
      const io = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      }, { threshold: 0.1, rootMargin: '0px 0px -8% 0px' });
      reveals.forEach((el) => io.observe(el));
    }
  }

  // === Gallery filters ===
  const filterButtons = document.querySelectorAll('.gallery-filters button');
  const galleryItems = document.querySelectorAll('.gallery-item');
  if (filterButtons.length && galleryItems.length) {
    filterButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const filter = btn.dataset.filter;
        filterButtons.forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        galleryItems.forEach((item) => {
          item.classList.toggle('hidden', !(filter === 'all' || item.dataset.cat === filter));
        });
      });
    });
  }

  // === Smooth scroll for anchor links ===
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href');
      if (href === '#' || href.length < 2) return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      }
    });
  });

  // === Contact form → /api/contact → GoHighLevel ===
  const enquiryForm = document.getElementById('enquiry');
  if (enquiryForm) {
    const statusEl = document.getElementById('form-status');
    const submitBtn = enquiryForm.querySelector('button[type="submit"]');
    const submitLabel = submitBtn ? submitBtn.innerHTML : '';

    const SENT = 'Thanks — that\'s with us. We\'ll be in touch within one working day.';
    const FAILED = 'Sorry, that didn\'t send. Please call 07588 539871 or email apexconstructionsouth@gmail.com.';

    const setStatus = (state, text) => {
      if (!statusEl) return;
      statusEl.className = `form-status ${state}`;
      statusEl.textContent = text;
      statusEl.hidden = false;
    };

    // Without JS the form posts normally and comes back as a redirect.
    const outcome = new URLSearchParams(window.location.search).get('enquiry');
    if (outcome === 'sent') setStatus('ok', SENT);
    if (outcome === 'error') setStatus('error', FAILED);

    enquiryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!enquiryForm.reportValidity()) return;

      const payload = Object.fromEntries(new FormData(enquiryForm).entries());
      payload.page = window.location.pathname;
      payload.referrer = document.referrer || '';

      // Carry any campaign tagging through to the note.
      const params = new URLSearchParams(window.location.search);
      const campaign = [...params].filter(([k]) => /^(utm_|gclid|fbclid)/i.test(k))
        .map(([k, v]) => `${k}=${v}`).join(' · ');
      if (campaign) payload.campaign = campaign;

      if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
      if (statusEl) statusEl.hidden = true;

      try {
        const res = await fetch(enquiryForm.getAttribute('action'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || FAILED);

        enquiryForm.reset();
        setStatus('ok', SENT);
      } catch (err) {
        setStatus('error', err.message || FAILED);
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = submitLabel; }
      }
    });
  }

  // === Header lift on scroll ===
  const header = document.querySelector('.header');
  if (header) {
    const onScroll = () => {
      header.style.boxShadow = window.scrollY > 8
        ? '0 10px 30px -18px rgba(7, 30, 51, 0.75)'
        : '';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }
})();
