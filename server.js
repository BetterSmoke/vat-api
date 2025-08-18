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

// Nur ENV, kein Hardcoded Key
const VATLAYER_API_KEY = process.env.VATLAYER_API_KEY;

// ============================================================================
// === VIES VAT-ID-Validierung (mit Fallback auf vatlayer & 20s Gesamt-Timeout)
// ============================================================================
app.post("/api/validate-vat", async (req, res) => {
  const rawVat = (req.body.vat_number || "").toUpperCase().replace(/\s+/g, "");
  if (!rawVat || rawVat.length < 3) {
    return res.status(400).json({ error: "Ungültige VAT-Nummer" });
  }

  const TIME_BUDGET_MS = 20000;
  const startedAt = Date.now();
  const timeLeft = () => Math.max(0, TIME_BUDGET_MS - (Date.now() - startedAt));

  const countryCode = rawVat.slice(0, 2);
  const vat = rawVat.slice(2);
  const wsdlUrl = "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";
  const forcedEndpoint = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";

  const isServiceUnavailable = (err) => {
    const s = String(
      err?.root?.Envelope?.Body?.Fault?.faultstring ||
      err?.response?.data ||
      err?.body ||
      err?.message ||
      ""
    );
    return /MS_UNAVAILABLE|SERVICE_UNAVAILABLE|temporarily|timeout/i.test(s);
  };

  const withTimeout = (promise, ms, label = "op") =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout_${label}`)), ms)
      ),
    ]);

  async function viesCheck() {
    const client = await soap.createClientAsync(wsdlUrl, { endpoint: forcedEndpoint });
    const [result] = await client.checkVatAsync({ countryCode, vatNumber: vat });
    return {
      valid: !!result.valid,
      name: result.name || null,
      address: result.address || null,
      source: "vies",
    };
  }

  async function vatlayerCheck() {
    if (!VATLAYER_API_KEY) throw new Error("vatlayer_missing_key");

    // 1) Neuer apilayer-Endpoint (Header apikey)
    try {
      const url1 = `https://api.apilayer.com/vat/validate?number=${encodeURIComponent(rawVat)}`;
      const r1 = await fetch(url1, { headers: { apikey: VATLAYER_API_KEY } });
      if (r1.ok) {
        const d = await r1.json();
        const valid = d.valid === true || d.validation_status === "valid" || d.format_valid === true;
        return {
          valid: !!valid,
          name: d.company_name || null,
          address: d.company_address || null,
          source: "vatlayer",
        };
      }
    } catch (_) { /* ignore */ }

    // 2) Älterer Endpoint (Query access_key)
    try {
      const url2 = `http://apilayer.net/api/validate?access_key=${encodeURIComponent(
        VATLAYER_API_KEY
      )}&vat_number=${encodeURIComponent(rawVat)}`;
      const r2 = await fetch(url2);
      if (r2.ok) {
        const d = await r2.json();
        const valid = d.valid === true || d.validation_status === "valid" || d.format_valid === true;
        return {
          valid: !!valid,
          name: d.company_name || null,
          address: d.company_address || null,
          source: "vatlayer-legacy",
        };
      }
    } catch (_) { /* ignore */ }

    throw new Error("vatlayer_unavailable");
  }

  // Ablauf: VIES (8s) → ggf. Retry (6s) → vatlayer (8s) – alles innerhalb 20s Budget.
  // Wenn Budget abgelaufen/Fehler: genehmigen (valid: true).
  try {
    if (timeLeft() <= 0) {
      console.warn("ℹ VAT: Zeitbudget vor Start erschöpft, genehmige.");
      return res.json({ valid: true, name: null, address: null });
    }

    try {
      const ms = Math.min(8000, timeLeft());
      const result = await withTimeout(viesCheck(), ms, "vies1");
      return res.json(result);
    } catch (err1) {
      if (isServiceUnavailable(err1) && timeLeft() > 0) {
        try {
          const ms = Math.min(6000, timeLeft());
          const result2 = await withTimeout(viesCheck(), ms, "vies2");
          return res.json(result2);
        } catch (err2) {
          // weiter zu vatlayer
        }
      }
    }

    if (timeLeft() > 0) {
      try {
        const ms = Math.min(8000, timeLeft());
        const fb = await withTimeout(vatlayerCheck(), ms, "vatlayer");
        return res.json(fb);
      } catch (errFb) {
        // unten genehmigen
      }
    }

    console.warn("ℹ VAT: Dienste nicht erreichbar oder Timeout. Genehmige VAT als gültig.");
    return res.json({ valid: true, name: null, address: null });

  } catch (fatal) {
    console.error("❌ Unerwarteter Fehler in VAT-Prüfung. Genehmige:", fatal);
    return res.json({ valid: true, name: null, address: null });
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

// ✅ API-Endpunkt für E-Mail-Abgleich
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

    // Optional: Telefonnummer zusätzlich in die Adresse schreiben (hilfreich für Versandlabels)
    if (req.body.phone) {
      addresses[0].phone = req.body.phone;
      if (addresses[1]) addresses[1].phone = req.body.phone;
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
