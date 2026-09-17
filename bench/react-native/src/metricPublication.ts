export class MetricPublication {
  publish = true;
  recording = false;
  private writes: Record<string, number> = {};
  private renders = 0;
  private errors = new Set<string>();
  reset() { this.writes = {}; this.renders = 0; this.errors.clear(); }
  write(label: string, value: unknown) {
    if (!this.recording) return;
    const owner = label.split('.')[0];
    this.writes[owner] = (this.writes[owner] ?? 0) + 1;
    if (/error$/i.test(label) && typeof value === 'string') this.errors.add(`${label}: ${value}`.slice(0, 200));
  }
  render() { if (this.recording) ++this.renders; }
  snapshot() { return { stateWrites: { ...this.writes }, stateHookRenders: this.renders, errors: [...this.errors].slice(0, 8) }; }
}
