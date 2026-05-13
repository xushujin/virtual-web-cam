export function matchScreenUrls(items, keyword) {
  const normalized = String(keyword || '').trim().toLowerCase();

  if (!normalized) {
    return items;
  }

  return items.filter((item) => [
    item.name,
    item.url,
    item.remark,
  ].some((value) => String(value || '').toLowerCase().includes(normalized)));
}
