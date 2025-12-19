import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * CORS: Allows browser-based tools (Hoppscotch) to call this API.
 * Safe for testing. For production you can restrict origins if desired.
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Secret between GPT and YOUR backend (not Shopify)
const INBOUND_API_KEY = process.env.INBOUND_API_KEY;

// Shopify store + app credentials (set these in Render → Environment)
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN; // e.g. rwn1zb-we.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

// Simple health endpoint
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/ping", (req, res) => {
  console.log("PING HIT", { time: new Date().toISOString() });
  res.json({ ok: true, ping: true });
});

/**
 * Gets a Shopify Admin API access token using the Client Credentials Grant.
 * IMPORTANT: Reads the response as TEXT first, so if Shopify returns HTML we log it and do not crash.
 */
async function getShopifyAccessToken() {
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error(
      "Missing Shopify environment variables. Check SHOPIFY_SHOP_DOMAIN, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET."
    );
  }

  const url = `https://${SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`;

  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", SHOPIFY_CLIENT_ID);
  body.set("client_secret", SHOPIFY_CLIENT_SECRET);

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const contentType = resp.headers.get("content-type") || "";
  const rawText = await resp.text();

  // This log line is critical for diagnosing the HTML/JSON issue
  console.log("TOKEN RESPONSE:", {
    status: resp.status,
    contentType,
    preview: rawText.slice(0, 200)
  });

  let data = null;
  if (contentType.includes("application/json")) {
    data = JSON.parse(rawText);
  }

  if (!resp.ok) {
    throw new Error(
      `Token request failed: status=${resp.status} contentType=${contentType} preview=${rawText.slice(0, 200)}`
    );
  }

  if (!data?.access_token) {
    throw new Error(
      `Token missing access_token. contentType=${contentType} preview=${rawText.slice(0, 200)}`
    );
  }

  return data.access_token;
}

/**
 * POST /create-draft-order
 * Creates a Shopify Draft Order and returns invoice_url (Shopify checkout link).
 *
 * Authentication:
 * - Requires header: X-Api-Key = INBOUND_API_KEY
 *
 * Body:
 * {
 *   "customer": {"email":"..."},
 *   "shipping_address": {"address1":"..."},
 *   "items": [{"title":"Single Vision Lenses","price":150,"quantity":1}],
 *   "tags": ["optional"],
 *   "note": "optional"
 * }
 */
app.post("/create-draft-order", async (req, res) => {
  try {
    // 1) Authenticate request (GPT -> your backend)
    const key = req.header("X-Api-Key");
    if (!INBOUND_API_KEY || key !== INBOUND_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 2) Validate inputs
    const { customer, shipping_address, items, tags = [], note = "" } = req.body;

    if (!customer?.email) {
      return res.status(400).json({ error: "Missing required field: customer.email" });
    }
    if (!shipping_address?.address1) {
      return res.status(400).json({ error: "Missing required field: shipping_address.address1" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Missing required field: items (must be a non-empty array)" });
    }

    // 3) Get Shopify token
    const accessToken = await getShopifyAccessToken();

    // 4) Create Draft Order in Shopify
    const gql = `
      mutation draftOrderCreate($input: DraftOrderInput!) {
        draftOrderCreate(input: $input) {
          draftOrder { id invoiceUrl }
          userErrors { field message }
        }
      }
    `;

    const lineItems = items.map((it) => ({
      title: it.title,
      quantity: it.quantity ?? 1,
      originalUnitPrice: String(it.price)
    }));

    const variables = {
      input: {
        email: customer.email,
        shippingAddress: {
          firstName: shipping_address.firstName ?? "",
          lastName: shipping_address.lastName ?? "",
          address1: shipping_address.address1,
          address2: shipping_address.address2 ?? "",
          city: shipping_address.city ?? "",
          province: shipping_address.province ?? "",
          country: shipping_address.country ?? "US",
          zip: shipping_address.zip ?? "",
          phone: shipping_address.phone ?? ""
        },
        note,
        tags,
        lineItems
      }
    };

    const resp = await fetch(`https://${SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken
      },
      body: JSON.stringify({ query: gql, variables })
    });

    const data = await resp.json();

    const userErrors = data?.data?.draftOrderCreate?.userErrors;
    if (!resp.ok || (Array.isArray(userErrors) && userErrors.length > 0)) {
      return res.status(400).json({
        error: "Shopify error creating draft order",
        details: userErrors ?? data
      });
    }

    const draft = data.data.draftOrderCreate.draftOrder;
    return res.json({
      draft_order_id: draft.id,
      invoice_url: draft.invoiceUrl
    });
  } catch (e) {
    console.error("SERVER ERROR:", String(e));
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Order API running on port ${port}`));
