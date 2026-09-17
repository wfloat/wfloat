export type SourceUpdate<T> = { active: boolean; value: T | null; error: string | null };
// A source owns its polling lifetime; subscribers only observe it. No metric
// selection/configuration framework: the app decides when the source runs.
export class SourcePoller<T> {
  private listeners = new Set<(update: SourceUpdate<T>) => void>();
  private current: SourceUpdate<T> = { active: false, value: null, error: null };
  private generation = 0;
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private read: () => Promise<T>;
  private intervalMs: number;
  constructor(read: () => Promise<T>, intervalMs = 2000) { this.read = read; this.intervalMs = intervalMs; }
  subscribe(listener: (update: SourceUpdate<T>) => void) {
    this.listeners.add(listener); listener(this.current);
    return () => { this.listeners.delete(listener); };
  }
  private emit(update: SourceUpdate<T>) {
    this.current = update;
    for (const listener of this.listeners) listener(update);
  }
  setActive(active: boolean) {
    if (active === this.current.active) return;
    ++this.generation;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.emit({ active, value: null, error: null });
    if (active) void this.poll();
  }
  private async poll() {
    if (this.pending || !this.current.active) return;
    this.pending = true;
    const generation = this.generation;
    try {
      const value = await this.read();
      if (generation === this.generation && this.current.active) this.emit({ active: true, value, error: null });
    } catch (error) {
      if (generation === this.generation && this.current.active)
        this.emit({ active: true, value: null, error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.pending = false;
      if (this.current.active) this.timer = setTimeout(() => void this.poll(), generation === this.generation ? this.intervalMs : 0);
    }
  }
}
