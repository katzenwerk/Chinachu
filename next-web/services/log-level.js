function numericField(text, names) {
  const pattern = new RegExp(`\\b(?:${names.join('|')})\\s*=\\s*(\\d+)\\b`, 'ig');
  let match;
  let maximum = 0;
  while ((match = pattern.exec(text)) !== null) {
    maximum = Math.max(maximum, Number.parseInt(match[1], 10));
  }
  return maximum;
}

export function classifyLogLine(value) {
  const text = String(value);
  const http = text.match(/(?:^|\s)([1-5]\d{2})\s+(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS):/i);
  if (http) {
    const status = Number.parseInt(http[1], 10);
    if (status >= 500) return 'error';
    if (status >= 400) return 'warning';
  }

  if (/\b(?:ERROR|FATAL)\s*:/i.test(text)
      || /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError|AggregateError)\s*:/i.test(text)
      || /\b(?:uncaught (?:exception|error)|unhandled (?:promise )?rejection)\b/i.test(text)
      || /\bstate\s*=\s*(?:failed|error)\b/i.test(text)
      || /\bSERVICE:\s+Restart failed\b/i.test(text)
      || numericField(text, ['failed', 'errors?', 'error_count']) > 0
      || /\b(?:failed to|startup failed|failure:)\b/i.test(text)) {
    return 'error';
  }

  if (/\bWARN(?:ING)?\s*:/i.test(text)
      || /容量不足|low[ -]?space/i.test(text)
      || /\bSERVICE:\s+Restart rejected\b/i.test(text)
      || /\bstate\s*=\s*aborted\b/i.test(text)
      || numericField(text, ['aborted']) > 0) {
    return 'warning';
  }

  return 'info';
}
