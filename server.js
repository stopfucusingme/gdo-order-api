import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS (helps browser tools). Safe for now.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Api-Key, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const INBOUND_API_KEY = process.env.INBOUND_API_KEY;

const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN; // rwn1zb-we.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/ping", (req, res) => {
  console.log("PING HIT", { time: new Date().toISOString() });
  res.json({ ok: true, ping: true });
});

function getProvidedKey(req) {
  const apiKeyHeader = req.header("X-Api-Key");
  const authHeader = req.header("Authorization") || "";
  const bearerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  return apiKeyHeader || bearerToken || "";
}

function requireApiKey(req, res) {
  const providedKey = getProvidedKey(req);
  if (!INBOUND_API_KEY || !providedKey || providedKey !== INBOUND_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

async function getShopifyAccessToken() {
  if (!SHOPIFY_SHOP_DOMAIN || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Missing Shopify env vars: SHOPIFY_SHOP_DOMAIN/CLIENT_ID/CLIENT_SECRET");
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

  console.log("TOKEN RESPONSE:", {
    status: resp.status,
    contentType,
    preview: rawText.slice(0, 200)
  });

  let data = null;
  if (contentType.includes("application/json")) data = JSON.parse(rawText);

  if (!resp.ok) {
    throw new Error(`Token request failed: ${resp.status} ${rawText.slice(0, 200)}`);
  }
  if (!data?.access_token) {
    throw new Error(`Token missing access_token: ${rawText.slice(0, 200)}`);
  }
  return data.access_token;
}

app.post("/create-draft-order", async (req, res) => {
  try {
    console.log("CREATE_DRAFT_ORDER HIT", {
      time: new Date().toISOString(),
      hasXApiKey: Boolean(req.headers["x-api-key"]),
      hasAuth: Boolean(req.headers["authorization"])
    });

    if (!requireApiKey(req, res)) return;

    const { customer, shipping_address, items, tags = [], note = "" } = req.body;

    if (!customer?.email) return res.status(400).json({ error: "Missing customer.email" });
    if (!shipping_address?.address1) return res.status(400).json({ error: "Missing shipping_address.address1" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Missing items[]" });

    const accessToken = await getShopifyAccessToken();

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
    const errs = data?.data?.draftOrderCreate?.userErrors;

    if (!resp.ok || (errs && errs.length)) {
      return res.status(400).json({ error: "Shopify error", details: errs ?? data });
    }

    const draft = data.data.draftOrderCreate.draftOrder;
    return res.json({ draft_order_id: draft.id, invoice_url: draft.invoiceUrl });
  } catch (e) {
    console.error("SERVER ERROR:", String(e));
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Order API running"));
