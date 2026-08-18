import abortableOperation from '#radial/application/internal/AbortableOperation.js';
import type OpenAIPNavaidTransport from '#radial/data-producer/internal/OpenAIPNavaidTransport.js';
import OpenAIPNavaidTransportError from '#radial/data-producer/internal/OpenAIPNavaidTransportError.js';

const OPENAIP_NAVAIDS_URL = 'https://api.core.openaip.net/api/navaids';
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

function createProductionOpenAIPNavaidTransport(apiKey: string): OpenAIPNavaidTransport {
  return async request => {
    abortableOperation.throwIfAborted(request.signal);
    const url = new URL(OPENAIP_NAVAIDS_URL);
    url.searchParams.set('page', String(request.page));
    url.searchParams.set('limit', String(request.limit));
    url.searchParams.set('sortBy', request.sortBy);
    url.searchParams.set('sortDesc', String(request.sortDesc));

    const controller = new AbortController();
    const connectionTimer = setTimeout(
      () => controller.abort(),
      request.connectionTimeoutMs
    );
    const requestTimer = setTimeout(() => controller.abort(), request.requestTimeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, {once: true});
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'br, gzip, deflate',
          'x-openaip-api-key': apiKey,
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      clearTimeout(connectionTimer);
      const body = await readResponseBody(response);
      return {
        status: response.status,
        headers: Object.freeze(Object.fromEntries(response.headers.entries())),
        body,
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw abortableOperation.abortError(request.signal);
      }
      if (error instanceof OpenAIPNavaidTransportError) {
        throw error;
      }
      throw new OpenAIPNavaidTransportError(
        'OpenAIP Navaid request transport failed.',
        true
      );
    } finally {
      clearTimeout(connectionTimer);
      clearTimeout(requestTimer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  };
}

async function readResponseBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  const contentEncoding = response.headers.get('content-encoding');
  if (
    (contentEncoding === null || contentEncoding === 'identity') &&
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_RESPONSE_BYTES
  ) {
    throw new OpenAIPNavaidTransportError(
      'OpenAIP Navaid response exceeded 64 MiB.',
      false
    );
  }
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    byteCount += result.value.byteLength;
    if (byteCount > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new OpenAIPNavaidTransportError(
        'OpenAIP Navaid response exceeded 64 MiB.',
        false
      );
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(body);
  } catch {
    throw new OpenAIPNavaidTransportError(
      'OpenAIP Navaid response was not valid UTF-8.',
      false
    );
  }
}

export default createProductionOpenAIPNavaidTransport;
