function validTitle(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'タイトル未取得';
}

export function programActionTitle(program) {
  return validTitle(program?.fullTitle || program?.title);
}

export async function copyProgramTitle(title) {
  const value = typeof title === 'string' ? title : '';
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('copy failed');
}

export function programSearchUrl(provider, title) {
  const query = encodeURIComponent(validTitle(title));
  if (provider === 'google') return `https://www.google.com/search?q=${query}`;
  if (provider === 'wikipedia') return `https://ja.wikipedia.org/w/index.php?search=${query}`;
  throw new Error(`Unsupported program search provider: ${provider}`);
}
