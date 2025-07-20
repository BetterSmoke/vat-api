const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const soap = require("soap"); // NEU für VIES SOAP API

const app = express();
app.use(cors());
app.use(bodyParser.json());

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOP_NAME = process.env.SHOP_NAME;

// === VIES VAT-ID-Validierung ===
app.post("/api/validate-vat", async (req, res) => {
  const vatNumber = req.body.vat_number;

  if (!vatNumber || vatNumber.length < 3) {
    return res.status(400).json({ error: "Ungültige VAT-Nummer" });
  }

  const countryCode = vatNumber.slice(0, 2);
  const vat = vatNumber.slice(2);

  const wsdlUrl = "https://ec.europa.eu/taxation_customs/vies/checkVatService.wsdl";

  try {
    const client = await soap.createClientAsync(wsdlUrl);
    const [result] = await client.checkVatAsync({ countryCode, vatNumber: vat });

    console.log("✅ VIES Antwort:", result);
    res.json({
      valid: result.valid,
      name: result.name || null,
      address: result.address || null,
    });
  } catch (err) {
    console.error("❌ Fehler bei VIES-Abfrage:", err);
    res.status(500).json({ error: "Fehler bei der VAT-Prüfung über VIES" });
  }
});


// === Shopify-Kunden-Registrierung ===

// Mapping von Ländernamen auf Shopify-konforme ISO-2 Codes
const countryMap = {
  "Deutschland": "DE",
  "Österreich": "AT",
  "Schweiz": "CH",
  "Frankreich": "FR",
  "Italien": "IT"
};

// Funktion zum Überprüfen, ob die E-Mail bereits existiert
async function findCustomerByEmail(email) {
  const response = await fetch(`https://${SHOP_NAME}/admin/api/2023-10/customers/search.json?query=email:${email}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN
    }
  });

  const data = await response.json();
  return data.customers.length > 0 ? data.customers[0] : null;
}

// Shopify-Kundenregistrierung
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

    console.log("📤 Sende Anfrage an Shopify:", JSON.stringify(customerData, null, 2));

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

    console.log(`🔄 Shopify Antwort (Status ${statusCode}):`, JSON.stringify(data, null, 2));

    if (statusCode >= 400 || !data.customer) {
      console.error("❌ Shopify API-Fehler:", data);
      return res.status(statusCode).json({
        error: data.errors || "Fehler bei der Registrierung. Überprüfe API-Berechtigungen oder Pflichtfelder."
      });
    }

    console.log("✅ Kunde erfolgreich erstellt:", data.customer);
    res.json({ success: true, customer: data.customer });

  } catch (error) {
    console.error("❌ Server-Fehler:", error);
    res.status(500).json({ error: "Server-Fehler." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Server läuft auf Port ${PORT}`));
