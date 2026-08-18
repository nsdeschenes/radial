export default interface OpenAIPNavaidTransport {
  (request: {
    readonly page: number;
    readonly limit: 1000;
    readonly sortBy: '_id';
    readonly sortDesc: false;
    readonly connectionTimeoutMs: 10_000;
    readonly requestTimeoutMs: 60_000;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
  }>;
}
