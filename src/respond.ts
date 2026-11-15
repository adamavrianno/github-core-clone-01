// The reply sink every surface writes through. The server implements it;
// the surfaces only call these methods, so none of them touches the raw
// HTTP response object. The server adds the X-GitHub-Request-Id header to
// every reply (including errors and 204s) before the surface writes.

export interface Reply {
  /** Send a JSON body with this status (Content-Type: application/json). */
  json(status: number, body: unknown): void;
  /** Send raw bytes with an explicit content type and status. */
  send(status: number, contentType: string, body: Buffer): void;
  /** Send a 204 with no body but the JSON content type set. */
  noContent(): void;
  /** Set one response header before sending. */
  header(name: string, value: string): void;
}
