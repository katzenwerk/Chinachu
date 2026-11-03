async function request(id, input, signal) {
  const response = await fetch(`/api/recorded/${encodeURIComponent(id)}/maintenance.json`, {
    method: input ? 'POST' : 'GET', signal, cache: 'no-store',
    headers: { Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || `状態確認に失敗しました (HTTP ${response.status})`);
  return data;
}
export const loadRecordedMaintenance = (id, signal) => request(id, null, signal);
export const requestRecordedMaintenance = (id, input, signal) => request(id, input, signal);
