import type { ListResponse } from "./core.js";

/**
 * What every list method returns. Await it for one page:
 *
 *   const { data, pagination } = await client.posts.list({ limit: 50 });
 *
 * or iterate it to walk every item, fetching the next page as needed:
 *
 *   for await (const post of client.posts.list({ status: "failed" })) { ... }
 *
 * The first page is requested once, on first use.
 */
export class PagePromise<T extends ListResponse> implements Promise<T>, AsyncIterable<T["data"][number]> {
  readonly [Symbol.toStringTag] = "PagePromise";
  private first: Promise<T> | undefined;

  constructor(private readonly fetchPage: (offset: number | undefined) => Promise<T>) {}

  private firstPage(): Promise<T> {
    this.first ??= this.fetchPage(undefined);
    return this.first;
  }

  then<R1 = T, R2 = never>(
    onFulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.firstPage().then(onFulfilled, onRejected);
  }

  catch<R = never>(onRejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.firstPage().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<T> {
    return this.firstPage().finally(onFinally);
  }

  /** Every page, starting with the first. */
  async *pages(): AsyncGenerator<T, void, undefined> {
    let page = await this.firstPage();
    for (;;) {
      yield page;
      const { offset, hasMore } = page.pagination;
      if (!hasMore || page.data.length === 0) return;
      page = await this.fetchPage(offset + page.data.length);
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T["data"][number], void, undefined> {
    for await (const page of this.pages()) yield* page.data as T["data"][number][];
  }

  /** Collects every item into an array. Mind large accounts: prefer `for await`. */
  async toArray(): Promise<T["data"][number][]> {
    const items: T["data"][number][] = [];
    for await (const item of this) items.push(item);
    return items;
  }
}
