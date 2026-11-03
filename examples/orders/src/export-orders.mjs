const csvField = (value) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

// fetchPage({ cursor: string | null, limit: number }) returns
// { orders: Array<{ id: string, customer: string }>, nextCursor: string | null }.
export async function exportOrders(fetchPage) {
  const { orders } = await fetchPage({ cursor: null, limit: 100 });
  return ["id,customer", ...orders.map(({ id, customer }) => [id, customer].map(csvField).join(","))].join("\n");
}
