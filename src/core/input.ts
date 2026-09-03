// Keyboard state with edge-triggered presses. Also exposes an injection hook the
// smoke tests use to drive the game headlessly (window.__input.set('KeyW', true)).

export type Action =
  | 'forward' | 'back' | 'left' | 'right'
  | 'handbrake' | 'sprint' | 'interact' | 'camera'
  | 'hud' | 'respawn' | 'showcase' | 'pause' | 'dance'
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
  hud:       ['KeyH'],
  respawn:   ['KeyR'],
  showcase:  ['KeyK'],
  pause:     ['Escape'],
  dance:     ['KeyG'],
  up:        ['KeyQ'],
  down:      ['KeyE'],
};

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private consumed = false;
  /** Set by scripted sequences (showcase) to override the human. */
  scripted: Partial<Record<Action, number>> | null = null;
  readonly mouse = { dx: 0, dy: 0, locked: false };
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
    document.addEventListener('pointerlockchange', () => {
      this.mouse.locked = document.pointerLockElement !== null;
    });
    // Test hook.
    (window as unknown as { __input: unknown }).__input = {
      set: (code: string, isDown: boolean) => {
        if (isDown) { this.down.add(code); this.pressed.add(code); }
        else this.down.delete(code);
        if (!this.gotFirstKey) { this.gotFirstKey = true; this.onFirstKey?.(); }
      },
      tap: (code: string) => { this.pressed.add(code); this.down.add(code); setTimeout(() => this.down.delete(code), 60); },
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
    this.consumed = true;
  }

  /**
   * Called once per rendered frame. Only clears presses that no physics step
   * consumed -- while paused no steps run at all, and without this a tap would
   * linger and re-fire every frame.
   */
  endFrame(): void {
    if (!this.consumed) this.pressed.clear();
    this.consumed = false;
    this.mouse.dx = 0;
    this.mouse.dy = 0;
  }
}
