const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const soap = require("soap"); // für VIES VAT-Prüfung

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_NAME = process.env.SHOP_NAME; // Muss z. B. "better-smoke.myshopify.com" sein

// === NEU: vatlayer API Key (ENV überschreibt, sonst fester Key aus deiner Nachricht) ===
const VATLAYER_API_KEY = process.env.VATLAYER_API_KEY || "757c265e2bbbfc00956f5d9366536a8e";

// === VIES VAT-ID-Validierung (mit Fallback auf vatlayer) ===
app.post("/api/validate-vat", async (req, res) => {
  const vatNumber = req.body.vat_number;
  if (!vatNumber || vatNumber.length < 3) {
    return res.status(400).json({ error: "Ungültige VAT-Nummer" });
  }

  const countryCode = vatNumber.slice(0, 2);
  const vat = vatNumber.slice(2);
  const wsdlUrl = "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";

  const isServiceUnavailable = (err) => {
    const s = String(
      err?.root?.Envelope?.Body?.Fault?.faultstring ||
      err?.response?.data ||
      err?.body ||
      err?.message ||
      ""
    );
    return /MS_UNAVAILABLE|SERVICE_UNAVAILABLE/i.test(s);
  };

  async function viesCheck() {
    // https-Endpoint erzwingen (falls WSDL http liefert)
    const client = await soap.createClientAsync(wsdlUrl, {
      endpoint: "https://ec.europa.eu/taxation_customs/vies/services/checkVatService",
    });
    const [result] = await client.checkVatAsync({ countryCode, vatNumber: vat });
    return {
      valid: !!result.valid,
      name: result.name || null,
      address: result.address || null,
    };
  }

  async function vatlayerCheck() {
    // 1) Neuer apilayer-Endpoint (Header: apikey)
    try {
      const url1 = `https://api.apilayer.com/vat/validate?number=${encodeURIComponent(vatNumber)}`;
      const r1 = await fetch(url1, { headers: { apikey: VATLAYER_API_KEY } });
      if (r1.ok) {
        const d = await r1.json();
        const valid =
          d.valid === true ||
          d.validation_status === "valid" ||
          d.format_valid === true;
        return {
          valid: !!valid,
          name: d.company_name || null,
          address: d.company_address || null,
        };
      }
    } catch (_) { /* ignore */ }

    // 2) Älterer Endpoint (falls der neue nicht verfügbar ist)
    try {
      const url2 = `http://apilayer.net/api/validate?access_key=${encodeURIComponent(
        VATLAYER_API_KEY
      )}&vat_number=${encodeURIComponent(vatNumber)}`;
      const r2 = await fetch(url2);
      if (r2.ok) {
        const d = await r2.json();
        const valid =
          d.valid === true ||
          d.validation_status === "valid" ||
          d.format_valid === true;
        return {
          valid: !!valid,
          name: d.company_name || null,
          address: d.company_address || null,
        };
      }
    } catch (_) { /* ignore */ }

    throw new Error("vatlayer_unavailable");
  }

  try {
    // 1) VIES aufrufen; bei MS_UNAVAILABLE einmal kurz retryen
    try {
      return res.json(await viesCheck());
    } catch (err) {
      if (isServiceUnavailable(err)) {
        await new Promise((r) => setTimeout(r, 400)); // kurzer Backoff
        try {
          return res.json(await viesCheck());
        } catch (err2) {
          if (!isServiceUnavailable(err2)) throw err2; // anderer Fehler -> unten behandeln
        }
      }
      // 2) Fallback: vatlayer
      const fallback = await vatlayerCheck();
      return res.json(fallback);
    }
  } catch (finalErr) {
    console.error("❌ VAT-Prüfung fehlgeschlagen:", finalErr);
    return res
      .status(503)
      .json({ error: "Die USt-IdNr. kann derzeit nicht verifiziert werden." });
  }
});

// === Shopify-Kunden-Registrierung ===

const countryMap = {
  "Deutschland": "DE",
  "Österreich": "AT",
  "Schweiz": "CH",
  "Frankreich": "FR",
  "Italien": "IT"
};

// Funktion zum Überprüfen, ob die E-Mail bereits existiert
async function findCustomerByEmail(email) {
  try {
    const response = await fetch(`https://${SHOP_NAME}/admin/api/2023-10/customers/search.json?query=email:${encodeURIComponent(email)}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Shopify API Fehler (${response.status}):`, errorText);
      return null;
    }

    const data = await response.json();
    return data.customers.length > 0 ? data.customers[0] : null;
  } catch (err) {
    console.error("❌ Fehler beim Shopify API Request:", err);
    return null;
  }
}

// ✅ NEU: API-Endpunkt für E-Mail-Abgleich
app.post("/check-email", async (req, res) => {
  const { email } = req.body;

  console.log("📩 E-Mail-Abfrage:", email);

  if (!email || typeof email !== "string") {
    console.log("❌ Ungültige E-Mail empfangen:", email);
    return res.status(400).json({ error: "Ungültige E-Mail" });
  }

  try {
    const existingCustomer = await findCustomerByEmail(email);
    console.log("🔍 Existiert Kunde:", !!existingCustomer);
    res.json({ exists: !!existingCustomer });
  } catch (error) {
    console.error("❌ Fehler bei E-Mail-Abgleich:", error);
    res.status(500).json({ error: "Fehler beim E-Mail-Abgleich" });
  }
});

// Registrierung bei Shopify
app.post("/register", async (req, res) => {
  try {
    console.log("📩 Eingehende Registrierungsanfrage:", req.body);

    const existingCustomer = await findCustomerByEmail(req.body.email);
    if (existingCustomer) {
      console.log("✅ Kunde existiert bereits:", existingCustomer.id);
      return res.json({ success: true, message: "Kunde existiert bereits.", customer: existingCustomer });
    }

    const countryCode = countryMap[req.body.country] || "DE";

    let addresses = [
      {
        company: req.body.company_name || "Muster GmbH",
        address1: req.body.street || "Straße 1",
        city: req.body.city || "Berlin",
        zip: req.body.zip || "10115",
        country: countryCode,
        default: true
      }
    ];

    if (req.body.shipping_address && req.body.shipping_address.street) {
      addresses.push({
        address1: req.body.shipping_address.street,
        city: req.body.shipping_address.city,
        zip: req.body.shipping_address.zip,
        country: countryCode,
        default: false
      });
    }

    const customerData = {
      customer: {
        first_name: req.body.first_name || "Test",
        last_name: req.body.last_name || "Kunde",
        email: req.body.email,
        phone: req.body.phone || "+49 123 456789",
        addresses: addresses,
        accepts_marketing: req.body.accepts_marketing || false
      }
    };

    console.log("📤 Shopify-Kundenanlage:", JSON.stringify(customerData, null, 2));

    const response = await fetch(`https://${SHOP_NAME}/admin/api/2023-10/customers.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
      },
      body: JSON.stringify(customerData)
    });

    const statusCode = response.status;
    const data = await response.json();

    console.log(`🔄 Shopify Antwort (${statusCode}):`, JSON.stringify(data, null, 2));

    if (statusCode >= 400 || !data.customer) {
      console.error("❌ Shopify API-Fehler:", data);
      return res.status(statusCode).json({
        error: data.errors || "Fehler bei der Registrierung. Überprüfe API-Berechtigungen oder Pflichtfelder."
      });
    }

    console.log("✅ Kunde erfolgreich erstellt:", data.customer);
    res.json({ success: true, customer: data.customer });

  } catch (error) {
    console.error("❌ Server-Fehler bei Registrierung:", error);
    res.status(500).json({ error: "Server-Fehler." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
