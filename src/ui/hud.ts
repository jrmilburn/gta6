// DOM overlay: stars, cash (count-up), speed + health, mission + timer, and the
// minimap slot. Plan section 9. System sans, heavy weight, slight letter
// spacing, white on a dark drop shadow. Every element hugs a screen edge so
// the centre 60% of the frame stays clear.
// DECISION: the plan's HUD bullet says "top left: minimap" while the minimap
// bullet says "bottom-left, 220x220". They conflict; this file follows the
// HUD bullet and places it top-left, next to nothing else so it never
// crowds the stars/cash in the opposite corner.
import type { Vec2 } from '../types';
import type { CityLayout } from '../world/cityGen';
import { createMinimap, type MinimapDots } from './minimap';

const MAX_STARS = 5;
const STAR_FULL = '★'; // ★
const STAR_EMPTY = '☆'; // ☆
const CASH_LERP = 5.5; // per-second convergence rate for the count-up

function fmtCash(n: number): string {
  const v = Math.round(n);
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
}

function fmtTimer(s: number): string {
  const t = Math.max(0, Math.ceil(s));
  const m = Math.floor(t / 60);
  const sec = t % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function el(tag: string, css: string, text?: string): HTMLDivElement {
  const d = document.createElement(tag) as HTMLDivElement;
  d.style.cssText = css;
  if (text !== undefined) d.textContent = text;
  return d;
}

export interface HudApi {
  root: HTMLDivElement;
  setStars(n: number): void;
  setCash(n: number): void;
  setMission(text: string | null): void;
  setTimer(seconds: number | null): void;
  setVisible(v: boolean): void;
  /** Brief centred message, e.g. "Dance!". Replaces any toast still showing. */
  toast(text: string, seconds: number): void;
  /** Crosshair and ammo readout while the pistol is out (section 7). */
  setArmed(armed: boolean, aiming: boolean, shots: number): void;
  /** The goofy-run indicator (section 5). */
  setGoofy(on: boolean): void;
  /** Contextual action prompt, e.g. "E  GET IN". Null hides it. */
  setPrompt(text: string | null): void;
  /** "Click to look around", shown until the pointer has been locked once. */
  setLookHint(show: boolean): void;
  tick(dt: number, speedKmh: number, healthFrac: number, playerPos: Vec2, heading: number, dots: MinimapDots): void;
}

const BASE_TEXT = `
  color:#fff; font-family:-apple-system, "Segoe UI", Roboto, Arial, sans-serif;
  font-weight:800; letter-spacing:0.04em;
  text-shadow: 0 2px 5px rgba(0,0,0,0.85), 0 0 12px rgba(0,0,0,0.5);
`;

export function createHud(uiRoot: HTMLElement, city: CityLayout): HudApi {
  const root = el('div', `position:absolute; inset:0; ${BASE_TEXT}`);

  // --- top right: stars + cash ---
  const topRight = el('div', 'position:absolute; top:16px; right:20px; text-align:right;');
  const stars = el('div', 'font-size:24px; line-height:1; color:#ffd452; text-shadow:0 2px 5px rgba(0,0,0,0.85);');
  const cash = el('div', 'font-size:22px; margin-top:6px;');
  topRight.append(stars, cash);

  // --- bottom right: speed + health ---
  const bottomRight = el('div', 'position:absolute; bottom:20px; right:20px; text-align:right;');
  const speed = el('div', 'font-size:54px; line-height:1;', '0');
  const speedUnit = el('div', 'font-size:13px; opacity:0.85; margin-top:-2px;', 'KM/H');
  const healthWrap = el(
    'div',
    'width:150px; height:9px; margin:8px 0 0 auto; background:rgba(0,0,0,0.5); ' +
      'border-radius:5px; overflow:hidden; border:1px solid rgba(255,255,255,0.4);',
  );
  const healthBar = el('div', 'height:100%; width:100%; background:#5be36b; transition:width 0.15s linear, background 0.3s;');
  healthWrap.appendChild(healthBar);
  bottomRight.append(speed, speedUnit, healthWrap);

  // --- bottom centre: mission + timer ---
  const bottomCenter = el(
    'div',
    'position:absolute; bottom:24px; left:50%; transform:translateX(-50%); text-align:center; max-width:56vw;',
  );
  const missionText = el('div', 'font-size:17px;');
  const timer = el('div', 'font-size:24px; margin-top:4px; opacity:0.92;');
  bottomCenter.append(missionText, timer);

  // --- centre: crosshair ---
  // Four ticks and a gap, not a dot: a dot vanishes against a bright wall, and
  // the gap is what tightens when the player aims.
  const cross = el('div', 'position:absolute; inset:0; pointer-events:none; opacity:0;'
    + ' transition:opacity 0.12s ease;');
  const ticks: HTMLDivElement[] = [];
  for (let i = 0; i < 4; i++) {
    const t = el('div', 'position:absolute; left:50%; top:50%; background:#fff;'
      + ' box-shadow:0 0 3px rgba(0,0,0,0.9); transition:transform 0.12s ease;');
    const vertical = i < 2;
    t.style.width = vertical ? '2px' : '9px';
    t.style.height = vertical ? '9px' : '2px';
    cross.appendChild(t);
    ticks.push(t);
  }
  const ammo = el('div', 'position:absolute; bottom:96px; right:20px; font-size:16px;'
    + ' letter-spacing:0.12em; opacity:0;  transition:opacity 0.15s ease;');

  // --- lower centre: contextual prompt ---
  // Just above the mission line, where the eye already goes for state, and only
  // ever shown when there is something to press.
  const prompt = el(
    'div',
    'position:absolute; bottom:78px; left:50%; transform:translateX(-50%); font-size:15px;'
      + ' letter-spacing:0.12em; padding:5px 12px; border-radius:14px;'
      + ' background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.35);'
      + ' opacity:0; transition:opacity 0.15s ease; pointer-events:none; white-space:nowrap;',
  );

  // --- lower left: mode indicators ---
  const modes = el('div', 'position:absolute; bottom:20px; left:20px; font-size:14px;'
    + ' letter-spacing:0.1em; display:flex; gap:10px;');
  const goofyTag = el('div', 'padding:3px 8px; border-radius:11px; background:rgba(0,0,0,0.45);'
    + ' border:1px solid rgba(255,255,255,0.35); display:none;', 'GOOFY');
  const lookHint = el('div', 'padding:3px 8px; border-radius:11px; background:rgba(0,0,0,0.45);'
    + ' border:1px solid rgba(255,255,255,0.25); opacity:0.85; font-weight:600;',
  'click to look around');
  modes.append(goofyTag, lookHint);

  // --- lower left, above the mode row: the controls ---
  // A key legend rather than a tutorial: two columns, key on the left, in the
  // same corner as the mode indicators so everything about "what can I press"
  // lives in one place, and small enough that it reads as furniture.
  const controls = el('div', 'position:absolute; bottom:56px; left:20px; font-size:12px;'
    + ' letter-spacing:0.08em; padding:8px 12px; border-radius:10px; background:rgba(0,0,0,0.42);'
    + ' border:1px solid rgba(255,255,255,0.22); display:grid; grid-template-columns:auto auto;'
    + ' column-gap:14px; row-gap:3px; align-items:baseline;');
  const CONTROLS: ReadonlyArray<[string, string]> = [
    ['WASD', 'move'],
    ['SHIFT', 'sprint'],
    ['SPACE', 'jump'],
    ['MOUSE', 'look  ·  click punch / fire  ·  right-click aim'],
    ['E', 'get in / out'],
    ['H', 'gun'],
    ['P', 'goofy walk'],
    ['G', 'gangnam style'],
  ];
  for (const [key, what] of CONTROLS) {
    controls.append(
      el('div', 'font-weight:800; color:#ffd452; text-align:right; white-space:nowrap;', key),
      el('div', 'font-weight:600; opacity:0.9; white-space:nowrap;', what),
    );
  }

  // --- upper centre: transient toast ---
  // Above the mission line and below the centre of frame, so it never sits over
  // the character it is announcing.
  const toastEl = el(
    'div',
    'position:absolute; top:22%; left:50%; transform:translateX(-50%); font-size:28px;'
      + ' opacity:0; transition:opacity 0.18s ease; pointer-events:none;',
  );

  // --- top left: minimap ---
  const topLeft = el('div', 'position:absolute; top:16px; left:16px;');
  const minimap = createMinimap(city);
  topLeft.appendChild(minimap.canvas);

  root.append(topRight, bottomRight, bottomCenter, topLeft, toastEl, cross, ammo, controls, modes, prompt);
  uiRoot.appendChild(root);

  let starCount = 0;
  let cashTarget = 0;
  let cashShown = 0;
  let toastLeft = 0;

  function renderStars(): void {
    stars.textContent = STAR_FULL.repeat(starCount) + STAR_EMPTY.repeat(MAX_STARS - starCount);
  }
  renderStars();
  cash.textContent = fmtCash(0);
  missionText.textContent = '';
  timer.textContent = '';

  return {
    root,
    setStars(n: number): void {
      starCount = Math.max(0, Math.min(MAX_STARS, Math.round(n)));
      renderStars();
    },
    setCash(n: number): void {
      cashTarget = n;
    },
    setMission(text: string | null): void {
      missionText.textContent = text ?? '';
    },
    setTimer(seconds: number | null): void {
      timer.textContent = seconds === null ? '' : fmtTimer(seconds);
    },
    setVisible(v: boolean): void {
      root.style.display = v ? '' : 'none';
    },
    setArmed(armed: boolean, aiming: boolean, shots: number): void {
      cross.style.opacity = armed ? '1' : '0';
      ammo.style.opacity = armed ? '0.9' : '0';
      ammo.textContent = `● ∞   ${shots} FIRED`;
      // Aiming pulls the ticks in; hip fire spreads them out.
      const gap = aiming ? 5 : 11;
      ticks[0].style.transform = `translate(-50%, ${-gap - 9}px)`;
      ticks[1].style.transform = `translate(-50%, ${gap}px)`;
      ticks[2].style.transform = `translate(${-gap - 9}px, -50%)`;
      ticks[3].style.transform = `translate(${gap}px, -50%)`;
    },
    setGoofy(on: boolean): void {
      goofyTag.style.display = on ? '' : 'none';
    },
    setPrompt(text: string | null): void {
      if (text !== null) prompt.textContent = text;
      prompt.style.opacity = text === null ? '0' : '1';
    },
    setLookHint(show: boolean): void {
      lookHint.style.display = show ? '' : 'none';
    },
    toast(text: string, seconds: number): void {
      toastEl.textContent = text;
      toastEl.style.opacity = '1';
      toastLeft = seconds;
    },
    tick(dt, speedKmh, healthFrac, playerPos, heading, dots): void {
      if (toastLeft > 0) {
        toastLeft -= dt;
        if (toastLeft <= 0) toastEl.style.opacity = '0';
      }
      cashShown += (cashTarget - cashShown) * Math.min(1, dt * CASH_LERP);
      if (Math.abs(cashTarget - cashShown) < 0.5) cashShown = cashTarget;
      cash.textContent = fmtCash(cashShown);

      speed.textContent = String(Math.round(speedKmh));
      const hf = Math.max(0, Math.min(1, healthFrac));
      healthBar.style.width = `${hf * 100}%`;
      healthBar.style.background = hf > 0.5 ? '#5be36b' : hf > 0.22 ? '#f5c542' : '#f0524a';

      minimap.render(playerPos, heading, dots);
    },
  };
}
