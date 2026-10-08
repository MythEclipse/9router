#!/usr/bin/env node
/**
 * Micro-benchmark for the gateway's own request overhead.
 *
 *   node scripts/bench-api.mjs [baseUrl] [iterations]
 *
 * Measures time-to-first-byte (TTFB) and total time per route with a warm
 * keep-alive agent, so what is reported is the gateway's per-request cost —
 * routing, auth guard, DB reads, translation — not TCP setup or upstream LLM
 * latency. Routes are picked so no upstream provider is contacted.
 */
import http from "node:http";

const BASE = process.argv[2] || "http://127.0.0.1:20127";
const ITERATIONS = Number(process.argv[3]) || 30;
const WARMUP = 5;

// BENCH_API_KEY (optional) unlocks the authenticated routes. The chat route
// targets a provider with no local credentials, so it exercises the whole
// gateway-side path (guard → key check → settings → model resolve → account
// selection) and stops before any upstream network call.
const API_KEY = process.env.BENCH_API_KEY || "";

const ROUTES = [
  { name: "GET  /api/health", method: "GET", path: "/api/health" },
  { name: "GET  /api/auth/status", method: "GET", path: "/api/auth/status" },
  { name: "GET  /api/init", method: "GET", path: "/api/init" },
  { name: "GET  /api/version", method: "GET", path: "/api/version" },
  { name: "GET  /v1/models", method: "GET", path: "/v1/models" },
  {
    name: "POST /v1/chat/completions",
    method: "POST",
    path: "/v1/chat/completions",
    needsKey: true,
    body: JSON.stringify({ model: "alicode/qwen3.5-plus", messages: [{ role: "user", content: "hi" }], stream: false }),
  },
];

const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });

function request(route) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    let firstByte = null;
    const headers = route.body
      ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(route.body) }
      : {};
    if (route.needsKey && API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
    const req = http.request(
      {
        agent,
        host: "127.0.0.1",
        port: Number(new URL(BASE).port) || 80,
        method: route.method,
        path: route.path,
        headers,
      },
      (res) => {
        firstByte = Number(process.hrtime.bigint() - started) / 1e6;
        res.resume();
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            ttfb: firstByte,
            total: Number(process.hrtime.bigint() - started) / 1e6,
          });
        });
      },
    );
    req.on("error", reject);
    if (route.body) req.write(route.body);
    req.end();
  });
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { min: sorted[0], median: at(50), p95: at(95), max: sorted[sorted.length - 1], mean };
}

const fmt = (n) => n.toFixed(2).padStart(8);
const rows = [];

for (const route of ROUTES) {
  try {
    for (let i = 0; i < WARMUP; i++) await request(route);
    const ttfb = [];
    const total = [];
    let status = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const r = await request(route);
      status = r.status;
      ttfb.push(r.ttfb);
      total.push(r.total);
    }
    rows.push({ route: route.name, status, ttfb: stats(ttfb), total: stats(total) });
  } catch (err) {
    rows.push({ route: route.name, status: `ERR ${err.code || err.message}` });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${BASE} · ${ITERATIONS} runs/route (after ${WARMUP} warm-up)`);
console.log(
  `${pad("route", 30)}${pad("code", 7)}${pad("ttfb med", 11)}${pad("ttfb p95", 11)}${pad("ttfb max", 11)}${pad("total med", 11)}${pad("total p95", 11)}`,
);
for (const r of rows) {
  if (typeof r.status !== "number") {
    console.log(`${pad(r.route, 30)}${pad(r.status, 7)}`);
    continue;
  }
  console.log(
    `${pad(r.route, 30)}${pad(r.status, 7)}${pad(fmt(r.ttfb.median), 11)}${pad(fmt(r.ttfb.p95), 11)}${pad(fmt(r.ttfb.max), 11)}${pad(fmt(r.total.median), 11)}${pad(fmt(r.total.p95), 11)}`,
  );
}

agent.destroy();
