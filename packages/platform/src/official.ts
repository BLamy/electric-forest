import {
  appendDurableJson,
  createDurableJsonStream,
  followDurableJson,
  readDurableJson,
  type FollowDurableJsonOptions,
} from "@eforest/client";
import type { Event } from "@eforest/protocol";

export interface StreamAdapter {
  create(streamId: string): Promise<void>;
  append(streamId: string, event: Event): Promise<void>;
  read(streamId: string): Promise<readonly unknown[]>;
  follow(streamId: string, signal?: AbortSignal): AsyncIterable<unknown>;
}

export interface OfficialStreamAdapterOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
}

function normalizedBaseUrl(value: string): string {
  const result = value.replace(/\/+$/, "");
  if (result.length === 0) throw new TypeError("baseUrl must not be empty");
  return result;
}

export class OfficialStreamAdapter implements StreamAdapter {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch | undefined;
  private readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(options: OfficialStreamAdapterOptions) {
    this.baseUrl = normalizedBaseUrl(options.baseUrl);
    this.fetcher = options.fetch;
    this.headers = options.headers;
  }

  async create(streamId: string): Promise<void> {
    await createDurableJsonStream(this.options(streamId));
  }

  async append(streamId: string, event: Event): Promise<void> {
    await appendDurableJson(this.options(streamId), event);
  }

  async read(streamId: string): Promise<readonly unknown[]> {
    return readDurableJson(this.options(streamId));
  }

  async *follow(streamId: string, signal?: AbortSignal): AsyncGenerator<unknown> {
    const options: FollowDurableJsonOptions = {
      ...this.options(streamId),
      live: "long-poll",
      ...(signal === undefined ? {} : { signal }),
    };
    for await (const batch of followDurableJson<unknown>(options)) yield* batch.items;
  }

  private options(streamId: string): {
    readonly url: string;
    readonly fetch?: typeof fetch;
    readonly headers?: Readonly<Record<string, string>>;
  } {
    if (streamId.length === 0) throw new TypeError("streamId must not be empty");
    return {
      url: `${this.baseUrl}/streams/${encodeURIComponent(streamId)}`,
      ...(this.fetcher === undefined ? {} : { fetch: this.fetcher }),
      ...(this.headers === undefined ? {} : { headers: this.headers }),
    };
  }
}
