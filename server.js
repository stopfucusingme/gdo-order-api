import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

// Secret between GPT and your backend (NOT Shopify)
const INBOUND_API_KEY = process.env.INBOUND_API_KEY;

// Shopify store + app credentials
const SHOPIFY_SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN; // rwn1zb-we.myshopify.com
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";

app.get("/health", (req, res) => res.json({ ok: true }));

async function getShopifyAccessToken() {
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

  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error(JSON.stringify(data));
  return data.access_token;
}

app.post("/create-draft-order", async (req, res) => {
  try {
    // Simple auth (GPT -> your backend)
    const key = req.header("X-Api-Key");
    if (!INBOUND_API_KEY || key !== INBOUND_API_KEY) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { customer, shipping_address, items, tags = [], note = "" } = req.body;

    if (!customer?.email || !shipping_address?.address1 || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Order API running"));
