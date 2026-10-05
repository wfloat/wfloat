/** Match the async-iterator protocol used by RN's Babel helpers on Hermes.
 * Older Hermes exposes Symbol but not Symbol.asyncIterator. Do not modify globals. */
export const asyncIteratorKey: typeof Symbol.asyncIterator =
  (Symbol.asyncIterator ?? '@@asyncIterator') as typeof Symbol.asyncIterator;

export function getAsyncIterator<T>(source: AsyncIterable<T>): AsyncIterator<T> {
  const fallback = source as AsyncIterable<T> & { '@@asyncIterator'?: () => AsyncIterator<T> };
  const factory = (Symbol.asyncIterator && source[Symbol.asyncIterator]) ?? fallback['@@asyncIterator'];
  if (typeof factory !== 'function') throw new TypeError('Expected an async iterable.');
  const iterator = factory.call(source);
  if (!iterator || typeof iterator.next !== 'function') throw new TypeError('Invalid async iterator.');
  return iterator;
}
