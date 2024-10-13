import express from "express";
import axios from "axios";
import * as crypto from "crypto";
import bodyParser from "body-parser";

import "dotenv/config";

import {
  completePaymentRequest,
  getCheckoutById,
  getPaymentRequest,
  getTransactionById,
} from "./vivenu.js";

const app = express();
const port = process.env.PORT || 8080;

app.use(
  bodyParser.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString();
    },
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

const APP_URL = process.env.APP_URL;
const SECRET_KEY = process.env.SECRET_KEY;
const SECRET_KEY_P = process.env.SECRET_KEY_P;
const SELLER_CURRENCY = process.env.CURRENCY;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;

async function initializeTransaction(
  customerEmail,
  amount,
  paymentId,
  callbackUrl,
  cancelUrl,
  currency
) {
  const url = "https://api.startbutton.tech/transaction/initialize";

  const fields = {
    email: customerEmail,
    amount: Math.round(amount),
    redirectUrl: callbackUrl,
    reference: paymentId,
    partner: "Paystack",
    currency: currency || SELLER_CURRENCY || "GHS",
    metadata: {
      cancel_action: cancelUrl,
    },
  };

  try {
    const response = await axios.post(url, fields, {
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        "Cache-Control": "no-cache",
      },
    });

    return response.data;
  } catch (error) {
    console.error(
      "Error initializing transaction:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

async function createRefund(reference, amount) {
  const url = "https://api.startbutton.tech/transaction/refunds";

  const data = {
    transactionReference: reference,
    amount,
  };

  const headers = {
    Authorization: `Bearer ${SECRET_KEY_P}`,
    "Cache-Control": "no-cache",
    "content-type": "application/json",
  };

  try {
    const response = await axios.post(url, data, { headers });
    return response.data;
  } catch (error) {
    console.error(
      "Error creating refund:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

async function getStartButtonTransaction(reference) {
  const url = `https://api.startbutton.tech/transaction/status/${reference}`;

  const headers = {
    Authorization: `Bearer ${SECRET_KEY_P}`,
    "Cache-Control": "no-cache",
    "content-type": "application/json",
  };

  try {
    const response = await axios.get(url, { headers });
    return response.data;
  } catch (error) {
    console.error(
      "Error getting the transaction:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

app.get("/pay/callback", async (req, res) => {
  try {
    const paymentId = req.query.paymentId;
    const paymentRequest = await getPaymentRequest(paymentId);

    if (paymentRequest && paymentRequest.status !== "NEW") {
      console.error("payment request is already processed");
      return res.status(403).end();
    }

    console.log("Payment Request Received => ", paymentRequest);

    const details = await initializeTransaction(
      paymentRequest.customer.email,
      paymentRequest.amount * 100,
      paymentId,
      `${APP_URL}/paystack/callback?paymentRequestId=${paymentId}`,
      `${APP_URL}/paystack/callback?paymentRequestId=${paymentId}`,
      paymentRequest.currency
    );

    if (details && details.success) {
      res.redirect(details.data);
      res.end();
    } else {
      res.status(404).send("Payment processing error", details);
    }
  } catch (error) {
    console.error("Error processing payment:", error);
    res.status(500).send("Error processing payment");
  }
});

app.get("/paystack/callback", async (req, res) => {
  try {
    let paymentId = req.query.paymentRequestId;

    const paymentRequest = await getPaymentRequest(paymentId);

    if (paymentRequest.status !== "NEW") {
      console.error("payment request is already processed");
      return res.status(403).end();
    }

    const startButtonTransaction = await getStartButtonTransaction(paymentId);

    if (startButtonTransaction.success) {
      const status =
        startButtonTransaction.data &&
        startButtonTransaction.data.transaction &&
        startButtonTransaction.data.transaction.status;

      if (status === "successful") {
        console.log("PAAID =====>", paymentRequest);
        const completedPaymentRequest = await completePaymentRequest(paymentId);
        res.redirect(completedPaymentRequest.successReturnUrl);
      }
    }

    res.redirect(paymentRequest.failureReturnUrl);
    res.end();
  } catch (e) {
    console.error("Error handling CMI success:", e);
    res.status(500).send("Error handling CMI success");
    res.end();
  }
});

app.get("/paystack/failure", async (req, res) => {
  // Get the payment Request and redirect to Vivenu

  try {
    let paymentId = req.query.paymentRequestId;

    const paymentRequest = await getPaymentRequest(paymentId);
    if (paymentRequest.status !== "NEW") {
      console.error("payment request is already processed");
      return res.status(403).end();
    }

    const completedPaymentRequest = await completePaymentRequest(paymentId);
    res.redirect(completedPaymentRequest.failureReturnUrl);

    res.end();
  } catch (e) {
    console.error("Error handling CMI success:", e);
    res.status(500).send("Error handling CMI success");
    res.end();
  }
});

app.post("/paystack/refund", async (req, res) => {
  try {
    const payload = req.body;
    if (payload.type !== "payment.refund") {
      return res.status(400).send("unsupported type");
    }

    const signature = crypto
      .createHmac("sha256", GATEWAY_SECRET)
      .update(req.rawBody)
      .digest("hex");

    const requestSignature = req.headers["x-vivenu-signature"];
    const isValid = signature.toLowerCase() === requestSignature.toLowerCase();
    if (!isValid) {
      return res.status(400).send("invalid signature");
    }

    const transactionDetails = await getTransactionById(
      payload.data.transactionId
    );

    const checkoutId = transactionDetails.checkoutId;

    const checkoutDetails = await getCheckoutById(checkoutId);

    const paymentRequestId =
      checkoutDetails.docs[0] && checkoutDetails.docs[0].paymentRequestId;

    const startButtonTransaction = await getStartButtonTransaction(
      paymentRequestId
    );

    if (startButtonTransaction.success) {
      const gatewayReference =
        startButtonTransaction &&
        startButtonTransaction.data &&
        startButtonTransaction.data.transaction &&
        startButtonTransaction.data.transaction.transactionReference;
      // Continue Refund
      const results = await createRefund(gatewayReference, payload.data.amount);
      if (results.success) {
        res.end(JSON.stringify({ reference: paymentRequestId }));
      } else {
        res.status(500).send("Error handling  Refund");
        res.end();
      }
    }
  } catch (e) {
    console.error("Error handling Refund :", e);
    res.status(500).send("Error handling  Refund ");
    res.end();
  }
});

app.get("/", async (req, res) => {
  res.send("API RUNNING FOR MERCHANT => ");
});

app.listen(port, () => {
  console.log(`Listening at http://localhost:${port}`);
});
