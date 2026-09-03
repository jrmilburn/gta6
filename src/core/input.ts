// Keyboard state with edge-triggered presses. Also exposes an injection hook the
// smoke tests use to drive the game headlessly (window.__input.set('KeyW', true)).

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'handbrake' | 'sprint' | 'interact' | 'camera'
  | 'hud' | 'respawn' | 'showcase' | 'pause' | 'dance'
  | 'goofy' | 'arm'
  | 'up' | 'down';

const BINDINGS: Record<Action, string[]> = {
  forward:   ['KeyW', 'ArrowUp'],
  back:      ['KeyS', 'ArrowDown'],
  left:      ['KeyA', 'ArrowLeft'],
  right:     ['KeyD', 'ArrowRight'],
  handbrake: ['Space'],
  sprint:    ['ShiftLeft', 'ShiftRight'],
  interact:  ['KeyE'],
  camera:    ['KeyC'],
  // DECISION: the HUD toggle moves off H, which this pass gives to the pistol.
  // Backquote is the conventional debug-overlay key and collides with nothing
  // the browser wants.
  hud:       ['Backquote'],
  respawn:   ['KeyR'],
  showcase:  ['KeyK'],
  pause:     ['Escape'],
  dance:     ['KeyG'],
  goofy:     ['KeyP'],
  arm:       ['KeyH'],
  up:        ['KeyQ'],
  down:      ['KeyE'],
};

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  /** Set by scripted sequences (showcase) to override the human. */
  scripted: Partial<Record<Action, number>> | null = null;
  /**
   * Mouse state. `dx`/`dy` accumulate movement for the frame and are cleared by
   * endFrame(); `left`/`right` are held state and `leftPressed`/`rightPressed`
   * are edge-triggered the same way keys are, so a click is one click however
   * many physics steps the frame ran.
   */
  readonly mouse = {
    dx: 0, dy: 0, locked: false,
    left: false, right: false,
    leftPressed: false, rightPressed: false,
  };
  onFirstKey: (() => void) | null = null;
  private gotFirstKey = false;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      this.pressed.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.gotFirstKey) { this.gotFirstKey = true; this.onFirstKey?.(); }
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
    window.addEventListener('mousemove', (e) => {
      if (!this.mouse.locked) return;
      this.mouse.dx += e.movementX;
      this.mouse.dy += e.movementY;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    // Right-drag is aim, so the context menu has to go or every aim opens it.
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.mouse.locked = document.pointerLockElement !== null;
      // Buttons held when the lock changes are never released, because the
      // mouseup lands somewhere else.
      if (!this.mouse.locked) { this.mouse.left = false; this.mouse.right = false; }
    });
    // Test hook.
    (window as unknown as { __input: unknown }).__input = {
      set: (code: string, isDown: boolean) => {
        if (isDown) { this.down.add(code); this.pressed.add(code); }
        else this.down.delete(code);
        if (!this.gotFirstKey) { this.gotFirstKey = true; this.onFirstKey?.(); }
      },
      tap: (code: string) => { this.pressed.add(code); this.down.add(code); setTimeout(() => this.down.delete(code), 60); },
      // Mouse injection for the smoke suite, which cannot take a pointer lock.
      mouse: (dx: number, dy: number) => { this.mouse.dx += dx; this.mouse.dy += dy; },
      button: (which: 'left' | 'right', isDown: boolean) => {
        this.mouse[which] = isDown;
        if (isDown) this.mouse[which === 'left' ? 'leftPressed' : 'rightPressed'] = true;
      },
      lock: (v: boolean) => { this.mouse.locked = v; },
    };
  }

  isDown(action: Action): boolean {
    const s = this.scripted?.[action];
    if (s !== undefined) return s !== 0;
    return BINDINGS[action].some((c) => this.down.has(c));
  }

  justPressed(action: Action): boolean {
    if (this.scripted) return false;
    return BINDINGS[action].some((c) => this.pressed.has(c));
  }

  /** -1..1 on the steering axis. */
  get steerAxis(): number {
    const s = this.scripted?.right;
    if (s !== undefined) return s;
    return (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
  }

  /** -1..1 on the throttle axis. */
  get throttleAxis(): number {
    const s = this.scripted?.forward;
    if (s !== undefined) return s;
    return (this.isDown('forward') ? 1 : 0) - (this.isDown('back') ? 1 : 0);
  }

  /**
   * Called at the end of every fixed physics step.
   *
   * Edge-triggered presses must be consumed per STEP, not per rendered frame:
   * Game.step() can run several ticks inside one frame under load, and a system
   * gated on justPressed() would otherwise see the same tap two or three times
   * and toggle a state back and forth on a single keypress.
   */
  endStep(): void {
    this.pressed.clear();
    this.mouse.leftPressed = false;
    this.mouse.rightPressed = false;
  }

  /**
   * Called once per rendered frame.
   *
   * A press that no physics step has seen yet is KEPT, and that is the whole
   * point. The simulation runs at a fixed 60 Hz while frames come as fast as
   * the display allows, so on anything above 60 Hz most frames run no step at
   * all -- and this used to throw the press away on every one of them. Roughly
   * half of all key presses were silently discarded on a 144 Hz monitor, which
   * is why G and H so often needed pressing twice.
   *
   * Presses are still dropped while PAUSED, which is the case the old clear was
   * actually written for: no steps run at all then, so without this a tap would
   * linger and fire the instant the game resumed.
   */
  endFrame(paused: boolean): void {
    if (paused) {
      this.pressed.clear();
      this.mouse.leftPressed = false;
      this.mouse.rightPressed = false;
    }
    this.mouse.dx = 0;
    this.mouse.dy = 0;
  }
}
