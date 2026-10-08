// Process-local counters (ARCH §18.2). Exported to the metrics backend when one is chosen; until
// then they are readable for tests and logs. Counter names are fixed strings, never user data.
export class Metrics {
  readonly #counters = new Map<string, number>();

  increment(name: string, by = 1): void {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.#counters.get(name) ?? 0;
  }
}
