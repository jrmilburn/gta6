// Full-screen overlays: title splash on boot, and the three fail/win states.
// Plan section 9: fade in/out 0.3 s, tinted overlays hold for 2.5 s total.
const FADE = 0.3;
const HOLD_TOTAL = 2.5; // wall time an overlay is visible, fades included

type PulseKind = 'wrecked' | 'busted' | 'passed';

interface PulseDef { tint: string; label: string; sub: (reward?: number) => string }

const PULSES: Record<PulseKind, PulseDef> = {
  wrecked: { tint: 'rgba(160,20,20,0.55)', label: 'WRECKED', sub: () => 'your ride is toast' },
  busted: { tint: 'rgba(20,60,160,0.55)', label: 'BUSTED', sub: () => 'the heat caught you' },
  passed: { tint: 'rgba(180,140,20,0.5)', label: 'MISSION PASSED', sub: (r) => (r ? `+${fmtReward(r)}` : '') },
};

function fmtReward(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function el(tag: string, css: string, text?: string): HTMLDivElement {
  const d = document.createElement(tag) as HTMLDivElement;
  d.style.cssText = css;
  if (text !== undefined) d.textContent = text;
  return d;
}

const TITLE_TEXT = `
  color:#fff; font-family:-apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  text-shadow: 0 4px 18px rgba(0,0,0,0.8);
`;

export interface ScreensApi {
  root: HTMLDivElement;
  /** Boot progress bar, 0..1. Hidden automatically once it reaches 1. */
  setProgress(fraction: number, label: string): void;
  /** True while a screen owns the frame (later phases can use this to pause input). */
  active: boolean;
  tick(dt: number): void;
  showTitle(): void;
  /** Dismiss the boot splash programmatically, with no keypress. */
  hideTitle(): void;
  /** True while the boot splash is still up. */
  readonly titleActive: boolean;
  showWrecked(): void;
  showBusted(): void;
  showMissionPassed(reward?: number): void;
}

export interface BlipHost { blip(freq?: number): void }

export function createScreens(uiRoot: HTMLElement, audio: BlipHost): ScreensApi {
  const root = el('div', 'position:absolute; inset:0;');
  uiRoot.appendChild(root);

  // --- title splash ---
  const title = el(
    'div',
    `position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
     justify-content:center; background:linear-gradient(180deg, #141026, #0b0716);
     opacity:0; transition:opacity ${FADE}s ease, background ${FADE * 2}s ease;`,
  );
  const titleMain = el(
    'div',
    `${TITLE_TEXT} font-size:min(11vw, 96px); font-weight:900; letter-spacing:0.12em;`,
    'SUNBELT CITY',
  );
  const titleSub = el(
    'div',
    `${TITLE_TEXT} font-size:20px; font-weight:700; letter-spacing:0.08em; margin-top:18px; opacity:0.9;`,
    'press any key',
  );
  // Loading bar. The title is shown from the first frame so the player has
  // something to look at while the environment map and models come down; `press
  // any key` only replaces the bar once everything is in.
  const barTrack = el(
    'div',
    `width:min(46vw, 420px); height:4px; margin-top:26px; border-radius:2px;
     background:rgba(255,255,255,0.18); overflow:hidden;`,
  );
  const barFill = el(
    'div',
    `width:0%; height:100%; border-radius:2px; background:#ffd9a0;
     transition:width 0.18s ease-out;`,
  );
  barTrack.appendChild(barFill);
  const barLabel = el(
    'div',
    `${TITLE_TEXT} font-size:13px; font-weight:600; letter-spacing:0.14em;
     margin-top:10px; opacity:0.65; text-transform:uppercase;`,
    'loading',
  );

  title.append(titleMain, titleSub, barTrack, barLabel);
  root.appendChild(title);
  titleSub.style.display = 'none';

  // --- pulse overlays (wrecked / busted / mission passed) ---
  const pulse = el(
    'div',
    `position:absolute; inset:0; display:flex; flex-direction:column; align-items:center;
     justify-content:center; opacity:0; transition:opacity ${FADE}s ease;`,
  );
  const pulseMain = el(`div`, `${TITLE_TEXT} font-size:min(9vw, 76px); font-weight:900; letter-spacing:0.1em;`);
  const pulseSub = el(`div`, `${TITLE_TEXT} font-size:22px; font-weight:700; margin-top:14px;`);
  pulse.append(pulseMain, pulseSub);
  root.appendChild(pulse);

  let titleVisible = false;
  let titleFading = false;
  let loaded = false;

  function dismissTitle(): void {
    // The game must not start before the assets are in, so a keypress during
    // the load is ignored rather than queued.
    if (!loaded || !titleVisible || titleFading) return;
    titleFading = true;
    title.style.opacity = '0';
    window.setTimeout(() => {
      titleVisible = false;
      titleFading = false;
      title.style.display = 'none';
    }, FADE * 1000);
  }
  const dismissHandler = (): void => dismissTitle();
  window.addEventListener('keydown', dismissHandler);
  window.addEventListener('mousedown', dismissHandler);

  let pulseKind: PulseKind | null = null;
  let pulseT = 0;

  function startPulse(kind: PulseKind, reward?: number): void {
    const def = PULSES[kind];
    pulseMain.textContent = def.label;
    pulseSub.textContent = def.sub(reward);
    pulse.style.background = def.tint;
    pulseKind = kind;
    pulseT = 0;
    pulse.style.display = 'flex';
    // Next frame so the display:flex takes before the opacity transition starts.
    requestAnimationFrame(() => { pulse.style.opacity = '1'; });
    if (kind === 'passed') audio.blip(1200);
  }

  return {
    root,
    setProgress(fraction: number, label: string): void {
      const f = Math.max(0, Math.min(1, fraction));
      barFill.style.width = `${(f * 100).toFixed(1)}%`;
      barLabel.textContent = label;
      if (f < 1 || loaded) return;
      loaded = true;
      barTrack.style.display = 'none';
      barLabel.style.display = 'none';
      titleSub.style.display = '';
      // Loading is over: let the world show through the title card.
      title.style.background = 'linear-gradient(180deg, rgba(10,8,20,0.15), rgba(6,4,14,0.55))';
    },
    get active(): boolean { return titleVisible || pulseKind !== null; },
    get titleActive(): boolean { return titleVisible; },
    tick(dt: number): void {
      if (pulseKind) {
        pulseT += dt;
        if (pulseT >= HOLD_TOTAL - FADE && pulseT < HOLD_TOTAL) {
          pulse.style.opacity = '0';
        } else if (pulseT >= HOLD_TOTAL) {
          pulse.style.display = 'none';
          pulseKind = null;
        }
      }
    },
      /**
     * Take the splash down without a keypress. The opening flight is the game's
     * own way in, so when it plays there is nothing to press a key for.
     */
    hideTitle(): void {
      loaded = true;
      dismissTitle();
    },
    showTitle(): void {
      titleVisible = true;
      titleFading = false;
      title.style.display = 'flex';
      requestAnimationFrame(() => { title.style.opacity = '1'; });
    },
    showWrecked(): void { startPulse('wrecked'); },
    showBusted(): void { startPulse('busted'); },
    showMissionPassed(reward?: number): void { startPulse('passed', reward); },
  };
}
