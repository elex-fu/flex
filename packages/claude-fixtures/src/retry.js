export function retry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      return fn(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No attempts executed");
}
