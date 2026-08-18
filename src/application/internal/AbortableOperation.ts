function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

async function awaitWithAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal | undefined
): Promise<Value> {
  if (signal === undefined) {
    return operation;
  }
  if (signal.aborted) {
    throw abortError(signal);
  }

  return new Promise<Value>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, {once: true});
    void operation.then(
      value => {
        cleanup();
        resolve(value);
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}

export default {abortError, awaitWithAbort};
