/**
 * Failing specs for the `detectCommerce` helper.
 *
 * Oracle: `research/raw/scan-*.json` → top-level `isCommerce` + `commerceSignals`.
 * Reference: `research/FINDINGS.md` §3 + §9 ("Commerce site detection").
 *
 * Signals detected from the homepage HTML + path probes:
 *   - platform:shopify|woocommerce|magento|bigcommerce  (HTML / headers)
 *   - meta:<token>                                      (<meta name|property>)
 *   - url:/checkout|/product|/shop|/cart                (HEAD returns 200)
 *
 * The 5 real fixtures provide the oracle: only `shopify` is `isCommerce=true`.
 * For cf-dev, cf, example, vercel the helper must return `isCommerce=false`
 * with `commerceSignals=[]` (we intentionally model conservatively; the
 * vercel oracle's `schema:Offer` and `url:/product` signals come from rules
 * we do not implement in this phase — the top-level `isCommerce` stays
 * `false` either way, so scoring round-trips correctly).
 */

import { describe, it, expect } from "vitest";

import { makeFetchStub } from "./_helpers/oracle";
import { createScanContext } from "@/lib/engine/context";
import { applyCommerceGate, detectCommerce } from "@/lib/engine/commerce-signals";
import type { CheckResult } from "@/lib/schema";

// ---------------------------------------------------------------------------
// Synthetic fixtures (oracle only records the final signal set, not homepage
// HTML — we model a realistic Shopify homepage + path HEAD probes that would
// produce the observed signal set).
// ---------------------------------------------------------------------------

const SHOPIFY_HTML = [
  '<!doctype html><html lang="en"><head>',
  '<meta charset="utf-8">',
  '<meta name="generator" content="Shopify">',
  '<title>Shopify</title>',
  // A representative inline script reference to the Shopify platform CDN.
  '<script src="https://cdn.shopify.com/shopifycloud/shopify/assets/static/controllers/checkout-web-pixel-shared-worker.js"></script>',
  "</head><body>Shopify</body></html>",
].join("\n");

const PLAIN_HTML =
  '<!doctype html><html><head><title>Hello</title></head><body>hi</body></html>';

// ---------------------------------------------------------------------------
// Shopify (isCommerce=true) oracle round-trip
// ---------------------------------------------------------------------------

describe("detectCommerce — shopify fixture", () => {
  it("detects the oracle signal set for the shopify origin", async () => {
    const origin = "https://www.shopify.com";
    const { fetchImpl } = makeFetchStub({
      // Homepage GET memoised by ctx.getHomepage()
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: SHOPIFY_HTML,
      },
      // HEAD probes for url:* signals. Shopify oracle reports
      // ["url:/checkout", "url:/product", "url:/shop"] but NOT "url:/cart".
      [`${origin}/checkout`]: { status: 200, headers: {}, body: "" },
      [`${origin}/product`]: { status: 200, headers: {}, body: "" },
      [`${origin}/shop`]: { status: 200, headers: {}, body: "" },
      [`${origin}/cart`]: { status: 404, headers: {}, body: "" },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });

    const result = await detectCommerce(ctx);

    expect(result.isCommerce).toBe(true);
    // Must contain the oracle signals (order-insensitive).
    expect(result.commerceSignals).toEqual(
      expect.arrayContaining([
        "platform:shopify",
        "meta:shopify",
        "url:/checkout",
        "url:/product",
        "url:/shop",
      ]),
    );
    expect(result.commerceSignals).not.toContain("url:/cart");
  });
});

// ---------------------------------------------------------------------------
// Non-commerce fixtures
// ---------------------------------------------------------------------------

describe("detectCommerce — non-commerce fixtures", () => {
  it.each(["https://example.com", "https://www.cloudflare.com", "https://developers.cloudflare.com"])(
    "returns isCommerce=false with no signals for %s",
    async (origin) => {
      const { fetchImpl } = makeFetchStub({
        [`${origin}/`]: {
          status: 200,
          headers: { "content-type": "text/html" },
          body: PLAIN_HTML,
        },
        [`${origin}/checkout`]: { status: 404 },
        [`${origin}/product`]: { status: 404 },
        [`${origin}/shop`]: { status: 404 },
        [`${origin}/cart`]: { status: 404 },
      });
      const ctx = createScanContext({ url: origin, fetchImpl });
      const result = await detectCommerce(ctx);
      expect(result.isCommerce).toBe(false);
      expect(result.commerceSignals).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Platform variants (regression guard)
// ---------------------------------------------------------------------------

describe("detectCommerce — platform heuristics", () => {
  it("flags a WooCommerce generator meta as meta:woocommerce", async () => {
    const origin = "https://woo.test";
    const html =
      '<html><head><meta name="generator" content="WooCommerce 7.1.0"></head></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("meta:woocommerce");
  });

  it("flags a WooCommerce plugin path as platform:woocommerce", async () => {
    const origin = "https://woo2.test";
    const html =
      '<html><head><link rel="stylesheet" href="/wp-content/plugins/woocommerce/assets/css/woocommerce.css"></head></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("platform:woocommerce");
  });

  it("flags a Magento platform header", async () => {
    const origin = "https://mage.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: {
          "content-type": "text/html",
          "x-magento-cache-debug": "HIT",
        },
        body: "<html></html>",
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("platform:magento");
  });

  it("flags a BigCommerce inline script URL", async () => {
    const origin = "https://bc.test";
    const html =
      '<html><head><script src="https://cdn11.bigcommerce.com/s-xyz/app.js"></script></head></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("platform:bigcommerce");
  });

  it("flags an og:type=product meta", async () => {
    const origin = "https://og.test";
    const html =
      '<html><head><meta property="og:type" content="product"></head></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("meta:product");
  });

  it("flags a <meta name=\"product\"> meta", async () => {
    const origin = "https://metaname.test";
    const html =
      '<html><head><meta name="product" content="Widget"></head></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("meta:product");
  });

  it("flags every url:* signal when each path returns 200", async () => {
    const origin = "https://cart.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: PLAIN_HTML,
      },
      [`${origin}/checkout`]: { status: 200 },
      [`${origin}/product`]: { status: 200 },
      [`${origin}/shop`]: { status: 200 },
      [`${origin}/cart`]: { status: 200 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toEqual(
      expect.arrayContaining([
        "url:/checkout",
        "url:/product",
        "url:/shop",
        "url:/cart",
      ]),
    );
  });

  it("returns no signals when the homepage fetch errors", async () => {
    const origin = "https://broken.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: new Error("ECONNRESET"),
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(false);
    expect(result.commerceSignals).toEqual([]);
  });

  it("does NOT treat descriptive meta copy as a platform signal (H2 regression)", async () => {
    const origin = "https://desc.test";
    // A marketing-style description meta that mentions "shopify" in prose
    // must not be counted as a Shopify platform signal.
    const html =
      '<!doctype html><html><head>' +
      '<meta name="description" content="How to shopify your store">' +
      '</head><body>hi</body></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(false);
    expect(result.commerceSignals).toEqual([]);
  });

  it("emits signals in platform -> meta -> url detection order (M2)", async () => {
    // Mirrors the shopify oracle's `commerceSignals` array ordering:
    // ["platform:shopify", "meta:shopify", "url:/checkout",
    //  "url:/product", "url:/shop"].
    const origin = "https://www.shopify.com";
    const html = [
      "<!doctype html><html><head>",
      '<meta name="generator" content="Shopify">',
      '<script src="https://cdn.shopify.com/app.js"></script>',
      "</head><body>shop</body></html>",
    ].join("\n");
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 200 },
      [`${origin}/product`]: { status: 200 },
      [`${origin}/shop`]: { status: 200 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.commerceSignals).toEqual([
      "platform:shopify",
      "meta:shopify",
      "url:/checkout",
      "url:/product",
      "url:/shop",
    ]);
  });

  it("matches the shopify fixture's commerceSignals array exactly (L5 fixture parity)", async () => {
    // Directly reads the oracle's `commerceSignals` from
    // `research/raw/scan-shopify.json` and asserts byte-for-byte parity
    // with the detector's output under a realistic stub. This is stricter
    // than the synthetic ordering test above because the oracle itself is
    // the source of truth.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const oracle = require("../../research/raw/scan-shopify.json");
    const origin = new URL(oracle.url).origin;
    const html = [
      "<!doctype html><html><head>",
      '<meta name="generator" content="Shopify">',
      '<script src="https://cdn.shopify.com/shopifycloud/shopify/assets/static/controllers/checkout-web-pixel-shared-worker.js"></script>',
      "</head><body>shop</body></html>",
    ].join("\n");
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 200 },
      [`${origin}/product`]: { status: 200 },
      [`${origin}/shop`]: { status: 200 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.commerceSignals).toEqual(oracle.commerceSignals);
  });

  it("flags a reversed-attribute Shopify generator meta (L2)", async () => {
    const origin = "https://rev.test";
    const html =
      '<!doctype html><html><head>' +
      '<meta content="Shopify" name="generator">' +
      '</head><body>hi</body></html>';
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
      },
      [`${origin}/checkout`]: { status: 404 },
      [`${origin}/product`]: { status: 404 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toContain("meta:shopify");
  });

  it("tolerates individual HEAD probe failures", async () => {
    const origin = "https://parthead.test";
    const { fetchImpl } = makeFetchStub({
      [`${origin}/`]: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: PLAIN_HTML,
      },
      [`${origin}/checkout`]: new Error("ETIMEDOUT"),
      [`${origin}/product`]: { status: 200 },
      [`${origin}/shop`]: { status: 404 },
      [`${origin}/cart`]: { status: 404 },
    });
    const ctx = createScanContext({ url: origin, fetchImpl });
    const result = await detectCommerce(ctx);
    expect(result.isCommerce).toBe(true);
    expect(result.commerceSignals).toEqual(["url:/product"]);
  });
});

// ---------------------------------------------------------------------------
// applyCommerceGate — message suffix / trailing-period handling (L2)
// ---------------------------------------------------------------------------

describe("applyCommerceGate", () => {
  it("passes the result through unchanged when isCommerce is true", () => {
    const input: CheckResult = {
      status: "fail",
      message: "X not detected",
      evidence: [],
      durationMs: 0,
    };
    expect(applyCommerceGate(input, true)).toBe(input);
  });

  it("strips a trailing period before appending the non-commerce suffix", () => {
    const input: CheckResult = {
      status: "fail",
      message: "X not detected.",
      evidence: [],
      durationMs: 0,
    };
    const out = applyCommerceGate(input, false);
    expect(out.status).toBe("neutral");
    expect(out.message).toBe("X not detected (not a commerce site)");
  });

  it("appends the suffix to a message without a trailing period", () => {
    const input: CheckResult = {
      status: "fail",
      message: "X not detected",
      evidence: [],
      durationMs: 0,
    };
    const out = applyCommerceGate(input, false);
    expect(out.message).toBe("X not detected (not a commerce site)");
  });
});
