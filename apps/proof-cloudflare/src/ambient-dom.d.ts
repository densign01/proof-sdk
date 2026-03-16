declare global {
  interface HTMLElement {
    dataset: Record<string, string | undefined>;
    getAttribute(name: string): string | null;
  }
}

export {};
