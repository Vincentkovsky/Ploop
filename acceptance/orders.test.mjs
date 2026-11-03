import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.env.PLOOP_TARGET) throw new Error("PLOOP_TARGET must identify the immutable verification snapshot");
const { exportOrders } = await import(pathToFileURL(resolve(process.env.PLOOP_TARGET, "src/export-orders.mjs")));

test("exports all 250 records in source order", async () => {
  const orders = Array.from({ length: 250 }, (_, i) => ({ id: String(i + 1), customer: `Customer ${i + 1}` }));
  const calls = [];
  const csv = await exportOrders(async ({ cursor, limit }) => {
    calls.push({ cursor, limit });
    const offset = cursor === null ? 0 : Number(cursor);
    const next = offset + limit;
    return { orders: orders.slice(offset, next), nextCursor: next < orders.length ? String(next) : null };
  });
  assert.deepEqual(csv.split("\n"), ["id,customer", ...orders.map((o) => `${o.id},${o.customer}`)]);
  assert.deepEqual(calls, [{ cursor: null, limit: 100 }, { cursor: "100", limit: 100 }, { cursor: "200", limit: 100 }]);
});

test("does not fetch an extra page when exactly 100 rows have null nextCursor", async () => {
  let calls = 0;
  const csv = await exportOrders(async () => {
    calls++;
    return { orders: Array.from({ length: 100 }, (_, i) => ({ id: String(i), customer: "A" })), nextCursor: null };
  });
  assert.equal(calls, 1);
  assert.equal(csv.split("\n").length, 101);
});

test("empty results preserve the CSV header", async () => {
  assert.equal(await exportOrders(async () => ({ orders: [], nextCursor: null })), "id,customer");
});

test("empty string is a valid continuation cursor", async () => {
  const cursors = [];
  const csv = await exportOrders(async ({ cursor }) => {
    cursors.push(cursor);
    return cursor === null
      ? { orders: [{ id: "1", customer: "A" }], nextCursor: "" }
      : { orders: [{ id: "2", customer: "B" }], nextCursor: null };
  });
  assert.deepEqual(cursors, [null, ""]);
  assert.equal(csv, "id,customer\n1,A\n2,B");
});

test("an empty intermediate page can still carry a continuation cursor", async () => {
  assert.equal(await exportOrders(async ({ cursor }) => cursor === null
    ? { orders: [], nextCursor: "next" }
    : { orders: [{ id: "1", customer: "A" }], nextCursor: null }), "id,customer\n1,A");
});

test("CSV commas, quotes and line breaks retain their escaping", async () => {
  assert.equal(await exportOrders(async () => ({ orders: [{ id: "a,b", customer: 'A "quote"\nB' }], nextCursor: null })),
    'id,customer\n"a,b","A ""quote""\nB"');
});

test("an error on a later page is propagated without a partial successful export", async () => {
  const failure = new Error("API unavailable");
  await assert.rejects(() => exportOrders(async ({ cursor }) => {
    if (cursor !== null) throw failure;
    return { orders: [{ id: "1", customer: "A" }], nextCursor: "next" };
  }), (error) => error === failure);
});

test("repeated continuation cursors fail instead of looping", async () => {
  let calls = 0;
  await assert.rejects(() => exportOrders(async () => {
    assert.ok(++calls <= 4, "pagination did not reject a repeated cursor");
    return { orders: [], nextCursor: "same" };
  }));
  assert.ok(calls <= 3);
});
