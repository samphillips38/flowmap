// First-visit walkthrough overlay.

const Onboarding = (function () {
  const STORAGE_KEY = 'transitOnboardingSeenV1';

  const STEPS = [
    {
      title: 'Welcome to Transit Times',
      body: 'Explore public-transit commute times across London. See where you could live with the shortest journey — or find a fair spot when several people need to get somewhere.',
    },
    {
      title: 'Add your destinations',
      body: 'Search for places in the sidebar — your office, university, gym, or anywhere you travel to regularly. You can add up to six locations and set departure time and transport mode for each.',
    },
    {
      title: 'Show travel times',
      body: 'Press "Show travel times" to calculate journeys across a grid of sample points. Green areas mean shorter commutes; red areas mean longer ones.',
    },
    {
      title: 'Multiple destinations',
      body: 'With two or more locations, open Options on the map to choose how times are combined: Min (best for any one person), Max (fairest — no one has the worst commute), Sum (lowest total travel), or Weighted (prioritise some places over others).',
    },
    {
      title: 'Explore on the map',
      body: 'Search for an address or tap anywhere on the map to see exact journey times and step-by-step routes to your destinations. Use the Sampling section to adjust the search area, radius, and how many points are tested.',
    },
    {
      title: 'Save your runs',
      body: 'Sign in to save heatmap runs to your account and reopen them later from Saved runs — on this device or any other.',
    },
  ];

  let currentStep = 0;
  let els = {};

  function hasSeen() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function markSeen() {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Private browsing or storage blocked — tour won't persist, which is fine.
    }
  }

  function renderStep() {
    const step = STEPS[currentStep];
    if (!step || !els.title || !els.body) return;

    els.title.textContent = step.title;
    els.body.textContent = step.body;

    els.dots.innerHTML = STEPS.map((_, i) => {
      const active = i === currentStep ? ' active' : '';
      const done = i < currentStep ? ' done' : '';
      return `<span class="onboarding-dot${active}${done}" aria-hidden="true"></span>`;
    }).join('');

    els.backBtn.classList.toggle('hidden', currentStep === 0);
    els.nextBtn.textContent = currentStep === STEPS.length - 1 ? 'Get started' : 'Next';
    els.stepLabel.textContent = `Step ${currentStep + 1} of ${STEPS.length}`;
  }

  function open() {
    currentStep = 0;
    renderStep();
    els.overlay.classList.remove('hidden');
    els.overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('onboarding-open');
    els.nextBtn.focus();
  }

  function close() {
    markSeen();
    els.overlay.classList.add('hidden');
    els.overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('onboarding-open');
  }

  function goNext() {
    if (currentStep < STEPS.length - 1) {
      currentStep += 1;
      renderStep();
      return;
    }
    close();
  }

  function goBack() {
    if (currentStep > 0) {
      currentStep -= 1;
      renderStep();
    }
  }

  function bindEvents() {
    els.nextBtn.addEventListener('click', goNext);
    els.backBtn.addEventListener('click', goBack);
    els.skipBtn.addEventListener('click', close);
    els.closeBtn.addEventListener('click', close);

    document.addEventListener('keydown', e => {
      if (els.overlay.classList.contains('hidden')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
  }

  function cacheElements() {
    els = {
      overlay: document.getElementById('onboarding-overlay'),
      title: document.getElementById('onboarding-title'),
      body: document.getElementById('onboarding-body'),
      dots: document.getElementById('onboarding-dots'),
      backBtn: document.getElementById('onboarding-back'),
      nextBtn: document.getElementById('onboarding-next'),
      skipBtn: document.getElementById('onboarding-skip'),
      closeBtn: document.getElementById('onboarding-close'),
      stepLabel: document.getElementById('onboarding-step-label'),
    };
  }

  function init() {
    cacheElements();
    if (!els.overlay) return;
    bindEvents();
    if (!hasSeen()) {
      open();
    }
  }

  return { init };
})();
